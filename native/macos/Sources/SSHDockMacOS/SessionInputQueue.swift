import Foundation
import Combine

/// A session's byte stream stays here until the core accepts each complete
/// chunk. Only one request is in flight; rejection never advances the head.
@MainActor
final class SessionInputQueue: ObservableObject {
    typealias Completion = @MainActor (Result<Void, CoreFailure>) -> Void
    typealias Sender = @MainActor (Data, @escaping Completion) -> Void

    @Published private(set) var pendingBytes = 0
    @Published private(set) var pauseReason: String?
    @Published private(set) var notice: String?
    var sender: Sender?
    private let chunkBytes: Int
    private let byteLimit: Int
    private var chunks: [Data] = []
    private var inFlight = false
    private var generation = 0
    private var stopped = false

    init(chunkBytes: Int = 64 * 1024, byteLimit: Int = 8 * 1024 * 1024) {
        precondition(chunkBytes > 0 && byteLimit >= chunkBytes)
        self.chunkBytes = chunkBytes
        self.byteLimit = byteLimit
    }

    @discardableResult
    func enqueue(_ data: Data) -> Bool {
        guard !stopped else { return false }
        guard data.count <= byteLimit - pendingBytes else {
            let limit = ByteCountFormatter.string(fromByteCount: Int64(byteLimit), countStyle: .memory)
            notice = "待发送内容超过 \(limit) 上限，本次输入未发送。请先重试或取消待发送内容，再分批粘贴。"
            return false // Reject the entire new paste before accepting a prefix.
        }
        guard !data.isEmpty else { return true }
        var offset = 0
        // Coalesce queued keystrokes without changing the already submitted head.
        if let tail = chunks.last, tail.count < chunkBytes, !(inFlight && chunks.count == 1) {
            let length = min(chunkBytes - tail.count, data.count)
            chunks[chunks.count - 1].append(data.subdata(in: 0..<length))
            offset = length
        }
        while offset < data.count {
            let end = min(offset + chunkBytes, data.count)
            chunks.append(data.subdata(in: offset..<end))
            offset = end
        }
        pendingBytes += data.count
        pump()
        return true
    }

    func retry() {
        guard !stopped else { return }
        pauseReason = nil
        notice = nil
        pump()
    }

    /// Already submitted input requests cannot be withdrawn, including requests
    /// still queued in the bridge. Cancel local pending data only; stale callbacks
    /// cannot acknowledge a new generation's queue head.
    func cancelPending() {
        generation += 1
        chunks.removeAll()
        pendingBytes = 0
        inFlight = false
        pauseReason = nil
        notice = nil
    }

    func dismissNotice() { notice = nil }

    func shutdown() {
        stopped = true
        cancelPending()
        sender = nil
    }

    private func pump() {
        guard !stopped, !inFlight, pauseReason == nil, let head = chunks.first, let sender else { return }
        inFlight = true
        let submittedGeneration = generation
        sender(head) { [weak self] result in
            guard let self, generation == submittedGeneration, !stopped else { return }
            inFlight = false
            switch result {
            case .success:
                pendingBytes -= chunks.removeFirst().count
                pump()
            case .failure(let error):
                if error.code == "INPUT_BACKPRESSURE" {
                    pauseReason = "终端暂时无法接收输入，待发送内容已保留。"
                } else {
                    pauseReason = "发送失败，待发送内容已保留：\(error.localizedDescription)"
                }
            }
        }
    }
}
