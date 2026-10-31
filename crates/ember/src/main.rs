//! The Ember terminal editor.
//!
//! Usage: `ember [-q] [--print-types] [FILE...]`
//!
//! - `-q`, `--no-init`: do not load `init.ts`.
//! - `--print-types`: print the TypeScript declarations for the `ember` API
//!   (after loading `init.ts`, so its commands are included) and exit.

mod ui;

use std::io::Write;
use std::{env, io};

use std::time::{Duration, Instant};

use ember_core::{Arg, Editor, Key, KeyCode, MouseEvent, MouseKind, WindowId, expand_file_name};
use ember_script::{config, type_definitions};
use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode as TermKey, KeyEvent, KeyEventKind, KeyModifiers,
    MouseButton, MouseEventKind,
};
use ratatui::crossterm::execute;

fn main() -> io::Result<()> {
    let (mut no_init, mut print_types, mut files) = (false, false, Vec::new());
    for arg in env::args().skip(1) {
        match arg.as_str() {
            "-q" | "--no-init" => no_init = true,
            "--print-types" => print_types = true,
            _ => files.push(arg),
        }
    }

    let mut editor = Editor::new();
    let _scripting = config::setup_with(&mut editor, !no_init, ember_agent::install);
    if print_types {
        print!("{}", type_definitions(&editor));
        return Ok(());
    }
    for file in files {
        if let Err(e) = editor.call("find-file", vec![Arg::Str(expand_file_name(&file).display().to_string())]) {
            editor.message(e.to_string());
        }
    }

    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;
    let result = run(&mut terminal, &mut editor);
    execute!(io::stdout(), DisableMouseCapture)?;
    ratatui::restore();
    result
}

fn run(terminal: &mut DefaultTerminal, editor: &mut Editor) -> io::Result<()> {
    let mut mouse = Mouse::default();
    while !editor.should_quit() {
        let size = terminal.size()?;
        ui::layout_windows(editor, size.width, size.height);
        editor.redisplay();
        terminal.draw(|frame| ui::draw(frame, editor))?;
        // Wait for a key, or until a timer or auto-save is due.
        if let Some(due) = editor.next_timer_in()
            && !event::poll(due)?
        {
            editor.run_timers();
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if let Some(key) = convert_key(key) {
                    editor.handle_key(key);
                }
            }
            Event::Mouse(event) => mouse.handle(editor, event, size.width, size.height),
            _ => {}
        }
        // The bell: the terminal's own, or with visible-bell its flash, as
        // Emacs on a terminal rings it.
        if editor.take_bell() {
            let visible = editor.variable("visible-bell").is_some_and(|v| v.is_true());
            let mut out = io::stdout();
            out.write_all(if visible { b"\x1b[?5h" } else { b"\x07" })?;
            out.flush()?;
            if visible {
                std::thread::sleep(std::time::Duration::from_millis(50));
                out.write_all(b"\x1b[?5l")?;
                out.flush()?;
            }
        }
    }
    Ok(())
}

/// Lines a wheel notch scrolls in a terminal.
const WHEEL_LINES: isize = 3;
/// How soon a second click counts as a double click.
const DOUBLE_CLICK: Duration = Duration::from_millis(400);

/// Turns the terminal's mouse reports into Emacs's mouse keys.
#[derive(Default)]
struct Mouse {
    /// Where the left button went down, while it is down.
    pressed: Option<(WindowId, Option<usize>)>,
    dragged: bool,
    /// The last click, for counting double and triple clicks.
    last_click: Option<(Instant, u16, u16, u8)>,
    clicks: u8,
}

