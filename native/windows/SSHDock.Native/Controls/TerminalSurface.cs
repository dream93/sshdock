using System.Numerics;
using Microsoft.Graphics.Canvas.Text;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using SSHDock.Native.Core;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;
using Windows.System;
using Windows.UI;
using Windows.UI.Core;
using Colors = Microsoft.UI.Colors;
using FontWeights = Microsoft.UI.Text.FontWeights;

namespace SSHDock.Native.Controls;

// One GPU-backed canvas per terminal, not one XAML element per grid cell.
internal sealed class TerminalSurface : UserControl, IDisposable
{
    private const double PaddingSize = 8;
    private static long _nextOwner;
    private readonly long _owner = Interlocked.Increment(ref _nextOwner);
    private readonly TerminalSession _session;
    private readonly CanvasControl _canvas = new() { ClearColor = Color.FromArgb(255, 16, 19, 25) };
    private readonly TextBox _input = new()
    {
        HorizontalAlignment = HorizontalAlignment.Left,
        VerticalAlignment = VerticalAlignment.Top,
        MinWidth = 0, MinHeight = 0, Width = 240, Height = 24,
        Padding = new Thickness(0), BorderThickness = new Thickness(0),
        Background = new SolidColorBrush(Colors.Transparent),
        Foreground = new SolidColorBrush(Colors.White),
        Opacity = 0.015,
        IsHitTestVisible = false,
        IsSpellCheckEnabled = false,
        IsTextPredictionEnabled = false,
        AcceptsReturn = false
    };
    private readonly TranslateTransform _inputPosition = new();
    private readonly Dictionary<(string Text, bool Bold), CanvasTextLayout> _layouts = [];
    private XamlRoot? _root;
    private CancellationTokenSource? _resizeDelay;
    private string _fontFamily = "Cascadia Mono";
    private float _fontSize = 14;
    private float _cellWidth = 8.4f;
    private float _cellHeight = 20;
    private bool _resourcesReady;
    private bool _disposed;
    private bool _composing;
    private bool _clearingInput;
    private bool _commitQueued;
    private bool _altText;
    private bool _selecting;
    private CellPoint? _selectionStart;
    private CellPoint? _selectionEnd;
    private readonly TaskCompletionSource _firstFrame = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<Exception> _renderFailure = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal Task FirstFrame => _firstFrame.Task;
    internal Task<Exception> RenderFailure => _renderFailure.Task;
    internal TerminalSnapshot? LastRenderedSnapshot { get; private set; }
    internal double CanvasWidth => _canvas.ActualWidth;
    internal double CanvasHeight => _canvas.ActualHeight;

    public TerminalSurface(TerminalSession session)
    {
        _session = session;
        HorizontalAlignment = HorizontalAlignment.Stretch;
        VerticalAlignment = VerticalAlignment.Stretch;
        HorizontalContentAlignment = HorizontalAlignment.Stretch;
        VerticalContentAlignment = VerticalAlignment.Stretch;
        _input.RenderTransform = _inputPosition;
        AutomationProperties.SetName(_input, "终端输入");
        AutomationProperties.SetName(_canvas, "终端输出");
        var grid = new Grid();
        grid.Children.Add(_canvas);
        grid.Children.Add(_input);
        Content = grid;

        _canvas.CreateResources += (_, _) => { _resourcesReady = true; MeasureGrid(); };
        _canvas.Draw += Draw;
        _canvas.SizeChanged += (_, _) => QueueResize();
        _canvas.PointerPressed += HandlePointerPressed;
        _canvas.PointerMoved += HandlePointerMoved;
        _canvas.PointerReleased += HandlePointerReleased;
        _canvas.PointerCaptureLost += (_, _) => _selecting = false;
        _canvas.PointerWheelChanged += async (_, args) =>
        {
            args.Handled = true;
            ClearSelection();
            var delta = args.GetCurrentPoint(_canvas).Properties.MouseWheelDelta;
            if (delta != 0) await _session.ScrollAsync(Math.Sign(delta) * 3);
        };
        _input.PreviewKeyDown += HandleKeyDown;
        _input.TextCompositionStarted += (_, _) => { _composing = true; _canvas.Invalidate(); };
        _input.TextCompositionChanged += (_, _) => _canvas.Invalidate();
        _input.TextCompositionEnded += (_, _) =>
        {
            _composing = false;
            QueueCommit();
            _canvas.Invalidate();
        };
        _input.TextChanged += (_, _) =>
        {
            if (_clearingInput) return;
            if (_composing) _canvas.Invalidate();
            else QueueCommit();
        };
        _input.GotFocus += (_, _) => _canvas.Invalidate();
        _input.LostFocus += (_, _) => _canvas.Invalidate();
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        _session.Changed += SnapshotChanged;
    }

