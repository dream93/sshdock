import AppKit
import SwiftUI

@MainActor
final class WindowCoordinator: NSObject, NSWindowDelegate {
    let store: SessionStore
    private(set) var mainWindow: NSWindow!
    private var detachedWindows: [UUID: NSWindow] = [:]
    private let presentWindow: (NSWindow) -> Void

    init(store: SessionStore, presentWindow: ((NSWindow) -> Void)? = nil) {
        self.store = store
        self.presentWindow = presentWindow ?? { window in
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        super.init()
        store.windowCoordinator = self
    }

    func showMain() {
        if mainWindow == nil {
            mainWindow = makeWindow(title: "SSHDock Native", size: NSSize(width: 1060, height: 720))
            mainWindow.contentViewController = NSHostingController(rootView: MainView(store: store))
            mainWindow.setContentSize(NSSize(width: 1060, height: 720))
            mainWindow.delegate = self
            mainWindow.center()
        }
        presentWindow(mainWindow)
    }

    func detach(_ session: TerminalSession) {
        guard !store.isStopping, store.sessions.contains(where: { $0 === session }), !store.isClosing(session) else { return }
        if detachedWindows[session.id] != nil { focusDetached(session); return }
        session.detached = true
        let window = makeWindow(title: "\(session.title) — SSHDock", size: NSSize(width: 920, height: 620))
        detachedWindows[session.id] = window
        window.contentViewController = NSHostingController(rootView: DetachedView(session: session) { [weak self, weak session] in
            if let session { self?.returnToMain(session) }
        })
        window.setContentSize(NSSize(width: 920, height: 620))
        window.delegate = self
        window.center()
        presentWindow(window)
        store.objectWillChange.send()
    }

    func focusDetached(_ session: TerminalSession) {
        if let window = detachedWindows[session.id] { presentWindow(window) }
    }

    func commandSession() -> TerminalSession? {
        commandSession(keyWindow: NSApp.keyWindow, mainWindow: NSApp.mainWindow, modalWindow: NSApp.modalWindow)
    }

    func commandSession(keyWindow: NSWindow?, mainWindow: NSWindow?, modalWindow: NSWindow? = nil) -> TerminalSession? {
        guard modalWindow == nil, !store.isStopping else { return nil }
        for candidate in [keyWindow, mainWindow] {
            var window = candidate
            while let current = window {
                if current === self.mainWindow || current.delegate === self {
                    guard current.attachedSheet == nil else { return nil }
                    let session: TerminalSession?
                    if current === self.mainWindow { session = store.selected }
                    else if let entry = detachedWindows.first(where: { $0.value === current }) {
                        session = store.sessions.first(where: { $0.id == entry.key })
                    } else { session = nil }
                    // An owned window with a removed session must never fall back
                    // to another window's selection.
                    return session.flatMap { store.isClosing($0) ? nil : $0 }
                }
                window = current.sheetParent
            }
        }
        return nil
    }

    func returnToMain(_ session: TerminalSession) {
        guard store.sessions.contains(where: { $0 === session }), !store.isClosing(session) else { return }
        if let window = detachedWindows[session.id] { window.close() }
        else {
            session.detached = false
            store.select(session)
            showMain()
        }
    }

    func removeDetachedWindow(for session: TerminalSession) {
        guard let window = detachedWindows.removeValue(forKey: session.id) else { return }
        session.terminal.removeFromSuperview()
        session.detached = false
        // Remove the mapping first: the close callback is disposal, not return.
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let entry = detachedWindows.first(where: { $0.value === window }) else { return }
        detachedWindows.removeValue(forKey: entry.key)
        if let session = store.sessions.first(where: { $0.id == entry.key }) {
            session.terminal.removeFromSuperview()
            session.detached = false
            if !store.isClosing(session) {
                store.select(session)
                showMain()
            }
            store.objectWillChange.send()
        }
        // Closing a window is a view operation. It never sends sessions.close.
    }

    private func makeWindow(title: String, size: NSSize) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 440, height: 280)
        return window
    }
}

@MainActor
final class ApplicationDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    let store = SessionStore()
    var windows: WindowCoordinator!

    func applicationDidFinishLaunching(_ notification: Notification) {
        windows = WindowCoordinator(store: store)
        installMenu()
        store.applyTheme()
        store.newSession()
        windows.showMain()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        windows.showMain()
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if store.isStopping { return .terminateLater }
        if store.runningCount > 0 {
            let alert = NSAlert()
            alert.messageText = "退出 SSHDock？"
            alert.informativeText = "退出会结束 \(store.runningCount) 个终端会话及其中运行的任务，并取消文件传输。"
            alert.addButton(withTitle: "退出")
            alert.addButton(withTitle: "取消")
            if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
        }
        store.beginStop {
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    @objc private func newSession() { windows.showMain(); store.newSession() }
    @objc private func showMain() { windows.showMain() }
    @objc private func detach() { if let session = windows.commandSession() { windows.detach(session) } }
    @objc private func closeSession() { if let session = windows.commandSession() { store.close(session) } }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(closeSession) { return windows.commandSession().map { $0.state != .starting } ?? false }
        if menuItem.action == #selector(detach) { return windows.commandSession() != nil }
        return true
    }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 SSHDock Native", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 SSHDock", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 SSHDock", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(title: "文件", action: nil, keyEquivalent: "")
        let fileMenu = NSMenu(title: "文件")
        add(fileMenu, "新建终端", #selector(newSession), "t")
        add(fileMenu, "显示主窗口", #selector(showMain), "n")
        add(fileMenu, "移至独立窗口", #selector(detach), "d", modifiers: [.command, .shift])
        add(fileMenu, "关闭会话", #selector(closeSession), "w", modifiers: [.command, .shift])
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        menu.addItem(fileItem)

        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String, modifiers: NSEvent.ModifierFlags = .command) {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.target = self
        item.keyEquivalentModifierMask = modifiers
    }
}

@main
struct SSHDockNativeApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = ApplicationDelegate()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
