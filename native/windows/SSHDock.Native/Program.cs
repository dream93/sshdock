using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace SSHDock.Native;

internal static class Program
{
    [STAThread]
    public static void Main()
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(parameters =>
        {
            SynchronizationContext.SetSynchronizationContext(
                new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
        });
    }
}

internal sealed class App : Application
{
    private AppCoordinator? _coordinator;

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        Resources.MergedDictionaries.Add(new Microsoft.UI.Xaml.Controls.XamlControlsResources());
        try
        {
            var core = await Task.Run(() => new Core.NativeCoreClient());
            _coordinator = new AppCoordinator(core, DispatcherQueue.GetForCurrentThread());
            var window = _coordinator.OpenWindow();
            window.Activate();
            await window.NewTerminalAsync();
        }
        catch (Exception exception)
        {
            var window = new Window
            {
                Title = "SSHDock · 启动失败",
                Content = new Microsoft.UI.Xaml.Controls.TextBlock
                {
                    Text = $"无法启动本地终端：\n{exception.Message}\n\n请通过 native/windows/build.ps1 构建，确保 sshdock_core.dll 与应用位于同一目录。",
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(24)
                }
            };
            window.Activate();
        }
    }
}