    public void SetFont(string family, float size)
    {
        _fontFamily = family;
        _fontSize = Math.Clamp(float.IsFinite(size) ? size : 14, 10, 32);
        _input.FontFamily = new FontFamily(family);
        _input.FontSize = _fontSize;
        ClearLayouts();
        if (_resourcesReady) MeasureGrid();
    }

    private void OnLoaded(object sender, RoutedEventArgs args)
    {
        if (_disposed) return;
        _session.ClaimView(_owner);
        _root = XamlRoot;
        if (_root is not null) _root.Changed += RootChanged;
        if (_resourcesReady) MeasureGrid();
        FocusInput();
    }

    private void OnUnloaded(object sender, RoutedEventArgs args)
    {
        _session.ReleaseView(_owner);
        _resizeDelay?.Cancel();
        if (_root is not null) _root.Changed -= RootChanged;
        _root = null;
    }

    private void RootChanged(XamlRoot sender, XamlRootChangedEventArgs args)
    {
        ClearLayouts();
        if (_resourcesReady) MeasureGrid();
    }

    private CanvasTextFormat TextFormat(bool bold = false) => new()
    {
        FontFamily = _fontFamily, FontSize = _fontSize,
        FontWeight = bold ? FontWeights.Bold : FontWeights.Normal,
        WordWrapping = CanvasWordWrapping.NoWrap,
        HorizontalAlignment = CanvasHorizontalAlignment.Left,
        VerticalAlignment = CanvasVerticalAlignment.Top
    };

    private void MeasureGrid()
    {
        if (_disposed) return;
        var scale = XamlRoot?.RasterizationScale ?? 1;
        using var format = TextFormat();
        using var layout = new CanvasTextLayout(_canvas, "M", format, 1000, 1000);
        _cellWidth = (float)(Math.Ceiling(Math.Max(1, layout.LayoutBounds.Width) * scale) / scale);
        _cellHeight = (float)(Math.Ceiling(Math.Max(layout.LayoutBounds.Height, _fontSize * 1.35) * scale) / scale);
        _input.Height = _cellHeight;
        PositionInputProxy();
        QueueResize();
        _canvas.Invalidate();
    }

    private async void QueueResize()
    {
        if (_disposed || !_resourcesReady || !_session.OwnsResize(_owner)) return;
        _resizeDelay?.Cancel();
        _resizeDelay?.Dispose();
        var delay = _resizeDelay = new CancellationTokenSource();
        try
        {
            await Task.Delay(50, delay.Token);
            if (!_session.OwnsResize(_owner)) return;
            var cols = Math.Clamp((int)((_canvas.ActualWidth - PaddingSize * 2) / _cellWidth), 2, 4096);
            var rows = Math.Clamp((int)((_canvas.ActualHeight - PaddingSize * 2) / _cellHeight), 1, Math.Min(1024, 200000 / cols));
            await _session.ResizeAsync(_owner, cols, rows);
        }
        catch (OperationCanceledException) { }
    }

    public void FocusInput()
    {
        if (_disposed) return;
        DispatcherQueue.TryEnqueue(() => { if (!_disposed && IsLoaded) _input.Focus(FocusState.Programmatic); });
    }

    private void SnapshotChanged()
    {
        if (_disposed) return;
        PositionInputProxy();
        _canvas.Invalidate();
    }

    private void PositionInputProxy()
    {
        var snapshot = _session.Snapshot;
        if (snapshot is null) return;
        // Keep the focused native text box at the real terminal cursor, including
        // per-monitor DPI transforms, so Windows positions its IME candidate UI.
        _inputPosition.X = PaddingSize + Math.Clamp(snapshot.Cursor.Col, 0, snapshot.Cols - 1) * _cellWidth;
        _inputPosition.Y = PaddingSize + Math.Clamp(snapshot.Cursor.Row, 0, snapshot.Rows - 1) * _cellHeight;
        _input.Width = Math.Max(_cellWidth * 2, Math.Min(240, _canvas.ActualWidth - _inputPosition.X - PaddingSize));
    }

