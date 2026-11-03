//! Searching and matching.

use crate::natives::{natives, Field};
use crate::*;

natives! {
    fn lookingAt(ed, pattern: String, pos: Option<usize>, fold: Option<bool>) -> bool {
        let case_fold = fold.unwrap_or_else(|| ed.variable("case-fold-search").is_none_or(|v| v.is_true()));
        let pos = pos.unwrap_or(ed.buffer().point());
        let found = ed.looking_at(&pattern, pos, case_fold)?;
        if found.is_some() {
            ed.set_match_data(found.clone());
        }
        Ok(found.is_some())
    }

    /// Whether a search for a string should fold case: case-fold-search, unless
    /// the search is interactive, search-upper-case is on and the string has a
    /// capital letter.
    #[ts = "(pattern: string, interactive?: boolean): boolean"]
    pub fn foldCaseFor(ed, pattern: String, interactive: bool) -> bool {
        Ok(ember_core::search_fold_case(ed, &pattern, interactive))
    }

    /// Read these keys next, after the running command, as if typed again (Emacs's unread-command-events).
    pub fn unreadKeys(ed, keys: String) {
        let keys = ember_core::Key::parse_seq(&keys)
            .ok_or_else(|| ember_core::Error::new(format!("Invalid key sequence: {keys}")))?;
        ed.unread_keys(&keys);
        Ok(())
    }

    fn setKeymapDefault(ed, keymap: EditorValue, command: Option<String>) {
        let map = ed.keymap_of(&keymap)?;
        ed.keymaps_mut().set_default(map, command.as_deref());
        Ok(())
    }

    fn remapCommand(ed, keymap: EditorValue, from: String, to: Option<String>) {
        let map = ed.keymap_of(&keymap)?;
        ed.keymaps_mut().remap(map, &from, to.as_deref());
        Ok(())
    }

    fn search(ed, pattern: String, from: Option<usize>, regexp: bool, backward: bool, bound: Option<usize>, fold: Option<bool>) -> Option<ember_core::Match> {
        let case_fold = fold.unwrap_or_else(|| ember_core::search_fold_case(ed, &pattern, false));
        let options = ember_core::SearchOptions { regexp, backward, case_fold, bound };
        let from = from.unwrap_or(ed.buffer().point());
        let found = ed.search(&pattern, from, &options)?;
        if found.is_some() {
            ed.set_match_data(found.clone());
        }
        Ok(found)
    }

    /// Each line matching, as `[line, start, text]`.
    fn matchingLines(ed, pattern: String, fold: Option<bool>, from: Option<usize>, to: Option<usize>) -> Vec<Field> {
        let case_fold = fold.unwrap_or_else(|| ed.variable("case-fold-search").is_none_or(|v| v.is_true()));
        let lines = ed.matching_lines_in(&pattern, case_fold, from.unwrap_or(0), to.unwrap_or(usize::MAX))?;
        Ok(lines.into_iter().map(|(line, start, text)| Field::List(vec![line.into(), start.into(), text.into()])).collect())
    }

    /// The last successful search's match.
    #[ts = "(): Match | undefined"]
    pub fn matchData(ed) -> Option<ember_core::Match> {
        Ok(ed.match_data().cloned())
    }

    fn replaceMatch(ed, replacement: String, literal: bool, fixed_case: bool) -> Vec<usize> {
        let (s, e) = ed.replace_match(&replacement, literal, fixed_case)?;
        Ok(vec![s, e])
    }

    fn setOverridingMap(ed, keymap: EditorValue) {
        ed.set_overriding_map(Some(&keymap).filter(|k| !matches!(k, EditorValue::Null)))
    }

    fn overridingMap(ed) -> Option<EditorValue> {
        Ok(ed.overriding_map().map(EditorValue::Keymap))
    }

    /// How many columns text takes on screen, counting wide characters as two (Emacs's string-width).
    pub fn stringWidth(ed, text: String) -> usize {
        Ok(ember_core::display::display_width(&text, 8))
    }
}
