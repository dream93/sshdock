using System.Text;
using System.Text.Json;
using SSHDock.Native.Core;
using SSHDock.Native.Services;

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

var input = new BoundedInputQueue(10);
Check(input.TryAppend("中文") && input.ByteCount == 6, "Input capacity must count UTF-8 bytes");
Check(input.TryPeek(out var oldChunk), "Input head");
Check(!input.TryAppend("再加") && input.ByteCount == 6 && input.Count == 1, "Over-limit append must reject the entire addition");
input.Clear();
Check(input.ByteCount == 0 && input.Generation > oldChunk.Generation, "Cancel must clear bytes and invalidate queued request guards");
Check(input.TryAppend("B"), "Input after cancellation");
input.Acknowledge(oldChunk);
Check(input.Count == 1 && input.ByteCount == 1, "Stale native acknowledgement must not discard new input");
Check(input.TryPeek(out var newChunk), "New input head");
input.Acknowledge(newChunk);
Check(input.Count == 0 && input.ByteCount == 0, "Acknowledged input releases capacity");
var unicodeInput = new BoundedInputQueue();
var boundaryText = new string('a', 16383) + "😀中";
Check(unicodeInput.TryAppend(boundaryText), "Unicode input must fit capacity");
var rebuilt = new StringBuilder();
while (unicodeInput.TryPeek(out var chunk))
{
    Check(!char.IsHighSurrogate(chunk.Text[^1]), "Chunk boundary must not split a surrogate pair");
    rebuilt.Append(chunk.Text);
    unicodeInput.Acknowledge(chunk);
}
Check(rebuilt.ToString() == boundaryText, "Input chunking must preserve committed Unicode text");

CoreEvent[] earlyBatch =
[
    new("output", "early", new string('x', 100000), null, null, null),
    new("output", "early", "more bytes", null, null, null),
    new("error", "early", null, null, "failed", "shell failed"),
    new("closed", "early", null, 1, null, null)
];
var compact = SessionRegistrationBuffer.Compact(earlyBatch);
Check(compact.Length == 3 && compact.All(item => item.Data is null), "UI notifications must coalesce output and discard raw bytes");
var registration = new SessionRegistrationBuffer();
foreach (var item in compact) registration.Append(item);
var replay = registration.Take("early");
Check(replay.Select(item => item.Type).SequenceEqual(new[] { "output", "error", "closed" }), "Registration must replay short-lived shell events in order");
Check(registration.Take("early").Length == 0, "Registration replay is consumed once");
for (var i = 0; i < 256; i++) registration.Append(new("error", "bounded", null, null, "failed", "error"));
try
{
    registration.Append(new("error", "bounded", null, null, "failed", "overflow"));
    throw new InvalidOperationException("Registration metadata must have a finite event budget");
}
catch (CoreException exception) when (exception.Code == "registration_event_overflow") { }
Check(registration.Take("bounded").Length == 256, "Rejected metadata append must preserve already retained notifications");

