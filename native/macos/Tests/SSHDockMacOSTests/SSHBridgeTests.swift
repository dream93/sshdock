import XCTest
@testable import SSHDockMacOS

private final class SSHEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var output = Data()
    private var code: Int?
    private var transferCount = 0
    private var marked = false
    let marker: XCTestExpectation
    let closed: XCTestExpectation
    init(marker: XCTestExpectation, closed: XCTestExpectation) { self.marker = marker; self.closed = closed }
    func receive(_ events: [CoreEvent]) {
        lock.lock(); defer { lock.unlock() }
        for event in events {
            if event.type == "output", let data = event.data.flatMap({ Data(base64Encoded: $0) }) {
                output.append(data)
                if !marked, output.range(of: Data("SSHDock_SWIFT_REMOTE".utf8)) != nil { marked = true; marker.fulfill() }
            }
            if event.type == "transfer" { transferCount += 1 }
            if event.type == "closed", code == nil { code = event.exitCode; closed.fulfill() }
        }
    }
    func snapshot() -> (Data, Int?, Int) { lock.lock(); defer { lock.unlock() }; return (output, code, transferCount) }
}

final class SSHBridgeTests: XCTestCase {
    func testShutdownCancelsAnActiveFileLaneBeforeReleasingHandle() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let host = environment["SSHDOCK_TEST_SSH_HOST"], let portText = environment["SSHDOCK_TEST_SSH_PORT"],
              let port = Int(portText), let username = environment["SSHDOCK_TEST_SSH_USERNAME"],
              let key = environment["SSHDOCK_TEST_SSH_KEY"] else { throw XCTSkip("Set SSHDOCK_TEST_SSH_* to an isolated OpenSSH fixture") }
        let started = expectation(description: "Transfer started")
        started.assertForOverFulfill = false
        let bridge = CoreBridge { events in
            if events.contains(where: { $0.type == "transfer" && $0.state == "running" }) { started.fulfill() }
        }
        defer { bridge.stop() }
        let identity = try JSONDecoder().decode(HostIdentity.self, from: await bridge.request(coreRequestJSON("ssh.hostKey", ["host": host, "port": port]), lane: .control))
        let auth: [String: Any] = ["host": host, "port": port, "username": username, "authType": "key", "keyPath": key,
            "passphrase": environment["SSHDOCK_TEST_SSH_PASSPHRASE"] ?? "", "expectedFingerprint": identity.fingerprint,
            "cols": 80, "rows": 24, "terminalEngine": false]
        let created = try await bridge.request(coreRequestJSON("ssh.connect", auth), lane: .control)
        let id = try XCTUnwrap((JSONSerialization.jsonObject(with: created) as? [String: Any])?["sessionId"] as? String)
        let local = FileManager.default.temporaryDirectory.appendingPathComponent("SSHDockShutdown-\(UUID())")
        try Data(repeating: 0x3c, count: 64 * 1024 * 1024).write(to: local)
        defer { try? FileManager.default.removeItem(at: local) }
        let remote = "/tmp/SSHDockShutdown-\(UUID())"
        let transfer = Task { try await bridge.request(coreRequestJSON("sftp.upload", ["sessionId": id, "localPath": local.path, "remotePath": remote, "transferId": UUID().uuidString]), lane: .files) }
        await fulfillment(of: [started], timeout: 5)
        let stopped = expectation(description: "All lanes stopped")
        bridge.stopAsync { stopped.fulfill() }
        await fulfillment(of: [stopped], timeout: 5)
        _ = await transfer.result // The pending continuation must always be resumed.
        do { _ = try await bridge.request(coreRequestJSON("sessions.list")); XCTFail("Stopped handle cannot be reused") }
        catch let failure as CoreFailure { XCTAssertEqual(failure.code, "CORE_STOPPED") }

