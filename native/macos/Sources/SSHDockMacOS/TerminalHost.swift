import AppKit
import SwiftUI

enum TerminalPresentation {
    case main, detached
    @MainActor func owns(_ session: TerminalSession) -> Bool {
        switch self { case .main: return !session.detached; case .detached: return session.detached }
    }
}

/// A session owns its TerminalView. Containers only move that existing view;
/// switching tabs or windows never recreates its parser, scrollback or shell.
@MainActor
final class TerminalContainer: NSView {
    var session: TerminalSession?
    var presentation: TerminalPresentation = .main

    func attach(_ session: TerminalSession, presentation: TerminalPresentation) {
        self.session = session
        self.presentation = presentation
        guard presentation.owns(session) else {
            if session.terminal.superview === self { session.terminal.removeFromSuperview() }
            return
        }
        if session.terminal.superview !== self {
            session.terminal.removeFromSuperview()
            addSubview(session.terminal)
            session.terminal.autoresizingMask = [.width, .height]
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard let session, presentation.owns(session), session.terminal.superview === self else { return }
        session.terminal.frame = bounds
        // SwiftUI can be laying out its representable here; publish measured
        // state on the next main-loop turn instead of during a view update.
        DispatchQueue.main.async { [weak session] in session?.measured() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window, let session, presentation.owns(session) {
            DispatchQueue.main.async { [weak self, weak window, weak session] in
                guard let self, let window, let session, self.session === session,
                      presentation.owns(session), session.terminal.superview === self,
                      session.terminal.window === window,
                      let store = session.store, !store.isClosing(session),
                      store.sessions.contains(where: { $0 === session }),
                      presentation == .detached || store.selectedID == session.id else { return }
                window.makeFirstResponder(session.terminal)
            }
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        if let session { session.store?.applyTheme(to: session) }
    }
}

struct TerminalHost: NSViewRepresentable {
    let session: TerminalSession
    var presentation: TerminalPresentation = .main
    func makeNSView(context: Context) -> TerminalContainer {
        let container = TerminalContainer()
        container.attach(session, presentation: presentation)
        return container
    }
    func updateNSView(_ container: TerminalContainer, context: Context) { container.attach(session, presentation: presentation) }
    static func dismantleNSView(_ container: TerminalContainer, coordinator: ()) {
        if let terminal = container.session?.terminal, terminal.superview === container { terminal.removeFromSuperview() }
        container.session = nil
    }
}

struct SessionHeader: View {
    @ObservedObject var session: TerminalSession
    var body: some View {
        HStack(spacing: 12) {
            Text(session.status).foregroundStyle(session.state == .running ? .green : .secondary)
            Text(session.cwd).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Text("\(session.columns) × \(session.rows)").monospacedDigit()
        }.font(.caption).padding(.horizontal, 12).padding(.vertical, 7)
    }
}

struct InputQueueBanner: View {
    @ObservedObject var queue: SessionInputQueue
    var body: some View {
        if queue.pauseReason != nil || queue.notice != nil {
            VStack(alignment: .leading, spacing: 7) {
                Text(queue.notice ?? queue.pauseReason ?? "")
                HStack {
                    if queue.pendingBytes > 0 {
                        Text("\(ByteCountFormatter.string(fromByteCount: Int64(queue.pendingBytes), countStyle: .memory)) 待发送")
                        Spacer()
                        Button("重试发送", action: queue.retry)
                        Button("取消待发送", action: queue.cancelPending)
                            .help("取消待发送内容，已经提交的输入请求无法撤回")
                    } else {
                        Button("关闭提示", action: queue.dismissNotice)
                    }
                }
            }.font(.caption).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.15))
        }
    }
}

struct SessionTabsView: View {
    @ObservedObject var store: SessionStore
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: store.newSession) { Label("新建终端", systemImage: "plus") }
                    .keyboardShortcut("t", modifiers: .command)
                Button(action: store.detachSelected) { Label("独立窗口", systemImage: "arrow.up.forward.square") }
                    .disabled(store.selected == nil)
                Spacer()
                Picker("主题", selection: $store.theme) {
                    ForEach(TerminalTheme.allCases) { Text($0.title).tag($0) }
                }.frame(width: 165)
            }.padding(10)
            Divider()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(store.sessions) { session in
                        HStack(spacing: 7) {
                            Button { store.select(session) } label: {
                                Label(session.title, systemImage: session.detached ? "macwindow" : "terminal")
                                    .lineLimit(1).frame(maxWidth: 220)
                            }.buttonStyle(.plain)
                            Button { store.close(session) } label: { Image(systemName: "xmark").font(.caption2) }
                                .buttonStyle(.plain).disabled(session.state == .starting)
                                .help("关闭会话")
                        }.padding(.horizontal, 10).padding(.vertical, 8)
                            .background(store.selectedID == session.id ? Color.accentColor.opacity(0.18) : .clear)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }.padding(6)
            }
            Divider()
            if let session = store.selected {
                SessionHeader(session: session)
                InputQueueBanner(queue: session.inputQueue)
                Divider()
                if session.detached {
                    VStack(spacing: 14) {
                        Image(systemName: "macwindow").font(.largeTitle)
                        Text("会话已移至独立窗口")
                        Button("显示窗口") { store.windowCoordinator?.focusDetached(session) }
                        Button("移回主窗口") { store.windowCoordinator?.returnToMain(session) }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    if session.connection != nil {
                        RemoteSessionView(session: session, presentation: .main).id(session.id)
                    } else {
                        TerminalHost(session: session).id(session.id).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "terminal").font(.largeTitle)
                    Text("创建一个本地终端开始使用")
                    Button("新建终端", action: store.newSession)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.frame(minWidth: 600, maxWidth: .infinity, minHeight: 380, maxHeight: .infinity)
            .alert("操作失败", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
                Button("确定") { store.errorMessage = nil }
            } message: { Text(store.errorMessage ?? "") }
    }
}

struct DetachedView: View {
    @ObservedObject var session: TerminalSession
    let returnToMain: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                SessionHeader(session: session)
                Button("移回主窗口", action: returnToMain).padding(.trailing, 10)
            }
            Divider()
            InputQueueBanner(queue: session.inputQueue)
            if session.connection != nil {
                RemoteSessionView(session: session, presentation: .detached)
            } else {
                TerminalHost(session: session, presentation: .detached).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.frame(minWidth: 400, maxWidth: .infinity, minHeight: 240, maxHeight: .infinity)
    }
}
