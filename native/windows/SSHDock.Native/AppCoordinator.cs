using Microsoft.UI.Dispatching;
using SSHDock.Native.Core;
using System.Text;

namespace SSHDock.Native;

internal sealed class AppCoordinator
{
    private readonly NativeCoreClient _core;
    private readonly DispatcherQueue _dispatcher;
    private readonly CancellationTokenSource _stop = new();
    private readonly Dictionary<string, TerminalSession> _sessions = [];
    private readonly List<MainWindow> _windows = [];
    private readonly Task _pollTask;
    private bool _shuttingDown;

    public AppCoordinator(NativeCoreClient core, DispatcherQueue dispatcher)
    {
        _core = core;
        _dispatcher = dispatcher;
        _pollTask = Task.Run(PollLoopAsync);
    }

    public MainWindow OpenWindow(TerminalSession? session = null, MainWindow? homeWindow = null)
    {
        var window = new MainWindow(this, homeWindow);
        _windows.Add(window);
        if (session is not null) window.AddSession(session);
        return window;
    }

    public async Task<TerminalSession> CreateSessionAsync(string? shell)
    {
        if (_shuttingDown) throw new InvalidOperationException("应用正在退出");
        var created = await _core.RequestAsync<LocalSession>("local.create", new
        {
            cols = 100, rows = 30, shell, terminalEngine = true
        });
        var session = new TerminalSession(_core, created);
        _sessions.Add(session.Id, session);
        return session;
    }

    private async Task PollLoopAsync()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(16));
            while (await timer.WaitForNextTickAsync(_stop.Token))
            {
                // poll returns an ordered batch. Refresh each visible session once,
                // regardless of how many chunks arrived in that batch.
                var events = await _core.PollAsync(_stop.Token);
                if (events.Length == 0) continue;
                _dispatcher.TryEnqueue(() =>
                {
                    var dirty = new HashSet<string>();
                    foreach (var item in events)
                    {
                        if (item.SessionId is null || !_sessions.TryGetValue(item.SessionId, out var session)) continue;
                        if (item.Type == "output") dirty.Add(item.SessionId);
                        else if (item.Type == "closed")
                        {
                            session.MarkClosed(item.ExitCode);
                            dirty.Add(item.SessionId);
                        }
                        else if (item.Type == "error") session.SetError(item.Message ?? item.Code ?? "终端错误");
                    }
                    foreach (var id in dirty)
                        if (_sessions.TryGetValue(id, out var session)) session.MarkDirty();
                });
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception exception)
        {
            _dispatcher.TryEnqueue(() =>
            {
                foreach (var session in _sessions.Values) session.SetError(exception.Message);
            });
        }
    }

    public async Task CloseSessionAsync(TerminalSession session)
    {
        if (!_sessions.Remove(session.Id)) return;
        session.ReleaseAllViews();
        try { await _core.RequestAsync<System.Text.Json.JsonElement>("sessions.close", new { sessionId = session.Id }); }
        catch (CoreException exception) { session.SetError(exception.Message); }
    }

    public void DetachSession(MainWindow source, TerminalSession session)
    {
        source.RemoveSession(session);
        var target = OpenWindow(session, source.HomeWindow ?? source);
        target.Activate();
    }

    public void MoveToOtherWindow(MainWindow source, TerminalSession session)
    {
        var target = _windows.FirstOrDefault(window => window != source);
        if (target is null) return;
        source.RemoveSession(session);
        target.AddSession(session);
        target.Activate();
    }

    public async Task<bool> CloseWindowAsync(MainWindow window)
    {
        // Closing a detached window migrates the same live sessions home. If a
        // home window has already closed, use another remaining application window.
        var target = window.HomeWindow is { } home && _windows.Contains(home) && home != window
            ? home : _windows.FirstOrDefault(candidate => candidate != window);
        if (target is not null)
        {
            foreach (var session in window.Sessions.ToArray())
            {
                window.RemoveSession(session);
                target.AddSession(session);
            }
            _windows.Remove(window);
            target.Activate();
            window.FinishClose();
            return true;
        }
        if (window.Sessions.Any(session => !session.Closed) && !await window.ConfirmExitAsync()) return false;
        foreach (var session in window.Sessions.ToArray())
        {
            window.RemoveSession(session);
            await CloseSessionAsync(session);
        }
        _windows.Remove(window);
        if (_windows.Count == 0)
        {
            _shuttingDown = true;
            _stop.Cancel();
            await _pollTask;
            await _core.DisposeAsync();
            _stop.Dispose();
        }
        window.FinishClose();
        return true;
    }
}

