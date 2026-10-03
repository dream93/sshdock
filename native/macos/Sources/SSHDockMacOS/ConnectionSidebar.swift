import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct MainView: View {
    @ObservedObject var store: SessionStore
    var body: some View {
        HSplitView {
            ConnectionSidebar(store: store, repository: store.connections)
                .frame(minWidth: 220, idealWidth: 245, maxWidth: 340)
            SessionTabsView(store: store).frame(maxWidth: .infinity, maxHeight: .infinity)
        }.frame(minWidth: 960, minHeight: 580)
    }
}

private struct ConnectionAction: Identifiable {
    var id: UUID { profile.id }
    let profile: SSHConnection
    let secret: String
    let connect: Bool
}

struct ConnectionSidebar: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var repository: ConnectionRepository
    @State private var action: ConnectionAction?
    @State private var message: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("SSH 连接").font(.headline)
                Spacer()
                Button { edit(SSHConnection(), connect: false) } label: { Image(systemName: "plus") }.help("新建 SSH 连接")
            }.padding(.horizontal, 12).padding(.top, 12)
            if let notice = repository.migrationNotice { Text(notice).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12) }
            if let failure = repository.loadError { Text(failure).font(.caption).foregroundStyle(.red).padding(.horizontal, 12) }
            if repository.connections.isEmpty {
                Text("新建连接，或导入旧版连接。密码和私钥口令只保存到 macOS 钥匙串。").font(.caption).foregroundStyle(.secondary).padding(12)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(repository.connections) { profile in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(profile.name).font(.headline).lineLimit(1)
                            Text("\(profile.username)@\(profile.host):\(String(profile.port))").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            HStack {
                                Button("连接") { edit(profile, connect: true) }.disabled(store.connectingIDs.contains(profile.id))
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("连接 \(profile.name)")
                                    .accessibilityIdentifier("connect-\(profile.id.uuidString)")
                                if store.connectingIDs.contains(profile.id) { ProgressView().controlSize(.small) }
                                Spacer()
                                Button { edit(profile, connect: false) } label: { Image(systemName: "pencil") }.help("编辑连接")
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("编辑 \(profile.name)")
                                    .accessibilityIdentifier("edit-\(profile.id.uuidString)")
                            }
                        }.padding(.vertical, 4).padding(.horizontal, 10)
                            .contextMenu {
                                Button("编辑") { edit(profile, connect: false) }
                                Button("重置主机信任") { resetTrust(profile) }
                                Button("删除连接", role: .destructive) { delete(profile) }
                            }
                    }
                }.padding(.horizontal, 6).padding(.vertical, 4)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            Button("导入旧版 connections.json", action: importMetadata).padding(.horizontal, 12).padding(.bottom, 12)
        }
        .sheet(item: $action) { item in
            ConnectionEditor(profile: item.profile, secret: item.secret, connectOnSave: item.connect) { profile, secret, connect in
                do { try repository.save(profile, secret: secret); action = nil; if connect { store.connect(try profile.validated(), secret: secret) } }
                catch { message = error.localizedDescription }
            }
        }
        .alert("连接配置", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("确定") { message = nil }
        } message: { Text(message ?? "") }
    }
    private func edit(_ profile: SSHConnection, connect: Bool) {
        do { action = ConnectionAction(profile: profile, secret: try repository.secret(for: profile), connect: connect) }
        catch { message = error.localizedDescription }
    }
    private func delete(_ profile: SSHConnection) {
        let alert = NSAlert(); alert.messageText = "删除连接“\(profile.name)”？"
        alert.informativeText = "将删除原生配置和关联钥匙串凭据，已连接的终端继续运行。"
        alert.addButton(withTitle: "删除"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do { try repository.delete(profile) } catch { message = error.localizedDescription }
    }
    private func resetTrust(_ profile: SSHConnection) {
        let alert = NSAlert(); alert.messageText = "重置 \(profile.host):\(profile.port) 的主机信任？"
        alert.informativeText = "仅在已核实服务器密钥变化后继续。下次连接会重新展示指纹并要求确认。"
        alert.addButton(withTitle: "重置信任"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do { try repository.forgetHost(profile) } catch { message = error.localizedDescription }
    }
    private func importMetadata() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.json]; panel.message = "导入旧版连接元数据；密码和私钥口令不会迁移"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { let count = try repository.importElectronMetadata(Data(contentsOf: url)); message = "已导入 \(count) 个连接。请重新输入密码或私钥口令；旧配置保持不变。" }
        catch { message = error.localizedDescription }
    }
}

