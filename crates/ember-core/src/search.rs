//! Searching, as Emacs's search.c: literal and regular expression search
//! forward and backward, with match data for the groups of the last match.
//!
//! Regular expressions are written in Emacs's syntax, where `\(`, `\)`,
//! `\|` and `\{` are special and the bare characters are literal, and are
//! translated to the `regex` crate's syntax. Back-references such as `\1`
//! cannot be translated, since the crate does not support them.

use regex::Regex;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};

/// Where an Emacs regular expression first matches in a string, in
/// characters, as Emacs's `string-match`.
pub fn string_match(pattern: &str, text: &str, fold: bool) -> Result<Option<usize>> {
    let re = regex::RegexBuilder::new(&translate_regexp(pattern)?)
        .case_insensitive(fold)
        .multi_line(true)
        .build()
        .map_err(|e| crate::error::Error::signal("invalid-regexp", format!("Invalid regexp: {e}"), Vec::new()))?;
    Ok(re.find(text).map(|m| text[..m.start()].chars().count()))
}

/// Translates an Emacs regular expression into the `regex` crate's syntax.
pub fn translate_regexp(emacs: &str) -> Result<String> {
    let chars: Vec<char> = emacs.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    // Whether the next character starts an expression, where `*` is literal, as in Emacs.
    let mut at_start = true;
    while i < chars.len() {
        let c = chars[i];
        let mut starts_next = false;
        match c {
            '\\' => {
                let Some(&next) = chars.get(i + 1) else {
                    return Err(Error::new("Trailing backslash"));
                };
                i += 1;
                match next {
                    '(' => {
                        if chars.get(i + 1) == Some(&'?') && chars.get(i + 2) == Some(&':') {
                            out.push_str("(?:");
                            i += 2;
                        } else {
                            out.push('(');
                        }
                        starts_next = true;
                    }
                    ')' => out.push(')'),
                    '|' => {
                        out.push('|');
                        starts_next = true;
                    }
                    '{' => {
                        let close = (i + 1..chars.len().saturating_sub(1))
                            .find(|&j| chars[j] == '\\' && chars[j + 1] == '}')
                            .ok_or_else(|| Error::new("Unmatched \\{"))?;
                        let inner: String = chars[i + 1..close].iter().collect();
                        let inner = if inner.starts_with(',') { format!("0{inner}") } else { inner };
                        out.push('{');
                        out.push_str(&inner);
                        out.push('}');
                        i = close + 1;
                    }
                    '<' => out.push_str(r"\b{start}"),
                    '>' => out.push_str(r"\b{end}"),
                    'b' => out.push_str(r"\b"),
                    'B' => out.push_str(r"\B"),
                    'w' => out.push_str(r"\w"),
                    'W' => out.push_str(r"\W"),
                    '`' => out.push_str(r"\A"),
                    '\'' => out.push_str(r"\z"),
                    '=' => return Err(Error::new("\\= (point) is not supported in regular expressions")),
                    '_' => match chars.get(i + 1) {
                        // Symbol boundaries, approximated by word boundaries,
                        // which treat `_` as part of a word too.
                        Some('<') => {
                            out.push_str(r"\b{start}");
                            i += 1;
                        }
                        Some('>') => {
                            out.push_str(r"\b{end}");
                            i += 1;
                        }
                        _ => return Err(Error::new("Invalid \\_ construct")),
                    },
                    's' | 'S' => {
                        let class = chars.get(i + 1).ok_or_else(|| Error::new("Invalid syntax class"))?;
                        let set = match class {
                            '-' | ' ' => r"\s",
                            'w' => r"\w",
                            '_' => r"[_\-]",
                            '.' => r"[[:punct:]]",
                            '(' => r"[(\[{]",
                            ')' => r"[)\]}]",
                            '"' => r#"["']"#,
                            _ => return Err(Error::new(format!("Invalid syntax class \\s{class}"))),
                        };
                        if next == 'S' {
                            let negated = match set {
                                r"\s" => r"\S".to_string(),
                                r"\w" => r"\W".to_string(),
                                set => format!("[^{}]", &set[1..set.len() - 1]),
                            };
                            out.push_str(&negated);
                        } else {
                            out.push_str(set);
                        }
                        i += 1;
                    }
                    d @ '1'..='9' => {
                        return Err(Error::new(format!("Back-references such as \\{d} are not supported")));
                    }
                    // Anything else after a backslash is itself.
                    other => out.push_str(&regex::escape(&other.to_string())),
                }
            }
            '*' | '+' | '?' if at_start => out.push_str(&regex::escape(&c.to_string())),
            '*' | '+' | '?' => {
                out.push(c);
                // `*?` is a non-greedy repeat in Emacs too.
                if chars.get(i + 1) == Some(&'?') {
                    out.push('?');
                    i += 1;
                }
            }
            '^' if at_start => {
                out.push_str("(?m:^)");
                starts_next = true;
            }
            '$' if chars.get(i + 1).is_none_or(|_| ends_expression(&chars, i + 1)) => out.push_str("(?m:$)"),
            '[' => {
                let (class, next) = translate_class(&chars, i)?;
                out.push_str(&class);
                i = next;
                at_start = false;
                continue;
            }
            '.' => out.push_str("[^\n]"),
            // Characters special to the crate but literal in Emacs.
            '(' | ')' | '|' | '{' | '}' | '^' | '$' | '#' | '&' | '-' | '~' => {
                out.push_str(&regex::escape(&c.to_string()))
            }
            c => out.push(c),
        }
        at_start = starts_next;
        i += 1;
    }
    Ok(out)
}

