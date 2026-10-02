using System.Text;

namespace SSHDock.Native.Core;

// UI-thread owned. The byte budget includes a chunk until the native core has
// accepted it, so queued and in-flight input share the same finite allowance.
internal sealed class BoundedInputQueue(int maximumBytes = 1024 * 1024)
{
    private readonly Queue<InputChunk> _chunks = [];
    public int ByteCount { get; private set; }
    public int Count => _chunks.Count;
    private long _generation;
    public long Generation => Interlocked.Read(ref _generation);

    public bool TryAppend(string text)
    {
        var addedBytes = Encoding.UTF8.GetByteCount(text);
        if (addedBytes > maximumBytes - ByteCount) return false;
        for (var offset = 0; offset < text.Length;)
        {
            var length = Math.Min(16384, text.Length - offset);
            if (offset + length < text.Length && char.IsHighSurrogate(text[offset + length - 1])) length--;
            var chunkText = text.Substring(offset, length);
            _chunks.Enqueue(new InputChunk(chunkText, Encoding.UTF8.GetByteCount(chunkText), Generation));
            offset += length;
        }
        ByteCount += addedBytes;
        return true;
    }

    public bool TryPeek(out InputChunk chunk) => _chunks.TryPeek(out chunk!);

    public void Acknowledge(InputChunk chunk)
    {
        // A canceled in-flight request can finish after new text is enqueued.
        // Only the exact acknowledged object can remove the current head.
        if (_chunks.TryPeek(out var current) && ReferenceEquals(current, chunk))
        {
            _chunks.Dequeue();
            ByteCount -= chunk.ByteCount;
        }
    }

    public void Clear()
    {
        _chunks.Clear();
        ByteCount = 0;
        Interlocked.Increment(ref _generation);
    }
}

internal sealed record InputChunk(string Text, int ByteCount, long Generation);

// Creation completes asynchronously, while a short-lived process may already
// have emitted closed/error events. Retain those events without output payloads.
internal sealed class SessionRegistrationBuffer
{
    private const int MaximumSessions = 64;
    private const int MaximumEvents = 256;
    private const int MaximumBytes = 256 * 1024;
    private readonly Dictionary<string, List<CoreEvent>> _events = [];
    private int _count;
    private int _bytes;

    public void Append(CoreEvent item)
    {
        if (item.SessionId is null) return;
        if (!_events.TryGetValue(item.SessionId, out var items))
        {
            if (_events.Count >= MaximumSessions) throw Overflow();
            items = [];
            _events.Add(item.SessionId, items);
        }
        if (item.Type == "output" && items.Any(earlier => earlier.Type == "output")) return;
        var retained = item with { Data = null };
        var bytes = MetadataBytes(retained);
        if (_count >= MaximumEvents || bytes > MaximumBytes - _bytes) throw Overflow();
        items.Add(retained);
        _count++;
        _bytes += bytes;
    }

    public CoreEvent[] Take(string sessionId)
    {
        if (!_events.Remove(sessionId, out var items)) return [];
        _count -= items.Count;
        _bytes -= items.Sum(MetadataBytes);
        return [.. items];
    }

    public void Clear()
    {
        _events.Clear();
        _count = _bytes = 0;
    }

    public static CoreEvent[] Compact(CoreEvent[] batch)
    {
        var outputs = new HashSet<string>();
        var notifications = new List<CoreEvent>();
        foreach (var item in batch)
        {
            if (item.Type == "output" && (item.SessionId is null || !outputs.Add(item.SessionId))) continue;
            notifications.Add(item with { Data = null });
        }
        return [.. notifications];
    }

    private static int MetadataBytes(CoreEvent item) =>
        Encoding.UTF8.GetByteCount(item.Type) + Encoding.UTF8.GetByteCount(item.SessionId ?? "") +
        Encoding.UTF8.GetByteCount(item.Code ?? "") + Encoding.UTF8.GetByteCount(item.Message ?? "");
    private static CoreException Overflow() => new("registration_event_overflow", "创建会话期间的事件缓冲超限，已停止轮询以避免丢失会话状态");
}
