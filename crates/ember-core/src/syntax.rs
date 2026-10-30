//! Syntax trees from tree-sitter, for highlighting, as Emacs's treesit.el
//! does it. A buffer with a language keeps a tree that edits update
//! incrementally; it is reparsed when a window next needs it. Highlighting
//! queries only the rows being drawn, and the grammar's captures, such as
//! `keyword` or `string`, become the `font-lock-*` faces.

use std::cell::{Cell, OnceCell, RefCell};
use std::rc::Rc;

use ropey::Rope;
use tree_sitter::{InputEdit, Language, Parser, Point, Query, QueryCursor, StreamingIterator, Tree};

use crate::error::{Error, Result};

/// A language Ember can parse: a grammar and its highlighting query.
pub(crate) struct Grammar {
    pub(crate) language: Language,
    highlights_source: &'static str,
    /// Compiled on first use, since compiling takes a while.
    highlights: OnceCell<Rc<Query>>,
}

impl Grammar {
    fn new(language: Language, highlights_source: &'static str) -> Grammar {
        Grammar { language, highlights_source, highlights: OnceCell::new() }
    }

    fn highlights(&self) -> Result<Rc<Query>> {
        if let Some(query) = self.highlights.get() {
            return Ok(query.clone());
        }
        let query = Query::new(&self.language, self.highlights_source)
            .map_err(|e| Error::new(format!("The highlighting query does not compile: {e}")))?;
        Ok(self.highlights.get_or_init(|| Rc::new(query)).clone())
    }
}

/// The grammars that ship with Ember, by the names Emacs uses for them.
pub(crate) fn builtin_grammars() -> Vec<(&'static str, Grammar)> {
    vec![
        ("javascript", Grammar::new(tree_sitter_javascript::LANGUAGE.into(), tree_sitter_javascript::HIGHLIGHT_QUERY)),
        ("json", Grammar::new(tree_sitter_json::LANGUAGE.into(), tree_sitter_json::HIGHLIGHTS_QUERY)),
        ("python", Grammar::new(tree_sitter_python::LANGUAGE.into(), tree_sitter_python::HIGHLIGHTS_QUERY)),
        ("rust", Grammar::new(tree_sitter_rust::LANGUAGE.into(), tree_sitter_rust::HIGHLIGHTS_QUERY)),
    ]
}

/// A buffer's syntax tree, and the parser that keeps it, as Emacs's
/// tree-sitter parser objects.
pub(crate) struct SyntaxTree {
    /// Its id, which parser and node objects refer to it by.
    pub(crate) id: u64,
    pub(crate) language: String,
    /// The tag code gave it, as `treesit-parser-create`'s TAG.
    pub(crate) tag: Option<String>,
    /// Whether it is the one the major mode made, which highlights.
    pub(crate) primary: bool,
    /// Counts the trees parsed, so a node from an earlier one is known to
    /// be out of date, as Emacs's node timestamps.
    pub(crate) generation: Cell<u64>,
    parser: RefCell<Parser>,
    tree: RefCell<Option<Tree>>,
    /// Whether edits since the last parse are waiting to be parsed.
    stale: Cell<bool>,
    query: Rc<Query>,
}

impl SyntaxTree {
    pub(crate) fn new(name: &str, grammar: &Grammar, tag: Option<String>, primary: bool) -> Result<SyntaxTree> {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let mut parser = Parser::new();
        parser
            .set_language(&grammar.language)
            .map_err(|e| Error::new(format!("Cannot use the {name} grammar: {e}")))?;
        Ok(SyntaxTree {
            id: NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            language: name.to_string(),
            tag,
            primary,
            generation: Cell::new(0),
            parser: RefCell::new(parser),
            tree: RefCell::new(None),
            stale: Cell::new(true),
            query: grammar.highlights()?,
        })
    }

    /// Tells the tree about an edit, so the next parse can reuse what did not change.
    pub(crate) fn edit(&self, edit: &InputEdit) {
        if let Some(tree) = self.tree.borrow_mut().as_mut() {
            tree.edit(edit);
        }
        self.stale.set(true);
    }

    pub(crate) fn reset(&self) {
        *self.tree.borrow_mut() = None;
        self.stale.set(true);
    }

    /// The tree as last parsed, with the edits since applied to it but not
    /// parsed again, as a node taken from it still sees it in Emacs.
    pub(crate) fn last_parsed(&self) -> Option<Tree> {
        self.tree.borrow().clone()
    }

