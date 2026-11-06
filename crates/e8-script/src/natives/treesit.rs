//! Tree-sitter.

use crate::natives::{natives, Record};

natives! {
    /// The languages E8 has tree-sitter grammars for.
    pub fn treesitLanguages(ed) -> Vec<String> {
        Ok(ed.treesit_languages().into_iter().map(String::from).collect::<Vec<_>>())
    }

    fn treesitSetLanguage(ed, language: Option<String>) {
        ed.set_buffer_language(language.as_deref())
    }

    /// The current buffer's tree-sitter language, if it has one.
    pub fn treesitLanguage(ed) -> Option<String> {
        Ok(ed.buffer_language().map(String::from))
    }

    /// Put the faces the syntax tree gives the text from start to end on it as face properties, as Emacs's treesit-font-lock-fontify-region.
    pub fn treesitFontLockFontifyRegion(ed, start: usize, end: usize) {
        ed.treesit_font_lock_fontify_region(start, end);
        Ok(())
    }

    fn treesitNodeAt(ed, pos: usize) -> Option<Record> {
        Ok(ed.syntax_node_at(pos).map(|(kind, start, end)| Record::new().with("type", kind).with("start", start).with("end", end)))
    }
}
