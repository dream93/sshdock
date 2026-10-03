using Microsoft.UI.Xaml;
using Windows.Storage.Pickers;

namespace SSHDock.Native.Services;

internal static class NativePickers
{
    public static async Task<string?> OpenFileAsync(Window owner)
    {
        var picker = new FileOpenPicker();
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(owner));
        return (await picker.PickSingleFileAsync())?.Path;
    }
    public static async Task<string?> OpenFolderAsync(Window owner)
    {
        var picker = new FolderPicker();
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(owner));
        return (await picker.PickSingleFolderAsync())?.Path;
    }
}