    /// The tree for the text, parsing first if it is out of date.
    pub(crate) fn parsed(&self, text: &Rope) -> Option<Tree> {
        if self.stale.get() || self.tree.borrow().is_none() {
            let old = self.tree.borrow().clone();
            let len = text.len_bytes();
            let mut read = |byte: usize, _: Point| -> &[u8] {
                if byte >= len {
                    return &[];
                }
                let (chunk, start, _, _) = text.chunk_at_byte(byte);
                &chunk.as_bytes()[byte - start..]
            };
            let tree = self.parser.borrow_mut().parse_with_options(&mut read, old.as_ref(), None);
            *self.tree.borrow_mut() = tree;
            self.stale.set(false);
            self.generation.set(self.generation.get() + 1);
        }
        self.tree.borrow().clone()
    }

    /// The faces of the characters from `start` up to `end`, one for each,
    /// from the highlighting query. Where captures overlap, the innermost
    /// wins, and among captures of the same text the query's first.
    pub(crate) fn faces(&self, text: &Rope, start: usize, end: usize) -> Vec<Option<&'static str>> {
        let mut faces = vec![None; end.saturating_sub(start)];
        let Some(tree) = self.parsed(text) else { return faces };
        let (start_byte, end_byte) = (text.char_to_byte(start), text.char_to_byte(end));
        let mut cursor = QueryCursor::new();
        cursor.set_byte_range(start_byte..end_byte);
        let source = |node: tree_sitter::Node| text.byte_slice(node.byte_range()).chunks().map(str::as_bytes);
        let names = self.query.capture_names();
        let mut spans = Vec::new();
        let mut captures = cursor.captures(&self.query, tree.root_node(), source);
        while let Some((m, i)) = captures.next() {
            let capture = m.captures()[*i];
            if let Some(face) = capture_face(names[capture.index as usize]) {
                spans.push((capture.node.byte_range(), m.pattern_index, face));
            }
        }
        // Longer spans first, so shorter ones inside them are painted over;
        // for the same text, the query's first pattern is painted last.
        spans.sort_by_key(|a| std::cmp::Reverse((a.0.len(), a.1)));
        for (range, _, face) in spans {
            let from = text.byte_to_char(range.start.max(start_byte)).max(start) - start;
            let to = text.byte_to_char(range.end.min(end_byte)).min(end) - start;
            for slot in &mut faces[from..to] {
                *slot = Some(face);
            }
        }
        faces
    }

    /// The kind of the smallest named node at a character position, and its range.
    pub(crate) fn node_at(&self, text: &Rope, pos: usize) -> Option<(String, usize, usize)> {
        let tree = self.parsed(text)?;
        let byte = text.char_to_byte(pos.min(text.len_chars()));
        let node = tree.root_node().named_descendant_for_byte_range(byte, byte)?;
        let range = node.byte_range();
        Some((node.kind().to_string(), text.byte_to_char(range.start), text.byte_to_char(range.end)))
    }
}

/// The face for a capture name, trying `keyword.control.rust`, then
/// `keyword.control`, then `keyword`.
fn capture_face(name: &str) -> Option<&'static str> {
    let mut name = name;
    loop {
        let face = match name {
            "comment" => Some("font-lock-comment-face"),
            "string" | "character" | "string.special" => Some("font-lock-string-face"),
            "escape" | "string.escape" | "string.regexp" => Some("font-lock-escape-face"),
            "keyword" | "conditional" | "repeat" | "include" | "exception" => Some("font-lock-keyword-face"),
            "function.macro" | "attribute" | "preproc" => Some("font-lock-builtin-face"),
            "function" | "method" | "function.method" | "function.call" | "constructor.call" => {
                Some("font-lock-function-call-face")
            }
            "type" | "constructor" | "module" | "namespace" => Some("font-lock-type-face"),
            "number" | "float" => Some("font-lock-number-face"),
            "constant" | "boolean" | "label" => Some("font-lock-constant-face"),
            "variable.builtin" | "type.builtin" | "function.builtin" => Some("font-lock-builtin-face"),
            "variable.parameter" | "parameter" => Some("font-lock-variable-name-face"),
            "property" | "field" | "tag" => Some("font-lock-property-name-face"),
            "operator" => Some("font-lock-operator-face"),
            "punctuation" => Some("font-lock-punctuation-face"),
            _ => None,
        };
        if face.is_some() {
            return face;
        }
        // Built-in variants fall back to the plain capture: "constant.builtin" to "constant".
        name = name.rsplit_once('.')?.0;
    }
}

