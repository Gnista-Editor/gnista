//! Case conversion, as Emacs's casefiddle.c: `upcase`, `downcase`,
//! `capitalize` and `upcase-initials` of characters and strings, the region
//! commands, and the word commands on `M-u`, `M-l` and `M-c`.
//!
//! A character alone changes as the case table says. In a string or the
//! buffer, the characters Unicode cases into several do so, ß upper-casing
//! to SS, and a capital sigma ending a word lower-cases to final sigma.
//! Words are runs of word constituents in the current buffer's syntax
//! table, so a word starts after `_` and, where it is punctuation, after `'`.

use crate::chartab_data::{SPECIAL_CASING, TITLECASE};
use crate::editor::Editor;
use crate::error::Result;
use crate::syntax_table::{Class, flags};

/// What casing does, as Emacs's `case_action`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Case {
    Up,
    Down,
    /// Each word's first character in title case and the rest in lower case.
    Capitalize,
    /// Each word's first character in title case and the rest as they are.
    UpcaseInitials,
}

const CAPITAL_SIGMA: char = '\u{3a3}';
const FINAL_SIGMA: char = '\u{3c2}';

/// A character's title case, as Unicode's `titlecase` property gives it,
/// for the few with a title form of their own, such as ǅ; the rest take
/// their upper case.
fn titlecase(c: char) -> Option<char> {
    let i = TITLECASE.binary_search_by_key(&(c as u32), |&(from, _)| from).ok()?;
    char::from_u32(TITLECASE[i].1)
}

/// What a character turns into when it changes into several, as the
/// `special-uppercase`, `special-lowercase` and `special-titlecase`
/// properties say.
fn special(c: char, case: Case) -> Option<&'static str> {
    let i = SPECIAL_CASING.binary_search_by_key(&(c as u32), |e| e.0).ok()?;
    let (_, up, down, title) = SPECIAL_CASING[i];
    match case {
        Case::Up => up,
        Case::Down => down,
        _ => title,
    }
}

/// The state of casing a run of text, as Emacs's `casing_context`.
struct Casing<'a> {
    case: Case,
    /// Whether it is the buffer, where an expression prefix starts no word.
    in_buffer: bool,
    in_word: bool,
    is_word: &'a dyn Fn(char) -> bool,
    is_prefix: &'a dyn Fn(char) -> bool,
    /// The buffer's own case table, if it has one rather than the standard.
    table: Option<std::rc::Rc<crate::casetab::CaseMaps>>,
}

impl Casing<'_> {
    /// What a character becomes, as `case_character`: `whole` for a string
    /// or the buffer, where special casings apply, and `next`, the
    /// character after it, for final sigma.
    fn character(&mut self, c: char, whole: bool, next: Option<char>) -> String {
        let was_in_word = self.in_word;
        self.in_word = (self.is_word)(c) && (!self.in_buffer || was_in_word || !(self.is_prefix)(c));
        let case = match self.case {
            Case::Capitalize if was_in_word => Case::Down,
            Case::UpcaseInitials if was_in_word => return c.to_string(),
            Case::UpcaseInitials => Case::Capitalize,
            case => case,
        };
        if whole && let Some(s) = special(c, case) {
            return s.to_string();
        }
        let down = |c| self.table.as_ref().map_or_else(|| crate::regexp::downcase(c), |t| t.downcase(c));
        let up = |c| self.table.as_ref().map_or_else(|| crate::regexp::upcase(c), |t| t.upcase(c));
        let cased = match case {
            Case::Down => down(c),
            Case::Capitalize => titlecase(c).unwrap_or_else(|| up(c)),
            _ => up(c),
        };
        // A capital sigma that ends a word becomes final sigma.
        if whole && was_in_word && c == CAPITAL_SIGMA && cased != c && !next.is_some_and(self.is_word) {
            return FINAL_SIGMA.to_string();
        }
        cased.to_string()
    }
}

impl Editor {
    fn casing<T>(&self, case: Case, in_buffer: bool, run: impl FnOnce(&mut Casing) -> T) -> T {
        let symbols = self.variable("case-symbols-as-words").is_some_and(|v| v.is_true());
        let is_word = |c: char| {
            let class = self.char_syntax(c).class;
            class == Class::Word || (symbols && class == Class::Symbol)
        };
        let is_prefix = |c: char| self.char_syntax(c).flags & flags::PREFIX != 0;
        let mut casing = Casing { case, in_buffer, in_word: false, is_word: &is_word, is_prefix: &is_prefix, table: self.case_maps() };
        run(&mut casing)
    }

    /// A string cased, as Emacs's `upcase`, `downcase`, `capitalize` and
    /// `upcase-initials` case a string.
    pub fn casify_string(&self, case: Case, s: &str) -> String {
        self.casing(case, false, |casing| {
            let chars: Vec<char> = s.chars().collect();
            (0..chars.len()).map(|i| casing.character(chars[i], true, chars.get(i + 1).copied())).collect()
        })
    }

    /// A character cased, as those functions case a character: by the case
    /// table alone, a character that cases into several staying as it is.
    pub fn casify_char(&self, case: Case, c: char) -> char {
        self.casing(case, false, |casing| casing.character(c, false, None)).chars().next().unwrap_or(c)
    }

    /// Cases the text from `start` to `end`, as Emacs's `upcase-region`,
    /// `downcase-region`, `capitalize-region` and `upcase-initials-region`:
    /// each character keeps its text properties, and point and markers stay
    /// with the text. Returns where the end of the text is now.
    pub fn casify_region(&mut self, case: Case, start: usize, end: usize) -> Result<usize> {
        let b = self.buffer();
        let (start, end) = (start.min(end).max(b.point_min()), start.max(end).min(b.point_max()));
        if start == end {
            return Ok(end);
        }
        let chars: Vec<char> = b.slice(start..end).chars().collect();
        let changes: Vec<(usize, String)> = self.casing(case, true, |casing| {
            let mut out = Vec::new();
            for (i, &c) in chars.iter().enumerate() {
                let cased = casing.character(c, true, chars.get(i + 1).copied());
                if cased.chars().ne(std::iter::once(c)) {
                    out.push((start + i, cased));
                }
            }
            out
        });
        if changes.is_empty() {
            return Ok(end);
        }
        let added: isize = changes.iter().map(|(_, s)| s.chars().count() as isize - 1).sum();
        self.case_chars(start, end, changes)?;
        Ok((end as isize + added) as usize)
    }

    /// Cases words from point, as Emacs's `upcase-word`, `downcase-word`
    /// and `capitalize-word`: `n` words on, moving over them, or back
    /// before point if `n` is negative, leaving point where it is.
    pub fn casify_word(&mut self, case: Case, n: i64) -> Result<()> {
        let point = self.buffer().point();
        let far = crate::commands::move_words(self, point, n);
        // Point goes to the end of what was cased: past the words going
        // forward, where it was going back.
        let end = self.casify_region(case, point, far)?;
        self.buffer_mut().set_point(end);
        Ok(())
    }
}
