//! Tree-sitter.

use crate::natives::{natives, Record};

natives! {
    /// The languages Ember has tree-sitter grammars for.
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

    fn treesitNodeAt(ed, pos: usize) -> Option<Record> {
        Ok(ed.syntax_node_at(pos).map(|(kind, start, end)| Record::new().with("type", kind).with("start", start).with("end", end)))
    }
}
