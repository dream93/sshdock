using System.Text;
using System.Text.Json;
using SSHDock.Native.Core;

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
Check(TerminalAlgorithms.EncodeKey(67, true, false, false) == "\x03", "Ctrl+C must send ETX");
Check(TerminalAlgorithms.EncodeKey(38, false, false, false) == "\x1b[A", "Normal cursor Up");
Check(TerminalAlgorithms.EncodeKey(38, false, false, false, true) == "\x1bOA", "Application cursor Up");
Check(TerminalAlgorithms.EncodeKey(39, true, false, true) == "\x1b[1;6C", "Modified Right");
Check(TerminalAlgorithms.EncodeKey(65, false, false, false) is null, "Printable text must use IME commit path");
var selectionSnapshot = new TerminalSnapshot(4, 2, new(0, 0, true),
    [new(0, 0, "中", "#ffffff", "#000000", false, false, true),
     new(0, 1, "", "#ffffff", "#000000", false, false, false),
     new(0, 2, "e\u0301", "#ffffff", "#000000", false, false, false),
     new(1, 0, "B", "#ffffff", "#000000", false, false, false)], 0, "test");
Check(TerminalAlgorithms.SelectedText(selectionSnapshot, new(1, 0), new(0, 0)) == "中e\u0301" + Environment.NewLine + "B", "Selection must preserve clusters and wide-cell spacers");

if (args.Contains("--algorithms-only"))
{
    Console.WriteLine("PASS keyboard encoding and Unicode selection");
    return;
}

await using var core = await Task.Run(() => new NativeCoreClient());
var created = await core.RequestAsync<LocalSession>("local.create", new
{
    cols = 80, rows = 24, shell = OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh", terminalEngine = true
});
Check(!string.IsNullOrWhiteSpace(created.SessionId), "Created session ID");
await core.RequestAsync<JsonElement>("sessions.input", new
{
    sessionId = created.SessionId,
    data = Convert.ToBase64String(Encoding.UTF8.GetBytes("echo SSHDOCK_ABI_OK\r"))
});
var received = new StringBuilder();
var deadline = DateTime.UtcNow.AddSeconds(10);
while (DateTime.UtcNow < deadline && !received.ToString().Contains("SSHDOCK_ABI_OK"))
{
    foreach (var item in await core.PollAsync())
    {
        Check(item.Type != "error", item.Message ?? "Core event error");
        if (item.Type == "output" && item.Data is not null) received.Append(Encoding.UTF8.GetString(Convert.FromBase64String(item.Data)));
    }
    await Task.Delay(20);
}
Check(received.ToString().Contains("SSHDOCK_ABI_OK"), "PTY byte stream must reach managed P/Invoke poll");
await core.RequestAsync<JsonElement>("sessions.resize", new { sessionId = created.SessionId, cols = 83, rows = 17 });
var snapshot = await core.RequestAsync<TerminalSnapshot>("terminal.snapshot", new { sessionId = created.SessionId });
Check(snapshot.Cols == 83 && snapshot.Rows == 17, "Native terminal snapshot must reflect resize");
Check(snapshot.Cells.Any(cell => cell.Text.Length > 0), "Parsed terminal cells must be deserializable");
await core.RequestAsync<JsonElement>("sessions.close", new { sessionId = created.SessionId });
var remaining = await core.RequestAsync<JsonElement>("sessions.list", new { });
Check(remaining.ValueKind == JsonValueKind.Array, "Session list must be deserializable");
var closed = false;
deadline = DateTime.UtcNow.AddSeconds(5);
while (!closed && DateTime.UtcNow < deadline)
{
    closed = (await core.PollAsync()).Any(item => item.Type == "closed" && item.SessionId == created.SessionId);
    if (!closed) await Task.Delay(20);
}
Check(closed, "Close must produce a process-exit event");

// Exercise the SafeHandle lane with a native poll already in flight during close.
var secondCore = await Task.Run(() => new NativeCoreClient());
var poll = secondCore.PollAsync();
await secondCore.DisposeAsync();
await poll;
await secondCore.DisposeAsync();
try
{
    await secondCore.PollAsync();
    throw new InvalidOperationException("Calls after disposal must fail");
}
catch (ObjectDisposedException) { }
Console.WriteLine("PASS native ABI, local PTY output, terminal snapshot, resize, close, and SafeHandle lifecycle");
