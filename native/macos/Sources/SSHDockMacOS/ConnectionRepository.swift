import Foundation
import Combine
import Security

struct SSHConnection: Codable, Identifiable, Equatable {
    enum Authentication: String, Codable, CaseIterable { case password, key }
    var id = UUID()
    var name = ""
    var host = ""
    var port = 22
    var username = NSUserName()
    var authType: Authentication = .password
    var keyPath = ""
    var rememberSecret = false

    func validated() throws -> SSHConnection {
        var value = self
        value.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        value.username = username.trimmingCharacters(in: .whitespacesAndNewlines)
        value.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.host.isEmpty, !value.username.isEmpty, (1...65535).contains(port) else {
            throw CoreFailure(code: "INVALID_CONNECTION", message: "请输入主机、用户名及 1–65535 之间的端口")
        }
        if value.name.isEmpty { value.name = "\(value.username)@\(value.host)" }
        if authType == .key && keyPath.isEmpty { throw CoreFailure(code: "INVALID_KEY", message: "请选择私钥文件") }
        return value
    }
}

struct HostIdentity: Codable, Equatable {
    let fingerprint: String
    let algorithm: String
}

enum HostTrust: Equatable { case unknown, match, mismatch(HostIdentity) }

protocol SecretStoring {
    func loadSecret(connectionID: UUID, kind: String) throws -> String?
    func saveSecret(value: String?, connectionID: UUID, kind: String) throws
}

final class KeychainSecrets: SecretStoring {
    private let service = "com.sshdock.native.prototype.credentials"
    private func query(_ id: UUID, _ kind: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "\(id.uuidString):\(kind)"]
    }
    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            throw CoreFailure(code: "KEYCHAIN_ERROR", message: "钥匙串操作失败：\(SecCopyErrorMessageString(status, nil) as String? ?? String(status))")
        }
    }
    func loadSecret(connectionID: UUID, kind: String) throws -> String? {
        var attributes = query(connectionID, kind)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let bytes = item as? Data, let value = String(data: bytes, encoding: .utf8) else {
            throw CoreFailure(code: "KEYCHAIN_ERROR", message: "钥匙串凭据格式无效")
        }
        return value
    }
    func saveSecret(value: String?, connectionID: UUID, kind: String) throws {
        let attributes = query(connectionID, kind)
        guard let value else {
            let status = SecItemDelete(attributes as CFDictionary)
            if status != errSecItemNotFound { try check(status) }
            return
        }
        let update = [kSecValueData as String: Data(value.utf8)]
        let status = SecItemUpdate(attributes as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = attributes.merging(update) { _, next in next }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            try check(SecItemAdd(item as CFDictionary, nil))
        } else { try check(status) }
    }
}

@MainActor
final class ConnectionRepository: ObservableObject {
    @Published private(set) var connections: [SSHConnection] = []
    @Published private(set) var knownHosts: [String: HostIdentity] = [:]
    @Published private(set) var loadError: String?
    @Published private(set) var migrationNotice: String?
    private let file: URL
    private let secrets: SecretStoring
    private var migrationCompleted = false
    private struct Document: Codable { let connections: [SSHConnection]; let knownHosts: [String: HostIdentity]; let migrationCompleted: Bool? }

