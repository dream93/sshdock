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

public sealed partial class App : Application
{
    private AppCoordinator? _coordinator;
    private MainWindow? _window;

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var smoke = Environment.GetCommandLineArgs().Contains("--startup-smoke");
        var stage = "xaml-resources";
        string? smokeCwd = null;
        try
        {
            // App.xaml activates the SDK's XAML metadata and application PRI resource pipeline.
            // Loading it here keeps resource failures inside the startup smoke report.
            InitializeComponent();
            stage = "native-core";
            var core = await Task.Run(() => new Core.NativeCoreClient());
            _coordinator = new AppCoordinator(core, DispatcherQueue.GetForCurrentThread());
            stage = "xaml-window";
            _window = _coordinator.OpenWindow();
            _window.Activate();
            if (smoke)
            {
                stage = "smoke-working-directory";
                smokeCwd = Path.Combine(Path.GetTempPath(), "SSHDock smoke 中文 " + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(smokeCwd);
            }
            stage = "local-pty";
            await _window.NewTerminalAsync(smoke ? "cmd.exe" : null, smokeCwd);
            if (smoke)
            {
                stage = "canvas-and-pty-output";
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                await _window.RunStartupSmokeAsync(timeout.Token, smokeCwd!);
                await WriteSmokeReportAsync(new
                {
                    ok = true, xamlWindow = true, canvasFirstFrame = true, localPty = true, ptyOutput = true, cwdMatches = true,
                    architecture = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString(),
                    diagnostics = _window.StartupSmokeDiagnostics()
                });
                await _coordinator.CloseWindowAsync(_window, confirm: false);
                DeleteSmokeDirectory(smokeCwd);
                Environment.Exit(0);
            }
        }
        catch (Exception exception)
        {
            if (smoke)
            {
                await WriteSmokeReportAsync(new
                {
                    ok = false, stage, error = exception.ToString(),
                    diagnostics = _window?.StartupSmokeDiagnostics()
                });
                if (_coordinator is not null && _window is not null)
                {
                    try { await _coordinator.CloseWindowAsync(_window, confirm: false); }
                    catch (Exception closeException) { Console.Error.WriteLine(closeException); }
                }
                DeleteSmokeDirectory(smokeCwd);
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

    private static void DeleteSmokeDirectory(string? path)
    {
        if (path is null) return;
        try { Directory.Delete(path); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        { Console.Error.WriteLine($"无法清理启动检查目录：{exception.Message}"); }
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