        // Cancellation intentionally leaves partial destinations; remove this fixture's file.
        let cleanup = CoreBridge(); defer { cleanup.stop() }
        let second = try await cleanup.request(coreRequestJSON("ssh.connect", auth), lane: .control)
        let secondID = try XCTUnwrap((JSONSerialization.jsonObject(with: second) as? [String: Any])?["sessionId"] as? String)
        _ = try await cleanup.request(coreRequestJSON("sftp.remove", ["sessionId": secondID, "path": remote]), lane: .files)
    }

    func testRealSSHRecursiveSFTPAndTerminalRemainIndependent() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let host = environment["SSHDOCK_TEST_SSH_HOST"], let portText = environment["SSHDOCK_TEST_SSH_PORT"],
              let port = Int(portText), let username = environment["SSHDOCK_TEST_SSH_USERNAME"],
              let key = environment["SSHDOCK_TEST_SSH_KEY"] else { throw XCTSkip("Set SSHDOCK_TEST_SSH_* to an isolated OpenSSH fixture") }
        let events = SSHEvents(marker: expectation(description: "Remote command executed"), closed: expectation(description: "Remote shell exited"))
        let bridge = CoreBridge { events.receive($0) }; defer { bridge.stop() }
        let identity = try JSONDecoder().decode(HostIdentity.self, from: await bridge.request(coreRequestJSON("ssh.hostKey", ["host": host, "port": port]), lane: .control))
        var parameters: [String: Any] = ["host": host, "port": port, "username": username, "authType": "key", "keyPath": key,
            "passphrase": environment["SSHDOCK_TEST_SSH_PASSPHRASE"] ?? "", "expectedFingerprint": "SHA256:incorrect",
            "cols": 80, "rows": 24, "terminalEngine": false]
        do { _ = try await bridge.request(coreRequestJSON("ssh.connect", parameters), lane: .control); XCTFail("Changed key must be rejected") }
        catch let failure as CoreFailure { XCTAssertEqual(failure.code, "host_key_mismatch") }
        parameters["expectedFingerprint"] = identity.fingerprint
        let created = try await bridge.request(coreRequestJSON("ssh.connect", parameters), lane: .control)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: created) as? [String: Any])
        let id = try XCTUnwrap(object["sessionId"] as? String)
        let home = try await bridge.request(coreRequestJSON("sftp.home", ["sessionId": id]), lane: .files)
        XCTAssertNotNil((try JSONSerialization.jsonObject(with: home) as? [String: Any])?["path"])

        let localRoot = FileManager.default.temporaryDirectory.appendingPathComponent("SSHDockSwiftSSH-\(UUID())")
        let source = localRoot.appendingPathComponent("source")
        let nested = source.appendingPathComponent("中文目录")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: localRoot) }
        let contents = Data(repeating: 0xa7, count: 4 * 1024 * 1024)
        try contents.write(to: nested.appendingPathComponent("字节.bin"))
        try Data().write(to: source.appendingPathComponent("empty.txt"))
        let remoteRoot = "/tmp/SSHDockSwiftSSH-\(UUID())"
        _ = try await bridge.request(coreRequestJSON("sftp.mkdir", ["sessionId": id, "path": remoteRoot]), lane: .files)
        async let upload = bridge.request(coreRequestJSON("sftp.upload", ["sessionId": id, "localPath": source.path, "remotePath": remoteRoot + "/tree", "transferId": UUID().uuidString]), lane: .files)
        _ = try await bridge.request(coreRequestJSON("sessions.resize", ["sessionId": id, "cols": 101, "rows": 33]))
        // Octal escapes prevent the command echo from satisfying the output assertion.
        let command = "printf '\\123\\123\\110\\104\\157\\143\\153\\137\\123\\127\\111\\106\\124\\137\\122\\105\\115\\117\\124\\105\\n'; stty size\n"
        _ = try await bridge.request(coreRequestJSON("sessions.input", ["sessionId": id, "data": Data(command.utf8).base64EncodedString()]))
        await fulfillment(of: [events.marker], timeout: 10)
        _ = try await upload
        let listing = try await bridge.request(coreRequestJSON("sftp.list", ["sessionId": id, "path": remoteRoot + "/tree"]), lane: .files)
        let rows = try XCTUnwrap((JSONSerialization.jsonObject(with: listing) as? [String: Any])?["entries"] as? [[String: Any]])
        XCTAssertTrue(rows.contains { $0["name"] as? String == "中文目录" })
        let download = localRoot.appendingPathComponent("download")
        _ = try await bridge.request(coreRequestJSON("sftp.download", ["sessionId": id, "remotePath": remoteRoot + "/tree", "localPath": download.path, "transferId": UUID().uuidString]), lane: .files)
        XCTAssertEqual(try Data(contentsOf: download.appendingPathComponent("中文目录/字节.bin")), contents)
        XCTAssertEqual(try Data(contentsOf: download.appendingPathComponent("empty.txt")).count, 0)
        _ = try JSONDecoder().decode(LinuxSample.self, from: await bridge.request(coreRequestJSON("stats.sample", ["sessionId": id]), lane: .statistics))
        _ = try await bridge.request(coreRequestJSON("sftp.remove", ["sessionId": id, "path": remoteRoot]), lane: .files)
        _ = try await bridge.request(coreRequestJSON("sessions.input", ["sessionId": id, "data": Data("exit 4\n".utf8).base64EncodedString()]))
        await fulfillment(of: [events.closed], timeout: 10)
        let snapshot = events.snapshot()
        XCTAssertNotNil(snapshot.0.range(of: Data("33 101".utf8)))
        XCTAssertEqual(snapshot.1, 4)
        XCTAssertGreaterThan(snapshot.2, 0)
    }
}