internal sealed class TerminalSession(NativeCoreClient core, LocalSession created)
{
    private long _owner;
    private bool _dirty = true;
    private bool _refreshing;
    private bool _released;
    private int _cols = 100;
    private int _rows = 30;
    private readonly Queue<string> _pendingInput = [];
    private bool _sending;
    public string Id { get; } = created.SessionId;
    public string Title { get; private set; } = created.Title;
    public string Cwd { get; } = created.Cwd;
    public string Status { get; private set; } = "本地终端";
    public bool Closed { get; private set; }
    public TerminalSnapshot? Snapshot { get; private set; }
    public bool HasPendingInput => _pendingInput.Count > 0;
    public event Action? Changed;

    public bool OwnsResize(long owner) => !_released && Interlocked.Read(ref _owner) == owner;
    public void ClaimView(long owner)
    {
        Interlocked.Exchange(ref _owner, owner);
        MarkDirty();
    }
    public void ReleaseView(long owner) => Interlocked.CompareExchange(ref _owner, 0, owner);
    public void ReleaseAllViews()
    {
        _released = true;
        Interlocked.Exchange(ref _owner, 0);
    }

    public void SetError(string message)
    {
        Status = message;
        Changed?.Invoke();
    }
    public void MarkClosed(int? exitCode)
    {
        Closed = true;
        Status = $"进程已退出 · {exitCode?.ToString() ?? "未知退出码"}";
        Changed?.Invoke();
    }
    public void MarkDirty()
    {
        _dirty = true;
        if (!_refreshing && !_released && Interlocked.Read(ref _owner) != 0) _ = RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        _refreshing = true;
        try
        {
            while (_dirty && !_released && Interlocked.Read(ref _owner) != 0)
            {
                _dirty = false;
                Snapshot = await core.RequestAsync<TerminalSnapshot>("terminal.snapshot", new { sessionId = Id });
                if (!string.IsNullOrWhiteSpace(Snapshot.Title)) Title = Snapshot.Title;
                Changed?.Invoke();
            }
        }
        catch (Exception exception) when (exception is CoreException or ObjectDisposedException)
        {
            if (!_released) SetError(exception.Message);
        }
        finally { _refreshing = false; }
    }

    public async Task ResizeAsync(long owner, int cols, int rows)
    {
        if (!OwnsResize(owner) || Closed || cols == _cols && rows == _rows) return;
        try
        {
            await core.RequestAsync<System.Text.Json.JsonElement>("sessions.resize", new { sessionId = Id, cols, rows },
                stillValid: () => OwnsResize(owner));
            _cols = cols;
            _rows = rows;
            MarkDirty();
        }
        catch (OperationCanceledException) { }
        catch (Exception exception) when (exception is CoreException or ObjectDisposedException) { if (!_released) SetError(exception.Message); }
    }

    public async Task SendAsync(string text)
    {
        if (Closed || _released) return;
        // Keep large pastes below the native 1 MiB request limit and preserve
        // UTF-16 surrogate pairs when splitting the ordered input queue.
        for (var offset = 0; offset < text.Length;)
        {
            var length = Math.Min(16384, text.Length - offset);
            if (offset + length < text.Length && char.IsHighSurrogate(text[offset + length - 1])) length--;
            _pendingInput.Enqueue(text.Substring(offset, length));
            offset += length;
        }
        if (_sending || _pendingInput.Count == 0) return;
        _sending = true;
        try
        {
            await core.RequestAsync<System.Text.Json.JsonElement>("terminal.resetScroll", new { sessionId = Id });
            while (_pendingInput.TryPeek(out var pending) && !_released && !Closed)
            {
                await core.RequestAsync<System.Text.Json.JsonElement>("sessions.input", new { sessionId = Id, data = Convert.ToBase64String(Encoding.UTF8.GetBytes(pending)) });
                _pendingInput.Dequeue();
            }
            if (!Closed) Status = "本地终端";
            MarkDirty();
            Changed?.Invoke();
        }
        catch (CoreException exception) { if (!_released) SetError($"{exception.Code}：{exception.Message} · 保留 {_pendingInput.Sum(item => item.Length)} 个未发送字符，可点击重试输入"); }
        catch (ObjectDisposedException exception) { if (!_released) SetError(exception.Message); }
        finally { _sending = false; }
    }

    public async Task ScrollAsync(int delta)
    {
        if (_released) return;
        try
        {
            await core.RequestAsync<System.Text.Json.JsonElement>("terminal.scroll", new { sessionId = Id, delta });
            MarkDirty();
        }
        catch (Exception exception) when (exception is CoreException or ObjectDisposedException) { if (!_released) SetError(exception.Message); }
    }
}