    init(directory: URL? = nil, secrets: SecretStoring = KeychainSecrets(), legacyFile: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SSHDockNative", isDirectory: true)
        file = root.appendingPathComponent("connections.json")
        self.secrets = secrets
        do {
            if FileManager.default.fileExists(atPath: file.path) {
                let document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: file))
                connections = document.connections
                knownHosts = document.knownHosts
                migrationCompleted = document.migrationCompleted ?? false
            }
        } catch { loadError = "读取原生连接配置失败，已阻止覆盖：\(error.localizedDescription)" }
        if (directory == nil || legacyFile != nil), connections.isEmpty, !migrationCompleted, loadError == nil {
            // Electron's packaged productName is SSHDock; development name is sshdock.
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            let legacy = legacyFile.map { [$0] } ?? ["SSHDock", "sshdock"].map { support.appendingPathComponent($0).appendingPathComponent("connections.json") }
            if let source = legacy.first(where: { FileManager.default.fileExists(atPath: $0.path) }) {
                do {
                    migrationCompleted = true
                    let count = try importElectronMetadata(Data(contentsOf: source))
                    migrationNotice = "已导入 \(count) 个旧连接。密码和私钥口令未迁移，请重新输入；旧文件保持不变。"
                } catch { migrationCompleted = false; migrationNotice = "旧连接导入失败：\(error.localizedDescription)。可从文件重新导入，旧文件保持不变。" }
            }
        }
    }
    private func persist(_ profiles: [SSHConnection], _ hosts: [String: HostIdentity]) throws {
        if let loadError { throw CoreFailure(code: "CONFIG_READ_FAILED", message: loadError) }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(Document(connections: profiles, knownHosts: hosts, migrationCompleted: migrationCompleted)).write(to: file, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        connections = profiles; knownHosts = hosts
    }
    func save(_ profile: SSHConnection, secret: String) throws {
        let value = try profile.validated()
        if let loadError { throw CoreFailure(code: "CONFIG_READ_FAILED", message: loadError) }
        try secrets.saveSecret(value: value.rememberSecret ? secret : nil, connectionID: value.id, kind: value.authType.rawValue)
        try secrets.saveSecret(value: nil, connectionID: value.id, kind: value.authType == .password ? "key" : "password")
        var profiles = connections
        if let index = profiles.firstIndex(where: { $0.id == value.id }) { profiles[index] = value } else { profiles.append(value) }
        try persist(profiles, knownHosts)
    }
    func secret(for profile: SSHConnection) throws -> String {
        try secrets.loadSecret(connectionID: profile.id, kind: profile.authType.rawValue) ?? ""
    }
    func delete(_ profile: SSHConnection) throws {
        if let loadError { throw CoreFailure(code: "CONFIG_READ_FAILED", message: loadError) }
        try secrets.saveSecret(value: nil, connectionID: profile.id, kind: "password")
        try secrets.saveSecret(value: nil, connectionID: profile.id, kind: "key")
        try persist(connections.filter { $0.id != profile.id }, knownHosts)
    }
    private func hostKey(_ profile: SSHConnection) -> String { "\(profile.host.lowercased()):\(profile.port)" }
    func trust(for profile: SSHConnection, identity: HostIdentity) -> HostTrust {
        guard let saved = knownHosts[hostKey(profile)] else { return .unknown }
        return saved == identity ? .match : .mismatch(saved)
    }
    func trustNewHost(_ profile: SSHConnection, identity: HostIdentity) throws {
        if case .mismatch = trust(for: profile, identity: identity) {
            throw CoreFailure(code: "HOST_KEY_MISMATCH", message: "主机密钥已变化；请核实后显式重置旧信任，再重新连接")
        }
        var hosts = knownHosts; hosts[hostKey(profile)] = identity
        try persist(connections, hosts)
    }
    func forgetHost(_ profile: SSHConnection) throws {
        var hosts = knownHosts; hosts.removeValue(forKey: hostKey(profile))
        try persist(connections, hosts)
    }
    func importElectronMetadata(_ data: Data) throws -> Int {
        // The old schema is an array. Only whitelisted non-sensitive fields are read.
        guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw CoreFailure(code: "INVALID_IMPORT", message: "请选择旧版 connections.json 数组文件")
        }
        var profiles = connections
        for row in rows {
            var profile = SSHConnection()
            profile.id = UUID(uuidString: row["id"] as? String ?? "") ?? UUID()
            profile.name = row["name"] as? String ?? ""
            profile.host = row["host"] as? String ?? ""
            profile.port = row["port"] as? Int ?? Int(row["port"] as? String ?? "") ?? 22
            profile.username = row["username"] as? String ?? ""
            profile.authType = row["authType"] as? String == "key" ? .key : .password
            profile.keyPath = row["keyPath"] as? String ?? ""
            profile = try profile.validated()
            // Avoid overwriting a saved connection or its Keychain account.
            if profiles.contains(where: { $0.id == profile.id }) { profile.id = UUID() }
            profiles.append(profile)
        }
        try persist(profiles, knownHosts)
        return rows.count
    }
}
