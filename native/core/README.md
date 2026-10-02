# Rust 共享核心

第一阶段提供本地 PTY / ConPTY、会话生命周期和 Windows 使用的 VT 网格。SSH、SFTP 和连接配置在后续阶段接入。

使用 Rust 1.99.0，执行：

```sh
cargo build --locked --manifest-path native/core/Cargo.toml
cargo test --locked --manifest-path native/core/Cargo.toml
cargo clippy --locked --manifest-path native/core/Cargo.toml --all-targets -- -D warnings
```

库产物为 `libsshdock_core.a`、`libsshdock_core.dylib`（macOS）或 `sshdock_core.dll`（Windows）。公开 C ABI 和内存规则位于 `native/include/sshdock_core.h`。

## JSON 协议

请求格式为 `{"method":"方法","params":{...}}`，成功响应为 `{"ok":true,"result":...}`，失败响应为 `{"ok":false,"error":{"code":"错误码","message":"说明"}}`。

| 方法 | 参数 | 返回结果 |
| --- | --- | --- |
| `core.info` | `{}` | `abiVersion: 1`、核心版本 |
| `local.create` | `cols`、`rows`、可选 `cwd` / `shell` / `terminalEngine` | `sessionId`、`title`、`cwd`、`closed` |
| `sessions.list` | `{}` | 会话数组 |
| `sessions.input` | `sessionId`、`data`（Base64 字节） | `{}` |
| `sessions.resize` | `sessionId`、`cols`、`rows` | `{}` |
| `sessions.close` | `sessionId` | `{}`；可重复调用 |
| `terminal.snapshot` | `sessionId` | 当前可视网格 |
| `terminal.scroll` | `sessionId`、有符号 `delta` | `{}`；正数向历史滚动 |
| `terminal.resetScroll` | `sessionId` | `{}`；回到输出底部 |

`terminalEngine` 默认为 `false`。SwiftTerm 接收原始输出并维护自己的终端状态；Windows 创建会话时启用 `terminalEngine`，使用 Alacritty 的连续 VT 解析器维护网格、光标、历史、备用屏幕和终端查询响应。

Windows 的 `portable-pty` 适配器使用 `PSEUDOCONSOLE_INHERIT_CURSOR`，因此 ConPTY 启动时会输出 `ESC[6n` 光标位置查询。启用 `terminalEngine` 时核心自动回复；使用原始输出模式的消费者必须连续解析 VT 查询，并通过 `sessions.input` 回复光标位置（初始位置可回复 `ESC[1;1R`），再进行后续操作。只读取字节并忽略查询会阻塞 ConPTY 输出，需要输出的 Windows PTY 测试与 WinUI 应用均启用终端引擎。[CreatePseudoConsole 官方说明](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)

快照字段为 `cols`、`rows`、`title`、`offset`、`cursor: {row,col,visible}`、`modes: {applicationCursor,bracketedPaste}` 和 `cells`。每个 cell 包含 `row,col,text,fg,bg,bold,underline,wide`；坐标从 0 开始，相对于可视区域；颜色为 `#rrggbb`。宽字符的后续占位 cell 保留背景，但 `text` 为空。`offset` 是当前历史偏移，底部为 0；查看历史时隐藏光标。

列数支持 2–4096、行数支持 1–1024，可视 cell 总数不超过 200000。每个会话保留最多 10000 行历史，同时限制历史总 cell 数为 2000000。单个核心最多保留 32 个会话；明确关闭且已经完成事件投递的会话在下次创建时释放。

## 输出、背压和销毁

`sshdock_core_poll` 返回事件数组。单个会话的原始输出保持读取顺序，`closed` 在最终输出之后投递；不同会话可能交错。PTY 读取每批不超过 16 KiB，输出事件的 `data` 为 Base64。输出队列最多 512 个事件 / 4 MiB，单次 poll 最多取约 1 MiB；消费者落后时暂停读取，不丢弃存活核心的输出。应使用独立 poll 调度持续消费事件。

输入采用独立写线程和 1 MiB / 128 次写入的有界队列。ABI 请求只负责接受整个输入批次，不等待子进程读取 stdin。队列满时返回 `INPUT_BACKPRESSURE`，该次输入的所有字节均未被接受，调用方可提示用户稍后重试。关闭会话会取消尚未写入的输入。

销毁时先停止事件投递、唤醒等待的队列生产者，然后终止并回收拥有的子进程，继续排空 PTY 后等待线程结束。macOS 的高输出子进程退出可能等待内核终端缓冲区被排空。Windows 使用带 `KILL_ON_JOB_CLOSE` 的 Job Object 管理 shell 及继承的子进程，在释放 ConPTY 前终止它们。[Windows Job Object 官方说明](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

请求和 poll 可并发；销毁必须等所有外部调用结束后单独执行。返回的 C 字符串属于调用方，独立于核心生命周期，必须使用 `sshdock_core_string_free` 释放一次。空句柄、非法 JSON、非 UTF-8 参数被明确拒绝；已经释放的句柄和外部伪造指针属于调用方错误。

## 验证范围

单元测试覆盖跨数据包 UTF-8 / CSI、组合字符与宽字符、颜色属性、备用屏幕、滚动、光标、模式切换、查询响应，以及输入 / 输出队列背压。macOS / Unix 集成测试运行真实 shell 验证中文、VT、PTY 尺寸、退出事件顺序、多会话并发、阻塞 stdin 的关闭、高输出销毁与进程回收。Windows CI 运行 ConPTY 中文、尺寸、退出顺序和阻塞 stdin / 子进程 Job 清理测试。C ABI 测试验证字符串在多次调用和核心销毁后独立存活及参数拒绝行为。
