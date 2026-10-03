import AppKit
import SwiftUI
import SwiftTerm

enum TerminalTheme: String, CaseIterable, Identifiable {
    case system, dark, light
    var id: String { rawValue }
    var title: String {
        switch self { case .system: return "跟随系统"; case .dark: return "深色"; case .light: return "浅色" }
    }
}

@MainActor
final class TerminalSession: ObservableObject, Identifiable, @preconcurrency TerminalViewDelegate {
    enum State { case waiting, starting, running, closed, failed }
    let id = UUID()
    let terminal: TerminalView
    let inputQueue = SessionInputQueue()
    @Published var title: String
    @Published var cwd: String
    @Published var state: State = .waiting
    @Published var detached = false
    @Published var status = "准备终端"
    @Published var columns = 80
    @Published var rows = 25
    var coreID: String?
    var lastSentSize: (Int, Int)?
    var connection: SSHConnection?
    @Published var remote: RemoteWorkspace?
    @Published var showRemoteFiles = true
    weak var store: SessionStore?

    init(title: String, cwd: String, store: SessionStore) {
        self.title = title
        self.cwd = cwd
        self.store = store
        terminal = TerminalView(frame: .zero, font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular), options: TerminalOptions(scrollback: 10_000))
        terminal.terminalDelegate = self
    }

    func measured() {
        let screen = terminal.getTerminal()
        let measuredColumns = max(1, screen.cols)
        let measuredRows = max(1, screen.rows)
        if columns != measuredColumns { columns = measuredColumns }
        if rows != measuredRows { rows = measuredRows }
        guard terminal.bounds.width > 40, terminal.bounds.height > 40 else { return }
        if state == .waiting {
            state = .starting
            status = "正在启动 shell"
            Task { await store?.start(self) }
        } else if state == .running { store?.resize(self) }
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let nextColumns = max(1, newCols)
            let nextRows = max(1, newRows)
            if columns != nextColumns { columns = nextColumns }
            if rows != nextRows { rows = nextRows }
            if state == .running { store?.resize(self) }
        }
    }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard state == .running else { return }
        store?.send(Data(data), to: self)
    }

    func setTerminalTitle(source: TerminalView, title: String) {
        if !title.isEmpty { self.title = title; store?.objectWillChange.send() }
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        guard let directory else { return }
        cwd = URL(string: directory)?.path ?? directory
    }

    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    // This is the OSC 52 callback, whose SwiftTerm default is also a no-op.
    // User selection copy(_: ) writes NSPasteboard directly in TerminalView.
    func clipboardCopy(source: TerminalView, content: Data) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }
    func bell(source: TerminalView) {
        if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    }
}

