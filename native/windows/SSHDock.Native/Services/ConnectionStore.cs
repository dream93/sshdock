using System.Text.Json;
using System.Text.Json.Serialization;
using SSHDock.Native.Core;

namespace SSHDock.Native.Services;

public sealed record ConnectionProfile(string Id, string Name, string Host, int Port, string Username, string AuthType, string KeyPath)
{
    [JsonIgnore] public string Display => $"{Name}\n{Username}@{Host}:{Port} · {(AuthType == "key" ? "私钥" : "密码")}";
    [JsonIgnore] public string HostIdentity => $"{Host.Trim().ToLowerInvariant()}:{Port}";
    public ConnectionProfile Validate()
    {
        if (string.IsNullOrWhiteSpace(Id) || Id.Length > 128 || Id.Any(char.IsControl)) throw new ArgumentException("连接标识无效");
        if (string.IsNullOrWhiteSpace(Name) || Name.Length > 120) throw new ArgumentException("连接名称需为 1–120 个字符");
        if (string.IsNullOrWhiteSpace(Host) || Host.Length > 253 || Host.Any(char.IsWhiteSpace) || Host.Any(char.IsControl) || Host.IndexOfAny(['/', '\\']) >= 0)
            throw new ArgumentException("请输入主机名或 IP 地址");
        if (Port is < 1 or > 65535) throw new ArgumentException("端口需为 1–65535");
        if (string.IsNullOrWhiteSpace(Username) || Username.Length > 128 || Username.Any(char.IsControl)) throw new ArgumentException("请输入 SSH 用户名");
        if (AuthType is not ("password" or "key")) throw new ArgumentException("认证方式无效");
        if (AuthType == "key" && string.IsNullOrWhiteSpace(KeyPath)) throw new ArgumentException("请选择私钥文件");
        return this;
    }
}

public sealed class ConnectionStore
{
    private readonly string _path;
    private StoreDocument _document;
    public event Action? Changed;
    public string? StartupNotice { get; private set; }
    public IReadOnlyList<ConnectionProfile> Connections => _document.Connections;
    public ConnectionStore(string? path = null)
    {
        _path = path ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SSHDockNative", "connections.json");
        _document = File.Exists(_path)
            ? JsonSerializer.Deserialize<StoreDocument>(File.ReadAllText(_path), NativeCoreClient.JsonOptions) ?? throw new InvalidDataException("SSH 配置为空")
            : new();
        if (_document.Connections is null || _document.KnownHosts is null) throw new InvalidDataException("SSH 配置结构无效，原文件已保留");
        foreach (var connection in _document.Connections) connection.Validate();
        if (path is null && _document.Connections.Length == 0 && !_document.LegacyMigrationAttempted)
        {
            var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var legacy = new[] { Path.Combine(roaming, "SSHDock", "connections.json"), Path.Combine(roaming, "sshdock", "connections.json") }
                .FirstOrDefault(File.Exists);
            try
            {
                if (legacy is not null)
                {
                    var count = ImportMetadata(legacy);
                    StartupNotice = $"已导入 {count} 个旧连接配置。旧密码和私钥口令均未导入，请重新输入并保存到 Windows 凭据管理器。";
                }
                Commit(_document with { LegacyMigrationAttempted = true });
            }
            catch (Exception exception) when (exception is JsonException or InvalidDataException or ArgumentException or IOException)
            { StartupNotice = "旧连接配置未能导入，原文件已保留；可使用“导入配置”选择有效的 connections.json。"; }
        }
    }
    public void Save(ConnectionProfile profile)
    {
        profile.Validate();
        var updated = _document.Connections.Where(item => item.Id != profile.Id).Append(profile).ToArray();
        if (updated.Length > 1000) throw new InvalidDataException("连接数量超过 1000");
        Commit(_document with { Connections = updated });
    }
    public void Delete(string id) => Commit(_document with { Connections = _document.Connections.Where(item => item.Id != id).ToArray() });
    public HostKey? KnownHost(ConnectionProfile profile) => _document.KnownHosts.GetValueOrDefault(profile.HostIdentity);
    public void TrustHost(ConnectionProfile profile, HostKey key)
    {
        if (_document.KnownHosts.TryGetValue(profile.HostIdentity, out var existing) && existing != key)
            throw new InvalidOperationException("已知主机密钥发生变化，必须先明确忘记旧信任再重新确认");
        var hosts = new Dictionary<string, HostKey>(_document.KnownHosts) { [profile.HostIdentity] = key };
        Commit(_document with { KnownHosts = hosts });
    }
    public void ForgetHost(ConnectionProfile profile)
    {
        var hosts = new Dictionary<string, HostKey>(_document.KnownHosts);
        hosts.Remove(profile.HostIdentity);
        Commit(_document with { KnownHosts = hosts });
    }
    public int ImportMetadata(string path)
    {
        if (new FileInfo(path).Length > 4 * 1024 * 1024) throw new InvalidDataException("连接配置文件超过 4 MiB");
        using var json = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { MaxDepth = 32 });
        if (json.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException("请选择 Electron 导出的 connections.json 数组");
        var imported = new List<ConnectionProfile>();
        var ids = _document.Connections.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var item in json.RootElement.EnumerateArray())
        {
            string Read(string name, string fallback = "") => item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;
            var host = Read("host").Trim();
            var port = item.TryGetProperty("port", out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : 22;
            var id = Read("id", Guid.NewGuid().ToString("N"));
            if (!ids.Add(id)) { id = Guid.NewGuid().ToString("N"); ids.Add(id); }
            imported.Add(new ConnectionProfile(id, Read("name", host), host, port,
                Read("username"), Read("authType", "password"), Read("keyPath")).Validate());
        }
        if (_document.Connections.Length + imported.Count > 1000) throw new InvalidDataException("连接数量超过 1000");
        Commit(_document with { Connections = [.. _document.Connections, .. imported] });
        return imported.Count;
    }
    private void Commit(StoreDocument document)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
        var temporary = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(document, NativeCoreClient.JsonOptions));
            File.Move(temporary, _path, overwrite: true);
            _document = document;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        Changed?.Invoke();
    }
    public sealed record StoreDocument
    {
        public ConnectionProfile[] Connections { get; init; } = [];
        public Dictionary<string, HostKey> KnownHosts { get; init; } = [];
        public bool LegacyMigrationAttempted { get; init; }
    }
}