var metadataDirectory = Path.Combine(Path.GetTempPath(), "sshdock-metadata-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(metadataDirectory);
try
{
    var metadataPath = Path.Combine(metadataDirectory, "native.json");
    var legacyPath = Path.Combine(metadataDirectory, "legacy.json");
    File.WriteAllText(legacyPath, """[{"id":"legacy-preserved","name":"server","host":"example.test","port":22,"username":"tester","authType":"password","password":"SECRET_MUST_NOT_MIGRATE","passwordEncoding":"plain","passphrase":"PASSPHRASE_MUST_NOT_MIGRATE"}]""");
    var store = new ConnectionStore(metadataPath);
    Check(store.ImportMetadata(legacyPath) == 1 && store.Connections[0].Id == "legacy-preserved", "Metadata migration must preserve the original ID");
    var saved = File.ReadAllText(metadataPath);
    Check(!saved.Contains("SECRET_MUST_NOT_MIGRATE") && !saved.Contains("PASSPHRASE_MUST_NOT_MIGRATE") && !saved.Contains("passwordEncoding"), "Secrets and plaintext encodings must never enter native metadata");
    var profile = store.Connections[0];
    var key = new HostKey("SHA256:original", "ssh-ed25519"); store.TrustHost(profile, key);
    saved = File.ReadAllText(metadataPath);
    try { store.TrustHost(profile, new HostKey("SHA256:changed", "ssh-ed25519")); throw new InvalidOperationException("Changed host key must be rejected"); }
    catch (InvalidOperationException exception) when (exception.Message != "Changed host key must be rejected") { }
    Check(store.KnownHost(profile) == key && File.ReadAllText(metadataPath) == saved, "Host key mismatch must preserve existing trust");
    File.WriteAllText(legacyPath, "not JSON");
    try { store.ImportMetadata(legacyPath); throw new InvalidOperationException("Invalid legacy metadata must fail"); }
    catch (JsonException) { }
    Check(File.ReadAllText(metadataPath) == saved, "Invalid migration must not overwrite current metadata");
    store.ForgetHost(profile); store.TrustHost(profile, new HostKey("SHA256:changed", "ssh-ed25519"));
    Check(new ConnectionStore(metadataPath).KnownHost(profile)?.Fingerprint == "SHA256:changed", "Explicit forget and reconfirm must persist new trust");
}
finally { Directory.Delete(metadataDirectory, recursive: true); }
Check(RemoteAlgorithms.JoinPath("/home/test", "new") == "/home/test/new", "Remote path construction");
var noTimestamp = JsonSerializer.Deserialize<SftpListing>("""{"path":"/home/test","entries":[{"name":"file","path":"/home/test/file","isDirectory":false,"isSymlink":false,"size":5,"modified":null}]}""", NativeCoreClient.JsonOptions);
Check(noTimestamp is { Entries.Length: 1 } && noTimestamp.Entries[0].Modified is null && noTimestamp.Entries[0].Name == "file", "SFTP entries without mtime must remain browsable");
var transferBatch = SessionRegistrationBuffer.Compact([
    new("transfer", "ssh", null, null, null, null, "upload", 10, 100, "running"),
    new("transfer", "ssh", null, null, null, null, "upload", 100, 100, "completed")]);
Check(transferBatch.Length == 1 && transferBatch[0].State == "completed", "Transfer UI notifications must retain the latest batch progress");
var largeExit = JsonSerializer.Deserialize<CoreEvent[]>("""[{"type":"closed","sessionId":"ssh","exitCode":4294967295}]""", NativeCoreClient.JsonOptions);
Check(largeExit is { Length: 1 } && largeExit[0].ExitCode == 4294967295L, "Unsigned native/SSH exit codes must not stop polling");
var largeProgress = JsonSerializer.Deserialize<CoreEvent[]>("""[{"type":"transfer","sessionId":"ssh","transferId":"download","transferred":18446744073709551615,"total":18446744073709551615,"state":"running"}]""", NativeCoreClient.JsonOptions);
Check(largeProgress is { Length: 1 } && largeProgress[0].Total == ulong.MaxValue, "Unsigned transfer counters must not stop polling");
var largeFile = JsonSerializer.Deserialize<SftpEntry>("""{"name":"large","path":"/large","isDirectory":false,"isSymlink":false,"size":18446744073709551615,"modified":null}""", NativeCoreClient.JsonOptions);
Check(largeFile?.Size == ulong.MaxValue, "Remote unsigned file sizes must deserialize without affecting other sessions");
try { RemoteAlgorithms.JoinPath("/home/test", "../escape"); throw new InvalidOperationException("Traversal must be rejected"); }
catch (ArgumentException) { }
var statsBefore = new LinuxStats(true, 100, 40, 4096, 2048, 1000, 500, 0.5);
var statsAfter = statsBefore with { CpuTotal = 200, CpuIdle = 65, Rx = 3000 };
Check(RemoteAlgorithms.CpuPercent(statsBefore, statsAfter) == 75 && RemoteAlgorithms.BytesPerSecond(1000, 3000, 2) == 1000, "Linux CPU and network deltas");
Check(RemoteAlgorithms.CpuPercent(statsAfter, statsBefore) == 0 && RemoteAlgorithms.BytesPerSecond(3000, 1000, 2) == 0, "Counter resets must not underflow");
if (OperatingSystem.IsWindows())
{
    var credentialId = "test-" + Guid.NewGuid().ToString("N");
    try
    {
        CredentialVault.Save(credentialId, "password", "credential-中文-🧪");
        CredentialVault.Save(credentialId, "passphrase", "encrypted-key-test");
        Check(CredentialVault.Read(credentialId, "password") == "credential-中文-🧪", "Windows Credential Manager UTF-8 secret roundtrip");
        CredentialVault.Delete(credentialId);
        Check(CredentialVault.Read(credentialId, "password") is null && CredentialVault.Read(credentialId, "passphrase") is null, "Deleting a connection must remove both auth secrets");
    }
    finally { CredentialVault.Delete(credentialId); }
}

if (args.Contains("--algorithms-only"))
{
    Console.WriteLine("PASS terminal algorithms, metadata-only migration, host key trust, remote path safety, and Linux stats deltas");
    return;
}

await using var core = await Task.Run(() => new NativeCoreClient());
var created = await core.RequestAsync<LocalSession>("local.create", new
{
    cols = 80, rows = 24, shell = OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh", terminalEngine = true
});
Check(!string.IsNullOrWhiteSpace(created.SessionId), "Created session ID");
// Keep the expected marker out of the input: receiving command echo alone must
// not pass. Windows uses the same CR that the UI emits for Enter.
var command = OperatingSystem.IsWindows()
    ? "set SSHDOCK_ABI_WORD=OK\recho SSHDOCK_ABI_%SSHDOCK_ABI_WORD%\r"
    : "printf 'SSHDOCK_ABI_%s\\n' OK\r";
await core.RequestAsync<JsonElement>("sessions.input", new
{
    sessionId = created.SessionId,
    data = Convert.ToBase64String(Encoding.UTF8.GetBytes(command))
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
Check(received.ToString().Contains("SSHDOCK_ABI_OK"),
    $"Executed shell output must reach managed P/Invoke poll; received={JsonSerializer.Serialize(received.ToString())}");
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
Console.WriteLine("PASS native ABI, executed local command, snapshot/resize/close, lifecycle, metadata migration, host trust, and remote models" +
    (OperatingSystem.IsWindows() ? ", Windows Credential Manager" : ""));
