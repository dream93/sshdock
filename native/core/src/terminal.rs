use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Listener(Arc<Mutex<Vec<Event>>>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    }
}

pub(crate) struct Terminal {
    term: Term<Listener>,
    parser: Processor,
    events: Listener,
    title: String,
    default_title: String,
}

impl Terminal {
    pub fn new(cols: u16, rows: u16, title: &str) -> Self {
        let events = Listener::default();
        let config = terminal_config(cols);
        Self {
            term: Term::new(
                config,
                &TermSize::new(cols.into(), rows.into()),
                events.clone(),
            ),
            parser: Processor::new(),
            events,
            title: title.to_owned(),
            default_title: title.to_owned(),
        }
    }

    /// The same parser lives for the entire session, including partial UTF-8/CSI.
    /// Reply strings must be written to the PTY by the session, never rendered.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.parser.advance(&mut self.term, bytes);
        // Native snapshots are rendered immediately; do not retain an unfinished
        // synchronized-update buffer forever if a program stops writing.
        self.parser.stop_sync(&mut self.term);
        let events = std::mem::take(&mut *self.events.0.lock().unwrap_or_else(|e| e.into_inner()));
        let mut replies = Vec::new();
        for event in events {
            match event {
                Event::Title(title) => self.title = title,
                Event::ResetTitle => self.title.clone_from(&self.default_title),
                Event::PtyWrite(text) => replies.push(text),
                Event::ColorRequest(index, formatter) => {
                    let color = self.term.colors()[index].unwrap_or_else(|| palette(index));
                    replies.push(formatter(color));
                }
                Event::TextAreaSizeRequest(formatter) => {
                    replies.push(formatter(WindowSize {
                        num_lines: self.term.screen_lines() as u16,
                        num_cols: self.term.columns() as u16,
                        cell_width: 0,
                        cell_height: 0,
                    }));
                }
                _ => {}
            }
        }
        replies
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.term.set_options(terminal_config(cols));
        self.term.resize(TermSize::new(cols.into(), rows.into()));
    }

    pub fn scroll(&mut self, delta: i32) {
        self.term.scroll_display(Scroll::Delta(delta));
    }

    pub fn reset_scroll(&mut self) {
        self.term.scroll_display(Scroll::Bottom);
    }

    pub fn snapshot(&self) -> Value {
        let content = self.term.renderable_content();
        let offset = content.display_offset;
        let cols = self.term.columns();
        let rows = self.term.screen_lines();
        let cursor_row = content.cursor.point.line.0 + offset as i32;
        let cursor = json!({
            "row": cursor_row.max(0),
            "col": content.cursor.point.column.0,
            "visible": offset == 0 && content.cursor.shape != CursorShape::Hidden,
        });
        let mut cells = Vec::with_capacity(cols * rows);
        for indexed in content.display_iter {
            let cell = indexed.cell;
            let row = indexed.point.line.0 + offset as i32;
            if !(0..rows as i32).contains(&row) {
                continue;
            }
            // Spacer cells still carry backgrounds, but must not draw another glyph.
            let spacer = cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
            let mut text = if spacer || cell.flags.contains(Flags::HIDDEN) {
                String::new()
            } else {
                cell.c.to_string()
            };
            if !spacer
                && !cell.flags.contains(Flags::HIDDEN)
                && let Some(combining) = cell.zerowidth()
            {
                text.extend(combining);
            }
            let mut fg = resolve_color(cell.fg, content.colors);
            let mut bg = resolve_color(cell.bg, content.colors);
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            cells.push(json!({
                "row": row,
                "col": indexed.point.column.0,
                "text": text,
                "fg": hex(fg),
                "bg": hex(bg),
                "bold": cell.flags.contains(Flags::BOLD),
                "underline": cell.flags.intersects(Flags::ALL_UNDERLINES),
                "wide": cell.flags.contains(Flags::WIDE_CHAR),
            }));
        }
        json!({"cols":cols,"rows":rows,"cursor":cursor,"cells":cells,"offset":offset,"title":self.title,
            "modes":{"applicationCursor":content.mode.contains(TermMode::APP_CURSOR),
                "bracketedPaste":content.mode.contains(TermMode::BRACKETED_PASTE)}})
    }
}

fn terminal_config(cols: u16) -> Config {
    // Retain up to 10000 lines without multiplying memory indefinitely on
    // ultrawide terminals. History is capped at two million cells per session.
    Config {
        scrolling_history: 10_000.min(2_000_000 / usize::from(cols)),
        ..Config::default()
    }
}

fn hex(color: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
}

