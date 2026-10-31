//! The Ember terminal editor.
//!
//! Usage: `ember [-q] [--print-types] [FILE...]`
//!
//! - `-q`, `--no-init`: do not load `init.ts`.
//! - `--print-types`: print the TypeScript declarations for the `ember` API
//!   (after loading `init.ts`, so its commands are included) and exit.

mod ui;

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::{env, io};

use std::time::{Duration, Instant};

use ember_core::driver::{Driver, Input};
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

    if print_types {
        let mut editor = Editor::new();
        let _scripting = config::setup_with(&mut editor, !no_init, ember_agent::install);
        print!("{}", type_definitions(&editor));
        return Ok(());
    }

    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;
    // The editor runs on a thread of its own; this one reads the terminal
    // and draws what the editor last published, so a long command never
    // stops the screen updating, and C-g reaches it.
    let size = terminal.size()?;
    let size = Arc::new(Mutex::new((size.width, size.height)));
    let laid_out = size.clone();
    let driver = Driver::spawn(
        move |editor| {
            let scripting = config::setup_with(editor, !no_init, ember_agent::install);
            for file in files {
                if let Err(e) = editor.call("find-file", vec![Arg::Str(expand_file_name(&file).display().to_string())]) {
                    editor.message(e.to_string());
                }
            }
            Box::new(scripting)
        },
        move |editor| {
            let (width, height) = *laid_out.lock().unwrap_or_else(|e| e.into_inner());
            ui::layout_windows(editor, width, height);
            editor.redisplay();
            vec![ui::describe(editor)]
        },
        || {},
    );
    let result = run(&mut terminal, &driver, &size);
    drop(driver);
    execute!(io::stdout(), DisableMouseCapture)?;
    ratatui::restore();
    result
}

/// How often the screen looks for a new frame from the editor while no
/// input comes.
const FRAME_POLL: Duration = Duration::from_millis(16);

fn run(terminal: &mut DefaultTerminal, driver: &Driver, size: &Mutex<(u16, u16)>) -> io::Result<()> {
    let mouse = Arc::new(Mutex::new(Mouse::default()));
    let mut drawn = 0;
    loop {
        // What the editor last published, whatever it is doing now.
        let (description, bell) = {
            let mut published = driver.published();
            if published.exit {
                return Ok(());
            }
            let fresh = published.generation != drawn;
            drawn = published.generation;
            let bell = std::mem::take(&mut published.bell).then_some(published.visible_bell);
            (published.frames.first().filter(|_| fresh).cloned(), bell)
        };
        if let Some(description) = description {
            terminal.draw(|frame| ui::draw(frame, &description))?;
        }
        if let Some(visible) = bell {
            ring_bell(visible)?;
        }
        if !event::poll(FRAME_POLL)? {
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if let Some(key) = convert_key(key) {
                    driver.key(key);
                }
            }
            Event::Mouse(event) => {
                let (width, height) = *size.lock().unwrap_or_else(|e| e.into_inner());
                let mouse = mouse.clone();
                driver.run(move |editor| {
                    mouse.lock().unwrap_or_else(|e| e.into_inner()).handle(editor, event, width, height);
                });
            }
            Event::Resize(width, height) => {
                *size.lock().unwrap_or_else(|e| e.into_inner()) = (width, height);
                driver.send(Input::Wake);
            }
            _ => {}
        }
    }
}

/// The bell: the terminal's own, or with visible-bell its flash, as Emacs
/// on a terminal rings it.
fn ring_bell(visible: bool) -> io::Result<()> {
    let mut out = io::stdout();
    out.write_all(if visible { b"\x1b[?5h" } else { b"\x07" })?;
    out.flush()?;
    if visible {
        std::thread::sleep(std::time::Duration::from_millis(50));
        out.write_all(b"\x1b[?5l")?;
        out.flush()?;
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
