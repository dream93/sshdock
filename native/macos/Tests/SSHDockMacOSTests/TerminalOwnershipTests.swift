import AppKit
import XCTest
@testable import SSHDockMacOS

final class TerminalOwnershipTests: XCTestCase {
    @MainActor
    func testWindowTransferPreservesTerminalAndRejectsStaleContainer() async throws {
        // AppKit objects can be exercised without showing windows or launching a shell.
        _ = NSApplication.shared
        let store = SessionStore()
        store.newSession()
        let session = try XCTUnwrap(store.selected)
        session.state = .closed // Geometry callbacks must not launch a PTY in this test.
        let parser = session.terminal.getTerminal()
        session.terminal.feed(text: "保存状态 Native")
        let contents = parser.getLine(row: 0)?.translateToString(trimRight: true, skipNullCellsFollowingWide: true)
        XCTAssertEqual(contents, "保存状态 Native")

        let main = TerminalContainer(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        main.attach(session, presentation: .main)
        main.layout()
        XCTAssertTrue(session.terminal.superview === main)

        session.detached = true
        let detached = TerminalContainer(frame: NSRect(x: 0, y: 0, width: 820, height: 610))
        detached.attach(session, presentation: .detached)
        detached.layout()
        // Reproduce SwiftUI calling update on the old host after the new host mounts.
        main.attach(session, presentation: .main)
        main.layout()
        XCTAssertTrue(session.terminal.superview === detached)
        XCTAssertTrue(session.terminal.getTerminal() === parser)
        XCTAssertEqual(parser.getLine(row: 0)?.translateToString(trimRight: true, skipNullCellsFollowingWide: true), contents)

        session.detached = false
        main.attach(session, presentation: .main)
        main.layout()
        detached.attach(session, presentation: .detached)
        detached.layout()
        XCTAssertTrue(session.terminal.superview === main)
        XCTAssertTrue(session.terminal.getTerminal() === parser)
        XCTAssertEqual(parser.getLine(row: 0)?.translateToString(trimRight: true, skipNullCellsFollowingWide: true), contents)
        XCTAssertNil(session.coreID, "Moving views must not create a shell")
    }
}