struct ConnectionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var profile: SSHConnection
    @State var secret: String
    let connectOnSave: Bool
    let save: (SSHConnection, String, Bool) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(connectOnSave ? "连接 SSH 服务器" : "SSH 连接配置").font(.title2)
            Form {
                TextField("名称", text: $profile.name)
                TextField("主机", text: $profile.host)
                TextField("端口", value: $profile.port, format: .number.grouping(.never))
                TextField("用户名", text: $profile.username)
                Picker("认证方式", selection: $profile.authType) {
                    Text("密码").tag(SSHConnection.Authentication.password)
                    Text("私钥").tag(SSHConnection.Authentication.key)
                }
                if profile.authType == .key {
                    HStack {
                        TextField("私钥路径", text: $profile.keyPath)
                        Button("选择…") { chooseKey() }
                    }
                }
                SecureField(profile.authType == .password ? "密码" : "私钥口令（可选）", text: $secret)
                Toggle("保存到 macOS 钥匙串", isOn: $profile.rememberSecret)
            }
            Text("首次连接需确认主机指纹。旧版加密密码和口令不会作为新凭据使用。").font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("取消") { secret = ""; dismiss() }.keyboardShortcut(.cancelAction)
                Button(connectOnSave ? "连接" : "保存") { save(profile, secret, connectOnSave) }.keyboardShortcut(.defaultAction)
            }
        }.padding(22).frame(width: 480)
            .onChange(of: profile.authType) { _ in secret = "" }
    }
    private func chooseKey() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.message = "选择 SSH 私钥"
        if panel.runModal() == .OK, let url = panel.url { profile.keyPath = url.path }
    }
}

struct RemoteSessionView: View {
    @ObservedObject var session: TerminalSession
    let presentation: TerminalPresentation
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(session.connection.map { "SSH · \($0.username)@\($0.host)" } ?? "SSH")
                Spacer()
                Toggle("文件与统计", isOn: $session.showRemoteFiles).toggleStyle(.checkbox)
            }.font(.caption).padding(.horizontal, 12).padding(.vertical, 5)
            HSplitView {
                TerminalHost(session: session, presentation: presentation).frame(maxWidth: .infinity, maxHeight: .infinity)
                if session.showRemoteFiles, let remote = session.remote {
                    RemoteFilesView(remote: remote).frame(minWidth: 280, idealWidth: 340, maxWidth: 480)
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct RemoteFilesView: View {
    @ObservedObject var remote: RemoteWorkspace
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SFTP").font(.headline)
            HStack {
                TextField("远程路径", text: $remote.path).onSubmit { Task { await remote.refresh() } }
                Button { Task { await remote.refresh() } } label: { Image(systemName: "arrow.clockwise") }
            }.disabled(remote.busy || remote.isClosed)
            HStack {
                Button("上级", action: remote.parent)
                Button("新建目录", action: remote.createDirectory)
                Button("上传…", action: remote.upload)
                if remote.busy { ProgressView().controlSize(.small) }
            }.disabled(remote.busy || remote.isClosed)
            List(remote.entries) { entry in
                HStack {
                    Image(systemName: entry.isSymlink ? "link" : entry.isDirectory ? "folder" : "doc")
                    Text(entry.name).lineLimit(1)
                    Spacer()
                    if !entry.isDirectory { Text(ByteCountFormatter.string(fromByteCount: Int64(clamping: entry.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary) }
                }.contentShape(Rectangle())
                    .onTapGesture(count: 2) { if entry.isDirectory && !entry.isSymlink { remote.navigate(entry.path) } }
                    .contextMenu {
                        if entry.isDirectory && !entry.isSymlink { Button("打开") { remote.navigate(entry.path) } }
                        Button("下载…") { remote.download(entry) }.disabled(remote.busy || remote.isClosed || entry.isSymlink)
                        Button("删除…", role: .destructive) { remote.remove(entry) }.disabled(remote.busy || remote.isClosed)
                    }
            }.listStyle(.inset)
            ForEach(remote.transfers) { transfer in
                VStack(alignment: .leading, spacing: 4) {
                    HStack { Text(transfer.title).lineLimit(1); Spacer(); if transfer.state == "running" { Button("取消") { remote.cancel(transfer) }.help("取消传输，部分目标文件可能保留") } }
                    ProgressView(value: transfer.fraction)
                    Text(transfer.message ?? "\(ByteCountFormatter.string(fromByteCount: Int64(clamping: transfer.transferred), countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: Int64(clamping: transfer.total), countStyle: .file)) · \(transfer.state)").font(.caption).foregroundStyle(.secondary)
                }
            }
            Divider()
            Toggle("Linux 统计", isOn: $remote.statsEnabled).disabled(remote.isClosed)
            Text(remote.statsStatus).font(.caption).foregroundStyle(.secondary)
            if let metrics = remote.metrics {
                HStack { metric("CPU", metrics.cpu.map { String(format: "%.0f%%", $0 * 100) }); metric("内存", metrics.memory.map { String(format: "%.0f%%", $0 * 100) }); metric("Load", metrics.load1.map { String(format: "%.2f", $0) }) }
                HStack { metric("接收", metrics.rxPerSecond.map(rate)); metric("发送", metrics.txPerSecond.map(rate)) }
            }
        }.padding(10)
            .alert("远程文件操作", isPresented: Binding(get: { remote.error != nil }, set: { if !$0 { remote.error = nil } })) {
                Button("确定") { remote.error = nil }
            } message: { Text(remote.error ?? "") }
    }
    private func metric(_ title: String, _ value: String?) -> some View { VStack(alignment: .leading) { Text(title).foregroundStyle(.secondary); Text(value ?? "—").monospacedDigit() }.font(.caption).frame(maxWidth: .infinity, alignment: .leading) }
    private func rate(_ bytes: Double) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) + "/s" }
}
