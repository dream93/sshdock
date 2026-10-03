# SSHDock 原生版本

原生迁移采用 macOS SwiftUI/AppKit、Windows C#/WinUI 3，以及共享 Rust 会话核心。
原生客户端提供连接管理、密码与私钥认证、主机密钥校验、远程 PTY、SFTP 文件与目录操作、
传输进度和 Linux 服务器状态，同时保留本地终端与独立窗口。原生应用使用独立配置目录，
首次发现旧版连接时只导入非敏感字段，不覆盖旧配置。密码和私钥口令重新输入后存入
macOS Keychain 或 Windows Credential Manager；不将旧版密文或明文密码写入新 JSON。

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
当前产物仍是开发版本，未使用正式发布证书签名或公证。

## 模块边界

| 模块 | 核心职责 | 平台职责 |
| --- | --- | --- |
| 会话 | PTY 生命周期、字节输入输出、尺寸、关闭事件 | 标签、焦点、窗口和会话绑定 |
| 终端 | 可选 VT 状态引擎、滚动历史 | macOS SwiftTerm；Windows Win2D 绘制、IME、选区 |
| SSH/SFTP | 认证、主机指纹、远程 PTY、多 channel、递归传输、进度、统计采样 | 原生连接表单、信任确认、文件选择和列表、指标展示 |
| 配置 | 不读取平台凭据 | 连接与信任元数据、Keychain/Credential Manager、旧版元数据导入 |

共享核心通过 `native/include/sshdock_core.h` 的 C ABI 暴露。
核心句柄在应用范围内保留，终端视图与 PTY 会话寿命分离。一个会话只有一个呈现窗口控制
PTY 的行列尺寸。独立窗口移交已有会话，窗口关闭时应回到主窗口；明确关闭会话才终止 shell。

## ABI v1

- `sshdock_core_create()` 创建核心，`sshdock_core_destroy()` 关闭全部会话并释放核心。
- `sshdock_core_request(core, json)` 接收 UTF-8 JSON，返回独立分配的 UTF-8 JSON。
- `sshdock_core_poll(core)` 排空当前批次事件，返回 JSON 数组。
- 每个返回字符串必须调用 `sshdock_core_string_free()` 恰好释放一次。
- 应用退出时先阻止新调用并请求 `core.shutdown` 取消活跃操作，再停止轮询、等待所有调用结束，最后销毁句柄。不得在销毁后继续使用句柄。
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
| `core.shutdown` | 无 | 幂等取消全部操作、结束会话并停止事件队列；等待调用结束后再销毁句柄 |
| `local.create` | `cols`, `rows`, 可选 `cwd`, `shell`, `terminalEngine` | 创建系统本地 shell；Swift 关闭内置 VT 引擎，Windows 开启 |
| `ssh.hostKey` | `host`, `port` | 获取主机公钥的算法与 SHA256 指纹，尚未认证 |
| `ssh.connect` | `host`, `port`, `username`, `authType`, `password` 或 `keyPath`/`passphrase`, `expectedFingerprint`, `cols`, `rows`, `terminalEngine` | 校验指纹后认证并创建远程 shell；实际握手再次匹配指纹 |
| `sessions.input` | `sessionId`, `data`（Base64） | 原始输入字节 |
| `sessions.resize` | `sessionId`, `cols`, `rows` | 调整 PTY 与 VT 状态尺寸 |
| `sessions.close` | `sessionId` | 终止会话 |
| `sessions.list` | 无 | 当前会话 |
| `terminal.snapshot` | `sessionId` | Windows 终端的可视网格、颜色、属性、光标与 `modes` |
| `terminal.scroll` | `sessionId`, `delta` | 正数向历史滚动，负数回底部 |
| `terminal.resetScroll` | `sessionId` | 恢复输出跟随 |
| `sftp.home` | `sessionId` | 获取远端主目录绝对路径 |
| `sftp.list` | `sessionId`, `path` | 获取规范路径和目录项 |
| `sftp.mkdir` / `sftp.remove` | `sessionId`, `path` | 新建目录或删除文件/递归目录，不跟随链接 |
| `sftp.upload` / `sftp.download` | `sessionId`, `localPath`, `remotePath`, `transferId` | 文件或目录传输；与终端输入使用不同调用通道 |
| `sftp.cancel` | `sessionId`, `transferId` | 取消传输 |
| `stats.sample` | `sessionId` | 通过独立 exec channel 获取 Linux CPU、内存、网络与负载原始采样 |

