using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using SSHDock.Native.Core;
using SSHDock.Native.Services;

namespace SSHDock.Native.Controls;

internal sealed class ConnectionsPane : UserControl, IDisposable
{
    private readonly MainWindow _window;
    private readonly AppCoordinator _coordinator;
    private readonly ListView _list = new() { Height = 175, DisplayMemberPath = "Display", SelectionMode = ListViewSelectionMode.Single };
    private readonly TextBox _name = new() { Header = "连接名称" };
    private readonly TextBox _host = new() { Header = "主机名 / IP" };
    private readonly NumberBox _port = new() { Header = "SSH 端口", Value = 22, Minimum = 1, Maximum = 65535, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
    private readonly TextBox _username = new() { Header = "用户名" };
    private readonly ComboBox _auth = new() { Header = "认证方式", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly TextBox _keyPath = new() { Header = "私钥文件路径" };
    private readonly PasswordBox _password = new() { Header = "密码" };
    private readonly PasswordBox _passphrase = new() { Header = "私钥口令（未加密可留空）" };
    private readonly CheckBox _remember = new() { Content = "保存到 Windows 凭据管理器" };
    private readonly TextBlock _notice = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly Button _connect = new() { Content = "连接 SSH", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly Button _keyBrowse = new() { Content = "选择私钥文件" };
    private string _id = Guid.NewGuid().ToString("N");
    private bool _loading, _connecting, _disposed;

    public ConnectionsPane(MainWindow window, AppCoordinator coordinator)
    {
        _window = window; _coordinator = coordinator;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        _auth.Items.Add("密码"); _auth.Items.Add("私钥 + 口令"); _auth.SelectedIndex = 0;
        var panel = new StackPanel { Spacing = 8, Padding = new Thickness(14) };
        panel.Children.Add(new TextBlock { Text = "SSH 服务器", FontSize = 20 });
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        var add = new Button { Content = "新建" }; add.Click += (_, _) => NewProfile();
        var delete = new Button { Content = "删除" }; delete.Click += async (_, _) => await RunAsync(DeleteAsync);
        var import = new Button { Content = "导入配置" }; import.Click += async (_, _) => await RunAsync(ImportAsync);
        foreach (var button in new[] { add, delete, import }) actions.Children.Add(button);
        panel.Children.Add(actions); panel.Children.Add(_list);
        foreach (var input in new FrameworkElement[] { _name, _host, _port, _username, _auth, _keyPath, _keyBrowse, _password, _passphrase, _remember }) panel.Children.Add(input);
        var save = new Button { Content = "保存 / 更新配置", HorizontalAlignment = HorizontalAlignment.Stretch };
        save.Click += (_, _) => { try { SaveProfile(); _notice.Text = "连接配置已保存。"; } catch (Exception exception) { _notice.Text = exception.Message; } };
        panel.Children.Add(save); panel.Children.Add(_connect);
        var forget = new Button { Content = "忘记此主机信任", HorizontalAlignment = HorizontalAlignment.Stretch };
        forget.Click += async (_, _) => await RunAsync(ForgetHostAsync);
        panel.Children.Add(forget); panel.Children.Add(_notice);
        Content = new ScrollViewer { Content = panel, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        _list.SelectionChanged += (_, _) => { if (!_loading && _list.SelectedItem is ConnectionProfile profile) LoadProfile(profile); };
        _auth.SelectionChanged += (_, _) => UpdateAuthVisibility();
        _keyBrowse.Click += async (_, _) => await RunAsync(async () => { var path = await NativePickers.OpenFileAsync(_window); if (path is not null) _keyPath.Text = path; });
        _connect.Click += async (_, _) => await RunAsync(ConnectAsync);
        coordinator.Connections.Changed += RefreshList;
        RefreshList(); UpdateAuthVisibility();
        _notice.Text = coordinator.Connections.StartupNotice ?? "选择连接后可编辑。首次连接需核对服务器指纹。";
    }
    private void RefreshList()
    {
        if (_disposed) return;
        _loading = true;
        _list.ItemsSource = _coordinator.Connections.Connections;
        _list.SelectedItem = _coordinator.Connections.Connections.FirstOrDefault(item => item.Id == _id);
        _loading = false;
    }
    private void LoadProfile(ConnectionProfile profile)
    {
        _id = profile.Id; _name.Text = profile.Name; _host.Text = profile.Host; _port.Value = profile.Port;
        _username.Text = profile.Username; _auth.SelectedIndex = profile.AuthType == "key" ? 1 : 0; _keyPath.Text = profile.KeyPath;
        _password.Password = ""; _passphrase.Password = ""; _remember.IsChecked = false;
        try
        {
            var secret = CredentialVault.Read(profile.Id, profile.AuthType == "key" ? "passphrase" : "password");
            if (secret is not null) { _remember.IsChecked = true; if (profile.AuthType == "key") _passphrase.Password = secret; else _password.Password = secret; }
            _notice.Text = secret is null ? "请重新输入认证凭据；配置文件只包含连接元数据。" : "已读取 Windows 凭据管理器中的认证凭据。";
        }
        catch (Exception exception) { _notice.Text = exception.Message; }
    }
    private void NewProfile()
    {
        _id = Guid.NewGuid().ToString("N"); _list.SelectedItem = null; _name.Text = _host.Text = _username.Text = _keyPath.Text = "";
        _password.Password = _passphrase.Password = ""; _port.Value = 22; _auth.SelectedIndex = 0; _remember.IsChecked = false;
        _notice.Text = "填写连接配置，保存或连接后加入列表。";
    }
    private void UpdateAuthVisibility()
    {
        var key = _auth.SelectedIndex == 1;
        _keyPath.Visibility = _keyBrowse.Visibility = _passphrase.Visibility = key ? Visibility.Visible : Visibility.Collapsed;
        _password.Visibility = key ? Visibility.Collapsed : Visibility.Visible;
    }
    private ConnectionProfile ReadProfile() => new ConnectionProfile(_id, _name.Text.Trim(), _host.Text.Trim(),
        double.IsFinite(_port.Value) ? (int)_port.Value : 0, _username.Text.Trim(), _auth.SelectedIndex == 1 ? "key" : "password", _keyPath.Text.Trim()).Validate();
    private ConnectionProfile SaveProfile()
    {
        var profile = ReadProfile();
        // Remove both former auth secrets, including when switching auth types.
        CredentialVault.Delete(profile.Id);
        if (_remember.IsChecked == true)
            CredentialVault.Save(profile.Id, profile.AuthType == "key" ? "passphrase" : "password", profile.AuthType == "key" ? _passphrase.Password : _password.Password);
        _coordinator.Connections.Save(profile);
        return profile;
    }
    private async Task ConnectAsync()
    {
        if (_connecting || _window.IsClosing) return;
        var profile = SaveProfile();
        var password = _password.Password; var passphrase = _passphrase.Password;
        _connecting = true; _connect.IsEnabled = _list.IsEnabled = false;
        try
        {
            _notice.Text = "正在获取服务器主机密钥…";
            var key = await _coordinator.Core.ConnectionRequestAsync<HostKey>("ssh.hostKey", new { host = profile.Host, port = profile.Port });
            if (_disposed || _window.IsClosing) return;
            var known = _coordinator.Connections.KnownHost(profile);
            if (known is not null && known != key)
            {
                await _window.ShowConnectionDialogAsync(new ContentDialog
                {
                    Title = "主机密钥已改变，连接已拒绝",
                    Content = $"{profile.Host}:{profile.Port}\n原指纹：{known.Fingerprint}\n当前指纹：{key.Fingerprint}\n\n请通过可信渠道核验。确认变更后，使用“忘记此主机信任”再重新连接。",
                    CloseButtonText = "关闭"
                });
                _notice.Text = "主机密钥变化，未发送认证凭据。"; return;
            }
            if (known is null)
            {
                var result = await _window.ShowConnectionDialogAsync(new ContentDialog
                {
                    Title = "信任此 SSH 主机？", Content = $"{profile.Host}:{profile.Port}\n算法：{key.Algorithm}\n指纹：{key.Fingerprint}\n\n请与服务器管理员提供的指纹核对。",
                    PrimaryButtonText = "指纹一致，信任并连接", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close
                });
                if (result != ContentDialogResult.Primary) { _notice.Text = "已取消连接。"; return; }
                _coordinator.Connections.TrustHost(profile, key);
            }
            _notice.Text = "正在认证并打开远程终端…";
            var session = await _coordinator.ConnectSshAsync(profile, password, passphrase, key);
            await _coordinator.AttachCreatedSessionAsync(_window, session);
            _notice.Text = $"已连接 {profile.Name}，可在工具栏打开 SFTP 与 Linux 状态。";
        }
        finally { _connecting = false; if (!_disposed) _connect.IsEnabled = _list.IsEnabled = true; }
    }
    private async Task DeleteAsync()
    {
        if (_list.SelectedItem is not ConnectionProfile profile) return;
        if (await _window.ShowConnectionDialogAsync(new ContentDialog { Title = "删除 SSH 连接配置？", Content = profile.Display,
            PrimaryButtonText = "删除配置和已保存凭据", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close }) != ContentDialogResult.Primary) return;
        CredentialVault.Delete(profile.Id); _coordinator.Connections.Delete(profile.Id); NewProfile();
    }
    private async Task ImportAsync()
    {
        var path = await NativePickers.OpenFileAsync(_window);
        if (path is null) return;
        var count = _coordinator.Connections.ImportMetadata(path);
        _notice.Text = $"已导入 {count} 个连接；旧密码、私钥口令和密码编码字段均未导入，请重新输入。";
    }
    private async Task ForgetHostAsync()
    {
        var profile = ReadProfile();
        var known = _coordinator.Connections.KnownHost(profile);
        if (known is null) { _notice.Text = "此主机尚未建立信任。"; return; }
        if (await _window.ShowConnectionDialogAsync(new ContentDialog { Title = "忘记已知主机密钥？", Content = $"{profile.Host}:{profile.Port}\n{known.Fingerprint}\n下次连接必须重新核验指纹。",
            PrimaryButtonText = "忘记信任", CloseButtonText = "取消", DefaultButton = ContentDialogButton.Close }) != ContentDialogResult.Primary) return;
        _coordinator.Connections.ForgetHost(profile); _notice.Text = "已忘记旧信任，请重新连接并核验指纹。";
    }
    private async Task RunAsync(Func<Task> action)
    {
        try { await action(); }
        catch (Exception exception) { if (!_disposed) _notice.Text = exception is CoreException core ? $"{core.Code}：{core.Message}" : exception.Message; }
    }
    public void Dispose()
    {
        _disposed = true; _coordinator.Connections.Changed -= RefreshList;
        _password.Password = _passphrase.Password = "";
    }
}
