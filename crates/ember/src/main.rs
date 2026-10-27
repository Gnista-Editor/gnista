//! The Ember terminal editor.
//!
//! Usage: `ember [-q] [--print-types] [FILE...]`
//!
//! - `-q`, `--no-init`: do not load `init.ts`.
//! - `--print-types`: print the TypeScript declarations for the `ember` API
//!   (after loading `init.ts`, so its commands are included) and exit.

mod ui;

use std::{env, io};

use ember_core::{Editor, Key, KeyCode, expand_file_name};
use ember_script::{config, type_definitions};
use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{self, Event, KeyCode as TermKey, KeyEvent, KeyEventKind, KeyModifiers};

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
    let _scripting = config::setup(&mut editor, !no_init);
    if print_types {
        print!("{}", type_definitions(&editor));
        return Ok(());
    }
    for file in files {
        if let Err(e) = editor.visit_file(&expand_file_name(&file)) {
            editor.message(e.to_string());
        }
    }

    let mut terminal = ratatui::init();
    let result = run(&mut terminal, &mut editor);
    ratatui::restore();
    result
}

fn run(terminal: &mut DefaultTerminal, editor: &mut Editor) -> io::Result<()> {
    while !editor.should_quit() {
        let size = terminal.size()?;
        ui::layout_windows(editor, size.width, size.height);
        editor.ensure_point_visible();
        terminal.draw(|frame| ui::draw(frame, editor))?;
        if let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
            && let Some(key) = convert_key(key)
        {
            editor.handle_key(key);
        }
    }
    Ok(())
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