事件包括 `output`（`sessionId`, Base64 `data`）、`closed`（`sessionId`, `exitCode`）、`error`
以及 `transfer`（`sessionId`, `transferId`, `transferred`, `total`, `state`）。
仅在收到输出批次或视口变化时更新快照，避免逐字符跨 FFI 和更新 XAML。
`modes.applicationCursor` 控制应用光标键编码；`modes.bracketedPaste` 控制粘贴边界序列。

## 使用 SSH

1. 在连接列表新增连接，填写名称、主机、端口、用户和认证方式。私钥认证可选择加密私钥并输入口令。
2. 首次连接会显示服务器公钥指纹；核对后确认信任。已保存的主机密钥变化时阻止连接，须先核实再显式重置信任。
3. 连接成功后，终端支持相同的输入、尺寸和窗口移交；远程文件面板浏览目录、上传下载文件或目录，并显示传输进度。
4. Linux 状态使用独立 SSH channel 采样；无 `/proc` 或采样不可用时显示不支持，不向交互终端插入统计命令。

首次启动且原生连接为空时会尝试从旧版默认目录导入连接元数据，也可手选旧版 `connections.json`。
名称、ID、主机、端口、用户、认证方式和私钥路径保留；旧密码与口令无论编码方式都不导入。
原生配置损坏时报告错误并阻止覆盖；原版客户端与配置仍然保留。

## 验收

自动检查：

```sh
cargo fmt --manifest-path native/core/Cargo.toml -- --check
cargo clippy --locked --manifest-path native/core/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native/core/Cargo.toml
bash native/scripts/test-macos.sh
node --test test/*.test.cjs
```

Windows 的 `build.ps1 -RunSmokeTests` 还会运行 C# / Rust 实际桥接检查；
该检查可在 macOS 指定 `SSHDOCK_CORE_LIBRARY` 为构建后的 `.dylib` 运行。
Windows x64 CI 还会启动发布后的应用，验证 XAML 窗口、Win2D 终端绘制和实际 shell 输出，
随后自动关闭会话并退出；输入法、DPI 和完整交互仍由手工检查覆盖。
macOS 使用 SwiftPM native builder 与 SwiftTerm CoreText 渲染，不要求安装可选 Metal 工具链。
`test-macos.sh` 启动仅监听本机的临时 OpenSSH 服务，自动运行真实 Swift/SSH/SFTP 桥接测试并清理。
CI 的 Linux OpenSSH 作业使用临时测试账户，验证密码和加密私钥认证、真实 Linux 统计、递归文件传输、
传输期间终端输入和取消；Rust 的隔离 SSH 协议测试同时运行于 macOS 与 Windows。

手工检查必须分别记录 macOS 和 Windows 结果，未运行的平台不能记为通过：

1. 默认 shell、指定工作目录、多个标签、独立窗口移交和自然退出。
2. `vim`、`less`、`top`、`tmux` 的全屏/备用屏幕、方向键、Ctrl-C 和调整尺寸。
3. 中文输入法提交/组合过程、全角标点、候选框、CJK 字宽、组合字符和 emoji。
4. 鼠标选区复制、历史滚动、查看历史时收到输出、回到底部后继续跟随。
5. 输出压力、关闭运行中的 shell、关闭应用、异常输入参数，检查无泄漏进程或死锁。
6. Windows 125%/150%/200% DPI、跨显示器移动；macOS Retina 与窗口重新激活。
7. SSH 密码、私钥与加密私钥登录；错误密码、错误口令、连接超时和断开均给出可见错误。
8. 首次信任确认、取消信任、主机密钥变化拒绝；探测与实际连接之间密钥变化仍拒绝。
9. 旧连接元数据保留；凭据重输后可从系统凭据库读取，JSON 不包含秘密。
10. SFTP 中文文件与目录、空文件、递归上传下载、删除确认、传输取消和失败；传输期间终端仍可输入。
11. Linux 状态持续更新；非 Linux 降级；关闭会话同时停止状态采样和传输。

## 后续阶段

| 阶段 | 范围 | 完成门槛 |
| --- | --- | --- |
| SSH 完整验收 | 已接入 SSH、连接管理、系统凭据、SFTP 与 Linux 统计 | 两个平台完成上述真实服务器与交互验收 |
| 配置与工作区 | 语言、终端组、休眠恢复、可选旧凭据协助迁移 | 字段和 ID 保留，迁移可恢复，目录继承与休眠恢复正确 |
| 5 | 拖放、响铃、任务关闭保护、安装包与升级 | 两个平台交互验收、签名、公证和升级路径通过 |

旧版 `connections.json` 中的 `safeStorage` 密文需要旧进程协助迁移或重新录入；不得把密文
当作新凭据，也不得为迁移写入普通明文导出文件。终端组只恢复标题与目录，不恢复进程。
正式接管配置目录前保留旧版数据，确保用户可以回到现有 Electron 客户端。
