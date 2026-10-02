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
    private MainWindow? _window;

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var smoke = Environment.GetCommandLineArgs().Contains("--startup-smoke");
        var stage = "xaml-resources";
        try
        {
            Resources.MergedDictionaries.Add(new Microsoft.UI.Xaml.Controls.XamlControlsResources());
            stage = "native-core";
            var core = await Task.Run(() => new Core.NativeCoreClient());
            _coordinator = new AppCoordinator(core, DispatcherQueue.GetForCurrentThread());
            stage = "xaml-window";
            _window = _coordinator.OpenWindow();
            _window.Activate();
            stage = "local-pty";
            await _window.NewTerminalAsync(smoke ? "cmd.exe" : null);
            if (smoke)
            {
                stage = "canvas-and-pty-output";
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                await _window.RunStartupSmokeAsync(timeout.Token);
                await WriteSmokeReportAsync(new
                {
                    ok = true, xamlWindow = true, canvasFirstFrame = true, localPty = true, ptyOutput = true,
                    architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString()
                });
                await _coordinator.CloseWindowAsync(_window, confirm: false);
                Environment.Exit(0);
            }
        }
        catch (Exception exception)
        {
            if (smoke)
            {
                await WriteSmokeReportAsync(new { ok = false, stage, error = exception.ToString() });
                if (_coordinator is not null && _window is not null)
                {
                    try { await _coordinator.CloseWindowAsync(_window, confirm: false); }
                    catch (Exception closeException) { Console.Error.WriteLine(closeException); }
                }
                Environment.Exit(1);
                return;
            }
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

    private static async Task WriteSmokeReportAsync(object report)
    {
        var arguments = Environment.GetCommandLineArgs();
        var index = Array.IndexOf(arguments, "--smoke-report");
        var path = index >= 0 && index + 1 < arguments.Length
            ? Path.GetFullPath(arguments[index + 1]) : Path.Combine(AppContext.BaseDirectory, "startup-smoke.json");
        var json = System.Text.Json.JsonSerializer.Serialize(report, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        await File.WriteAllTextAsync(path, json);
    }
}
