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
    @Published var theme: TerminalTheme {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: "native.theme")
            applyTheme()
        }
    }
    var windowCoordinator: WindowCoordinator?
    private var nextNumber = 0
    private var pendingEvents: [String: [CoreEvent]] = [:]
    private var isStopping = false
    private lazy var bridge = CoreBridge(deliverEvents: { [weak self] events, consumed in
        // Dispatch FIFO is deliberate: unstructured MainActor tasks may run
        // in another order, corrupting an ANSI/UTF-8 stream between poll batches.
        DispatchQueue.main.async { [weak self] in self?.consume(events); consumed() }
    })

    init() {
        theme = TerminalTheme(rawValue: UserDefaults.standard.string(forKey: "native.theme") ?? "system") ?? .system
    }

    var selected: TerminalSession? { sessions.first { $0.id == selectedID } }
    var runningCount: Int { sessions.filter { $0.state == .running || $0.state == .starting }.count }

    func newSession() {
        nextNumber += 1
        let session = TerminalSession(title: "终端 \(nextNumber)", cwd: selected?.cwd ?? FileManager.default.homeDirectoryForCurrentUser.path, store: self)
        sessions.append(session)
        selectedID = session.id
        applyTheme(to: session)
    }

    func select(_ session: TerminalSession) {
        selectedID = session.id
        if session.detached { windowCoordinator?.focusDetached(session) }
        else { DispatchQueue.main.async { session.terminal.window?.makeFirstResponder(session.terminal) } }
    }

    func start(_ session: TerminalSession) async {
        do {
            let initialSize = (session.columns, session.rows)
            let data = try await request("local.create", ["cols": initialSize.0, "rows": initialSize.1, "cwd": session.cwd, "terminalEngine": false])
            let response = try JSONDecoder().decode(CreatedSession.self, from: data)
            session.coreID = response.sessionId
            session.cwd = response.cwd
            configureInput(session)
            session.state = .running
            session.status = "运行中"
            session.lastSentSize = initialSize
            if let events = pendingEvents.removeValue(forKey: response.sessionId) { consume(events) }
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
        if session.state == .starting { return }
        if session.state == .running {
            let alert = NSAlert()
            alert.messageText = "关闭“\(session.title)”？"
            alert.informativeText = "此操作会结束 shell 及其中运行的任务。关闭独立窗口会保留会话。"
            alert.addButton(withTitle: "关闭会话")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        session.state = .closed
        session.inputQueue.shutdown()
        Task {
            if let id = session.coreID { await perform("sessions.close", ["sessionId": id]) }
            windowCoordinator?.closeDetached(session)
            sessions.removeAll { $0.id == session.id }
            if selectedID == session.id { selectedID = sessions.last?.id }
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
        for session in sessions { session.inputQueue.shutdown() }
        bridge.stop()
        pendingEvents.removeAll()
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
            guard let session = sessions.first(where: { $0.coreID == id }) else {
                // A shell can produce output before the create continuation reaches MainActor.
                if sessions.contains(where: { $0.state == .starting }) { pendingEvents[id, default: []].append(event) }
                continue
            }
            switch event.type {
            case "output":
                if let encoded = event.data, let data = Data(base64Encoded: encoded) { session.terminal.feed(byteArray: Array(data)[...]) }
            case "closed":
                session.state = .closed
                session.inputQueue.shutdown()
                session.status = "已退出（\(event.exitCode ?? 0)）"
                objectWillChange.send()
            case "error": session.status = event.message ?? "会话出错"
            default: break
            }
        }
    }

    private struct CreatedSession: Decodable { let sessionId: String; let cwd: String }
}
