using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;

namespace SSHDock.Native.Services;

internal static class AppIcon
{
    public static string Path => System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "SSHDock.ico");

    public static void Apply(Window window)
    {
        if (!File.Exists(Path)) throw new FileNotFoundException("SSHDock 原有窗口图标未随应用发布", Path);
        window.AppWindow.SetIcon(Path);
    }

    public static bool IsSet(Window window)
    {
        var handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        // WM_GETICON returns the actual native window icons used by the taskbar
        // (ICON_BIG) and title bar (ICON_SMALL2), rather than a copied asset flag.
        return SendMessage(handle, 0x007f, 1, 0) != 0 && SendMessage(handle, 0x007f, 2, 0) != 0;
    }

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern nint SendMessage(nint window, uint message, nuint wParam, nint lParam);
}
