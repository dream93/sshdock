# SSHDock 原生版本

原生迁移采用 macOS SwiftUI/AppKit、Windows C#/WinUI 3，以及共享 Rust 会话核心。
当前交付第一阶段：本地 PTY、原生终端控件和两端桥接。SSH/SFTP、连接与凭据迁移、
服务器统计及正式安装包会在后续阶段接入。原生应用使用独立名称和标识，暂不读取或覆盖旧配置。

## 构建与运行

依赖 Rust 1.99、macOS 的 Xcode/Swift，以及 Windows 的 .NET 10 SDK、Windows SDK
和 Visual Studio C++ 构建工具。第三方依赖由 Cargo、SwiftPM 和 NuGet 还原。

macOS：

```sh
bash native/scripts/build-macos.sh
open native/artifacts/SSHDockNative.app
```

Windows（在 Developer PowerShell 中）：

```powershell
./native/windows/build.ps1 -Architecture x64 -Configuration Release
# arm64 交叉构建需要对应的 Visual Studio ARM64 C++ 工具链
./native/windows/build.ps1 -Architecture arm64 -Configuration Release
```

Windows 输出位于 `native/windows/artifacts/<architecture>/`。macOS 按构建主机架构输出 `.app`。
CI 分别构建 macOS arm64/x86_64 与 Windows x64/arm64。构建成功表示代码与打包验证通过，
交互式输入法、渲染和跨显示器 DPI 仍须在对应平台完成下面的手工验收。
第一阶段产物是开发原型，未使用正式发布证书签名或公证。

## 模块边界

| 模块 | 核心职责 | 平台职责 |
| --- | --- | --- |
| 会话 | PTY 生命周期、字节输入输出、尺寸、关闭事件 | 标签、焦点、窗口和会话绑定 |
| 终端 | 可选 VT 状态引擎、滚动历史 | macOS SwiftTerm；Windows Win2D 绘制、IME、选区 |
| 后续 SSH/SFTP | 认证、多 channel、传输、进度、统计 | 原生表单、文件选择、文件列表 |
| 后续配置 | 连接与组模型、非敏感数据保存 | Keychain/Credential Manager、导入界面 |

共享核心通过 `native/include/sshdock_core.h` 的 C ABI 暴露。
核心句柄在应用范围内保留，终端视图与 PTY 会话寿命分离。一个会话只有一个呈现窗口控制
PTY 的行列尺寸。独立窗口移交已有会话，窗口关闭时应回到主窗口；明确关闭会话才终止 shell。

## ABI v1

- `sshdock_core_create()` 创建核心，`sshdock_core_destroy()` 关闭全部会话并释放核心。
- `sshdock_core_request(core, json)` 接收 UTF-8 JSON，返回独立分配的 UTF-8 JSON。
- `sshdock_core_poll(core)` 排空当前批次事件，返回 JSON 数组。
- 每个返回字符串必须调用 `sshdock_core_string_free()` 恰好释放一次。
- 应用销毁核心前须停止轮询、等待所有调用结束。不得在销毁后继续使用句柄。
- 终端输出是 Base64 字节，保留跨读取边界的 UTF-8/VT 序列；控件更新在 UI 线程执行。
- 输出队列有界，消费落后时向 PTY 施加背压，不静默丢弃存活会话的输出。
- 输入在有界写队列中处理；无法接受时返回 `INPUT_BACKPRESSURE`，界面应报告并保留输入以供重试。

请求与返回示例：

```json
{"method":"local.create","params":{"cols":80,"rows":24,"terminalEngine":true}}
```

```json
{"ok":true,"result":{"sessionId":"...","title":"...","cwd":"..."}}
```

失败返回 `{"ok":false,"error":{"code":"...","message":"..."}}`。

