using System.Text;

namespace SSHDock.Native.Core;

public sealed record LocalSession(string SessionId, string Title, string Cwd, string Kind = "local", bool Closed = false);
public sealed record CoreEvent(string Type, string? SessionId, string? Data, int? ExitCode, string? Code, string? Message,
    string? TransferId = null, long? Transferred = null, long? Total = null, string? State = null);
public sealed record TerminalCursor(int Row, int Col, bool Visible);
public sealed record TerminalCell(int Row, int Col, string Text, string Fg, string Bg, bool Bold, bool Underline, bool Wide);
public sealed record TerminalModes(bool ApplicationCursor, bool BracketedPaste);
public sealed record TerminalSnapshot(int Cols, int Rows, TerminalCursor Cursor, TerminalCell[] Cells, int Offset, string Title, TerminalModes? Modes = null);
public readonly record struct CellPoint(int Row, int Col);

public static class TerminalAlgorithms
{
    // Virtual-key values are kept independent of WinRT so this mapping is tested
    // on every platform; printable text is delivered by the native input proxy.
    public static string? EncodeKey(int key, bool control, bool alt, bool shift, bool applicationCursor = false)
    {
        if (control && key is >= 65 and <= 90) return ((char)(key - 64)).ToString();
        if (control)
        {
            var controlText = key switch { 32 or 50 => "\0", 219 => "\x1b", 220 => "\x1c", 221 => "\x1d", 54 => "\x1e", 189 => "\x1f", _ => null };
            if (controlText is not null) return controlText;
        }
        var modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (control ? 4 : 0);
        string Cursor(string suffix) => modifier == 1
            ? $"\x1b{(applicationCursor && suffix is "A" or "B" or "C" or "D" or "H" or "F" ? "O" : "[")}{suffix}"
            : $"\x1b[1;{modifier}{suffix}";
        string Tilde(int number) => modifier == 1 ? $"\x1b[{number}~" : $"\x1b[{number};{modifier}~";
        var text = key switch
        {
            8 => "\x7f", 9 => shift ? "\x1b[Z" : "\t", 13 => "\r", 27 => "\x1b",
            37 => Cursor("D"), 38 => Cursor("A"), 39 => Cursor("C"), 40 => Cursor("B"),
            36 => Cursor("H"), 35 => Cursor("F"), 33 => Tilde(5), 34 => Tilde(6), 45 => Tilde(2), 46 => Tilde(3),
            112 => modifier == 1 ? "\x1bOP" : Cursor("P"), 113 => modifier == 1 ? "\x1bOQ" : Cursor("Q"),
            114 => modifier == 1 ? "\x1bOR" : Cursor("R"), 115 => modifier == 1 ? "\x1bOS" : Cursor("S"),
            116 => Tilde(15), 117 => Tilde(17), 118 => Tilde(18), 119 => Tilde(19),
            120 => Tilde(20), 121 => Tilde(21), 122 => Tilde(23), 123 => Tilde(24), _ => null
        };
        if (alt && text is not null && key is 8 or 9 or 13) return "\x1b" + text;
        return text;
    }

    public static (CellPoint Start, CellPoint End) Order(CellPoint a, CellPoint b) =>
        a.Row < b.Row || a.Row == b.Row && a.Col <= b.Col ? (a, b) : (b, a);

    public static string SelectedText(TerminalSnapshot snapshot, CellPoint a, CellPoint b)
    {
        var (start, end) = Order(a, b);
        var cells = snapshot.Cells.ToDictionary(cell => (cell.Row, cell.Col));
        var lines = new List<string>();
        for (var row = start.Row; row <= end.Row; row++)
        {
            var line = new StringBuilder();
            var first = row == start.Row ? start.Col : 0;
            var last = row == end.Row ? end.Col : snapshot.Cols - 1;
            for (var col = first; col <= last; col++)
            {
                if (cells.TryGetValue((row, col), out var cell)) line.Append(cell.Text);
                else line.Append(' ');
            }
            lines.Add(line.ToString().TrimEnd());
        }
        return string.Join(Environment.NewLine, lines);
    }
}
