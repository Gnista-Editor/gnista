//! The Ember terminal editor.

mod ui;

use std::{env, io};

use ember_core::{Editor, Key, KeyCode, expand_file_name};
use ratatui::DefaultTerminal;
use ratatui::crossterm::event::{self, Event, KeyCode as TermKey, KeyEvent, KeyEventKind, KeyModifiers};

fn main() -> io::Result<()> {
    let mut editor = Editor::new();
    for arg in env::args().skip(1) {
        if let Err(e) = editor.visit_file(&expand_file_name(&arg)) {
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
        editor.set_viewport_height(ui::text_height(size.height));
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
    let code = match event.code {
        TermKey::Char(c) if ctrl => KeyCode::Char(match c {
            // Terminals send C-/ and C-_ as 0x1f, which crossterm reports as C-7;
            // 0x1c to 0x1e arrive as C-4 to C-6 the same way.
            '7' => '/',
            '4' => '\\',
            '5' => ']',
            '6' => '^',
            c => c.to_ascii_lowercase(),
        }),
        TermKey::Char(c) => KeyCode::Char(c),
        TermKey::Enter => KeyCode::Enter,
        TermKey::Tab => KeyCode::Tab,
        TermKey::Backspace => KeyCode::Backspace,
        TermKey::Delete => KeyCode::Delete,
        TermKey::Esc => KeyCode::Esc,
        TermKey::Left => KeyCode::Left,
        TermKey::Right => KeyCode::Right,
        TermKey::Up => KeyCode::Up,
        TermKey::Down => KeyCode::Down,
        TermKey::Home => KeyCode::Home,
        TermKey::End => KeyCode::End,
        TermKey::PageUp => KeyCode::PageUp,
        TermKey::PageDown => KeyCode::PageDown,
        _ => return None,
    };
    Some(Key { code, ctrl, meta })
}
