//! The system clipboard, as Emacs's select.el links it to the kill ring
//! with `select-enable-clipboard`: what is killed or copied goes to the
//! clipboard too, and yanking first takes in what another program put
//! there since, as `interprogram-cut-function` and
//! `interprogram-paste-function` do. The front end reads and writes the
//! clipboard; without one, as in tests and the terminal, the kill ring
//! keeps to itself.

use crate::editor::Editor;

/// A front end's access to the system clipboard.
pub trait Clipboard: Send {
    /// The text on the clipboard, if any.
    fn get_text(&mut self) -> Option<String>;
    fn set_text(&mut self, text: &str);
}

impl Editor {
    /// Gives the editor the system clipboard.
    pub fn set_clipboard(&mut self, clipboard: Box<dyn Clipboard>) {
        self.clipboard = Some(clipboard);
    }

    fn clipboard_enabled(&self) -> bool {
        self.variable("select-enable-clipboard").is_none_or(|v| v.is_true())
    }

    /// Puts killed text on the clipboard, as `gui-select-text` does.
    pub(crate) fn interprogram_cut(&mut self, text: &str) {
        if !self.clipboard_enabled() {
            return;
        }
        if let Some(clipboard) = &mut self.clipboard {
            clipboard.set_text(text);
            self.last_selected_text = Some(text.to_string());
        }
    }

    /// What another program put on the clipboard since the editor last put
    /// text there or took it in, as `gui-selection-value` gives it: nothing
    /// if it is what the editor put there itself.
    pub(crate) fn interprogram_paste(&mut self) -> Option<String> {
        if !self.clipboard_enabled() {
            return None;
        }
        let text = self.clipboard.as_mut()?.get_text().filter(|t| !t.is_empty())?;
        if self.last_selected_text.as_ref() == Some(&text) {
            return None;
        }
        self.last_selected_text = Some(text.clone());
        Some(text)
    }
}
