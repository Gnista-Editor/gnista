//! The kill ring and the system clipboard, as Emacs's select-enable-clipboard links them.

use std::sync::{Arc, Mutex};

use gnista_core::Editor;
use gnista_core::select::Clipboard;

/// A clipboard another program can write to as well.
#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Option<String>>>);

impl Clipboard for Shared {
    fn get_text(&mut self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    fn set_text(&mut self, text: &str) {
        *self.0.lock().unwrap() = Some(text.to_string());
    }
}

fn setup(text: &str) -> (Editor, Shared) {
    let mut ed = Editor::new();
    ed.window_buffer_mut().set_text(text);
    let clipboard = Shared::default();
    ed.set_clipboard(Box::new(clipboard.clone()));
    (ed, clipboard)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn kills_and_copies_go_to_the_clipboard() {
    let (mut ed, mut clipboard) = setup("one two\nthree\nfour\n");
    ed.press("C-SPC M-f M-w").unwrap();
    assert_eq!(clipboard.get_text().as_deref(), Some("one"));
    // Kills in a row join, and the whole of it is on the clipboard.
    ed.press("C-n C-a C-k C-k").unwrap();
    assert_eq!(clipboard.get_text().as_deref(), Some("three\n"));
}

#[test]
fn yanking_takes_in_what_another_program_copied() {
    let (mut ed, mut clipboard) = setup("");
    ed.kill_new("from gnista");
    clipboard.set_text("from elsewhere");
    ed.press("C-y").unwrap();
    assert_eq!(text(&ed), "from elsewhere");
    // It is the newest kill now: M-y would go on to the one before.
    assert_eq!(ed.current_kill(1).unwrap(), "from gnista");
    assert_eq!(ed.current_kill(-1).unwrap(), "from elsewhere");
    // Yanking again takes nothing new in: the clipboard is unchanged since.
    ed.press("RET C-y").unwrap();
    assert_eq!(text(&ed), "from elsewhere\nfrom elsewhere");
    assert_eq!(ed.kill_ring(), ["from gnista", "from elsewhere"]);
    // What the editor put there itself is not taken in again.
    ed.kill_new("mine");
    ed.press("RET C-y").unwrap();
    assert_eq!(ed.kill_ring(), ["from gnista", "from elsewhere", "mine"]);
}

#[test]
fn the_clipboard_can_be_kept_apart() {
    let (mut ed, mut clipboard) = setup("word");
    ed.set_variable("select-enable-clipboard", gnista_core::Value::Bool(false));
    clipboard.set_text("outside");
    ed.press("C-SPC M-f M-w").unwrap();
    assert_eq!(clipboard.get_text().as_deref(), Some("outside"));
    ed.press("C-e C-y").unwrap();
    assert_eq!(text(&ed), "wordword");
}

#[test]
fn a_front_end_runs_copy_and_paste_as_commands() {
    // As the Mac's ⌘C and ⌘V do, through the command loop, so M-y can follow.
    let (mut ed, mut clipboard) = setup("");
    ed.kill_new("older");
    clipboard.set_text("pasted");
    ed.command_execute("yank");
    assert_eq!(text(&ed), "pasted");
    assert_eq!(ed.last_command(), Some("yank"));
}
