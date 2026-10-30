//! The system clipboard for the editor's kill ring, through `arboard`,
//! which egui itself uses for the clipboard.

use ember_core::select::Clipboard;

pub struct SystemClipboard(arboard::Clipboard);

impl SystemClipboard {
    /// The system clipboard, if this system has one the editor can reach.
    pub fn new() -> Option<SystemClipboard> {
        arboard::Clipboard::new().ok().map(SystemClipboard)
    }
}

impl Clipboard for SystemClipboard {
    fn get_text(&mut self) -> Option<String> {
        self.0.get_text().ok()
    }

    fn set_text(&mut self, text: &str) {
        let _ = self.0.set_text(text.to_string());
    }
}