impl Mouse {
    fn handle(&mut self, ed: &mut Editor, event: ratatui::crossterm::event::MouseEvent, width: u16, height: u16) {
        let Some((window, position)) = ui::mouse_target(ed, width, height, event.column, event.row) else { return };
        let shift = event.modifiers.contains(KeyModifiers::SHIFT);
        let key = |kind| Key { code: KeyCode::Mouse(kind, 1), ctrl: false, meta: false, shift };
        let at = MouseEvent { window, position, start: None };
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let now = Instant::now();
                self.clicks = match self.last_click {
                    Some((t, x, y, n)) if now - t < DOUBLE_CLICK && (x, y) == (event.column, event.row) => n % 3 + 1,
                    _ => 1,
                };
                self.last_click = Some((now, event.column, event.row, self.clicks));
                self.pressed = Some((window, position));
                self.dragged = false;
                if self.clicks == 1 {
                    ed.mouse(key(MouseKind::Down), at);
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(start) = self.pressed
                    && (self.dragged || start != (window, position))
                {
                    self.dragged = true;
                    ed.mouse(key(MouseKind::Drag), MouseEvent { start: Some(start), ..at });
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if self.pressed.take().is_some() && !self.dragged {
                    let kind = match self.clicks {
                        2 => MouseKind::Double,
                        3 => MouseKind::Triple,
                        _ => MouseKind::Click,
                    };
                    ed.mouse(key(kind), at);
                }
            }
            MouseEventKind::ScrollDown => ed.wheel_in(Some(window), WHEEL_LINES),
            MouseEventKind::ScrollUp => ed.wheel_in(Some(window), -WHEEL_LINES),
            _ => {}
        }
    }
}

/// Translates a terminal key event into the core's key type.
fn convert_key(event: KeyEvent) -> Option<Key> {
    let ctrl = event.modifiers.contains(KeyModifiers::CONTROL);
    let meta = event.modifiers.contains(KeyModifiers::ALT);
    let shift = event.modifiers.contains(KeyModifiers::SHIFT);
    let (code, shift) = match event.code {
        TermKey::Char(c) if ctrl => {
            let c = match c {
                // Terminals send C-/ and C-_ as 0x1f, which crossterm reports as C-7;
                // 0x1c to 0x1e arrive as C-4 to C-6 the same way.
                '7' => '/',
                '4' => '\\',
                '5' => ']',
                '6' => '^',
                c => c,
            };
            // A shifted letter in a chord is written C-S-f, as in Emacs.
            (KeyCode::Char(c.to_ascii_lowercase()), c.is_ascii_uppercase() || (shift && c.is_ascii_alphabetic()))
        }
        TermKey::Char(c) if meta && c.is_ascii_uppercase() => (KeyCode::Char(c.to_ascii_lowercase()), true),
        // Shift on a plain character is part of the character.
        TermKey::Char(c) => (KeyCode::Char(c), false),
        TermKey::BackTab => (KeyCode::Tab, true),
        code => (special_key(code)?, shift),
    };
    Some(Key { code, ctrl, meta, shift })
}

fn special_key(code: TermKey) -> Option<KeyCode> {
    Some(match code {
        TermKey::Enter => KeyCode::Enter,
        TermKey::Tab => KeyCode::Tab,
        TermKey::Backspace => KeyCode::Backspace,
        TermKey::Delete => KeyCode::Delete,
        TermKey::Insert => KeyCode::Insert,
        TermKey::Esc => KeyCode::Esc,
        TermKey::Left => KeyCode::Left,
        TermKey::Right => KeyCode::Right,
        TermKey::Up => KeyCode::Up,
        TermKey::Down => KeyCode::Down,
        TermKey::Home => KeyCode::Home,
        TermKey::End => KeyCode::End,
        TermKey::PageUp => KeyCode::PageUp,
        TermKey::PageDown => KeyCode::PageDown,
        TermKey::F(n) => KeyCode::F(n),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: TermKey, modifiers: KeyModifiers) -> String {
        convert_key(KeyEvent::new(code, modifiers)).map(|k| k.to_string()).unwrap_or_default()
    }

    #[test]
    fn converts_terminal_keys() {
        assert_eq!(key(TermKey::Char('x'), KeyModifiers::CONTROL), "C-x");
        assert_eq!(key(TermKey::Char('7'), KeyModifiers::CONTROL), "C-/");
        assert_eq!(key(TermKey::Char('A'), KeyModifiers::SHIFT), "A");
        assert_eq!(key(TermKey::Char('<'), KeyModifiers::ALT), "M-<");
        assert_eq!(key(TermKey::Right, KeyModifiers::SHIFT), "S-<right>");
        assert_eq!(key(TermKey::Char('F'), KeyModifiers::CONTROL | KeyModifiers::SHIFT), "C-S-f");
        assert_eq!(key(TermKey::Char('F'), KeyModifiers::ALT), "M-S-f");
    }
}
