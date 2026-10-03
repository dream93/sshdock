# Windows 本地终端技术原型

这一阶段验证 WinUI 3 原生界面、Win2D 终端绘制和 Rust 会话核心，不包含 SSH/SFTP。界面没有 WebView、xterm.js 或 Electron。

## 构建和运行

在 Windows 上安装 .NET 10 SDK、Rust MSVC 工具链，以及 Visual Studio 的 C++ 桌面开发组件和 Windows SDK。ARM64 交叉构建还需要 ARM64 C++ 编译工具及库。

从仓库根目录执行：

```powershell
./native/windows/build.ps1 -Architecture x64 -Configuration Release -RunSmokeTests
./native/windows/build.ps1 -Architecture arm64 -Configuration Release
./native/windows/artifacts/x64/SSHDock.Native.exe
```

脚本使用 Cargo.lock 构建对应 MSVC 架构的 `sshdock_core.dll`，将自包含 .NET / Windows App SDK 程序发布到 `native/windows/artifacts/<arch>/`，然后把同架构 Rust DLL 复制到应用目录。运行时不要求用户另外安装 .NET 或 Windows App Runtime；本原型尚未生成签名安装包。

依赖固定为官方稳定 [Windows App SDK 1.8.12](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/release-notes/windows-app-sdk-1-8?pivots=stable)（`1.8.260921001`）和 [Win2D 1.4.0](https://www.nuget.org/packages/Microsoft.Graphics.Win2D/1.4.0)。这是原型验证组合，后续发行前需要评估迁移到当前 Windows App SDK 主版本。

## 交互

- `+` 或“新建终端”创建新的 PTY，可选择系统默认 shell、PowerShell、cmd 或 WSL。
- 每个标签使用独立会话，改变字体和窗口尺寸会根据实际字体及显示器 DPI 重新计算字符网格。
- 鼠标拖动选择文本，`Ctrl+Shift+C` / `Ctrl+Insert` 复制；`Ctrl+V`、`Ctrl+Shift+V` / `Shift+Insert` 粘贴。根据终端模式启用 bracketed paste。
- 滚轮滚动历史，`Shift+PageUp/PageDown` 按页滚动。输入时回到实时输出。
- 箭头、Home/End、功能键和 Ctrl 组合发送终端控制序列；箭头支持 application cursor 模式。
- 中文输入使用位于终端光标旁的原生 TextBox 代理。组合文本只在本地显示，提交后才发送给 PTY。候选框位置由原生文本服务决定。
- “移到独立窗口”把已有会话迁移到新窗口，不创建第二个 PTY。关闭独立窗口会把会话移回仍存在的原窗口；原窗口已关闭时移到另一个现存窗口。所有窗口都遵循“剩余窗口承接会话”的规则。
- 关闭最后一个窗口且仍有运行中的会话时，显示结束会话确认。关闭运行中的标签也需要确认，随后结束该标签所属会话。退出时停止 poll、释放核心并清理子进程。
- 核心输入队列满时展示 `INPUT_BACKPRESSURE` 错误并保留未发送字符；“重试输入”按原顺序再次提交。每会话 UI 待发送输入有 1 MiB UTF-8 字节上限，超限整次拒绝新追加并明确提示未发送。“取消未发送输入”清空尚未提交的输入，已提交的输入请求无法撤回；会话关闭时也会清空待发送缓冲。

## 实现边界和验证

`NativeCoreClient` 在后台执行 JSON ABI 请求；请求串行维护顺序，poll 使用独立后台通道持续排空有界输出队列。SafeHandle 保证每次 P/Invoke 调用及已经排队的 poll 持有核心生命周期，所有响应字符串由核心释放函数释放。启动时验证 ABI 版本为 1。

每个 poll 批次先压缩为不含 PTY 原始字节的通知，最多有一个批次等待 UI 确认，确认后才继续 poll；退出取消会直接结束确认等待。仅有活动视图的会话请求屏幕快照。创建期间到达的未知会话通知临时保存在有界元数据缓冲中，注册后按序重放，短命 shell 的退出和错误也能显示。每个终端标签创建一个 Win2D CanvasControl，使用同一画布绘制该终端所有单元格。VT 解析、网格、历史和模式保存在共享 Rust 核心，UI 不再解析控制序列。视图加载、卸载和迁移更新唯一 resize owner，过期的延迟 resize 在进入核心前再次检查 owner。

无 UI 的真实 C# / Rust ABI 测试可以在 macOS 运行：

```sh
cargo build --locked --manifest-path native/core/Cargo.toml
SSHDOCK_CORE_LIBRARY="$PWD/native/core/target/debug/libsshdock_core.dylib" \
  dotnet run --project native/windows/CoreSmokeTest/CoreSmokeTest.csproj
```

测试覆盖按键编码、Unicode 选区、输入字节上限/取消/旧请求确认、短命会话事件重放、ABI 版本、本地 PTY 字节输出、快照解析、resize、关闭事件、并发 poll/释放和重复释放。仅运行纯算法检查可加 `-- --algorithms-only`。

Windows 自包含产物还提供真实启动 smoke 模式：

```powershell
./native/windows/artifacts/x64/SSHDock.Native.exe --startup-smoke --smoke-report "$PWD/native/windows/artifacts/x64/startup-smoke.json"
```

该模式创建真实 XAML 窗口、本地 PTY 和 Win2D 首帧，等待已绘制的 cmd 提示符后，通过与 Enter 一致的 CR 输入命令，再等待 shell 执行变量展开后的测试标记；通过后写入 `ok: true` 的 JSON 报告、自动清理会话并退出 0。失败报告包含阶段、Canvas 实际尺寸、终端行列数、已绘制文本、核心快照文本和会话状态并退出 1，绘制/输出等待限制为 20 秒；CI 还应给整个进程设置超时，捕获应用初始化之前的故障。此模式跳过退出确认，仅用于自动验证，普通启动保留关闭保护。TabView、TabViewItem 和终端内容显式 Stretch，让 Canvas 填满窗口分配的内容区域。

`App.xaml` 只负责合并官方 `XamlControlsResources`，窗口和终端继续由 C# 与 Win2D 创建。该应用定义生成 SDK 的 XAML 元数据与应用资源。当前非 MSIX 构建流程生成的合并资源索引为根目录的 `SSHDock.Native.pri`；项目通过 SDK 的 `ProjectPriFullPath` / `ProjectPriFileName` 显式纳入发布，补足上游 [WindowsAppSDK #6720](https://github.com/microsoft/WindowsAppSDK/issues/6720) 的缺项，构建脚本会检查该文件存在。

macOS 能还原依赖并运行上述非 UI 桥接测试。WinUI 应用的编译和发布需要 Windows，因为 `App.xaml` 的官方 XAML 编译器、`mt.exe` 和 `makepri.exe` 都是 Windows 工具。下面的源码编译检查也应在 Windows 上执行，它不会生成可运行的完整发布包：

```sh
dotnet restore native/windows/SSHDock.Native/SSHDock.Native.csproj -r win-x64 -p:Platform=x64
dotnet build native/windows/SSHDock.Native/SSHDock.Native.csproj --no-restore \
  --configuration Release --runtime win-x64 \
  -p:Platform=x64 -p:WindowsAppSDKSelfContained=false \
  -p:GenerateAppxPackageOnBuild=false
```

Windows 上仍需实际验证候选框位置、IME Enter/Escape 行为、125%/150%/200% 缩放、跨显示器移动、Vim/tmux、鼠标选择和独立窗口迁移。源码编译和 ABI 测试不等于这些交互已验收。阶段 1 不承诺终端无障碍文本模式、鼠标报告、超链接、终端图像或完整高级协议；这些能力需要下一阶段专门验收。