@MainActor
final class SessionStore: ObservableObject {
    @Published var sessions: [TerminalSession] = []
    @Published var selectedID: UUID?
    @Published var errorMessage: String?
    @Published private(set) var connectingIDs: Set<UUID> = []
    let connections: ConnectionRepository
    @Published var theme: TerminalTheme {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: "native.theme")
            applyTheme()
        }
    }
    var windowCoordinator: WindowCoordinator?
    private var nextNumber = 0
    private var pendingEvents: [String: [CoreEvent]] = [:]
    @Published private(set) var isStopping = false
    private var closingSessionIDs: Set<UUID> = []
    private struct SSHLaunch { let profile: SSHConnection; let secret: String; let fingerprint: String }
    private var sshLaunches: [UUID: SSHLaunch] = [:]
    private var ignoredCoreIDs: Set<String> = []
    private var ignoredCoreOrder: [String] = []

    private func ignoreCore(_ id: String) {
        if ignoredCoreIDs.insert(id).inserted { ignoredCoreOrder.append(id) }
        if ignoredCoreOrder.count > 2048 { ignoredCoreIDs.remove(ignoredCoreOrder.removeFirst()) }
    }
    private lazy var bridge = CoreBridge(deliverEvents: { [weak self] events, consumed in
        // Dispatch FIFO is deliberate: unstructured MainActor tasks may run
        // in another order, corrupting an ANSI/UTF-8 stream between poll batches.
        DispatchQueue.main.async { [weak self] in self?.consume(events); consumed() }
    })

    init(connections: ConnectionRepository? = nil) {
        self.connections = connections ?? ConnectionRepository()
        theme = TerminalTheme(rawValue: UserDefaults.standard.string(forKey: "native.theme") ?? "system") ?? .system
    }

    var selected: TerminalSession? { sessions.first { $0.id == selectedID } }
    var runningCount: Int { sessions.filter { $0.state == .running || $0.state == .starting }.count }

    func newSession() {
        guard !isStopping else { return }
        nextNumber += 1
        let localCwd = selected?.connection == nil ? selected?.cwd : nil
        let session = TerminalSession(title: "终端 \(nextNumber)", cwd: localCwd ?? FileManager.default.homeDirectoryForCurrentUser.path, store: self)
        sessions.append(session)
        selectedID = session.id
        applyTheme(to: session)
    }

    func connect(_ profile: SSHConnection, secret: String) {
        guard !isStopping, !connectingIDs.contains(profile.id) else { return }
        connectingIDs.insert(profile.id)
        Task {
            defer { connectingIDs.remove(profile.id) }
            do {
                let bytes = try await remoteRequest("ssh.hostKey", ["host": profile.host, "port": profile.port], lane: .control)
                let identity = try JSONDecoder().decode(HostIdentity.self, from: bytes)
                guard !isStopping else { return }
                switch connections.trust(for: profile, identity: identity) {
                case .match: break
                case .mismatch(let previous):
                    throw CoreFailure(code: "HOST_KEY_MISMATCH", message: "主机密钥发生变化，连接已阻止。旧：\(previous.fingerprint)\n新：\(identity.fingerprint)\n请核实服务器后，在连接菜单中显式重置主机信任。")
                case .unknown:
                    let alert = NSAlert(); alert.messageText = "信任新的 SSH 主机？"
                    alert.informativeText = "\(profile.host):\(profile.port)\n\(identity.algorithm)\n\(identity.fingerprint)\n请向服务器管理员核对指纹。"
                    alert.addButton(withTitle: "信任并连接"); alert.addButton(withTitle: "取消")
                    guard alert.runModal() == .alertFirstButtonReturn else { return }
                    try connections.trustNewHost(profile, identity: identity)
                }
                let session = TerminalSession(title: profile.name, cwd: "远程", store: self)
                session.connection = profile
                sshLaunches[session.id] = SSHLaunch(profile: profile, secret: secret, fingerprint: identity.fingerprint)
                sessions.append(session); selectedID = session.id; applyTheme(to: session)
                windowCoordinator?.showMain()
            } catch { if !isStopping { errorMessage = error.localizedDescription } }
        }
    }

    func select(_ session: TerminalSession) {
        guard !isStopping, sessions.contains(where: { $0 === session }), !isClosing(session) else { return }
        selectedID = session.id
        if session.detached { windowCoordinator?.focusDetached(session) }
        else {
            DispatchQueue.main.async { [weak self, weak session] in
                guard let self, let session, selectedID == session.id,
                      !session.detached, !isClosing(session), sessions.contains(where: { $0 === session }) else { return }
                session.terminal.window?.makeFirstResponder(session.terminal)
            }
        }
    }

    func isClosing(_ session: TerminalSession) -> Bool { closingSessionIDs.contains(session.id) }

    func start(_ session: TerminalSession) async {
        do {
            let initialSize = (session.columns, session.rows)
            let data: Data
            if let launch = sshLaunches.removeValue(forKey: session.id) {
                data = try await remoteRequest("ssh.connect", ["host": launch.profile.host, "port": launch.profile.port,
                    "username": launch.profile.username, "authType": launch.profile.authType.rawValue,
                    "password": launch.profile.authType == .password ? launch.secret : "", "keyPath": launch.profile.keyPath,
                    "passphrase": launch.profile.authType == .key ? launch.secret : "", "expectedFingerprint": launch.fingerprint,
                    "cols": initialSize.0, "rows": initialSize.1, "terminalEngine": false], lane: .control)
            } else if session.connection != nil {
                throw CoreFailure(code: "MISSING_AUTH", message: "远程认证已清理，请重新连接")
            } else {
                data = try await request("local.create", ["cols": initialSize.0, "rows": initialSize.1, "cwd": session.cwd, "terminalEngine": false])
            }
            let response = try JSONDecoder().decode(CreatedSession.self, from: data)
            guard !isStopping else { return }
            guard !ignoredCoreIDs.contains(response.sessionId) else {
                throw CoreFailure(code: "STARTUP_OUTPUT_LIMIT", message: "启动输出超出暂存上限，会话已关闭，请重新连接")
            }
            session.coreID = response.sessionId
            session.cwd = response.cwd
            configureInput(session)
            session.state = .running
            session.status = "运行中"
            session.lastSentSize = initialSize
            if let events = pendingEvents.removeValue(forKey: response.sessionId) { consume(events) }
            if session.connection != nil, session.state == .running {
                let remote = RemoteWorkspace(sessionID: response.sessionId) { [weak self] method, params, lane in
                    guard let self else { throw CoreFailure(code: "CORE_STOPPED", message: "应用已停止") }
                    return try await remoteRequest(method, params, lane: lane)
                }
                session.remote = remote; remote.start()
            }
            resize(session)
            objectWillChange.send()
        } catch {
            session.state = .failed
            session.status = error.localizedDescription
            session.terminal.feed(text: "\r\n启动失败：\(error.localizedDescription)\r\n")
        }
    }

    func send(_ data: Data, to session: TerminalSession) {
        guard !isStopping, session.coreID != nil, session.state == .running else { return }
        session.inputQueue.enqueue(data)
    }

    private func configureInput(_ session: TerminalSession) {
        session.inputQueue.sender = { [weak self, weak session] data, completion in
            guard let self, !isStopping, let session, let id = session.coreID, session.state == .running else {
                completion(.failure(CoreFailure(code: "session_closed", message: "会话已关闭")))
                return
            }
            do {
                let json = try coreRequestJSON("sessions.input", ["sessionId": id, "data": data.base64EncodedString()])
                bridge.submit(json) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success: completion(.success(()))
                        case .failure(let error): completion(.failure(error as? CoreFailure ?? CoreFailure(code: "INPUT_ERROR", message: error.localizedDescription)))
                        }
                    }
                }
            } catch {
                completion(.failure(CoreFailure(code: "INVALID_REQUEST", message: error.localizedDescription)))
            }
        }
    }

    func resize(_ session: TerminalSession) {
        guard let id = session.coreID, session.state == .running else { return }
        let size = (session.columns, session.rows)
        guard session.lastSentSize?.0 != size.0 || session.lastSentSize?.1 != size.1 else { return }
        session.lastSentSize = size
        enqueue("sessions.resize", ["sessionId": id, "cols": size.0, "rows": size.1])
    }

    func close(_ session: TerminalSession) {
        guard !isStopping, sessions.contains(where: { $0 === session }), !isClosing(session) else { return }
        if session.state == .starting { return }
        if session.state == .running {
            let alert = NSAlert()
            alert.messageText = "关闭“\(session.title)”？"
            alert.informativeText = "此操作会结束 shell 及其中运行的任务。关闭独立窗口会保留会话。"
            alert.addButton(withTitle: "关闭会话")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        closingSessionIDs.insert(session.id)
        sshLaunches.removeValue(forKey: session.id)
        session.state = .closed
        session.inputQueue.shutdown()
        session.remote?.stop()
        Task {
            if let id = session.coreID { await perform("sessions.close", ["sessionId": id]) }
            if let id = session.coreID { ignoreCore(id); pendingEvents.removeValue(forKey: id) }
            windowCoordinator?.removeDetachedWindow(for: session)
            sessions.removeAll { $0.id == session.id }
            if selectedID == session.id { selectedID = sessions.last?.id }
            closingSessionIDs.remove(session.id)
        }
    }

    func detachSelected() {
        guard let selected else { return }
        windowCoordinator?.detach(selected)
    }

    func applyTheme() {
        let appearance: NSAppearance?
        switch theme {
        case .system: appearance = nil
        case .dark: appearance = NSAppearance(named: .darkAqua)
        case .light: appearance = NSAppearance(named: .aqua)
        }
        NSApp.appearance = appearance
        for session in sessions { applyTheme(to: session) }
    }

    func applyTheme(to session: TerminalSession) {
        let dark = theme == .dark || (theme == .system && NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
        session.terminal.nativeBackgroundColor = dark ? NSColor(calibratedRed: 0.055, green: 0.07, blue: 0.09, alpha: 1) : .textBackgroundColor
        session.terminal.nativeForegroundColor = dark ? NSColor(calibratedWhite: 0.9, alpha: 1) : .textColor
        session.terminal.needsDisplay = true
    }

    func stop() {
        isStopping = true
        for session in sessions { session.inputQueue.shutdown(); session.remote?.stop() }
        sshLaunches.removeAll()
        bridge.stop()
        pendingEvents.removeAll()
    }

    func beginStop(completion: @escaping @Sendable () -> Void) {
        isStopping = true
        for session in sessions { session.inputQueue.shutdown(); session.remote?.stop() }
        sshLaunches.removeAll(); pendingEvents.removeAll()
        bridge.stopAsync(completion: completion)
    }

    func remoteRequest(_ method: String, _ params: [String: Any], lane: CoreBridge.Lane) async throws -> Data {
        guard !isStopping else { throw CoreFailure(code: "CORE_STOPPED", message: "应用正在退出") }
        return try await bridge.request(coreRequestJSON(method, params), lane: lane)
    }

    private func request(_ method: String, _ params: [String: Any] = [:]) async throws -> Data {
        guard !isStopping else { throw CoreFailure(code: "CORE_STOPPED", message: "应用正在退出") }
        return try await bridge.request(coreRequestJSON(method, params))
    }

    private func perform(_ method: String, _ params: [String: Any]) async {
        do { _ = try await request(method, params) }
        catch { if !isStopping { errorMessage = error.localizedDescription } }
    }

    private func enqueue(_ method: String, _ params: [String: Any]) {
        guard !isStopping else { return }
        do {
            bridge.submit(try coreRequestJSON(method, params)) { [weak self] result in
                if case .failure(let error) = result {
                    Task { @MainActor [weak self] in
                        if self?.isStopping == false { self?.errorMessage = error.localizedDescription }
                    }
                }
            }
        } catch { errorMessage = error.localizedDescription }
    }

    private func consume(_ events: [CoreEvent]) {
        guard !isStopping else { return }
        for event in events {
            guard let id = event.sessionId else { if event.type == "error" { errorMessage = event.message }; continue }
            if event.type == "transfer" {
                sessions.first(where: { $0.coreID == id })?.remote?.consume(event)
                continue
            }
            guard !ignoredCoreIDs.contains(id) else { continue }
            guard let session = sessions.first(where: { $0.coreID == id }) else {
                // A shell can produce output before the create continuation reaches MainActor.
                if sessions.contains(where: { $0.state == .starting }), ["output", "closed", "error"].contains(event.type) {
                    let cost = (event.data?.utf8.count ?? 0) + 128
                    let perSession = pendingEvents[id, default: []].reduce(0) { $0 + ($1.data?.utf8.count ?? 0) + 128 }
                    let total = pendingEvents.values.flatMap { $0 }.reduce(0) { $0 + ($1.data?.utf8.count ?? 0) + 128 }
                    if perSession + cost <= 512 * 1024, total + cost <= 2 * 1024 * 1024,
                       pendingEvents[id, default: []].count < 512 {
                        pendingEvents[id, default: []].append(event)
                    } else {
                        ignoreCore(id); pendingEvents.removeValue(forKey: id)
                        enqueue("sessions.close", ["sessionId": id])
                        errorMessage = "启动输出超出暂存上限，会话已关闭，请重试。"
                    }
                }
                continue
            }
            switch event.type {
            case "output":
                if let encoded = event.data, let data = Data(base64Encoded: encoded) { session.terminal.feed(byteArray: Array(data)[...]) }
            case "closed":
                session.state = .closed
                session.inputQueue.shutdown()
                session.remote?.stop()
                ignoreCore(id)
                if let code = event.exitCode { session.status = "已退出（\(code)）" }
                else { session.status = session.connection != nil ? "连接已断开（服务器未返回退出码）" : "已退出（未知退出码）" }
                objectWillChange.send()
            case "error": session.status = event.message ?? "会话出错"
            default: break
            }
        }
    }

    private struct CreatedSession: Decodable { let sessionId: String; let cwd: String }
}