impl crate::editor::Editor {
    /// The languages Ember has grammars for.
    pub fn treesit_languages(&self) -> Vec<&'static str> {
        self.grammars.keys().copied().collect()
    }

    /// Gives the current buffer a syntax tree in a language, as a major mode
    /// does with Emacs's `treesit-parser-create`. `None` removes it.
    pub fn set_buffer_language(&mut self, language: Option<&str>) -> Result<()> {
        let syntax = match language {
            Some(name) => {
                let grammar = self
                    .grammars
                    .get(name)
                    .ok_or_else(|| Error::new(format!("No grammar for {name}")))?;
                Some(SyntaxTree::new(name, grammar, None, true)?)
            }
            None => None,
        };
        let b = self.buffer_mut();
        b.parsers.retain(|p| !p.primary);
        if let Some(syntax) = syntax {
            b.parsers.insert(0, syntax);
        }
        Ok(())
    }

    /// The current buffer's language, if it has a syntax tree.
    pub fn buffer_language(&self) -> Option<&str> {
        self.buffer().primary_syntax().map(|s| s.language.as_str())
    }

    /// The kind and range of the smallest named syntax node at a position.
    pub fn syntax_node_at(&self, pos: usize) -> Option<(String, usize, usize)> {
        let b = self.buffer();
        b.primary_syntax()?.node_at(b.text(), pos)
    }
}

/// Where a character position is, for tree-sitter: its byte offset, and its
/// line and byte column.
pub(crate) fn point_at(text: &Rope, pos: usize) -> (usize, Point) {
    let byte = text.char_to_byte(pos);
    let line = text.char_to_line(pos);
    (byte, Point { row: line, column: byte - text.line_to_byte(line) })
}

pub(crate) fn input_edit(start: (usize, Point), old_end: (usize, Point), new_end: (usize, Point)) -> InputEdit {
    InputEdit {
        start_byte: start.0,
        old_end_byte: old_end.0,
        new_end_byte: new_end.0,
        start_position: start.1,
        old_end_position: old_end.1,
        new_end_position: new_end.1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn faces_of(language: &str, source: &str) -> Vec<(String, &'static str)> {
        let grammars = builtin_grammars();
        let grammar = &grammars.iter().find(|(n, _)| *n == language).unwrap().1;
        let tree = SyntaxTree::new(language, grammar, None, true).unwrap();
        let text = Rope::from_str(source);
        let faces = tree.faces(&text, 0, text.len_chars());
        // Runs of the same face, with their text.
        let mut runs: Vec<(String, &'static str)> = Vec::new();
        for (i, face) in faces.iter().enumerate() {
            let Some(face) = face else { continue };
            match runs.last_mut() {
                Some((s, f)) if f == face && faces[i - 1] == Some(face) => s.push(text.char(i)),
                _ => runs.push((text.char(i).to_string(), face)),
            }
        }
        runs
    }

    #[test]
    fn highlights_rust() {
        let runs = faces_of("rust", "fn main() { let s = \"hi\"; // note\n}");
        assert!(runs.contains(&("fn".into(), "font-lock-keyword-face")), "{runs:?}");
        assert!(runs.contains(&("\"hi\"".into(), "font-lock-string-face")), "{runs:?}");
        assert!(runs.contains(&("// note".into(), "font-lock-comment-face")), "{runs:?}");
        assert!(runs.iter().any(|(s, f)| s == "main" && f.contains("function")), "{runs:?}");
    }

    #[test]
    fn highlights_json_and_python() {
        let json = faces_of("json", r#"{"a": 1, "b": true}"#);
        assert!(json.iter().any(|(_, f)| *f == "font-lock-number-face"), "{json:?}");
        let python = faces_of("python", "def f():\n    return None  # done\n");
        assert!(python.contains(&("def".into(), "font-lock-keyword-face")), "{python:?}");
        assert!(python.contains(&("# done".into(), "font-lock-comment-face")), "{python:?}");
    }

    #[test]
    fn capture_names_fall_back() {
        assert_eq!(capture_face("keyword.control.rust"), Some("font-lock-keyword-face"));
        assert_eq!(capture_face("constant.builtin"), Some("font-lock-constant-face"));
        assert_eq!(capture_face("variable"), None);
    }
}
