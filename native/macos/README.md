# macOS 原生本地终端原型

阶段 1：SwiftUI 管理标签与设置，AppKit 管理窗口，SwiftTerm `v1.20.0` 提供终端模拟、CoreText 渲染、选区复制和中文输入法，Rust 核心负责本地 PTY。界面中不使用 WebView。

## 构建与运行

需要 macOS 13+、Xcode 的 Swift 6+ 工具链以及 Rust。SwiftPM 依赖由 `Package.resolved` 固定；Rust 依赖由核心的 `Cargo.lock` 固定。

在仓库根目录运行：

```bash
bash native/scripts/build-macos.sh
open native/artifacts/SSHDockNative.app
```

脚本默认构建 Release，静态链接 Rust 核心并生成本机架构的 `.app`。本地使用 ad-hoc 签名，未做开发者签名和公证。构建脚本使用 SwiftPM native builder；SwiftTerm 的可选 Metal 渲染未启用，不需要额外的 Metal Toolchain。

已有 Rust Release 静态库时，可以单独构建 Swift 部分：

```bash
swift build --package-path native/macos --build-system native
swift test --package-path native/macos --build-system native
```

## 使用行为

- `⌘T` 新建本地终端，标签切换保留同一个终端对象与 shell。
- `⌘⇧D` 将前台窗口对应的终端移至独立窗口，不创建新进程；重复操作聚焦已有窗口。关闭独立窗口或点击“移回主窗口”会显示主窗口并选中返回的会话。
- `⌘W` 关闭窗口并保留会话，应用仍驻留；通过 Dock 或 `⌘N` 可以再次显示主窗口。
- `⌘⇧W` 关闭前台窗口对应的会话，运行中的 shell 会提示确认；确认弹窗期间暂停会话菜单操作，退出应用也会确认并结束所有 shell。
- `⌘C` 复制终端选区，`⌘V` 粘贴；IME、字符宽度和鼠标选择交给 SwiftTerm 原生控件。
- 支持跟随系统、深色、浅色主题，主题保存到独立应用偏好中。
- 每个会话最多保留 8 MiB 待发送输入，大段粘贴按原始字节分块。核心暂时无法接受输入时，未接受的内容按顺序保留，主窗口和独立窗口都会显示“重试发送”和“取消待发送”。已经提交的输入请求无法撤回，包括仍在桥接队列中的请求；超过本地上限的整次新输入会明确拒绝，用户可以分批粘贴。

## 会话与线程边界

`TerminalSession` 保留 SwiftTerm 的视图、解析器、滚动历史和选区。窗口容器只重新挂接这个视图；首次测得真实行列数后才创建 PTY，每次有效尺寸变化同步到核心。

`CoreBridge` 使用独立的请求和输出轮询队列。键盘输入在回调中同步排入会话 FIFO，只在核心接受当前块后提交下一块；拒绝时保持队首，后续键入不会越过。输出以 base64 携带原始字节并按顺序交给主线程。渲染最多积压两批输出，接收方处理后确认；核心在界面较慢时施加背压。停止时清理会话输入，拒绝请求，再等待两条 FFI 队列完成，最后销毁句柄；Rust 返回的字符串只通过 Rust 提供的释放函数回收。启动时校验 ABI 1。

## 验证范围与后续工作

XCTest 运行真实 `/bin/sh` 和 PTY，验证非法 UTF-8 字节完整传输、`stty size` 行列同步、分段输入顺序、自然退出码、主动关闭，以及停止后的请求拒绝。输入队列回归覆盖背压重试与后续输入顺序、超过 1 MiB 的字节分块、容量原子拒绝和取消后的陈旧回调。另有不显示窗口的 AppKit 回归测试，覆盖终端在主窗口与独立窗口之间移动、旧容器延迟更新、解析器和中文内容的保留、双会话前台窗口路由、模态阻断、返回与删除路径，以及过期焦点回调。

2026-10-03 在 macOS arm64 上完成实际 GUI 检查：中文输出、独立窗口完整显示、移交/移回时 shell PID 保持一致；独立窗口放大后 PTY 从 112×37 变为 181×48，移回主窗口为 130×37。Vim 的中文、备用屏幕、方向键和退出恢复、Ctrl-C、自然退出码 7、120 行中文输出的历史滚动，以及退出确认后两个已知 shell PID 的清理均通过。普通历史可以向上阅读并回到底部；观看历史期间新增输出尚未测试。前台窗口菜单路由修复已有自动回归，尚待新构建的 GUI 复测。

中文粘贴与显示不代表输入法验收通过。IME 组合过程和候选框、鼠标选区复制、复杂 tmux 交互、Retina 与跨显示器、持续输出压力仍需单独检查。

此原型使用独立的 bundle identifier `com.sshdock.native.prototype`，不读取或修改 Electron 连接配置。SSH、SFTP、连接管理、旧凭据迁移、终端组持久化和正式发行签名属于后续阶段；当前 shell 的目录显示可以响应 OSC 7，未实现通用的进程 cwd 查询。
