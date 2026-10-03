import XCTest
@testable import SSHDockMacOS

private final class FakeSecrets: SecretStoring {
    var values: [String: String] = [:]
    var fail = false
    func loadSecret(connectionID: UUID, kind: String) throws -> String? { values["\(connectionID):\(kind)"] }
    func saveSecret(value: String?, connectionID: UUID, kind: String) throws {
        if fail { throw CoreFailure(code: "KEYCHAIN_ERROR", message: "denied") }
        values["\(connectionID):\(kind)"] = value
    }
}

final class ConnectionRepositoryTests: XCTestCase {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("SSHDockMacTests-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    @MainActor
    func testMetadataRoundTripKeepsCredentialsOutOfJSONAndHonorsKeychainFailure() throws {
        let root = try temporary(); defer { try? FileManager.default.removeItem(at: root) }
        let secrets = FakeSecrets()
        let repository = ConnectionRepository(directory: root, secrets: secrets)
        var connection = SSHConnection(); connection.name = "中文服务器"; connection.host = "example.test"; connection.rememberSecret = true
        try repository.save(connection, secret: "never-write-this-password")
        let file = root.appendingPathComponent("connections.json")
        let bytes = try Data(contentsOf: file)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("never-write-this-password"))
        let reopened = ConnectionRepository(directory: root, secrets: secrets)
        XCTAssertEqual(reopened.connections, [connection])
        XCTAssertEqual(try reopened.secret(for: connection), "never-write-this-password")
        secrets.fail = true; connection.name = "should-not-save"
        XCTAssertThrowsError(try repository.save(connection, secret: "other"))
        XCTAssertEqual(try Data(contentsOf: file), bytes, "No plaintext fallback or metadata overwrite on Keychain failure")
        secrets.fail = false; try reopened.delete(reopened.connections[0])
        XCTAssertTrue(reopened.connections.isEmpty)
        XCTAssertTrue(secrets.values.isEmpty)
    }
    @MainActor
    func testAutomaticLegacyImportPreservesIDDiscardsAllSecretsAndDoesNotRepeat() throws {
        let root = try temporary(); defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("legacy.json")
        let id = UUID()
        let data = try JSONSerialization.data(withJSONObject: [["id": id.uuidString, "name": "旧连接", "host": "legacy.test", "port": 2222, "username": "tester", "authType": "password", "password": "OLD-PLAIN", "passwordEncoding": "plain", "passphrase": "OLD-CIPHER", "passphraseEncoding": "safeStorage"]])
        try data.write(to: legacy)
        let secrets = FakeSecrets()
        let directory = root.appendingPathComponent("native")
        let repository = ConnectionRepository(directory: directory, secrets: secrets, legacyFile: legacy)
        XCTAssertEqual(repository.connections.map(\.id), [id])
        XCTAssertFalse(repository.connections[0].rememberSecret)
        XCTAssertTrue(secrets.values.isEmpty)
        XCTAssertNotNil(repository.migrationNotice)
        let json = String(decoding: try Data(contentsOf: directory.appendingPathComponent("connections.json")), as: UTF8.self)
        XCTAssertFalse(json.contains("OLD-PLAIN")); XCTAssertFalse(json.contains("OLD-CIPHER"))
        XCTAssertEqual(try Data(contentsOf: legacy), data)
        try repository.delete(repository.connections[0])
        XCTAssertTrue(ConnectionRepository(directory: directory, secrets: secrets, legacyFile: legacy).connections.isEmpty,
                      "Deleting imported metadata must not cause it to be reimported on restart")
    }
    @MainActor
    func testTrustRejectsChangedFingerprintUntilExplicitReset() throws {
        let root = try temporary(); defer { try? FileManager.default.removeItem(at: root) }
        let repository = ConnectionRepository(directory: root, secrets: FakeSecrets())
        var connection = SSHConnection(); connection.host = "host.test"
        let old = HostIdentity(fingerprint: "SHA256:old", algorithm: "ssh-ed25519")
        let new = HostIdentity(fingerprint: "SHA256:new", algorithm: "ssh-ed25519")
        XCTAssertEqual(repository.trust(for: connection, identity: old), .unknown)
        try repository.trustNewHost(connection, identity: old)
        XCTAssertEqual(repository.trust(for: connection, identity: old), .match)
        XCTAssertEqual(repository.trust(for: connection, identity: new), .mismatch(old))
        XCTAssertThrowsError(try repository.trustNewHost(connection, identity: new))
        XCTAssertEqual(repository.trust(for: connection, identity: old), .match)
        try repository.forgetHost(connection)
        try repository.trustNewHost(connection, identity: new)
        XCTAssertEqual(repository.trust(for: connection, identity: new), .match)
    }
    @MainActor
    func testInvalidNativeJSONCannotBeOverwrittenBySaveOrLegacyImport() throws {
        let root = try temporary(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("connections.json")
        let invalid = Data("broken-json".utf8); try invalid.write(to: file)
        let repository = ConnectionRepository(directory: root, secrets: FakeSecrets())
        XCTAssertNotNil(repository.loadError)
        var connection = SSHConnection(); connection.host = "example.test"
        XCTAssertThrowsError(try repository.save(connection, secret: "secret"))
        XCTAssertThrowsError(try repository.importElectronMetadata(Data("[]".utf8)))
        XCTAssertEqual(try Data(contentsOf: file), invalid)
    }
    func testLinuxMetricsRequireTwoCPUSamplesAndHandleCounterReset() {
        let previous = LinuxSample(supported: true, cpuTotal: 100, cpuIdle: 40, memTotal: 1000, memAvailable: 600, rx: 1000, tx: 100, load1: 1)
        let current = LinuxSample(supported: true, cpuTotal: 200, cpuIdle: 65, memTotal: 1000, memAvailable: 250, rx: 1800, tx: 300, load1: 2)
        let result = LinuxMetrics.calculate(previous: previous, current: current, seconds: 2)
        XCTAssertEqual(result.cpu, 0.75); XCTAssertEqual(result.memory, 0.75)
        XCTAssertEqual(result.rxPerSecond, 400); XCTAssertEqual(result.txPerSecond, 100)
        XCTAssertNil(LinuxMetrics.calculate(previous: nil, current: current, seconds: 0).cpu)
        XCTAssertNil(LinuxMetrics.calculate(previous: current, current: previous, seconds: 2).rxPerSecond)
    }
    @MainActor
    func testNewLocalTerminalNeverUsesRemoteDirectory() throws {
        let root = try temporary(); defer { try? FileManager.default.removeItem(at: root) }
        let store = SessionStore(connections: ConnectionRepository(directory: root, secrets: FakeSecrets()))
        store.newSession()
        let remote = try XCTUnwrap(store.selected); remote.state = .closed; remote.connection = SSHConnection(); remote.cwd = "/remote-only-path"
        store.newSession()
        XCTAssertEqual(store.selected?.cwd, FileManager.default.homeDirectoryForCurrentUser.path)
        store.selected?.state = .closed
    }
}
