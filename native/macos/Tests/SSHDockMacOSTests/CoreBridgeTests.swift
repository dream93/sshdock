import XCTest
@testable import SSHDockMacOS

private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var output = Data()
    private var exitCode: Int?
    let closed: XCTestExpectation

    init(closed: XCTestExpectation) { self.closed = closed }
    func receive(_ events: [CoreEvent]) {
        lock.lock()
        defer { lock.unlock() }
        for event in events {
            if event.type == "output", let data = event.data.flatMap({ Data(base64Encoded: $0) }) { output.append(data) }
            if event.type == "closed" { exitCode = event.exitCode; closed.fulfill() }
        }
    }
    func snapshot() -> (Data, Int?) {
        lock.lock()
        defer { lock.unlock() }
        return (output, exitCode)
    }
}

final class CoreBridgeTests: XCTestCase {
    func testRealPTYRawBytesResizeAndNaturalExit() async throws {
        let recorder = EventRecorder(closed: expectation(description: "PTY exited"))
        let bridge = CoreBridge { recorder.receive($0) }
        defer { bridge.stop() }
        let created = try await bridge.request(coreRequestJSON("local.create", ["cols": 80, "rows": 24, "cwd": "/tmp", "shell": "/bin/sh", "terminalEngine": false]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: created) as? [String: Any])
        let id = try XCTUnwrap(object["sessionId"] as? String)
        _ = try await bridge.request(coreRequestJSON("sessions.resize", ["sessionId": id, "cols": 91, "rows": 31]))
        let command = Data("printf '\\377\\376SSHDock_RAW\\n'; stty size; exit 7\n".utf8)
        _ = try await bridge.request(coreRequestJSON("sessions.input", ["sessionId": id, "data": command.base64EncodedString()]))
        await fulfillment(of: [recorder.closed], timeout: 10)
        let (output, code) = recorder.snapshot()
        XCTAssertNotNil(output.range(of: Data([0xff, 0xfe] + Array("SSHDock_RAW".utf8))), "FFI must preserve invalid UTF-8 terminal bytes")
        XCTAssertNotNil(output.range(of: Data("31 91".utf8)), "stty must observe the requested PTY dimensions")
        XCTAssertEqual(code, 7)
    }

    func testFIFOInputAndExplicitSessionClose() async throws {
        let recorder = EventRecorder(closed: expectation(description: "PTY closed"))
        let bridge = CoreBridge { recorder.receive($0) }
        defer { bridge.stop() }
        let data = try await bridge.request(coreRequestJSON("local.create", ["cols": 80, "rows": 24, "cwd": "/tmp", "shell": "/bin/sh", "terminalEngine": false]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let id = try XCTUnwrap(object["sessionId"] as? String)
        for fragment in ["printf '\\377", "\\376SSHDock_", "FIFO\\n'\n"] {
            bridge.submit(try coreRequestJSON("sessions.input", ["sessionId": id, "data": Data(fragment.utf8).base64EncodedString()]))
        }
        // A barrier request must finish after all three input submissions.
        _ = try await bridge.request(coreRequestJSON("sessions.list"))
        let deadline = Date().addingTimeInterval(5)
        while recorder.snapshot().0.range(of: Data([0xff, 0xfe] + Array("SSHDock_FIFO".utf8))) == nil && Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertNotNil(recorder.snapshot().0.range(of: Data([0xff, 0xfe] + Array("SSHDock_FIFO".utf8))))
        _ = try await bridge.request(coreRequestJSON("sessions.close", ["sessionId": id]))
        await fulfillment(of: [recorder.closed], timeout: 10)
        bridge.stop()
        do {
            _ = try await bridge.request(coreRequestJSON("sessions.list"))
            XCTFail("A destroyed core must reject new requests")
        } catch let error as CoreFailure { XCTAssertEqual(error.code, "CORE_STOPPED") }
    }
}
