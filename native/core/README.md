# Rust 共享核心

提供本地 PTY / ConPTY、SSH 认证与远程 PTY、SFTP 文件操作、Linux 运行状态，以及 Windows 使用的 VT 网格。原生客户端负责连接配置和系统凭据存储。

使用 Rust 1.99.0，执行：

```sh
cargo build --locked --manifest-path native/core/Cargo.toml
cargo test --locked --manifest-path native/core/Cargo.toml
cargo clippy --locked --manifest-path native/core/Cargo.toml --all-targets -- -D warnings
```

库产物为 `libsshdock_core.a`、`libsshdock_core.dylib`（macOS）或 `sshdock_core.dll`（Windows）。公开 C ABI 和内存规则位于 `native/include/sshdock_core.h`。

macOS 的正式打包应使用 `native/scripts/build-macos.sh`；脚本设置 `MACOSX_DEPLOYMENT_TARGET=13.0`，使 Rust 与 ring 的 C 对象和 Swift 客户端保持同一最低系统版本。手工重建 macOS Release 库时也应传该环境变量。

诊断工具可用 `cargo run --locked --manifest-path native/core/Cargo.toml --example core_cli` 启动。它从 stdin 接收 JSON 行并返回一行响应；`core.poll` 排空事件。不要把含真实密码或口令的请求保存在 shell 历史或测试日志中。

## JSON 协议

请求格式为 `{"method":"方法","params":{...}}`，成功响应为 `{"ok":true,"result":...}`，失败响应为 `{"ok":false,"error":{"code":"错误码","message":"说明"}}`。

| 方法 | 参数 | 返回结果 |
| --- | --- | --- |
| `core.info` | `{}` | `abiVersion: 1`、核心版本 |
| `core.shutdown` | `{}` | `{}`；取消连接、传输、统计和本地进程，幂等；之后新操作返回 `CORE_STOPPED` |
| `local.create` | `cols`、`rows`、可选 `cwd` / `shell` / `terminalEngine` | `sessionId`、`title`、`cwd`、`closed` |
| `sessions.list` | `{}` | 会话数组 |
| `sessions.input` | `sessionId`、`data`（Base64 字节） | `{}` |
| `sessions.resize` | `sessionId`、`cols`、`rows` | `{}` |
| `sessions.close` | `sessionId` | `{}`；可重复调用 |
| `terminal.snapshot` | `sessionId` | 当前可视网格 |
| `terminal.scroll` | `sessionId`、有符号 `delta` | `{}`；正数向历史滚动 |
| `terminal.resetScroll` | `sessionId` | `{}`；回到输出底部 |
| `ssh.hostKey` | `host`、`port` | `algorithm`、`fingerprint`（`SHA256:...`） |
| `ssh.connect` | `host`、`port`、`username`、`authType`、`expectedFingerprint`、`cols`、`rows`，可选 `terminalEngine` | `sessionId`、`title`、`cwd: "."`、`kind: "ssh"`、`closed` |
| `sftp.home` | `sessionId` | `path`（服务器规范路径） |
| `sftp.list` | `sessionId`、`path` | 规范化 `path`、`entries` |
| `sftp.mkdir` | `sessionId`、`path` | `{}` |
| `sftp.remove` | `sessionId`、`path` | `{}`；递归删除目录，不跟随符号链接 |
| `sftp.upload` / `sftp.download` | `sessionId`、`localPath`、`remotePath`、`transferId` | `transferred`、`total`（字节） |
| `sftp.cancel` | `sessionId`、`transferId` | `{}`；取消当前传输，可重复调用 |
| `stats.sample` | `sessionId` | Linux 原始计数或 `supported: false` |

`authType: "password"` 需要 `password`；`authType: "key"` 需要 `keyPath`，加密私钥可传 `passphrase`。私钥加载支持 russh 的 OpenSSH、PEM、PPK 格式，最大 1 MiB；私钥缓冲区、密码与口令副本在释放时清零。核心不保存凭据。

