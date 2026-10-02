import XCTest
@testable import SSHDockMacOS

@MainActor
private final class ControlledInputReceiver {
    var attempts: [Data] = []
    var accepted: [Data] = []
    var waiting: [(Data, SessionInputQueue.Completion)] = []
    func send(_ data: Data, completion: @escaping SessionInputQueue.Completion) {
        attempts.append(data)
        waiting.append((data, completion))
    }
    func complete(_ result: Result<Void, CoreFailure>) {
        let (data, completion) = waiting.removeFirst()
        if case .success = result { accepted.append(data) }
        completion(result)
    }
}

final class SessionInputQueueTests: XCTestCase {
    @MainActor
    func testBackpressureRetainsRejectedBytesAndOrdersLaterInput() async {
        let receiver = ControlledInputReceiver()
        let queue = SessionInputQueue(chunkBytes: 3, byteLimit: 128)
        queue.sender = { receiver.send($0, completion: $1) }
        let first = Data([0xff, 0xfe] + Array("中文".utf8))
        let later = Data("后续\0".utf8)
        XCTAssertTrue(queue.enqueue(first))
        let rejected = receiver.attempts[0]
        receiver.complete(.failure(CoreFailure(code: "INPUT_BACKPRESSURE", message: "full")))
        XCTAssertTrue(queue.enqueue(later))
        XCTAssertEqual(receiver.attempts.count, 1, "Later input must wait behind the rejected head")
        XCTAssertEqual(queue.pendingBytes, first.count + later.count)
        XCTAssertNotNil(queue.pauseReason)

        queue.retry()
        XCTAssertEqual(receiver.attempts[1], rejected, "Retry must resend the entire rejected chunk")
        while !receiver.waiting.isEmpty { receiver.complete(.success(())) }
        XCTAssertEqual(receiver.accepted.reduce(into: Data()) { $0.append($1) }, first + later)
        XCTAssertEqual(queue.pendingBytes, 0)
        XCTAssertNil(queue.pauseReason)
    }

    @MainActor
    func testOversizedPasteIsByteExactAndStaysWithinABIRequestLimit() async {
        let queue = SessionInputQueue()
        var accepted = Data()
        var largestRequest = 0
        queue.sender = { data, completion in
            accepted.append(data)
            largestRequest = max(largestRequest, data.count)
            completion(.success(()))
        }
        var paste = Data(repeating: 0xff, count: 1_500_000)
        paste.append(Data("跨块中文与 Emoji 😀".utf8))
        XCTAssertTrue(queue.enqueue(paste))
        XCTAssertEqual(accepted, paste)
        XCTAssertLessThanOrEqual(largestRequest, 1024 * 1024)
        XCTAssertEqual(queue.pendingBytes, 0)
    }

    @MainActor
    func testCapacityRejectsWholeInputAndCancelIgnoresOldCompletion() async {
        let receiver = ControlledInputReceiver()
        let queue = SessionInputQueue(chunkBytes: 4, byteLimit: 8)
        queue.sender = { receiver.send($0, completion: $1) }
        XCTAssertTrue(queue.enqueue(Data("ABCDEFGH".utf8)))
        XCTAssertFalse(queue.enqueue(Data("X".utf8)))
        XCTAssertEqual(queue.pendingBytes, 8)
        XCTAssertNotNil(queue.notice)
        XCTAssertEqual(receiver.attempts.count, 1)

        queue.cancelPending()
        XCTAssertTrue(queue.enqueue(Data("NEW".utf8)))
        receiver.complete(.success(())) // Old request may already have reached the core.
        XCTAssertEqual(queue.pendingBytes, 3, "Old completion cannot acknowledge newly queued bytes")
        receiver.complete(.success(()))
        XCTAssertEqual(queue.pendingBytes, 0)
        XCTAssertEqual(receiver.attempts, [Data("ABCD".utf8), Data("NEW".utf8)])
        queue.shutdown()
        XCTAssertFalse(queue.enqueue(Data("after close".utf8)))
    }
}
