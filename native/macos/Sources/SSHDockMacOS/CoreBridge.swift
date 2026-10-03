import Foundation
import CSshDockCore

struct CoreFailure: Error, LocalizedError, Sendable {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

struct CoreEvent: Decodable, Sendable {
    let type: String
    let sessionId: String?
    let data: String?
    let exitCode: Int?
    let message: String?
    let transferId: String?
    let transferred: UInt64?
    let total: UInt64?
    let state: String?
}

/// Requests are FIFO. Polling has its own lane so output draining continues
/// during input/resize calls. The runtime owns the handle beyond either lane.
final class CoreBridge: @unchecked Sendable {
    enum Lane { case terminal, control, files, statistics }
    private let runtime: CoreRuntime

    init(eventHandler: @escaping @Sendable ([CoreEvent]) -> Void = { _ in }) {
        runtime = CoreRuntime { events, consumed in eventHandler(events); consumed() }
    }

    /// The receiver calls consumed after applying a batch. At most two batches
    /// may be in flight; slower rendering therefore backpressures the core.
    init(deliverEvents: @escaping @Sendable ([CoreEvent], @escaping @Sendable () -> Void) -> Void) {
        runtime = CoreRuntime(eventHandler: deliverEvents)
    }

    func request(_ json: String, lane: Lane = .terminal) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            runtime.submit(json, lane: lane) { continuation.resume(with: $0) }
        }
    }

    /// Synchronous enqueue preserves keyboard/paste ordering without spawning
    /// unstructured tasks whose scheduling can reorder input.
    func submit(_ json: String, completion: @escaping @Sendable (Result<Data, Error>) -> Void = { _ in }) {
        runtime.submit(json, lane: .terminal, completion: completion)
    }

    func stop() { runtime.stop() }
    func stopAsync(completion: @escaping @Sendable () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in runtime.stop(); completion() }
    }
    deinit { runtime.stop() }
}

private final class CoreRuntime: @unchecked Sendable {
    private let requests = DispatchQueue(label: "com.sshdock.native.requests", qos: .userInitiated)
    private let polling = DispatchQueue(label: "com.sshdock.native.poll", qos: .userInitiated)
    private let control = DispatchQueue(label: "com.sshdock.native.control", qos: .userInitiated)
    private let files = DispatchQueue(label: "com.sshdock.native.files", qos: .utility)
    private let statistics = DispatchQueue(label: "com.sshdock.native.statistics", qos: .utility)
    private let initialized = DispatchGroup()
    private let laneKey = DispatchSpecificKey<Bool>()
    private let stateLock = NSLock()
    private let stopLock = NSLock()
    private var handle: UnsafeMutableRawPointer?
    private var timer: DispatchSourceTimer?
    private var stopped = false
    private var initializationFailure: CoreFailure?
    private let deliverySlots = DispatchSemaphore(value: 2)
    private let eventHandler: @Sendable ([CoreEvent], @escaping @Sendable () -> Void) -> Void

    init(eventHandler: @escaping @Sendable ([CoreEvent], @escaping @Sendable () -> Void) -> Void) {
        self.eventHandler = eventHandler
        requests.setSpecific(key: laneKey, value: true)
        polling.setSpecific(key: laneKey, value: true)
        control.setSpecific(key: laneKey, value: true)
        files.setSpecific(key: laneKey, value: true)
        statistics.setSpecific(key: laneKey, value: true)
        initialized.enter()
        requests.async { [self] in
            stateLock.lock()
            if !stopped {
                handle = sshdock_core_create()
                do {
                    guard let handle else { throw CoreFailure(code: "CORE_UNAVAILABLE", message: "无法创建会话核心") }
                    let pointer = "{\"method\":\"core.info\",\"params\":{}}".withCString { sshdock_core_request(handle, $0) }
                    let info = try JSONSerialization.jsonObject(with: copyResult(pointer)) as? [String: Any]
                    let result = info?["result"] as? [String: Any]
                    guard info?["ok"] as? Bool == true, result?["abiVersion"] as? Int == 1 else {
                        throw CoreFailure(code: "ABI_MISMATCH", message: "会话核心版本不兼容，要求 ABI 1")
                    }
                } catch {
                    initializationFailure = error as? CoreFailure ?? CoreFailure(code: "INVALID_RESPONSE", message: error.localizedDescription)
                    if let handle { sshdock_core_destroy(handle) }
                    handle = nil
                }
            }
            stateLock.unlock()
            initialized.leave()
            polling.async { [self] in
                guard activeHandle(allowStopping: false) != nil else { return }
                let pollTimer = DispatchSource.makeTimerSource(queue: polling)
                pollTimer.schedule(deadline: .now(), repeating: .milliseconds(16), leeway: .milliseconds(4))
                pollTimer.setEventHandler { [weak self] in self?.poll() }
                timer = pollTimer
                pollTimer.resume()
            }
        }
    }

