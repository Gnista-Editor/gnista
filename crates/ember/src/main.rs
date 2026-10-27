//! The Ember terminal editor.
//!
//! Usage: `ember [-q] [--print-types] [FILE...]`
//!
//! - `-q`, `--no-init`: do not load `init.ts`.
//! - `--print-types`: print the TypeScript declarations for the `ember` API
//!   (after loading `init.ts`, so its commands are included) and exit.

mod config;
mod ui;

use std::{env, io};

use ember_core::{Editor, Key, KeyCode, expand_file_name};
use ember_script::{Scripting, type_definitions};
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
    let dir = config::config_dir();
    match Scripting::new(&mut editor) {
        Ok(scripting) if !no_init => config::load_init(&mut editor, &scripting, &dir),
        Ok(_) => {}
        Err(e) => editor.message(format!("Scripting is unavailable: {e}")),
    }
    if print_types {
        print!("{}", type_definitions(&editor));
        return Ok(());
    }
    if let Err(e) = config::write_type_files(&editor, &dir) {
        editor.message(format!("Could not write ember.d.ts: {e}"));
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