| 方法 | 参数 | 用途 |
| --- | --- | --- |
| `core.info` | 无 | 获取 `abiVersion` 并校验桥接兼容性 |
| `local.create` | `cols`, `rows`, 可选 `cwd`, `shell`, `terminalEngine` | 创建系统本地 shell；Swift 关闭内置 VT 引擎，Windows 开启 |
| `sessions.input` | `sessionId`, `data`（Base64） | 原始输入字节 |
| `sessions.resize` | `sessionId`, `cols`, `rows` | 调整 PTY 与 VT 状态尺寸 |
| `sessions.close` | `sessionId` | 终止会话 |
| `sessions.list` | 无 | 当前会话 |
| `terminal.snapshot` | `sessionId` | Windows 终端的可视网格、颜色、属性、光标与 `modes` |
| `terminal.scroll` | `sessionId`, `delta` | 正数向历史滚动，负数回底部 |
| `terminal.resetScroll` | `sessionId` | 恢复输出跟随 |

事件包括 `output`（`sessionId`, Base64 `data`）、`closed`（`sessionId`, `exitCode`）和 `error`。
仅在收到输出批次或视口变化时更新快照，避免逐字符跨 FFI 和更新 XAML。
`modes.applicationCursor` 控制应用光标键编码；`modes.bracketedPaste` 控制粘贴边界序列。

## 第一阶段验收

自动检查：

```sh
cargo fmt --manifest-path native/core/Cargo.toml -- --check
cargo clippy --locked --manifest-path native/core/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native/core/Cargo.toml
swift test --package-path native/macos --build-system native -c release
node --test test/*.test.cjs
```

Windows 的 `build.ps1 -RunSmokeTests` 还会运行 C# / Rust 实际桥接检查；
该检查可在 macOS 指定 `SSHDOCK_CORE_LIBRARY` 为构建后的 `.dylib` 运行。
Windows x64 CI 还会启动发布后的应用，验证 XAML 窗口、Win2D 终端绘制和实际 shell 输出，
随后自动关闭会话并退出；输入法、DPI 和完整交互仍由手工检查覆盖。
macOS 使用 SwiftPM native builder 与 SwiftTerm CoreText 渲染，不要求安装可选 Metal 工具链。

手工检查必须分别记录 macOS 和 Windows 结果，未运行的平台不能记为通过：

1. 默认 shell、指定工作目录、多个标签、独立窗口移交和自然退出。
2. `vim`、`less`、`top`、`tmux` 的全屏/备用屏幕、方向键、Ctrl-C 和调整尺寸。
3. 中文输入法提交/组合过程、全角标点、候选框、CJK 字宽、组合字符和 emoji。
4. 鼠标选区复制、历史滚动、查看历史时收到输出、回到底部后继续跟随。
5. 输出压力、关闭运行中的 shell、关闭应用、异常输入参数，检查无泄漏进程或死锁。
6. Windows 125%/150%/200% DPI、跨显示器移动；macOS Retina 与窗口重新激活。

## 后续阶段

| 阶段 | 范围 | 完成门槛 |
| --- | --- | --- |
| 2 | russh/russh-sftp、SSH 会话、host key、密码与加密私钥 | SSH 与多窗口行为通过，终端尺寸和断线清理正确 |
| 3 | 原生连接管理、主题语言、终端组、配置与凭据导入 | 字段和 ID 保留，迁移可恢复，目录继承与休眠恢复正确 |
| 4 | SFTP、目录操作、传输进度、Linux 统计 | 传输与 shell 并行，中文路径、空文件、失败和非 Linux 降级正确 |
| 5 | 拖放、响铃、任务关闭保护、安装包与升级 | 两个平台交互验收、签名、公证和升级路径通过 |

旧版 `connections.json` 中的 `safeStorage` 密文需要旧进程协助迁移或重新录入；不得把密文
当作新凭据，也不得为迁移写入普通明文导出文件。终端组只恢复标题与目录，不恢复进程。
正式接管配置目录前保留旧版数据，确保用户可以回到现有 Electron 客户端。