    func submit(_ json: String, lane: CoreBridge.Lane, completion: @escaping @Sendable (Result<Data, Error>) -> Void) {
        let queue: DispatchQueue
        switch lane { case .terminal: queue = requests; case .control: queue = control; case .files: queue = files; case .statistics: queue = statistics }
        queue.async { [self] in
            initialized.wait()
            guard let handle = activeHandle(allowStopping: false) else {
                stateLock.lock()
                let failure = initializationFailure ?? CoreFailure(code: "CORE_STOPPED", message: "会话核心已停止")
                stateLock.unlock()
                completion(.failure(failure))
                return
            }
            do {
                let result = json.withCString { sshdock_core_request(handle, $0) }
                let data = try copyResult(result)
                let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard object?["ok"] as? Bool == true else {
                    let error = object?["error"] as? [String: Any]
                    throw CoreFailure(code: error?["code"] as? String ?? "CORE_ERROR", message: error?["message"] as? String ?? "无效的核心响应")
                }
                guard let value = object?["result"] else {
                    throw CoreFailure(code: "INVALID_RESPONSE", message: "核心响应缺少结果")
                }
                completion(.success(try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])))
            } catch {
                completion(.failure(error))
            }
        }
    }

    func stop() {
        // If a consumer releases the bridge in an FFI callback, defer shutdown
        // beyond that callback instead of synchronously waiting on our own lane.
        if DispatchQueue.getSpecific(key: laneKey) != nil {
            DispatchQueue.global(qos: .userInitiated).async { [self] in stop() }
            return
        }
        stopLock.lock()
        defer { stopLock.unlock() }
        stateLock.lock()
        let wasStopped = stopped
        stopped = true
        stateLock.unlock()
        guard !wasStopped else { return }
        initialized.wait()
        stateLock.lock(); let liveHandle = handle; stateLock.unlock()
        if let liveHandle {
            // This cancellation call deliberately bypasses busy request lanes.
            // It wakes transfers and blocked IO before we wait for their barriers.
            let pointer = "{\"method\":\"core.shutdown\",\"params\":{}}".withCString { sshdock_core_request(liveHandle, $0) }
            if let pointer { sshdock_core_string_free(pointer) }
        }
        // Leave polling alive until every request has returned. Only then drain
        // the poll lane and destroy, ensuring neither lane can use a freed handle.
        requests.sync {}
        control.sync {}
        files.sync {}
        statistics.sync {}
        polling.sync {
            timer?.cancel()
            timer = nil
            stateLock.lock()
            if let handle { sshdock_core_destroy(handle) }
            handle = nil
            stateLock.unlock()
        }
    }

    private func activeHandle(allowStopping: Bool) -> UnsafeMutableRawPointer? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return (!stopped || allowStopping) ? handle : nil
    }

    private func copyResult(_ pointer: UnsafeMutablePointer<CChar>?) throws -> Data {
        guard let pointer else { throw CoreFailure(code: "NO_RESPONSE", message: "核心未返回数据") }
        defer { sshdock_core_string_free(pointer) }
        return Data(bytes: pointer, count: strlen(pointer))
    }

    private func poll() {
        guard let handle = activeHandle(allowStopping: true) else { return }
        // Nonblocking: shutdown never waits for MainActor to consume a batch.
        guard deliverySlots.wait(timeout: .now()) == .success else { return }
        do {
            let data = try copyResult(sshdock_core_poll(handle))
            let events = try JSONDecoder().decode([CoreEvent].self, from: data)
            if events.isEmpty { deliverySlots.signal() }
            else { eventHandler(events) { [deliverySlots] in deliverySlots.signal() } }
        } catch {
            eventHandler([CoreEvent(type: "error", sessionId: nil, data: nil, exitCode: nil, message: error.localizedDescription, transferId: nil, transferred: nil, total: nil, state: nil)]) { [deliverySlots] in deliverySlots.signal() }
        }
    }
}

func coreRequestJSON(_ method: String, _ params: [String: Any] = [:]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: ["method": method, "params": params], options: [.sortedKeys])
    guard let json = String(data: data, encoding: .utf8) else {
        throw CoreFailure(code: "INVALID_REQUEST", message: "无法编码核心请求")
    }
    return json
}
