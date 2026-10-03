using System.Diagnostics;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using SSHDock.Native.Core;
using SSHDock.Native.Services;

namespace SSHDock.Native;

internal sealed class RemoteToolsWindow : Window
{
    private readonly AppCoordinator _coordinator;
    private readonly TerminalSession _session;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBox _path = new() { HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "远程路径" };
    private readonly ListView _entries = new() { DisplayMemberPath = "Display", SelectionMode = ListViewSelectionMode.Single };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly TextBlock _stats = new() { Text = "正在读取 Linux 状态…", TextWrapping = TextWrapping.Wrap };
    private readonly ProgressBar _progress = new() { Minimum = 0, Maximum = 100, Visibility = Visibility.Collapsed };
    private readonly CheckBox _pauseStats = new() { Content = "暂停服务器状态采样" };
    private readonly Button _cancel = new() { Content = "取消传输", IsEnabled = false };
    private readonly List<Button> _fileButtons = [];
    private SftpEntry[] _listing = [];
    private string? _transferId;
    private bool _busy, _closed, _allowClose;

    public RemoteToolsWindow(AppCoordinator coordinator, TerminalSession session)
    {
        _coordinator = coordinator; _session = session;
        Title = $"SSHDock · SFTP 与状态 · {session.Title}";
        AppIcon.Apply(this);
        AppWindow.Resize(new Windows.Graphics.SizeInt32(960, 680));
        var root = new Grid { RequestedTheme = ElementTheme.Dark, Padding = new Thickness(16), RowSpacing = 10,
            Background = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(255, 20, 23, 29)) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var stats = new StackPanel { Spacing = 6 }; stats.Children.Add(_stats); stats.Children.Add(_pauseStats); root.Children.Add(stats);
        var navigation = new Grid { ColumnSpacing = 8 };
        navigation.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        navigation.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        navigation.Children.Add(_path);
        var go = MakeButton("打开路径", () => NavigateAsync(_path.Text)); Grid.SetColumn(go, 1); navigation.Children.Add(go);
        Grid.SetRow(navigation, 1); root.Children.Add(navigation);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        foreach (var button in new[] {
            MakeButton("上级", () => NavigateAsync(RemoteAlgorithms.ParentPath(_path.Text))),
            MakeButton("刷新", () => NavigateAsync(_path.Text)), MakeButton("上传文件", () => UploadAsync(false)),
            MakeButton("上传目录", () => UploadAsync(true)), MakeButton("下载选中项", DownloadAsync),
            MakeButton("新建目录", MkdirAsync), MakeButton("删除", RemoveAsync) }) actions.Children.Add(button);
        actions.Children.Add(_cancel); Grid.SetRow(actions, 2); root.Children.Add(new ScrollViewer
        { Content = actions, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollMode = ScrollMode.Enabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, VerticalScrollMode = ScrollMode.Disabled });
        Grid.SetRow((FrameworkElement)root.Children[^1], 2);
        Grid.SetRow(_entries, 3); root.Children.Add(_entries);
        var footer = new StackPanel { Spacing = 8 }; footer.Children.Add(_progress); footer.Children.Add(_status);
        Grid.SetRow(footer, 4); root.Children.Add(footer);
        Content = root;
        _path.KeyDown += async (_, args) => { if (args.Key == Windows.System.VirtualKey.Enter) { args.Handled = true; await FileActionAsync(() => NavigateAsync(_path.Text)); } };
        _entries.DoubleTapped += async (_, _) =>
        {
            if (_entries.SelectedItem is SftpEntry { IsDirectory: true, IsSymlink: false } entry) await FileActionAsync(() => NavigateAsync(entry.Path));
        };
        _cancel.Click += async (_, _) =>
        {
            try { await CancelTransferAsync(); }
            catch (Exception exception) { if (!_closed) _status.Text = exception.Message; }
        };
        coordinator.TransferProgress += OnTransfer;
        session.Changed += OnSessionChanged;
        AppWindow.Closing += async (_, args) =>
        {
            if (_allowClose) return;
            if (_busy)
            {
                args.Cancel = true;
                var dialog = new ContentDialog { XamlRoot = root.XamlRoot, Title = "停止文件操作并关闭？",
                    Content = "未完成的传输会被取消；已写入的部分文件可能保留。", PrimaryButtonText = "停止并关闭",
                    CloseButtonText = "继续传输", DefaultButton = ContentDialogButton.Close };
                try { if (await dialog.ShowAsync() == ContentDialogResult.Primary) { await CancelTransferAsync(); Shutdown(); } }
                catch (Exception exception) { _status.Text = exception.Message; }
            }
            else Cleanup();
        };
        _ = InitializeAsync(); _ = SampleStatsAsync();
    }
    private Button MakeButton(string text, Func<Task> action)
    {
        var button = new Button { Content = text };
        button.Click += async (_, _) => await FileActionAsync(action);
        _fileButtons.Add(button); return button;
    }
    private async Task InitializeAsync()
    {
        await FileActionAsync(async () =>
        {
            var home = await _coordinator.Core.FileRequestAsync<SftpHome>("sftp.home", new { sessionId = _session.Id }, _lifetime.Token);
            await NavigateAsync(home.Path);
        });
    }
    private async Task NavigateAsync(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("请输入远程路径");
        var listing = await _coordinator.Core.FileRequestAsync<SftpListing>("sftp.list", new { sessionId = _session.Id, path }, _lifetime.Token);
        if (_closed) return;
        _path.Text = listing.Path;
        _listing = listing.Entries.OrderByDescending(item => item.IsDirectory).ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        _entries.ItemsSource = _listing; _status.Text = $"{_listing.Length} 项 · 双击文件夹打开；下载支持文件和目录。";
    }
    private async Task UploadAsync(bool folder)
    {
        var local = folder ? await NativePickers.OpenFolderAsync(this) : await NativePickers.OpenFileAsync(this);
        if (local is null) return;
        var name = Path.GetFileName(local.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var remote = RemoteAlgorithms.JoinPath(_path.Text, name);
        if (_listing.Any(item => item.Name == name) && !await ConfirmAsync("覆盖远程同名内容？", $"{remote}\n同名文件会被覆盖，目录内容会合并。", "覆盖并上传")) return;
        await TransferAsync("sftp.upload", local, remote);
        await NavigateAsync(_path.Text);
    }
    private async Task DownloadAsync()
    {
        var entry = SelectedEntry();
        if (entry.IsSymlink) throw new InvalidOperationException("下载不会跟随符号链接，请选择实际文件或目录。");
        if (entry.Name is "." or ".." || entry.Name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || Path.GetFileName(entry.Name) != entry.Name)
            throw new InvalidOperationException("此远程名称不能作为 Windows 文件名，请在服务器上重命名后下载。");
        var folder = await NativePickers.OpenFolderAsync(this);
        if (folder is null) return;
        var local = Path.Combine(folder, entry.Name);
        if ((File.Exists(local) || Directory.Exists(local)) && !await ConfirmAsync("覆盖本地同名内容？", $"{local}\n同名文件会被覆盖，目录内容会合并。", "覆盖并下载")) return;
        await TransferAsync("sftp.download", local, entry.Path);
    }
    private async Task TransferAsync(string method, string local, string remote)
    {
        _transferId = Guid.NewGuid().ToString("N"); _cancel.IsEnabled = true; _progress.Visibility = Visibility.Visible;
        _progress.IsIndeterminate = true; _status.Text = $"正在{(method == "sftp.upload" ? "上传" : "下载")}：{remote}";
        try
        {
            await _coordinator.Core.FileRequestAsync<JsonElement>(method, new { sessionId = _session.Id, localPath = local,
                remotePath = remote, transferId = _transferId }, _lifetime.Token);
            if (!_closed) { _status.Text = "传输完成。"; _progress.IsIndeterminate = false; _progress.Value = 100; }
        }
        finally { _transferId = null; if (!_closed) _cancel.IsEnabled = false; }
    }
    private async Task MkdirAsync()
    {
        var name = new TextBox { Header = "新目录名称" };
        var dialog = new ContentDialog { XamlRoot = ((FrameworkElement)Content).XamlRoot, Title = "新建远程目录", Content = name,
            PrimaryButtonText = "创建", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await _coordinator.Core.FileRequestAsync<JsonElement>("sftp.mkdir", new { sessionId = _session.Id, path = RemoteAlgorithms.JoinPath(_path.Text, name.Text) }, _lifetime.Token);
        await NavigateAsync(_path.Text);
    }
    private async Task RemoveAsync()
    {
        var entry = SelectedEntry();
        if (!await ConfirmAsync("删除远程文件？", entry.Path + (entry.IsDirectory && !entry.IsSymlink ? "\n整个目录及其内容将被删除；符号链接不跟随。" : "\n此操作将删除所选文件或链接。"), "删除")) return;
        await _coordinator.Core.FileRequestAsync<JsonElement>("sftp.remove", new { sessionId = _session.Id, path = entry.Path }, _lifetime.Token);
        await NavigateAsync(_path.Text);
    }
    private SftpEntry SelectedEntry() => _entries.SelectedItem as SftpEntry ?? throw new InvalidOperationException("请先选择远程文件或目录");
    private async Task<bool> ConfirmAsync(string title, string text, string button) =>
        await new ContentDialog { XamlRoot = ((FrameworkElement)Content).XamlRoot, Title = title, Content = text,
            PrimaryButtonText = button, CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close }.ShowAsync() == ContentDialogResult.Primary;
    private async Task FileActionAsync(Func<Task> action)
    {
        if (_busy || _closed) return;
        _busy = true; foreach (var button in _fileButtons) button.IsEnabled = false;
        try { await action(); }
        catch (OperationCanceledException) { }
        catch (Exception exception) { if (!_closed) _status.Text = exception is CoreException core ? $"{core.Code}：{core.Message}" : exception.Message; }
        finally { _busy = false; if (!_closed) foreach (var button in _fileButtons) button.IsEnabled = true; }
    }
    private void OnTransfer(CoreEvent item)
    {
        if (_closed || item.SessionId != _session.Id || item.TransferId != _transferId) return;
        var total = item.Total ?? 0; var transferred = item.Transferred ?? 0;
        _progress.IsIndeterminate = total <= 0;
        if (total > 0) _progress.Value = Math.Clamp(100d * transferred / total, 0, 100);
        _status.Text = $"{SftpEntry.FormatBytes(transferred)} / {(total > 0 ? SftpEntry.FormatBytes(total) : "计算中")} · {item.State}" +
            (string.IsNullOrWhiteSpace(item.Message) ? "" : $" · {item.Message}");
    }
    private async Task CancelTransferAsync()
    {
        if (_transferId is null) return;
        await _coordinator.Core.RequestAsync<JsonElement>("sftp.cancel", new { sessionId = _session.Id, transferId = _transferId });
        if (!_closed) _status.Text = "正在取消传输；已写入的部分文件可能保留。";
    }
    private async Task SampleStatsAsync()
    {
        LinuxStats? previous = null; long timestamp = 0;
        try
        {
            while (!_closed)
            {
                if (_pauseStats.IsChecked != true)
                {
                    var current = await _coordinator.Core.StatsRequestAsync<LinuxStats>("stats.sample", new { sessionId = _session.Id }, _lifetime.Token);
                    if (_closed) return;
                    if (!current.Supported) { _stats.Text = "当前服务器不支持 Linux /proc 状态统计。"; _pauseStats.IsChecked = true; }
                    else
                    {
                        var now = Stopwatch.GetTimestamp();
                        var seconds = previous is null ? 0 : Stopwatch.GetElapsedTime(timestamp, now).TotalSeconds;
                        var cpu = previous is null ? "采样中" : $"{RemoteAlgorithms.CpuPercent(previous, current):0.0}%";
                        var rx = previous is null ? 0 : RemoteAlgorithms.BytesPerSecond(previous.Rx, current.Rx, seconds);
                        var tx = previous is null ? 0 : RemoteAlgorithms.BytesPerSecond(previous.Tx, current.Tx, seconds);
                        _stats.Text = $"CPU {cpu} · 内存 {SftpEntry.FormatBytes(current.MemTotal - Math.Min(current.MemAvailable, current.MemTotal))} / {SftpEntry.FormatBytes(current.MemTotal)} · 负载 {current.Load1:0.00}\n接收 {SftpEntry.FormatBytes(rx)}/s · 发送 {SftpEntry.FormatBytes(tx)}/s";
                        previous = current; timestamp = now;
                    }
                }
                else previous = null;
                await Task.Delay(2000, _lifetime.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception exception) { if (!_closed) _stats.Text = $"状态采样失败：{exception.Message}（关闭并重新打开工具窗口可重试）"; }
    }
    private void OnSessionChanged() { if (_session.Closed && !_closed) Shutdown(); }
    private void Cleanup()
    {
        if (_closed) return;
        _closed = true; _lifetime.Cancel(); _coordinator.TransferProgress -= OnTransfer; _session.Changed -= OnSessionChanged;
    }
    public void Shutdown()
    {
        if (_closed) return;
        _ = CancelBeforeClosingAsync(); Cleanup(); _allowClose = true; Close();
    }
    private async Task CancelBeforeClosingAsync()
    {
        try { await CancelTransferAsync(); }
        catch (Exception exception) when (exception is CoreException or ObjectDisposedException) { }
    }
}