fn resolve_color(color: Color, colors: &Colors) -> Rgb {
    match color {
        Color::Spec(rgb) => rgb,
        Color::Indexed(index) => colors[index as usize].unwrap_or_else(|| palette(index as usize)),
        Color::Named(name) => colors[name].unwrap_or_else(|| palette(name as usize)),
    }
}

fn palette(index: usize) -> Rgb {
    const ANSI: [u32; 16] = [
        0x1d2028, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf, 0x5c6370,
        0xff7b86, 0xb5e890, 0xffd68a, 0x82c7ff, 0xe59bff, 0x7ed9e4, 0xffffff,
    ];
    let value = match index {
        0..16 => ANSI[index],
        16..232 => {
            let index = index - 16;
            let level = |v: usize| if v == 0 { 0 } else { 55 + 40 * v };
            ((level(index / 36) as u32) << 16)
                | ((level(index / 6 % 6) as u32) << 8)
                | level(index % 6) as u32
        }
        232..256 => {
            let gray = 8 + (index - 232) * 10;
            (gray as u32) * 0x010101
        }
        v if v == NamedColor::Background as usize => 0x151922,
        259..267 => {
            let base = ANSI[index - 259];
            ((base & 0xff0000) >> 1 & 0x7f0000)
                | ((base & 0x00ff00) >> 1 & 0x007f00)
                | ((base & 0x0000ff) >> 1)
        }
        _ => 0xd8dee9,
    };
    Rgb {
        r: (value >> 16) as u8,
        g: (value >> 8) as u8,
        b: value as u8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(snapshot: &Value, row: u64, col: u64) -> &Value {
        snapshot["cells"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["row"] == row && v["col"] == col)
            .unwrap()
    }

    #[test]
    fn utf8_escape_sequences_combining_width_and_attributes_survive_chunk_boundaries() {
        let mut terminal = Terminal::new(20, 4, "shell");
        for byte in "中e\u{301}\x1b[31;1;4m红\x1b[0m\x1b]0;标题\x07".as_bytes() {
            terminal.feed(&[*byte]);
        }
        let snapshot = terminal.snapshot();
        assert_eq!(cell(&snapshot, 0, 0)["text"], "中");
        assert_eq!(cell(&snapshot, 0, 0)["wide"], true);
        assert_eq!(cell(&snapshot, 0, 1)["text"], "");
        assert_eq!(cell(&snapshot, 0, 2)["text"], "e\u{301}");
        assert_eq!(cell(&snapshot, 0, 3)["text"], "红");
        assert_eq!(cell(&snapshot, 0, 3)["fg"], "#e06c75");
        assert_eq!(cell(&snapshot, 0, 3)["bold"], true);
        assert_eq!(cell(&snapshot, 0, 3)["underline"], true);
        assert_eq!(snapshot["title"], "标题");
    }

    #[test]
    fn alternate_screen_scrollback_cursor_and_resize_are_preserved() {
        let mut terminal = Terminal::new(20, 3, "shell");
        terminal.feed(b"one\r\ntwo\r\nthree\r\nfour");
        terminal.scroll(1);
        assert_eq!(terminal.snapshot()["offset"], 1);
        assert_eq!(cell(&terminal.snapshot(), 0, 0)["text"], "o");
        assert_eq!(terminal.snapshot()["cursor"]["visible"], false);
        terminal.reset_scroll();
        terminal.feed(b"\x1b[?1049h\x1b[2J\x1b[Hvim\x1b[?25l");
        assert_eq!(cell(&terminal.snapshot(), 0, 0)["text"], "v");
        assert_eq!(terminal.snapshot()["cursor"]["visible"], false);
        terminal.feed(b"\x1b[?1049l\x1b[?25h");
        assert_eq!(cell(&terminal.snapshot(), 0, 0)["text"], "t");
        terminal.resize(25, 5);
        assert_eq!(terminal.snapshot()["cols"], 25);
        assert_eq!(terminal.snapshot()["rows"], 5);
        assert_eq!(terminal.snapshot()["cursor"]["visible"], true);
    }

    #[test]
    fn terminal_queries_return_protocol_replies() {
        let mut terminal = Terminal::new(80, 24, "shell");
        assert_eq!(terminal.feed(b"\x1b[6n"), vec!["\x1b[1;1R"]);
        terminal.feed(b"\x1b[?1h\x1b[?2004h");
        assert_eq!(terminal.snapshot()["modes"]["applicationCursor"], true);
        assert_eq!(terminal.snapshot()["modes"]["bracketedPaste"], true);
        terminal.feed(b"\x1b[?1l\x1b[?2004l");
        assert_eq!(terminal.snapshot()["modes"]["applicationCursor"], false);
        assert_eq!(terminal.snapshot()["modes"]["bracketedPaste"], false);
    }
}