/// Whether position `i` ends an expression: the end, or `\)` or `\|`.
fn ends_expression(chars: &[char], i: usize) -> bool {
    i >= chars.len() || (chars[i] == '\\' && matches!(chars.get(i + 1), Some(')') | Some('|')))
}

/// Translates a bracket expression starting at `chars[start]`, which is
/// `[`. Returns it and the index after its `]`.
fn translate_class(chars: &[char], start: usize) -> Result<(String, usize)> {
    let mut out = String::from("[");
    let mut i = start + 1;
    if chars.get(i) == Some(&'^') {
        out.push('^');
        i += 1;
    }
    // A `]` first is part of the set.
    let mut first = true;
    loop {
        let Some(&c) = chars.get(i) else { return Err(Error::new("Unmatched [ or [^")) };
        if c == ']' && !first {
            out.push(']');
            return Ok((out, i + 1));
        }
        first = false;
        if c == '[' && chars.get(i + 1) == Some(&':') {
            let close = (i + 2..chars.len().saturating_sub(1))
                .find(|&j| chars[j] == ':' && chars[j + 1] == ']')
                .ok_or_else(|| Error::new("Unmatched [:"))?;
            let name: String = chars[i + 2..close].iter().collect();
            let class = match name.as_str() {
                "space" | "blank" => "[:space:]",
                "word" => r"\w",
                "nonascii" => r"[^\x00-\x7f]",
                "multibyte" => r"[^\x00-\xff]",
                "alpha" | "alnum" | "digit" | "xdigit" | "upper" | "lower" | "punct" | "cntrl" | "graph"
                | "print" | "ascii" => {
                    out.push_str(&format!("[:{name}:]"));
                    i = close + 2;
                    continue;
                }
                _ => return Err(Error::new(format!("Invalid character class [:{name}:]"))),
            };
            out.push_str(class);
            i = close + 2;
            continue;
        }
        match c {
            '\\' | '[' | '&' | '~' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
        i += 1;
    }
}

/// What a search looks for and how.
#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub regexp: bool,
    pub backward: bool,
    /// Whether upper and lower case match each other.
    pub case_fold: bool,
    /// How far the search may go: a match must lie before it searching
    /// forward, or after it searching backward.
    pub bound: Option<usize>,
}

/// A match: where it starts and ends, and where each group matched.
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    /// Group 0 is the whole match.
    pub groups: Vec<Option<(usize, usize)>>,
}

/// Compiles a search pattern.
pub fn compile(pattern: &str, options: &SearchOptions) -> Result<Regex> {
    let source = if options.regexp { translate_regexp(pattern)? } else { regex::escape(pattern) };
    let source = if options.case_fold { format!("(?i){source}") } else { source };
    Regex::new(&source).map_err(|e| Error::signal("invalid-regexp", format!("Invalid regexp: {e}"), Vec::new()))
}

