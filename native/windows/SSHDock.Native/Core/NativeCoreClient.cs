using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace SSHDock.Native.Core;

// Requests retain FIFO ordering. Poll uses a separate lane: a blocked PTY write
// must not stop draining the bounded native output queue.
public sealed class NativeCoreClient : IAsyncDisposable
{
    private readonly CoreHandle _handle = new();
    private readonly SemaphoreSlim _requests = new(1, 1);
    private int _disposed;

    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public NativeCoreClient()
    {
        try
        {
            using var document = ReadJson(NativeMethods.Request(_handle, "{\"method\":\"core.info\",\"params\":{}}"));
            var response = document.RootElement;
            if (!response.GetProperty("ok").GetBoolean() ||
                response.GetProperty("result").GetProperty("abiVersion").GetInt32() != 1)
                throw new CoreException("abi_mismatch", "SSHDock native core ABI version 1 is required");
        }
        catch { _handle.Dispose(); throw; }
    }

    public async Task<T> RequestAsync<T>(string method, object parameters,
        CancellationToken cancellationToken = default, Func<bool>? stillValid = null)
    {
        await _requests.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            if (stillValid is not null && !stillValid()) throw new OperationCanceledException();
            var json = JsonSerializer.Serialize(new { method, @params = parameters }, JsonOptions);
            return await Task.Run(() =>
            {
                using var document = ReadJson(NativeMethods.Request(_handle, json));
                var response = document.RootElement;
                if (!response.GetProperty("ok").GetBoolean())
                {
                    var error = response.GetProperty("error");
                    throw new CoreException(error.GetProperty("code").GetString() ?? "core_error",
                        error.GetProperty("message").GetString() ?? "Native core request failed");
                }
                return response.GetProperty("result").Deserialize<T>(JsonOptions)!;
            }).ConfigureAwait(false);
        }
        finally { _requests.Release(); }
    }

    public Task<CoreEvent[]> PollAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        var retained = false;
        _handle.DangerousAddRef(ref retained);
        var pointer = _handle.DangerousGetHandle();
        try
        {
            return Task.Run(() =>
            {
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    using var document = ReadJson(NativeMethods.Poll(pointer));
                    return document.RootElement.Deserialize<CoreEvent[]>(JsonOptions) ?? [];
                }
                finally { _handle.DangerousRelease(); }
            });
        }
        catch { if (retained) _handle.DangerousRelease(); throw; }
    }

    private static JsonDocument ReadJson(IntPtr pointer)
    {
        if (pointer == IntPtr.Zero) throw new CoreException("null_response", "Native core returned no response");
        try { return JsonDocument.Parse(Marshal.PtrToStringUTF8(pointer) ?? "null"); }
        finally { NativeMethods.StringFree(pointer); }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        await _requests.WaitAsync().ConfigureAwait(false);
        try
        {
            // SafeHandle retains the core during any concurrent poll P/Invoke.
            // ReleaseHandle runs after the last outstanding native call returns.
            await Task.Run(_handle.Dispose).ConfigureAwait(false);
        }
        finally { _requests.Release(); }
    }
}

public sealed class CoreException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed class CoreHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public CoreHandle() : base(true)
    {
        SetHandle(NativeMethods.Create());
        if (IsInvalid) throw new CoreException("create_failed", "Unable to create the native session core");
    }

    protected override bool ReleaseHandle()
    {
        NativeMethods.Destroy(handle);
        return true;
    }
}

internal static class NativeMethods
{
    private const string Library = "sshdock_core";

    static NativeMethods()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeMethods).Assembly, ResolveLibrary);
    }

    private static IntPtr ResolveLibrary(string name, Assembly assembly, DllImportSearchPath? searchPath)
    {
        // A full library path lets the portable ABI smoke test run on macOS too.
        var path = Environment.GetEnvironmentVariable("SSHDOCK_CORE_LIBRARY");
        return name == Library && !string.IsNullOrWhiteSpace(path) ? NativeLibrary.Load(path) : IntPtr.Zero;
    }

    [DllImport(Library, EntryPoint = "sshdock_core_create", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Create();
    [DllImport(Library, EntryPoint = "sshdock_core_request", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Request(CoreHandle core, [MarshalAs(UnmanagedType.LPUTF8Str)] string json);
    [DllImport(Library, EntryPoint = "sshdock_core_poll", CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr Poll(IntPtr core);
    [DllImport(Library, EntryPoint = "sshdock_core_string_free", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void StringFree(IntPtr json);
    [DllImport(Library, EntryPoint = "sshdock_core_destroy", CallingConvention = CallingConvention.Cdecl)]
    internal static extern void Destroy(IntPtr core);
}
