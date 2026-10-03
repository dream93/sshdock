namespace SSHDock.Native.Core;

public sealed record HostKey(string Fingerprint, string Algorithm);
public sealed record SftpHome(string Path);
public sealed record SftpEntry(string Name, string Path, bool IsDirectory, bool IsSymlink, ulong Size, long? Modified)
{
    public string Display => $"{(IsSymlink ? "链接" : IsDirectory ? "文件夹" : "文件")}  {Name}   {(IsDirectory ? "" : FormatBytes(Size))}";
    public static string FormatBytes(double bytes) => bytes < 1024 ? $"{bytes:0} B" : bytes < 1048576 ? $"{bytes / 1024:0.0} KiB" : $"{bytes / 1048576:0.0} MiB";
}
public sealed record SftpListing(string Path, SftpEntry[] Entries);
public sealed record LinuxStats(bool Supported, ulong CpuTotal, ulong CpuIdle, ulong MemTotal, ulong MemAvailable, ulong Rx, ulong Tx, double Load1);

public static class RemoteAlgorithms
{
    public static string JoinPath(string directory, string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.IndexOfAny(['/', '\\', '\0']) >= 0)
            throw new ArgumentException("文件名不能包含路径分隔符或使用 . / ..");
        return directory.TrimEnd('/') + "/" + name;
    }
    public static string ParentPath(string path)
    {
        var normalized = path.TrimEnd('/');
        var separator = normalized.LastIndexOf('/');
        return separator <= 0 ? "/" : normalized[..separator];
    }
    public static double CpuPercent(LinuxStats previous, LinuxStats current)
    {
        if (current.CpuTotal <= previous.CpuTotal || current.CpuIdle < previous.CpuIdle) return 0;
        var total = current.CpuTotal - previous.CpuTotal;
        var idle = current.CpuIdle - previous.CpuIdle;
        return Math.Clamp(100 * (1 - Math.Min((double)idle / total, 1)), 0, 100);
    }
    public static double BytesPerSecond(ulong previous, ulong current, double seconds) =>
        current >= previous && seconds > 0 ? (current - previous) / seconds : 0;
}