/// Searches a buffer from `from`, positions counted in characters.
///
/// Only the text a match could lie in is copied out of the buffer: from the
/// start of the line the search begins on, so `^` and `\b` see what comes
/// before them, to the bound. A pattern anchored at the buffer's start gets
/// the text from there.
pub fn search(b: &Buffer, pattern: &str, from: usize, options: &SearchOptions) -> Result<Option<Match>> {
    let re = compile(pattern, options)?;
    let rope = b.text();
    // A narrowed buffer is searched only where it is accessible, as in Emacs,
    // and its start is where \` matches.
    let (min, max) = (b.point_min(), b.point_max());
    let from = from.clamp(min, max);
    let line_start = |pos: usize| b.line_start(b.line_of(pos.min(max))).max(min);
    let anchored_at_start = re.as_str().contains(r"\A");
    let (lo, hi) = if options.backward {
        let lo = if anchored_at_start { min } else { options.bound.map_or(min, line_start) };
        (lo, from)
    } else {
        let lo = if anchored_at_start { min } else { line_start(from) };
        (lo, options.bound.map_or(max, |bound| bound.clamp(min, max)))
    };
    if lo > hi || from > hi {
        return Ok(None);
    }
    let text = b.slice(lo..hi);
    let base = rope.char_to_byte(lo);
    let to_char = |byte: usize| rope.byte_to_char(base + byte);
    let byte_of = |pos: usize| rope.char_to_byte(pos) - base;
    // Group offsets of a match found in `text[start..]`, as buffer positions.
    let to_match = |start: usize, caps: regex::Captures| {
        let groups: Vec<Option<(usize, usize)>> = (0..caps.len())
            .map(|g| caps.get(g).map(|m| (to_char(start + m.start()), to_char(start + m.end()))))
            .collect();
        let (start, end) = groups[0].expect("group 0 always matches");
        Match { start, end, groups }
    };
    if !options.backward {
        return Ok(re.captures_at(&text, byte_of(from)).map(|caps| to_match(0, caps)));
    }
    let limit = options.bound.map_or(0, |bound| byte_of(bound.clamp(lo, hi)));
    if options.bound.is_some_and(|bound| from < bound) {
        return Ok(None);
    }
    // The match that starts last before `from` and ends by it, as Emacs's
    // backward search finds. The last of the non-overlapping matches gives
    // the lowest place it can start.
    let haystack = text.as_str();
    let Some(lowest) = re.find_iter(haystack).filter(|m| m.start() >= limit).last().map(|m| m.start()) else {
        return Ok(None);
    };
    let anchored = Regex::new(&format!(r"\A(?:{})", re.as_str())).map_err(|e| Error::signal("invalid-regexp", format!("Invalid regexp: {e}"), Vec::new()))?;
    let found = (lowest..=haystack.len())
        .rev()
        .filter(|&start| haystack.is_char_boundary(start))
        .find_map(|start| anchored.captures(&haystack[start..]).map(|caps| to_match(start, caps)));
    Ok(found)
}

/// The match of an Emacs regexp starting exactly at `pos`, as Emacs's
/// looking-at finds it, or `None`. It reads from the start of the line, so
/// `^` and `\b` see what comes before, and only a little past `pos` unless
/// the match runs on.
pub fn looking_at(b: &Buffer, pattern: &str, pos: usize, case_fold: bool) -> Result<Option<Match>> {
    let re = compile(pattern, &SearchOptions { regexp: true, backward: false, case_fold, bound: None })?;
    let rope = b.text();
    let (min, max) = (b.point_min(), b.point_max());
    let pos = pos.clamp(min, max);
    let lo = if re.as_str().contains(r"\A") { min } else { b.line_start(b.line_of(pos)).max(min) };
    let mut window = 4096;
    loop {
        let hi = (pos + window).min(max);
        let text = b.slice(lo..hi);
        let base = rope.char_to_byte(lo);
        let at = rope.char_to_byte(pos) - base;
        let found = re.captures_at(&text, at).filter(|caps| caps.get(0).is_some_and(|m| m.start() == at));
        match found {
            // A match that reaches the end of what was read may run on.
            Some(caps) if caps.get(0).is_some_and(|m| m.end() == text.len()) && hi < max => window *= 8,
            Some(caps) => {
                let to_char = |byte: usize| rope.byte_to_char(base + byte);
                let groups: Vec<Option<(usize, usize)>> =
                    (0..caps.len()).map(|g| caps.get(g).map(|m| (to_char(m.start()), to_char(m.end())))).collect();
                let (start, end) = groups[0].expect("group 0 always matches");
                return Ok(Some(Match { start, end, groups }));
            }
            None => return Ok(None),
        }
    }
}

