using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using SSHDock.Native.Controls;

namespace SSHDock.Native;

internal sealed class MainWindow : Window
{
    private readonly AppCoordinator _coordinator;
    private readonly TabView _tabs = new() { TabWidthMode = TabViewWidthMode.SizeToContent, IsAddTabButtonVisible = true };
    private readonly ComboBox _shell = new() { Width = 145, SelectedIndex = 0 };
    private readonly ComboBox _font = new() { Width = 145, SelectedIndex = 0 };
    private readonly NumberBox _fontSize = new() { Value = 14, Minimum = 10, Maximum = 32, Width = 80, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
    private readonly TextBlock _status = new() { Text = "正在启动本地终端…", Margin = new Thickness(12, 6, 12, 6), TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Dictionary<TerminalSession, (TabViewItem Tab, TerminalSurface Surface, Action Listener)> _items = [];
    private bool _closing;
    private bool _allowClose;
    private bool _dialogOpen;
    public MainWindow? HomeWindow { get; }

    public IEnumerable<TerminalSession> Sessions => _items.Keys;
    private TerminalSession? SelectedSession => _items.FirstOrDefault(pair => ReferenceEquals(pair.Value.Tab, _tabs.SelectedItem)).Key;

    public MainWindow(AppCoordinator coordinator, MainWindow? homeWindow = null)
    {
        _coordinator = coordinator;
        HomeWindow = homeWindow;
        Title = "SSHDock Native · 本地终端";
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1100, 740));
        _shell.Items.Add("系统默认 shell");
        _shell.Items.Add("pwsh.exe");
        _shell.Items.Add("powershell.exe");
        _shell.Items.Add("cmd.exe");
        _shell.Items.Add("wsl.exe");
        foreach (var family in new[] { "Cascadia Mono", "Consolas", "Courier New" }) _font.Items.Add(family);
        _shell.SelectedIndex = 0;
        _font.SelectedIndex = 0;
        _font.SelectionChanged += (_, _) => UpdateFonts();
        _fontSize.ValueChanged += (_, _) => UpdateFonts();

        var newButton = new Button { Content = "新建终端" };
        newButton.Click += async (_, _) => await NewTerminalAsync();
        var detachButton = new Button { Content = "移到独立窗口" };
        detachButton.Click += (_, _) => { if (SelectedSession is { } session) _coordinator.DetachSession(this, session); };
        var returnButton = new Button { Content = "移回其他窗口" };
        returnButton.Click += (_, _) => { if (SelectedSession is { } session) _coordinator.MoveToOtherWindow(this, session); };
        var retryButton = new Button { Content = "重试输入" };
        retryButton.Click += async (_, _) => { if (SelectedSession is { } session) await session.SendAsync(""); };
        var toolbar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(12, 10, 12, 10) };
        foreach (var control in new FrameworkElement[] { newButton, _shell, detachButton, returnButton, retryButton, _font, _fontSize }) toolbar.Children.Add(control);

        _tabs.AddTabButtonClick += async (_, _) => await NewTerminalAsync();
        _tabs.TabCloseRequested += async (_, args) =>
        {
            var session = _items.FirstOrDefault(pair => pair.Value.Tab == args.Tab).Key;
            if (session is null || _dialogOpen || _closing) return;
            _dialogOpen = true;
            try
            {
                if (!session.Closed && !await ConfirmSessionCloseAsync(session)) return;
                RemoveSession(session);
                await _coordinator.CloseSessionAsync(session);
            }
            catch (Exception exception) { _status.Text = exception.Message; }
            finally { _dialogOpen = false; }
        };
        _tabs.SelectionChanged += (_, _) =>
        {
            if (SelectedSession is { } session && _items.TryGetValue(session, out var item))
            {
                item.Surface.FocusInput();
                UpdateStatus(session);
            }
        };

        var root = new Grid { RequestedTheme = ElementTheme.Dark, Background = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(255, 20, 23, 29)) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.Children.Add(new ScrollViewer
        {
            Content = toolbar,
            HorizontalScrollMode = ScrollMode.Enabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Disabled,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled
        });
        Grid.SetRow(_tabs, 1);
        root.Children.Add(_tabs);
        Grid.SetRow(_status, 2);
        root.Children.Add(_status);
        Content = root;

        AppWindow.Closing += async (_, args) =>
        {
            if (_allowClose) return;
            args.Cancel = true;
            if (_closing || _dialogOpen) return;
            _closing = true;
            try { if (!await _coordinator.CloseWindowAsync(this)) _closing = false; }
            catch (Exception exception) { _status.Text = exception.Message; _closing = false; }
        };
    }

    public async Task NewTerminalAsync()
    {
        if (_closing) return;
        try
        {
            var shell = _shell.SelectedIndex <= 0 ? null : _shell.SelectedItem?.ToString();
            AddSession(await _coordinator.CreateSessionAsync(shell));
        }
        catch (Exception exception) { _status.Text = $"创建失败：{exception.Message}"; }
    }

    public void AddSession(TerminalSession session)
    {
        if (_items.ContainsKey(session)) return;
        var surface = new TerminalSurface(session);
        surface.SetFont(_font.SelectedItem?.ToString() ?? "Cascadia Mono", (float)_fontSize.Value);
        var tab = new TabViewItem { Header = session.Title, Content = surface, IsClosable = true };
        Action listener = () =>
        {
            tab.Header = session.Title;
            if (SelectedSession == session) UpdateStatus(session);
        };
        session.Changed += listener;
        _items.Add(session, (tab, surface, listener));
        _tabs.TabItems.Add(tab);
        _tabs.SelectedItem = tab;
    }

    public void RemoveSession(TerminalSession session)
    {
        if (!_items.Remove(session, out var item)) return;
        session.Changed -= item.Listener;
        item.Surface.Dispose();
        _tabs.TabItems.Remove(item.Tab);
        item.Tab.Content = null;
        if (_items.Count == 0) _status.Text = "点击 + 新建本地终端";
    }

    private void UpdateFonts()
    {
        foreach (var item in _items.Values) item.Surface.SetFont(_font.SelectedItem?.ToString() ?? "Cascadia Mono", (float)_fontSize.Value);
    }

    private void UpdateStatus(TerminalSession session)
    {
        var grid = session.Snapshot;
        _status.Text = $"{session.Status} · {session.Cwd} · {grid?.Cols ?? 100} × {grid?.Rows ?? 30} · Ctrl+Shift+C/V 复制/粘贴" +
            (grid?.Offset > 0 ? $" · 历史偏移 {grid.Offset}" : "");
    }

    public void FinishClose()
    {
        _allowClose = true;
        Close();
    }

    public async Task<bool> ConfirmExitAsync()
    {
        var dialog = new ContentDialog
        {
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
            Title = "结束本地会话并退出？",
            Content = "最后一个窗口中的 shell 和它们启动的进程将被终止。",
            PrimaryButtonText = "结束会话并退出",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private async Task<bool> ConfirmSessionCloseAsync(TerminalSession session)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = ((FrameworkElement)Content).XamlRoot,
            Title = $"结束 {session.Title}？",
            Content = "此标签中的 shell 和它启动的进程将被终止。",
            PrimaryButtonText = "结束会话",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Close
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }
}
