import Foundation
import Combine
import AppKit

struct RemoteEntry: Decodable, Identifiable {
    var id: String { path }
    let name: String
    let path: String
    let isDirectory: Bool
    let isSymlink: Bool
    let size: UInt64
    let modified: UInt64?
}

struct RemoteTransfer: Identifiable {
    let id: String
    let title: String
    var transferred: UInt64 = 0
    var total: UInt64 = 0
    var state = "running"
    var message: String?
    var fraction: Double { total > 0 ? min(1, Double(transferred) / Double(total)) : 0 }
}

struct LinuxSample: Decodable {
    let supported: Bool
    let cpuTotal: UInt64?
    let cpuIdle: UInt64?
    let memTotal: UInt64?
    let memAvailable: UInt64?
    let rx: UInt64?
    let tx: UInt64?
    let load1: Double?
}

struct LinuxMetrics: Equatable {
    let cpu: Double?
    let memory: Double?
    let rxPerSecond: Double?
    let txPerSecond: Double?
    let load1: Double?
    static func calculate(previous: LinuxSample?, current: LinuxSample, seconds: Double) -> LinuxMetrics {
        func rate(_ before: UInt64?, _ after: UInt64?) -> Double? {
            guard let before, let after, after >= before, seconds > 0 else { return nil }
            return Double(after - before) / seconds
        }
        var cpu: Double?
        if let oldTotal = previous?.cpuTotal, let total = current.cpuTotal, total > oldTotal,
           let oldIdle = previous?.cpuIdle, let idle = current.cpuIdle, idle >= oldIdle {
            cpu = max(0, min(1, 1 - Double(idle - oldIdle) / Double(total - oldTotal)))
        }
        var memory: Double?
        if let total = current.memTotal, let available = current.memAvailable, total > 0, available <= total {
            memory = Double(total - available) / Double(total)
        }
        return LinuxMetrics(cpu: cpu, memory: memory, rxPerSecond: rate(previous?.rx, current.rx),
                            txPerSecond: rate(previous?.tx, current.tx), load1: current.load1)
    }
}

@MainActor
final class RemoteWorkspace: ObservableObject {
    typealias Request = (String, [String: Any], CoreBridge.Lane) async throws -> Data
    @Published var path = ""
    @Published private(set) var entries: [RemoteEntry] = []
    @Published private(set) var busy = false
    @Published private(set) var transfers: [RemoteTransfer] = []
    @Published var error: String?
    @Published var statsEnabled = true { didSet { updateStatsTask() } }
    @Published private(set) var statsStatus = "正在获取 Linux 统计…"
    @Published private(set) var metrics: LinuxMetrics?
    let sessionID: String
    var isClosed: Bool { stopped }
    private let request: Request
    private var stopped = false
    private var statsTask: Task<Void, Never>?
    private var previousSample: LinuxSample?
    private var previousTime: TimeInterval?
    private var statsInFlight = false