/// Whether search case should be folded for a string, as Emacs decides with
/// `case-fold-search` and, for interactive searches, `search-upper-case`:
/// folding is on unless the string has an upper case letter.
pub fn fold_case_for(ed: &Editor, pattern: &str, interactive: bool) -> bool {
    let fold = ed.variable("case-fold-search").is_none_or(|v| v.is_true());
    let upper = interactive
        && ed.variable("search-upper-case").is_none_or(|v| v.is_true())
        && has_upper_case(pattern);
    fold && !upper
}

/// Whether a search string has an upper case letter, ignoring escapes such
/// as `\W` in a regexp.
fn has_upper_case(pattern: &str) -> bool {
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c.is_uppercase() {
            return true;
        }
    }
    false
}

/// Expands a replacement for a match, as Emacs's `replace-match`: `\&` is
/// the whole match, `\N` group N and `\\` a backslash, when `literal` is
/// off. Unless `fixed_case`, the replacement follows the match's case: all
/// capitals if the match is, capitalised if its first letter is.
pub fn expand_replacement(text: &str, m: &Match, replacement: &str, literal: bool, fixed_case: bool) -> Result<String> {
    let mut out = String::new();
    if literal {
        out.push_str(replacement);
    } else {
        let chars: Vec<char> = text.chars().collect();
        let group = |n: usize| -> Result<String> {
            let (s, e) = m.groups.get(n).copied().flatten().ok_or_else(|| Error::new(format!("No group {n} in the match")))?;
            Ok(chars[s - m.start..e - m.start].iter().collect())
        };
        let mut it = replacement.chars();
        while let Some(c) = it.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match it.next() {
                Some('&') => out.push_str(&group(0)?),
                Some(d @ '0'..='9') => out.push_str(&group(d as usize - '0' as usize)?),
                Some('\\') => out.push('\\'),
                Some('?') => return Err(Error::new("\\? in a replacement is not supported")),
                Some(other) => return Err(Error::new(format!("Invalid use of `\\' in replacement text: \\{other}"))),
                None => return Err(Error::new("Invalid use of `\\' in replacement text")),
            }
        }
    }
    if fixed_case {
        return Ok(out);
    }
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return Ok(out);
    }
    let all_upper = letters.iter().all(|c| c.is_uppercase());
    let first_upper = text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).all(|w| {
        w.chars().next().is_some_and(char::is_uppercase)
    });
    Ok(if all_upper && letters.len() > 1 {
        out.to_uppercase()
    } else if first_upper {
        capitalize(&out)
    } else {
        out
    })
}

