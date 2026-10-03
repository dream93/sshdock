namespace SSHDock.Native.Core;

internal static class StartupSmokeValidation
{
    public static bool WindowsDirectoriesEqual(string expected, string actual) =>
        string.Equals(NormalizeWindowsDirectory(expected), NormalizeWindowsDirectory(actual), StringComparison.OrdinalIgnoreCase);

    private static string NormalizeWindowsDirectory(string path)
    {
        var normalized = path.Replace('/', '\\');
        if (normalized.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) normalized = @"\\" + normalized[8..];
        else if (normalized.StartsWith(@"\\?\", StringComparison.Ordinal)) normalized = normalized[4..];
        // Keep the drive root separator: C: is a relative drive path, unlike C:\.
        while (normalized.Length > 3 && normalized.EndsWith('\\')) normalized = normalized[..^1];
        return normalized;
    }

    public static string? RenderedValue(TerminalSnapshot? snapshot, string startMarker, string endMarker)
    {
        if (snapshot is null) return null;
        // cmd wraps long paths across terminal rows. Concatenate cells without
        // inserting newlines or trimming spaces that may belong to the path.
        var text = string.Concat(snapshot.Cells.OrderBy(cell => cell.Row).ThenBy(cell => cell.Col).Select(cell => cell.Text));
        var start = text.IndexOf(startMarker, StringComparison.Ordinal);
        if (start < 0) return null;
        start += startMarker.Length;
        var end = text.IndexOf(endMarker, start, StringComparison.Ordinal);
        return end < 0 ? null : text[start..end];
    }
}
