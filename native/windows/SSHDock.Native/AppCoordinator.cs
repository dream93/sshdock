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
    private readonly SessionRegistrationBuffer _earlyEvents = new();
    private readonly Task _pollTask;
    private bool _shuttingDown;
    private int _createsInFlight;
    private string? _pollError;

    public AppCoordinator(NativeCoreClient core, DispatcherQueue dispatcher)
    {
        _core = core;
        _dispatcher = dispatcher;
        _pollTask = Task.Run(PollLoopAsync);
    }

    public MainWindow OpenWindow(TerminalSession? session = null, MainWindow? homeWindow = null)
    {
        if (_shuttingDown) throw new InvalidOperationException("应用正在退出");
        var window = new MainWindow(this, homeWindow);
        _windows.Add(window);
        if (session is not null) window.AddSession(session);
        return window;
    }

    public async Task<TerminalSession> CreateSessionAsync(string? shell)
    {
        if (_shuttingDown) throw new InvalidOperationException("应用正在退出");
        if (_createsInFlight >= 32) throw new InvalidOperationException("同时创建的终端已达上限，请稍后重试");
        _createsInFlight++;
        try
        {
            var created = await _core.RequestAsync<LocalSession>("local.create", new
            {
                cols = 100, rows = 30, shell, terminalEngine = true
            });
            var session = new TerminalSession(_core, created);
            if (_shuttingDown)
            {
                try { await _core.RequestAsync<System.Text.Json.JsonElement>("sessions.close", new { sessionId = session.Id }); }
                catch (ObjectDisposedException) { } // Core destroy already terminates every owned process.
                throw new InvalidOperationException("窗口已关闭，刚创建的会话已结束");
            }
            _sessions.Add(session.Id, session);
            ApplyNotifications(_earlyEvents.Take(session.Id));
            if (_pollError is not null) session.SetError(_pollError);
            return session;
        }
        finally
        {
            _createsInFlight--;
            if (_createsInFlight == 0) _earlyEvents.Clear();
        }
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
                var notifications = SessionRegistrationBuffer.Compact(events);
                // Never hold raw PTY data in the UI queue. At most one compact
                // notification batch is outstanding; a busy UI applies native
                // output backpressure instead of growing managed memory.
                await DispatchAndWaitAsync(() => ApplyNotifications(notifications), _stop.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception exception)
        {
            try { await DispatchAndWaitAsync(() =>
            {
                _pollError = exception.Message;
                foreach (var session in _sessions.Values) session.SetError(exception.Message);
            }, _stop.Token); }
            catch (Exception dispatchException) when (dispatchException is OperationCanceledException or ObjectDisposedException) { }
        }
    }

    private void ApplyNotifications(CoreEvent[] events)
    {
        var dirty = new HashSet<string>();
        foreach (var item in events)
        {
            if (item.SessionId is null) continue;
            if (!_sessions.TryGetValue(item.SessionId, out var session))
            {
                if (_createsInFlight > 0) _earlyEvents.Append(item);
                continue;
            }
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
    }

    private async Task DispatchAndWaitAsync(Action action, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var applied = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = cancellationToken.Register(() => applied.TrySetCanceled(cancellationToken));
        if (!_dispatcher.TryEnqueue(() =>
        {
            if (cancellationToken.IsCancellationRequested) { applied.TrySetCanceled(cancellationToken); return; }
            try { action(); applied.TrySetResult(); }
            catch (Exception exception) { applied.TrySetException(exception); }
        })) throw new ObjectDisposedException(nameof(DispatcherQueue));
        await applied.Task.ConfigureAwait(false);
    }

    public async Task CloseSessionAsync(TerminalSession session)
    {
        if (!_sessions.Remove(session.Id)) return;
        session.ReleaseAllViews();
        try { await _core.RequestAsync<System.Text.Json.JsonElement>("sessions.close", new { sessionId = session.Id }); }
        catch (CoreException exception) { session.SetError(exception.Message); }
    }

    public async Task AttachCreatedSessionAsync(MainWindow origin, TerminalSession session)
    {
        var target = _windows.Contains(origin) && !origin.IsClosing
            ? origin : _windows.FirstOrDefault(window => !window.IsClosing);
        if (target is not null)
        {
            target.AddSession(session);
            target.Activate();
        }
        else await CloseSessionAsync(session);
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

    public async Task<bool> CloseWindowAsync(MainWindow window, bool confirm = true)
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
        if (confirm && window.Sessions.Any(session => !session.Closed) && !await window.ConfirmExitAsync()) return false;
        _shuttingDown = true;
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
    private readonly BoundedInputQueue _pendingInput = new();
    private bool _sending;
    private long _statusRevision;
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
        _cols = _rows = 0;
        MarkDirty();
    }
    public void ReleaseView(long owner) => Interlocked.CompareExchange(ref _owner, 0, owner);
    public void ReleaseAllViews()
    {
        _released = true;
        _pendingInput.Clear();
        Interlocked.Exchange(ref _owner, 0);
    }

    public void SetError(string message)
    {
        Status = message;
        _statusRevision++;
        Changed?.Invoke();
    }
    public void MarkClosed(int? exitCode)
    {
        Closed = true;
        _pendingInput.Clear();
        Status = $"进程已退出 · {exitCode?.ToString() ?? "未知退出码"}";
        _statusRevision++;
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
            if (OwnsResize(owner))
            {
                _cols = cols;
                _rows = rows;
            }
            MarkDirty();
        }
        catch (OperationCanceledException) { }
        catch (Exception exception) when (exception is CoreException or ObjectDisposedException) { if (!_released) SetError(exception.Message); }
    }

    public async Task SendAsync(string text)
    {
        if (Closed || _released) return;
        if (!_pendingInput.TryAppend(text))
        {
            SetError("本次输入未发送：待发送缓冲上限为 1 MiB，已整次拒绝。请重试已有输入或取消未发送输入后重新输入/粘贴");
            return;
        }
        if (_sending || _pendingInput.Count == 0) return;
        _sending = true;
        var startingGeneration = _pendingInput.Generation;
        var startingStatusRevision = _statusRevision;
        try
        {
            await core.RequestAsync<System.Text.Json.JsonElement>("terminal.resetScroll", new { sessionId = Id });
            while (_pendingInput.TryPeek(out var pending) && !_released && !Closed)
            {
                try
                {
                    await core.RequestAsync<System.Text.Json.JsonElement>("sessions.input", new { sessionId = Id, data = Convert.ToBase64String(Encoding.UTF8.GetBytes(pending.Text)) },
                        stillValid: () => !_released && !Closed && _pendingInput.Generation == pending.Generation);
                    _pendingInput.Acknowledge(pending);
                }
                catch (OperationCanceledException) when (_released || Closed || _pendingInput.Generation != pending.Generation) { }
            }
            if (!Closed && !_released && _pendingInput.Generation == startingGeneration && _statusRevision == startingStatusRevision) Status = "本地终端";
            MarkDirty();
            Changed?.Invoke();
        }
        catch (CoreException exception) { if (!_released && !Closed && _pendingInput.Count > 0) SetError($"{exception.Code}：{exception.Message} · 保留 {_pendingInput.ByteCount} 字节未发送输入，可重试或取消"); }
        catch (ObjectDisposedException exception) { if (!_released) SetError(exception.Message); }
        finally { _sending = false; }
    }

    public void CancelPendingInput()
    {
        if (_released || Closed) return;
        _pendingInput.Clear();
        SetError("已取消待发送输入；已提交的输入请求无法撤回");
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