/// Capitalises each word, as Emacs's `upcase-initials`.
fn capitalize(text: &str) -> String {
    let mut out = String::new();
    let mut start = true;
    for c in text.chars() {
        if start && c.is_alphabetic() {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        start = !c.is_alphanumeric();
    }
    out
}

impl Editor {
    /// Searches the current buffer from point, as Emacs's `search-forward`
    /// and its relatives do: on success, point moves to the end of the match
    /// (its start, searching backward) and the match is kept for
    /// [`Editor::match_data`]. `count` finds that many matches in turn.
    pub fn search_buffer(&mut self, pattern: &str, options: &SearchOptions, count: usize) -> Result<Option<Match>> {
        let mut found = None;
        let mut from = self.buffer().point();
        for _ in 0..count.max(1) {
            let Some(m) = search(self.buffer(), pattern, from, options)? else { return Ok(None) };
            // An empty match where the last one ended would repeat forever.
            from = if options.backward { m.start } else { m.end };
            found = Some(m);
        }
        let m = found.expect("count is at least one");
        self.buffer_mut().set_point(if options.backward { m.start } else { m.end });
        self.match_data = Some(m.clone());
        Ok(Some(m))
    }

    /// The last successful search's match.
    pub fn match_data(&self) -> Option<&Match> {
        self.match_data.as_ref()
    }

    pub fn set_match_data(&mut self, m: Option<Match>) {
        self.match_data = m;
    }

    /// Replaces the text the last search matched, as Emacs's `replace-match`,
    /// leaving point after the replacement. Returns the new text's range.
    pub fn replace_match(&mut self, replacement: &str, literal: bool, fixed_case: bool) -> Result<(usize, usize)> {
        let m = self.match_data.clone().ok_or_else(|| Error::new("No previous search"))?;
        let b = self.buffer();
        if m.end > b.len() {
            return Err(Error::new("The match is out of date"));
        }
        let text = b.slice(m.start..m.end);
        let new = expand_replacement(&text, &m, replacement, literal, fixed_case)?;
        let b = self.buffer_mut();
        // As in Emacs, a mark at the end of the replaced text ends up at the
        // end of the new text, even where the match was empty.
        let mark_at_end = b.mark() == Some(m.end);
        b.set_point(m.start);
        b.delete(m.start..m.end)?;
        b.insert(&new)?;
        let end = m.start + new.chars().count();
        if mark_at_end {
            b.set_mark(Some(end));
        }
        self.match_data = Some(Match { start: m.start, end, groups: vec![Some((m.start, end))] });
        Ok((m.start, end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(emacs: &str) -> String {
        translate_regexp(emacs).unwrap()
    }

    #[test]
    fn translates_emacs_syntax() {
        assert_eq!(t(r"\(foo\|bar\)"), "(foo|bar)");
        assert_eq!(t("(a|b)"), r"\(a\|b\)");
        assert_eq!(t(r"a\{2,3\}"), "a{2,3}");
        assert_eq!(t(r"a\{,3\}"), "a{0,3}");
        assert_eq!(t("*a"), r"\*a");
        assert_eq!(t("^a$"), "(?m:^)a(?m:$)");
        assert_eq!(t("a^b$c"), r"a\^b\$c");
        assert_eq!(t(r"\(?:x\)"), "(?:x)");
        assert_eq!(t("[]a]"), "[]a]");
        assert_eq!(t("[[:alpha:]_]"), "[[:alpha:]_]");
        assert_eq!(t("a.b"), "a[^\n]b");
        assert!(translate_regexp(r"\(a\)\1").is_err());
    }

    fn buffer(text: &str) -> Buffer {
        let mut b = Buffer::new("t");
        b.set_text(text);
        b
    }

    fn find(b: &Buffer, pattern: &str, from: usize, regexp: bool, backward: bool) -> Option<(usize, usize)> {
        let options = SearchOptions { regexp, backward, ..Default::default() };
        search(b, pattern, from, &options).unwrap().map(|m| (m.start, m.end))
    }

    #[test]
    fn searches_forward_and_backward() {
        let b = buffer("one two one two");
        assert_eq!(find(&b, "two", 0, false, false), Some((4, 7)));
        assert_eq!(find(&b, "two", 5, false, false), Some((12, 15)));
        assert_eq!(find(&b, "one", 15, false, true), Some((8, 11)));
        // Backward, the match must end by the starting point.
        assert_eq!(find(&b, "one", 10, false, true), Some((0, 3)));
        assert_eq!(find(&b, r"o\w*", 15, true, true), Some((14, 15)));
        assert_eq!(find(&b, r"\<t\w+", 0, true, false), Some((4, 7)));
        assert_eq!(find(&b, "three", 0, false, false), None);
    }

    #[test]
    fn positions_count_characters() {
        let b = buffer("héllo wörld");
        assert_eq!(find(&b, "wö", 0, false, false), Some((6, 8)));
        assert_eq!(find(&b, "l", 11, false, true), Some((9, 10)));
    }

    #[test]
    fn replacements_follow_case() {
        let m = |s: usize, e: usize| Match { start: s, end: e, groups: vec![Some((s, e))] };
        assert_eq!(expand_replacement("foo", &m(0, 3), "bar", false, false).unwrap(), "bar");
        assert_eq!(expand_replacement("Foo", &m(0, 3), "bar", false, false).unwrap(), "Bar");
        assert_eq!(expand_replacement("FOO", &m(0, 3), "bar", false, false).unwrap(), "BAR");
        assert_eq!(expand_replacement("FOO", &m(0, 3), "bar", false, true).unwrap(), "bar");
        let groups = Match { start: 0, end: 7, groups: vec![Some((0, 7)), Some((0, 3)), Some((4, 7))] };
        assert_eq!(expand_replacement("abc def", &groups, r"\2 \1 [\&]", false, true).unwrap(), "def abc [abc def]");
    }
}