    private CanvasTextLayout Layout(string text, bool bold)
    {
        if (_layouts.TryGetValue((text, bold), out var layout)) return layout;
        if (_layouts.Count >= 2048) ClearLayouts();
        using var format = TextFormat(bold);
        layout = new CanvasTextLayout(_canvas, text, format, 8192, _cellHeight * 2);
        _layouts.Add((text, bold), layout);
        return layout;
    }

    private void Draw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        if (_disposed || _session.Snapshot is null) return;
        try
        {
            DrawSnapshot(sender, args);
            LastRenderedSnapshot = _session.Snapshot;
            _firstFrame.TrySetResult();
        }
        catch (Exception exception)
        {
            _firstFrame.TrySetException(exception);
            if (_renderFailure.TrySetResult(exception)) _session.SetError($"终端绘制失败：{exception.Message}");
        }
    }

    private void DrawSnapshot(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var snapshot = _session.Snapshot;
        if (_disposed || snapshot is null) return;
        var drawing = args.DrawingSession;
        foreach (var cell in snapshot.Cells)
        {
            var rectangle = CellRect(cell.Row, cell.Col, cell.Wide ? 2 : 1);
            drawing.FillRectangle(rectangle, ParseColor(cell.Bg));
        }
        if (_selectionStart is { } selectionStart && _selectionEnd is { } selectionEnd)
        {
            var (start, end) = TerminalAlgorithms.Order(selectionStart, selectionEnd);
            for (var row = start.Row; row <= end.Row; row++)
            {
                var first = row == start.Row ? start.Col : 0;
                var last = row == end.Row ? end.Col : snapshot.Cols - 1;
                drawing.FillRectangle(CellRect(row, first, last - first + 1), Color.FromArgb(180, 55, 88, 130));
            }
        }
        foreach (var cell in snapshot.Cells)
        {
            if (string.IsNullOrWhiteSpace(cell.Text)) continue;
            var rectangle = CellRect(cell.Row, cell.Col, cell.Wide ? 2 : 1);
            using (drawing.CreateLayer(1f, rectangle))
                drawing.DrawTextLayout(Layout(cell.Text, cell.Bold), new Vector2((float)rectangle.X, (float)rectangle.Y), ParseColor(cell.Fg));
            if (cell.Underline)
                drawing.DrawLine((float)rectangle.Left, (float)rectangle.Bottom - 2,
                    (float)rectangle.Right, (float)rectangle.Bottom - 2, ParseColor(cell.Fg), 1);
        }
        if (snapshot.Cursor.Visible && snapshot.Offset == 0)
        {
            var cursor = CellRect(snapshot.Cursor.Row, snapshot.Cursor.Col, 1);
            drawing.DrawRectangle(cursor, _input.FocusState != FocusState.Unfocused ? Colors.White : Color.FromArgb(255, 120, 125, 135), 1);
            if (_composing && _input.Text.Length > 0)
            {
                using var format = TextFormat();
                drawing.DrawText(_input.Text, new Vector2((float)cursor.X, (float)cursor.Y), Colors.White, format);
                drawing.DrawLine((float)cursor.X, (float)cursor.Bottom - 1,
                    (float)cursor.X + Math.Min(_input.Text.Length * _cellWidth, (float)_input.Width), (float)cursor.Bottom - 1, Colors.White, 1);
            }
        }
    }

    private Rect CellRect(int row, int col, int width) => new(PaddingSize + col * _cellWidth, PaddingSize + row * _cellHeight, width * _cellWidth, _cellHeight);
    private static Color ParseColor(string hex)
    {
        if (hex.Length == 7 && int.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out var value))
            return Color.FromArgb(255, (byte)(value >> 16), (byte)(value >> 8), (byte)value);
        return Colors.White;
    }

    private CellPoint PointAt(Point point)
    {
        var snapshot = _session.Snapshot;
        return new CellPoint(Math.Clamp((int)((point.Y - PaddingSize) / _cellHeight), 0, Math.Max(0, (snapshot?.Rows ?? 1) - 1)),
            Math.Clamp((int)((point.X - PaddingSize) / _cellWidth), 0, Math.Max(0, (snapshot?.Cols ?? 1) - 1)));
    }

    private void HandlePointerPressed(object sender, PointerRoutedEventArgs args)
    {
        var point = args.GetCurrentPoint(_canvas);
        if (!point.Properties.IsLeftButtonPressed) return;
        _selectionStart = _selectionEnd = PointAt(point.Position);
        _selecting = true;
        _canvas.CapturePointer(args.Pointer);
        args.Handled = true;
        FocusInput();
        _canvas.Invalidate();
    }
    private void HandlePointerMoved(object sender, PointerRoutedEventArgs args)
    {
        if (!_selecting) return;
        _selectionEnd = PointAt(args.GetCurrentPoint(_canvas).Position);
        args.Handled = true;
        _canvas.Invalidate();
    }
    private void HandlePointerReleased(object sender, PointerRoutedEventArgs args)
    {
        if (!_selecting) return;
        _selectionEnd = PointAt(args.GetCurrentPoint(_canvas).Position);
        _selecting = false;
        _canvas.ReleasePointerCapture(args.Pointer);
        args.Handled = true;
        _canvas.Invalidate();
    }
    private void ClearSelection()
    {
        _selectionStart = _selectionEnd = null;
        _canvas.Invalidate();
    }

    private static bool IsDown(VirtualKey key) =>
        (InputKeyboardSource.GetKeyStateForCurrentThread(key) & CoreVirtualKeyStates.Down) != 0;

    private async void HandleKeyDown(object sender, KeyRoutedEventArgs args)
    {
        // During composition, Enter/Escape/arrows belong to the IME. Only the
        // native TextBox's eventual committed string enters the PTY.
        if (_composing) return;
        var control = IsDown(VirtualKey.Control);
        var alt = IsDown(VirtualKey.Menu);
        var shift = IsDown(VirtualKey.Shift);
        // Right Alt (AltGr) can report Ctrl+Alt; let the native text service
        // produce its actual keyboard-layout text instead of a control code.
        if (control && alt && IsDown(VirtualKey.RightMenu)) { _altText = false; return; }
        if (control && (args.Key == VirtualKey.C && shift || args.Key == VirtualKey.Insert))
        {
            args.Handled = true;
            CopySelection();
            return;
        }
        if (control && args.Key == VirtualKey.V || shift && args.Key == VirtualKey.Insert)
        {
            args.Handled = true;
            await PasteAsync();
            return;
        }
        if (shift && args.Key is VirtualKey.PageUp or VirtualKey.PageDown)
        {
            args.Handled = true;
            await _session.ScrollAsync((args.Key == VirtualKey.PageUp ? 1 : -1) * Math.Max(1, (_session.Snapshot?.Rows ?? 30) - 1));
            return;
        }
        var encoded = TerminalAlgorithms.EncodeKey((int)args.Key, control, alt, shift, _session.Snapshot?.Modes?.ApplicationCursor ?? false);
        if (encoded is null) { _altText = alt; return; }
        args.Handled = true;
        var pending = TakeCommittedText();
        ClearSelection();
        await _session.SendAsync(pending + encoded);
    }

    private void QueueCommit()
    {
        if (_commitQueued || _disposed) return;
        _commitQueued = true;
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, async () =>
        {
            _commitQueued = false;
            if (_disposed || _composing || _input.Text.Length == 0) return;
            var text = TakeCommittedText();
            ClearSelection();
            await _session.SendAsync(text);
        });
    }

    private string TakeCommittedText()
    {
        if (_composing || _input.Text.Length == 0) return "";
        var text = (_altText ? "\x1b" : "") + _input.Text;
        _altText = false;
        _clearingInput = true;
        _input.Text = "";
        _clearingInput = false;
        return text;
    }

    private void CopySelection()
    {
        if (_session.Snapshot is not { } snapshot || _selectionStart is not { } a || _selectionEnd is not { } b) return;
        try
        {
            var data = new DataPackage();
            data.SetText(TerminalAlgorithms.SelectedText(snapshot, a, b));
            Clipboard.SetContent(data);
        }
        catch (Exception exception) { _session.SetError($"复制失败：{exception.Message}"); }
    }

    private async Task PasteAsync()
    {
        try
        {
            var data = Clipboard.GetContent();
            if (!data.Contains(StandardDataFormats.Text)) return;
            ClearSelection();
            var text = await data.GetTextAsync();
            if (_session.Snapshot?.Modes?.BracketedPaste == true) text = "\x1b[200~" + text + "\x1b[201~";
            await _session.SendAsync(text);
        }
        catch (Exception exception) { _session.SetError($"粘贴失败：{exception.Message}"); }
    }

    private void ClearLayouts()
    {
        foreach (var layout in _layouts.Values) layout.Dispose();
        _layouts.Clear();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _session.ReleaseView(_owner);
        _session.Changed -= SnapshotChanged;
        _resizeDelay?.Cancel();
        _resizeDelay?.Dispose();
        if (_root is not null) _root.Changed -= RootChanged;
        ClearLayouts();
        _canvas.RemoveFromVisualTree();
    }
}