    init(sessionID: String, request: @escaping Request) {
        self.sessionID = sessionID; self.request = request
    }
    func start() {
        Task {
            do {
                let bytes = try await call("sftp.home")
                let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
                guard !stopped else { return }
                path = object?["path"] as? String ?? "."
                await refresh()
            } catch { if !stopped { self.error = error.localizedDescription } }
        }
        updateStatsTask()
    }
    func stop() {
        stopped = true; statsTask?.cancel(); statsTask = nil
        statsStatus = "连接已关闭"
    }
    private func call(_ method: String, _ params: [String: Any] = [:], lane: CoreBridge.Lane = .files) async throws -> Data {
        guard !stopped else { throw CoreFailure(code: "session_closed", message: "远程会话已关闭") }
        var fields = params; fields["sessionId"] = sessionID
        return try await request(method, fields, lane)
    }
    func refresh() async {
        guard !busy, !stopped else { return }
        busy = true; defer { busy = false }
        do {
            let result = try JSONDecoder().decode(Listing.self, from: await call("sftp.list", ["path": path]))
            guard !stopped else { return }
            path = result.path
            entries = result.entries.sorted { ($0.isDirectory != $1.isDirectory) ? $0.isDirectory : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        } catch { if !stopped { self.error = error.localizedDescription } }
    }
    func navigate(_ newPath: String) {
        guard !busy else { return }; path = newPath; Task { await refresh() }
    }
    func parent() { navigate((path as NSString).deletingLastPathComponent.isEmpty ? "/" : (path as NSString).deletingLastPathComponent) }
    private func remotePath(_ name: String) -> String { path.hasSuffix("/") ? path + name : path + "/" + name }
    func createDirectory() {
        let alert = NSAlert(); alert.messageText = "创建远程目录"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); field.placeholderString = "目录名"
        alert.accessoryView = field; alert.addButton(withTitle: "创建"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let name = field.stringValue
        guard !name.isEmpty, ![".", ".."].contains(name), !name.contains("/"), !name.contains("\0") else {
            error = "请输入单个有效目录名"; return
        }
        performMutation("sftp.mkdir", path: remotePath(name))
    }
    func remove(_ entry: RemoteEntry) {
        guard confirm("删除远程“\(entry.name)”？", detail: entry.isDirectory && !entry.isSymlink ? "将递归删除目录内容，此操作无法撤回。" : "此操作无法撤回。", action: "删除") else { return }
        performMutation("sftp.remove", path: entry.path)
    }
    private func performMutation(_ method: String, path: String) {
        guard !busy else { return }
        Task {
            busy = true
            do { _ = try await call(method, ["path": path]) } catch { self.error = error.localizedDescription }
            busy = false; await refresh()
        }
    }
    func upload() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
        panel.message = "选择上传的文件或目录"
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        Task {
            for url in urls {
                guard !stopped else { break }
                if entries.contains(where: { $0.name == url.lastPathComponent }),
                   !confirm("覆盖远程“\(url.lastPathComponent)”？", detail: "同名文件将被覆盖，目录内容可能合并。", action: "继续上传") { continue }
                await transfer(method: "sftp.upload", local: url.path, remote: remotePath(url.lastPathComponent), title: "上传 \(url.lastPathComponent)")
            }
            await refresh()
        }
    }
    func download(_ entry: RemoteEntry) {
        guard !busy else { return }
        guard !entry.name.isEmpty, ![".", ".."].contains(entry.name),
              !entry.name.contains("/"), !entry.name.contains("\\"), !entry.name.contains("\0") else {
            error = "远端文件名不能用于本地下载目标"; return
        }
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true
        panel.message = "选择下载保存目录"
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        let target = folder.appendingPathComponent(entry.name)
        if FileManager.default.fileExists(atPath: target.path),
           !confirm("覆盖本地“\(entry.name)”？", detail: "同名文件将被覆盖，目录内容可能合并。", action: "继续下载") { return }
        Task { await transfer(method: "sftp.download", local: target.path, remote: entry.path, title: "下载 \(entry.name)") }
    }
    func transfer(method: String, local: String, remote: String, title: String) async {
        guard !busy, !stopped else { return }
        busy = true; defer { busy = false }
        let id = UUID().uuidString
        transfers.removeAll { $0.state != "running" }
        transfers.append(RemoteTransfer(id: id, title: title))
        do {
            let receipt = try JSONDecoder().decode(TransferReceipt.self, from: await call(method, ["localPath": local, "remotePath": remote, "transferId": id]))
            if let index = transfers.firstIndex(where: { $0.id == id }) {
                transfers[index].transferred = receipt.transferred
                transfers[index].total = receipt.total
                transfers[index].state = "completed"
            }
        } catch {
            if let index = transfers.firstIndex(where: { $0.id == id }) {
                transfers[index].state = "failed"; transfers[index].message = error.localizedDescription
            }
        }
    }
    func cancel(_ transfer: RemoteTransfer) {
        Task {
            do { _ = try await call("sftp.cancel", ["transferId": transfer.id], lane: .terminal) }
            catch { self.error = error.localizedDescription }
        }
    }
    func consume(_ event: CoreEvent) {
        guard let id = event.transferId, let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        // A request completion may reach MainActor before an older poll batch.
        // Never let late progress revive a cancelled/completed transfer.
        guard transfers[index].state == "running" else { return }
        transfers[index].transferred = max(event.transferred ?? 0, transfers[index].transferred)
        transfers[index].total = event.total ?? transfers[index].total
        transfers[index].state = event.state ?? transfers[index].state
        transfers[index].message = event.message
    }
    private func updateStatsTask() {
        statsTask?.cancel(); statsTask = nil
        guard statsEnabled, !stopped else { statsStatus = stopped ? "连接已关闭" : "统计已暂停"; return }
        previousSample = nil; previousTime = nil
        statsTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !stopped else { return }
                await sampleStats()
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
    private func sampleStats() async {
        guard !statsInFlight else { return }
        statsInFlight = true; defer { statsInFlight = false }
        do {
            let value = try JSONDecoder().decode(LinuxSample.self, from: await call("stats.sample", lane: .statistics))
            guard !stopped, statsEnabled, !Task.isCancelled else { return }
            guard value.supported else { statsStatus = "该服务器不支持 Linux /proc 统计"; statsTask?.cancel(); return }
            let now = ProcessInfo.processInfo.systemUptime
            metrics = LinuxMetrics.calculate(previous: previousSample, current: value, seconds: now - (previousTime ?? now))
            previousSample = value; previousTime = now; statsStatus = "Linux · 每 3 秒采样"
        } catch { if !stopped, !Task.isCancelled { statsStatus = "统计暂不可用：\(error.localizedDescription)" } }
    }
    private func confirm(_ title: String, detail: String, action: String) -> Bool {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: action); alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }
    private struct Listing: Decodable { let path: String; let entries: [RemoteEntry] }
    private struct TransferReceipt: Decodable { let transferred: UInt64; let total: UInt64 }
}
