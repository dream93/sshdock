import AppKit
import XCTest
@testable import SSHDockMacOS

final class WindowRoutingTests: XCTestCase {
    @MainActor
    private func flushMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        await Task.yield()
    }

    @MainActor
    func testCommandsFollowForegroundWindowAndBlockModalRouting() throws {
        _ = NSApplication.shared
        let store = SessionStore()
        store.newSession()
        let first = try XCTUnwrap(store.selected)
        first.state = .closed // No geometry callback may launch a shell.
        var presented: [NSWindow] = []
        let windows = WindowCoordinator(store: store, presentWindow: { presented.append($0) })
        defer { store.windowCoordinator = nil }
        windows.showMain()
        let main = try XCTUnwrap(windows.mainWindow)
        windows.detach(first)
        let detached = try XCTUnwrap(presented.last)
        XCTAssertFalse(detached === main)

        store.newSession()
        let second = try XCTUnwrap(store.selected)
        second.state = .closed
        XCTAssertTrue(windows.commandSession(keyWindow: detached, mainWindow: main) === first)
        XCTAssertTrue(windows.commandSession(keyWindow: main, mainWindow: detached) === second)
        XCTAssertTrue(windows.commandSession(keyWindow: nil, mainWindow: detached) === first)

        // An auxiliary key panel must not redirect the command away from A.
        let panel = NSPanel(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        XCTAssertTrue(windows.commandSession(keyWindow: panel, mainWindow: detached) === first)
        XCTAssertNil(windows.commandSession(keyWindow: panel, mainWindow: detached, modalWindow: panel))

        windows.detach(first)
        XCTAssertTrue(presented.last === detached, "Repeated detach must focus the existing window")
        XCTAssertEqual(Set(presented.map(ObjectIdentifier.init)).count, 2)
        XCTAssertEqual(store.sessions.count, 2)
        store.select(first)
        XCTAssertTrue(windows.commandSession(keyWindow: main, mainWindow: main) === first,
                      "The main window's detached placeholder still represents its selected session")
        XCTAssertNil(first.coreID)
        XCTAssertNil(second.coreID)
    }

    @MainActor
    func testReturnSelectsOriginalSessionButRemovalNeverReturnsDeletedSession() async throws {
        _ = NSApplication.shared
        let store = SessionStore()
        store.newSession()
        let first = try XCTUnwrap(store.selected)
        first.state = .closed
        first.terminal.feed(text: "返回状态")
        let parser = first.terminal.getTerminal()
        var presented: [NSWindow] = []
        let windows = WindowCoordinator(store: store, presentWindow: { presented.append($0) })
        defer { store.windowCoordinator = nil }
        windows.showMain()
        let main = try XCTUnwrap(windows.mainWindow)
        windows.detach(first)
        let detached = try XCTUnwrap(presented.last)
        store.newSession()
        let second = try XCTUnwrap(store.selected)
        second.state = .closed

        // Exercise NSWindow's actual close notification without showing it.
        detached.close()
        XCTAssertFalse(first.detached)
        XCTAssertTrue(store.selected === first)
        XCTAssertTrue(presented.last === main)
        XCTAssertTrue(first.terminal.getTerminal() === parser)

        windows.detach(first)
        let nextDetached = try XCTUnwrap(presented.last)
        store.select(second)
        windows.returnToMain(first)
        XCTAssertFalse(first.detached)
        XCTAssertTrue(store.selected === first)
        XCTAssertTrue(presented.last === main)

        windows.detach(first)
        let removedWindow = try XCTUnwrap(presented.last)
        store.select(second)
        let presentationCount = presented.count
        store.close(first)
        XCTAssertTrue(store.isClosing(first))
        XCTAssertNil(windows.commandSession(keyWindow: removedWindow, mainWindow: main))
        windows.returnToMain(first) // A closing session cannot be selected again.
        for _ in 0..<3 { await flushMainQueue() }

        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertTrue(store.selected === second)
        XCTAssertFalse(first.detached)
        XCTAssertFalse(store.isClosing(first))
        XCTAssertEqual(presented.count, presentationCount,
                       "Disposal must not reopen the main window or select the removed session")
        XCTAssertNil(windows.commandSession(keyWindow: removedWindow, mainWindow: main),
                     "A stale owned window must not fall back to another session")
        store.select(first)
        windows.returnToMain(first)
        XCTAssertTrue(store.selected === second)
        XCTAssertEqual(presented.count, presentationCount)
        XCTAssertTrue(first.terminal.getTerminal() === parser)
        XCTAssertNil(first.coreID)
        XCTAssertNil(second.coreID)
        // Each return/re-detach may create a presentation window, never a PTY.
        XCTAssertFalse(nextDetached === removedWindow)
    }

    @MainActor
    func testDeferredFocusCannotSelectAnOldMainWindowTerminal() async throws {
        _ = NSApplication.shared
        let store = SessionStore()
        store.newSession()
        let first = try XCTUnwrap(store.selected)
        first.state = .closed
        store.newSession()
        let second = try XCTUnwrap(store.selected)
        second.state = .closed
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                              styleMask: [.titled], backing: .buffered, defer: false)
        let root = NSView(frame: window.contentView!.bounds)
        window.contentView = root
        let firstHost = TerminalContainer(frame: root.bounds)
        let secondHost = TerminalContainer(frame: root.bounds)
        firstHost.attach(first, presentation: .main)
        secondHost.attach(second, presentation: .main)
        store.selectedID = first.id
        root.addSubview(firstHost) // Queues the old viewDidMoveToWindow focus.
        root.addSubview(secondHost)
        store.selectedID = second.id
        XCTAssertTrue(window.makeFirstResponder(second.terminal))
        await flushMainQueue()
        XCTAssertTrue(window.firstResponder === second.terminal)

        store.select(first) // Queues the old explicit selection focus.
        store.selectedID = second.id
        XCTAssertTrue(window.makeFirstResponder(second.terminal))
        await flushMainQueue()
        XCTAssertTrue(window.firstResponder === second.terminal)
        XCTAssertNil(first.coreID)
        XCTAssertNil(second.coreID)
    }
}