`ssh.hostKey` 在收到公钥后拒绝继续握手，从而不发送认证信息。原生界面要求用户首次确认服务器指纹，之后 `ssh.connect` 始终校验已信任的 SHA256 指纹。服务器公钥改变时返回 `host_key_mismatch`；密码拒绝返回 `ssh_auth_failed`；私钥读取或口令错误返回 `key_load_failed`。握手、认证和远程命令分别限制 20 秒。握手超时或取消会关闭底层 socket，防止遗留后台协议任务。SSH 使用 [russh](https://docs.rs/russh/0.63.3/russh/) 0.63.3，SFTP 使用 [russh-sftp](https://docs.rs/russh-sftp/3.0.1/russh_sftp/) 3.0.1，支持 Windows 与 macOS。

SFTP `entries` 每项含 `name`、`path`、`isDirectory`、`isSymlink`、`size`（字节）、`modified`（Unix 秒或 null）。上传和下载支持目录递归，保留空目录和空文件；现有常规文件会覆盖，现有目录合并，界面应在覆盖前确认。符号链接上传/下载返回 `symlink_transfer_unsupported`；下载拒绝远端路径穿越名称和目的目录内的现有符号链接，显式选择的本地父目录先规范化。递归最多 100000 项、128 层，超限返回 `sftp_limit`。每次网络 I/O 30 秒无进展会超时。传输进度事件包含 `sessionId`、`transferId`、`transferred`、`total`、`state`（`running` / `completed` / `failed`）和可选 `message`。取消返回 `transfer_cancelled`；失败或取消可能留下部分文件，不会显示完成。

`stats.sample` 通过独立 SSH exec 通道读取 Linux `/proc`，返回 `supported`、`cpuTotal`、`cpuIdle`（jiffies）、`memTotal`、`memAvailable`（字节）、`rx`、`tx`（排除 loopback 的累积字节）、`load1`。客户端用相邻样本计算 CPU 与网络速率。Darwin 等非 Linux 系统返回 `supported: false`，不伪造零值。命令超时关闭对应 exec 通道；终端继续使用原连接。

Windows 下载会拒绝设备名（例如 `NUL.txt` / `COM1`）、结尾的空格或句点、系统禁止字符，避免设备写入和路径别名导致数据丢失；远端名称仍可浏览和删除。macOS / Linux 保留这些普通名称的行为。[Windows 官方文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)

`terminalEngine` 默认为 `false`。SwiftTerm 接收原始输出并维护自己的终端状态；Windows 创建会话时启用 `terminalEngine`，使用 Alacritty 的连续 VT 解析器维护网格、光标、历史、备用屏幕和终端查询响应。

Windows 的 `portable-pty` 适配器使用 `PSEUDOCONSOLE_INHERIT_CURSOR`，因此 ConPTY 启动时会输出 `ESC[6n` 光标位置查询。启用 `terminalEngine` 时核心自动回复；使用原始输出模式的消费者必须连续解析 VT 查询，并通过 `sessions.input` 回复光标位置（初始位置可回复 `ESC[1;1R`），再进行后续操作。只读取字节并忽略查询会阻塞 ConPTY 输出，需要输出的 Windows PTY 测试与 WinUI 应用均启用终端引擎。[CreatePseudoConsole 官方说明](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)

快照字段为 `cols`、`rows`、`title`、`offset`、`cursor: {row,col,visible}`、`modes: {applicationCursor,bracketedPaste}` 和 `cells`。每个 cell 包含 `row,col,text,fg,bg,bold,underline,wide`；坐标从 0 开始，相对于可视区域；颜色为 `#rrggbb`。宽字符的后续占位 cell 保留背景，但 `text` 为空。`offset` 是当前历史偏移，底部为 0；查看历史时隐藏光标。

列数支持 2–4096、行数支持 1–1024，可视 cell 总数不超过 200000。每个会话保留最多 10000 行历史，同时限制历史总 cell 数为 2000000。单个核心最多保留 32 个会话；明确关闭且已经完成事件投递的会话在下次创建时释放。

## 输出、背压和销毁

`sshdock_core_poll` 返回事件数组。单个会话的原始输出保持读取顺序，`closed` 在最终输出之后投递；不同会话可能交错。PTY 读取每批不超过 16 KiB，输出事件的 `data` 为 Base64。输出队列最多 512 个事件 / 4 MiB，单次 poll 最多取约 1 MiB；消费者落后时暂停读取，不丢弃存活核心的输出。应使用独立 poll 调度持续消费事件。

输入采用独立写线程和 1 MiB / 128 次写入的有界队列。ABI 请求只负责接受整个输入批次，不等待子进程读取 stdin。队列满时返回 `INPUT_BACKPRESSURE`，该次输入的所有字节均未被接受，调用方可提示用户稍后重试。关闭会话会取消尚未写入的输入。

销毁时先停止事件投递、唤醒等待的队列生产者，然后终止并回收拥有的子进程，继续排空 PTY 后等待线程结束。macOS 的高输出子进程退出可能等待内核终端缓冲区被排空。Windows 使用带 `KILL_ON_JOB_CLOSE` 的 Job Object 管理 shell 及继承的子进程，在释放 ConPTY 前终止它们。[Windows Job Object 官方说明](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

请求和 poll 可并发；销毁必须等所有外部调用结束后单独执行。返回的 C 字符串属于调用方，独立于核心生命周期，必须使用 `sshdock_core_string_free` 释放一次。空句柄、非法 JSON、非 UTF-8 参数被明确拒绝；已经释放的句柄和外部伪造指针属于调用方错误。

关闭整个应用时先调用可并发的 `core.shutdown`，取消 SSH 握手、文件传输、统计请求和本地进程，并唤醒背压队列；随后等待各请求队列返回，最后单独销毁句柄。`shutdown` 不释放句柄，也无需等待长传输自然完成。单次文件取消使用 `sftp.cancel`，不关闭终端会话。

## 验证范围

单元测试覆盖跨数据包 UTF-8 / CSI、组合字符与宽字符、颜色属性、备用屏幕、滚动、光标、模式切换、查询响应，以及输入 / 输出队列背压。macOS / Unix 集成测试运行真实 shell 验证中文、VT、PTY 尺寸、退出事件顺序、多会话并发、阻塞 stdin 的关闭、高输出销毁与进程回收。Windows CI 运行 ConPTY 中文、尺寸、退出顺序和阻塞 stdin / 子进程 Job 清理测试。C ABI 测试验证字符串在多次调用和核心销毁后独立存活及参数拒绝行为。

SSH 集成测试使用本机随机端口的加密 SSH / SFTP 服务 fixture，无需安装系统 sshd，覆盖主机指纹拒绝、密码拒绝/成功、加密私钥口令、远程终端输入/尺寸/退出、中文目录与空文件递归传输、链接安全边界、长传输与交互并行、单次取消、满输出自然退出顺序、关闭握手后的 socket EOF。真实系统 shell 行为与 Linux `/proc` 统计由 CI 的隔离 OpenSSH 验收补充；协议 fixture 的固定命令回复不作为真实 shell 执行证据。
