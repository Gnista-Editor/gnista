//! Emacs's regular expressions, as regex-emacs.c matches them: the syntax
//! parsed exactly, with its rules for when `*`, `^` and `$` are special,
//! and compiled to a program for a backtracking machine that reads the
//! buffer, or a string, through a [`Haystack`], asking its syntax table for
//! the classes `\w`, `\sC`, `\b` and `[:space:]` depend on. Alternatives
//! are tried in order and greedy operators try the longest first, as
//! Emacs's matcher does, so the match and its groups are Emacs's.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::error::{Error, Result};
use crate::syntax_table::Class;

/// What a regexp is matched against: characters by position, with the
/// accessible bounds, point, and each character's syntax class.
pub trait Haystack {
    /// The character at `pos`, or `None` outside the bounds.
    fn char_at(&self, pos: usize) -> Option<char>;
    /// Where `\`` and `^` match at the start, and `\'` and `$` at the end.
    fn min(&self) -> usize;
    fn max(&self) -> usize;
    /// Where `\=` matches, or `None`, as in a string.
    fn point(&self) -> Option<usize>;
    /// The syntax class of the character `c` at `pos`.
    fn class_at(&self, pos: usize, c: char) -> Class;
}

/// A string to match, with a syntax table's classes.
pub struct StrHaystack<'a> {
    pub chars: Vec<char>,
    pub class: &'a dyn Fn(char) -> Class,
}

impl Haystack for StrHaystack<'_> {
    fn char_at(&self, pos: usize) -> Option<char> {
        self.chars.get(pos).copied()
    }
    fn min(&self) -> usize {
        0
    }
    fn max(&self) -> usize {
        self.chars.len()
    }
    fn point(&self) -> Option<usize> {
        None
    }
    fn class_at(&self, _: usize, c: char) -> Class {
        (self.class)(c)
    }
}

/// A match's groups as positions: group 0 is the whole match, and a group
/// that did not take part is `None`.
pub type Groups = Vec<Option<(usize, usize)>>;

#[derive(Clone, Debug)]
enum Node {
    Empty,
    Char(char),
    /// Any character but a newline, `.`.
    Any,
    Set(Set),
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Group(Option<usize>, Box<Node>),
    Repeat { node: Box<Node>, min: u32, max: Option<u32>, greedy: bool },
    Backref(usize),
    Assert(Assert),
    /// A syntax class, `\sC`, or with `true` its complement, `\SC`.
    Syntax(Class, bool),
    /// A category, `\cC`, or its complement, `\CC`.
    Category(char, bool),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Assert {
    LineStart,
    LineEnd,
    BufStart,
    BufEnd,
    Point,
    WordBound,
    NotWordBound,
    WordStart,
    WordEnd,
    SymbolStart,
    SymbolEnd,
}

/// A bracket expression.
#[derive(Clone, Debug, Default)]
struct Set {
    negated: bool,
    chars: Vec<char>,
    ranges: Vec<(char, char)>,
    classes: Vec<Named>,
}

/// The character classes of bracket expressions, `[:alpha:]` and the rest.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Named {
    Alpha,
    Alnum,
    Digit,
    Xdigit,
    Upper,
    Lower,
    Space,
    Word,
    Punct,
    Blank,
    Cntrl,
    Graph,
    Print,
    Ascii,
    Nonascii,
    Unibyte,
    Multibyte,
}

impl Named {
    fn from_name(name: &str) -> Option<Named> {
        Some(match name {
            "alpha" => Named::Alpha,
            "alnum" => Named::Alnum,
            "digit" => Named::Digit,
            "xdigit" => Named::Xdigit,
            "upper" => Named::Upper,
            "lower" => Named::Lower,
            "space" => Named::Space,
            "word" => Named::Word,
            "punct" => Named::Punct,
            "blank" => Named::Blank,
            "cntrl" => Named::Cntrl,
            "graph" => Named::Graph,
            "print" => Named::Print,
            "ascii" => Named::Ascii,
            "nonascii" => Named::Nonascii,
            "unibyte" => Named::Unibyte,
            "multibyte" => Named::Multibyte,
            _ => return None,
        })
    }

    fn matches(self, c: char, class: Class, fold: bool) -> bool {
        match self {
            Named::Alpha => c.is_alphabetic(),
            Named::Alnum => c.is_alphanumeric(),
            Named::Digit => c.is_ascii_digit(),
            Named::Xdigit => c.is_ascii_hexdigit(),
            // Under case folding either matches any letter with case, as in Emacs.
            Named::Upper => c.is_uppercase() || (fold && c.is_lowercase()),
            Named::Lower => c.is_lowercase() || (fold && c.is_uppercase()),
            Named::Space => class == Class::Whitespace,
            Named::Word => class == Class::Word,
            // ASCII punctuation, and any other character that is not a word constituent.
            Named::Punct => if c.is_ascii() { c.is_ascii_punctuation() } else { class != Class::Word },
            Named::Blank => c == ' ' || c == '\t' || (!c.is_ascii() && c.is_whitespace() && c != '\u{85}' && !matches!(c, '\u{2028}' | '\u{2029}')),
            Named::Cntrl => (c as u32) < 32,
            Named::Graph => if c.is_ascii() { c.is_ascii_graphic() } else { !c.is_whitespace() && !c.is_control() },
            Named::Print => if c.is_ascii() { c == ' ' || c.is_ascii_graphic() } else { !c.is_control() },
            Named::Ascii | Named::Unibyte => c.is_ascii(),
            Named::Nonascii | Named::Multibyte => !c.is_ascii(),
        }
    }
}

impl Set {
    fn matches_one(&self, c: char, class: Class, fold: bool) -> bool {
        self.chars.contains(&c) || self.ranges.iter().any(|&(a, b)| a <= c && c <= b) || self.classes.iter().any(|n| n.matches(c, class, fold))
    }

    fn matches(&self, c: char, class: Class, fold: bool) -> bool {
        let found = self.matches_one(c, class, fold) || (fold && (self.matches_one(downcase(c), class, fold) || self.matches_one(upcase(c), class, fold)));
        found != self.negated
    }
}

fn downcase(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

fn upcase(c: char) -> char {
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(u), None) => u,
        _ => c,
    }
}

fn invalid(message: &str) -> Error {
    Error::signal("invalid-regexp", format!("Invalid regexp: \"{message}\""), vec![crate::Value::Str(message.to_string())])
}

/// Parses Emacs's syntax, as regex_compile reads it.
struct Parser<'a> {
    chars: &'a [char],
    i: usize,
    /// The highest group number given so far.
    groups: usize,
    /// The groups not yet closed, which a back-reference may not name.
    open: Vec<usize>,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn at_backslash(&self, c: char) -> bool {
        self.chars.get(self.i) == Some(&'\\') && self.chars.get(self.i + 1) == Some(&c)
    }

    /// Alternatives up to the end, or with `group` up to `\)`.
    fn alternatives(&mut self, group: bool) -> Result<Node> {
        let mut branches = vec![self.branch()?];
        while self.at_backslash('|') {
            self.i += 2;
            branches.push(self.branch()?);
        }
        if self.at_backslash(')') {
            if !group {
                return Err(invalid("Unmatched ) or \\)"));
            }
        } else if group {
            return Err(invalid("Unmatched ( or \\("));
        }
        Ok(if branches.len() == 1 { branches.pop().expect("one") } else { Node::Alt(branches) })
    }

    /// Whether `$` at `i` is special: at the end, or before `\)` or `\|`.
    fn dollar_is_special(&self, i: usize) -> bool {
        i + 1 >= self.chars.len() || (self.chars[i + 1] == '\\' && matches!(self.chars.get(i + 2), Some(')') | Some('|')))
    }

    fn branch(&mut self) -> Result<Node> {
        let mut items: Vec<Node> = Vec::new();
        // Whether the last item can be repeated: `*` with nothing before it,
        // or after a `^` that is special, is an ordinary character.
        let mut repeatable = false;
        let mut at_start = true;
        while let Some(c) = self.peek() {
            if c == '\\' && matches!(self.chars.get(self.i + 1), Some('|') | Some(')')) {
                break;
            }
            match c {
                '*' | '+' | '?' if repeatable => {
                    let (min, max, greedy) = self.repetition();
                    let last = items.pop().expect("repeatable means an item");
                    items.push(Node::Repeat { node: Box::new(last), min, max, greedy });
                }
                '\\' if self.chars.get(self.i + 1) == Some(&'{') && repeatable => {
                    let (min, max) = self.interval()?;
                    let last = items.pop().expect("repeatable means an item");
                    items.push(Node::Repeat { node: Box::new(last), min, max, greedy: true });
                }
                '^' if at_start => {
                    self.i += 1;
                    items.push(Node::Assert(Assert::LineStart));
                    repeatable = false;
                    at_start = false;
                    continue;
                }
                '$' if self.dollar_is_special(self.i) => {
                    self.i += 1;
                    items.push(Node::Assert(Assert::LineEnd));
                    repeatable = false;
                }
                _ => {
                    items.push(self.atom()?);
                    repeatable = true;
                }
            }
            at_start = false;
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().expect("one"),
            _ => Node::Concat(items),
        })
    }

    /// A run of `*`, `+` and `?`, collapsed into one, as regex_compile's
    /// handle_plus does: `*?` and `+?` and `??` do not repeat greedily.
    fn repetition(&mut self) -> (u32, Option<u32>, bool) {
        let (mut zero, mut many, mut greedy) = (false, false, true);
        while let Some(c @ ('*' | '+' | '?')) = self.peek() {
            self.i += 1;
            if c == '?' && (zero || many) {
                greedy = false;
            } else {
                zero |= c != '+';
                many |= c != '?';
            }
        }
        (if zero { 0 } else { 1 }, if many { None } else { Some(1) }, greedy)
    }

    /// `\{N,M\}`, `\{N\}`, `\{,M\}`, `\{N,\}` or `\{\}`, which is `\{0\}`.
    fn interval(&mut self) -> Result<(u32, Option<u32>)> {
        self.i += 2;
        let number = |p: &mut Self| -> Option<u32> {
            let start = p.i;
            while p.peek().is_some_and(|c| c.is_ascii_digit()) {
                p.i += 1;
            }
            (p.i > start).then(|| p.chars[start..p.i].iter().collect::<String>().parse().unwrap_or(u32::MAX))
        };
        let min = number(self);
        let (min, max) = if self.peek() == Some(',') {
            self.i += 1;
            (min.unwrap_or(0), number(self))
        } else {
            let n = min.unwrap_or(0);
            (n, Some(n))
        };
        if !self.at_backslash('}') {
            return Err(invalid("Invalid content of \\{\\}"));
        }
        self.i += 2;
        if max.is_some_and(|max| max < min) || min > 0xffff || max.is_some_and(|m| m > 0xffff) {
            return Err(invalid("Invalid content of \\{\\}"));
        }
        Ok((min, max))
    }

    fn atom(&mut self) -> Result<Node> {
        let c = self.peek().expect("an atom has a character");
        self.i += 1;
        match c {
            '.' => Ok(Node::Any),
            '[' => self.bracket(),
            '\\' => self.escape(),
            c => Ok(Node::Char(c)),
        }
    }

    fn escape(&mut self) -> Result<Node> {
        let Some(c) = self.peek() else { return Err(invalid("Trailing backslash")) };
        self.i += 1;
        Ok(match c {
            '(' => {
                let number = if self.peek() == Some('?') {
                    self.i += 1;
                    let start = self.i;
                    while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                        self.i += 1;
                    }
                    if self.peek() != Some(':') {
                        return Err(invalid("Invalid regular expression"));
                    }
                    let digits: String = self.chars[start..self.i].iter().collect();
                    self.i += 1;
                    if digits.is_empty() {
                        None
                    } else {
                        let n: usize = digits.parse().map_err(|_| invalid("Invalid regular expression"))?;
                        if n == 0 {
                            return Err(invalid("Invalid regular expression"));
                        }
                        self.groups = self.groups.max(n);
                        Some(n)
                    }
                } else {
                    self.groups += 1;
                    Some(self.groups)
                };
                if let Some(n) = number {
                    self.open.push(n);
                }
                let inner = self.alternatives(true)?;
                self.i += 2;
                if number.is_some() {
                    self.open.pop();
                }
                Node::Group(number, Box::new(inner))
            }
            '{' => Node::Char('{'),
            d @ '1'..='9' => {
                let n = d as usize - '0' as usize;
                if n > self.groups || self.open.contains(&n) {
                    return Err(invalid("Invalid back reference"));
                }
                Node::Backref(n)
            }
            'w' => Node::Syntax(Class::Word, false),
            'W' => Node::Syntax(Class::Word, true),
            's' | 'S' => {
                let Some(d) = self.peek() else { return Err(invalid("Invalid syntax designator")) };
                self.i += 1;
                let class = Class::from_char(d).ok_or_else(|| invalid("Invalid syntax designator"))?;
                Node::Syntax(class, c == 'S')
            }
            'c' | 'C' => {
                let Some(d) = self.peek() else { return Err(invalid("Invalid category designator")) };
                self.i += 1;
                if category(d, ' ').is_none() {
                    return Err(invalid("Invalid category designator"));
                }
                Node::Category(d, c == 'C')
            }
            '`' => Node::Assert(Assert::BufStart),
            '\'' => Node::Assert(Assert::BufEnd),
            '=' => Node::Assert(Assert::Point),
            'b' => Node::Assert(Assert::WordBound),
            'B' => Node::Assert(Assert::NotWordBound),
            '<' => Node::Assert(Assert::WordStart),
            '>' => Node::Assert(Assert::WordEnd),
            '_' => {
                let d = self.peek();
                self.i += 1;
                match d {
                    Some('<') => Node::Assert(Assert::SymbolStart),
                    Some('>') => Node::Assert(Assert::SymbolEnd),
                    _ => return Err(invalid("Invalid \\_ construct")),
                }
            }
            // Anything else after a backslash is itself.
            c => Node::Char(c),
        })
    }

    /// A bracket expression, after its `[`.
    fn bracket(&mut self) -> Result<Node> {
        let mut set = Set::default();
        if self.peek() == Some('^') {
            set.negated = true;
            self.i += 1;
        }
        let mut first = true;
        loop {
            let Some(c) = self.peek() else { return Err(invalid("Unmatched [ or [^")) };
            if c == ']' && !first {
                self.i += 1;
                return Ok(Node::Set(set));
            }
            first = false;
            if c == '[' && self.chars.get(self.i + 1) == Some(&':') {
                let close = (self.i + 2..self.chars.len().saturating_sub(1)).find(|&j| self.chars[j] == ':' && self.chars[j + 1] == ']');
                if let Some(close) = close {
                    let name: String = self.chars[self.i + 2..close].iter().collect();
                    let named = Named::from_name(&name).ok_or_else(|| invalid("Invalid character class name"))?;
                    set.classes.push(named);
                    self.i = close + 2;
                    continue;
                }
            }
            self.i += 1;
            // A range, unless the `-` is last.
            if self.peek() == Some('-') && self.chars.get(self.i + 1).is_some_and(|&e| e != ']') {
                let end = self.chars[self.i + 1];
                self.i += 2;
                // A range backwards is empty, as in Emacs.
                if c <= end {
                    set.ranges.push((c, end));
                }
                continue;
            }
            set.chars.push(c);
        }
    }
}

/// Whether the character `c` is in one of Emacs's standard categories,
/// worked out from Unicode until Ember has category tables, or `None` for
/// a category it does not know.
fn category(designator: char, c: char) -> Option<bool> {
    let u = c as u32;
    let han = (0x4e00..=0x9fff).contains(&u) || (0x3400..=0x4dbf).contains(&u) || (0x20000..=0x2ffff).contains(&u) || (0xf900..=0xfaff).contains(&u);
    let hiragana = (0x3040..=0x309f).contains(&u);
    let katakana = (0x30a0..=0x30ff).contains(&u) || (0x31f0..=0x31ff).contains(&u) || (0xff66..=0xff9f).contains(&u);
    let hangul = (0xac00..=0xd7af).contains(&u) || (0x1100..=0x11ff).contains(&u) || (0x3130..=0x318f).contains(&u);
    let combining = (0x300..=0x36f).contains(&u) || (0x1ab0..=0x1aff).contains(&u) || (0x1dc0..=0x1dff).contains(&u) || (0x20d0..=0x20ff).contains(&u) || (0xfe20..=0xfe2f).contains(&u);
    Some(match designator {
        'a' => c.is_ascii() && !c.is_ascii_control(),
        'l' => (0xa0..=0x24f).contains(&u) || (0x1e00..=0x1eff).contains(&u),
        'g' => (0x370..=0x3ff).contains(&u) || (0x1f00..=0x1fff).contains(&u),
        'y' => (0x400..=0x52f).contains(&u),
        'b' => (0x600..=0x6ff).contains(&u) || (0x750..=0x77f).contains(&u),
        'w' => (0x590..=0x5ff).contains(&u),
        't' => (0xe00..=0xe7f).contains(&u),
        'e' => (0x1200..=0x139f).contains(&u),
        'h' => hangul,
        'k' => katakana,
        'r' => (0xff01..=0xff5e).contains(&u),
        'K' => katakana,
        'H' => hiragana,
        'C' | 'c' => han,
        'j' => han || hiragana || katakana,
        '^' => combining,
        '.' => !combining,
        '|' => han || hiragana || katakana || hangul,
        ' ' => c == ' ',
        _ => return None,
    })
}

#[derive(Clone, Debug)]
enum Inst {
    Char(char),
    Any,
    Set(usize),
    Syntax(Class, bool),
    Category(char, bool),
    Assert(Assert),
    Backref(usize),
    /// Puts where the match is into a group's start or end slot.
    Save(usize),
    /// Goes on at the first, coming back to the second if that fails.
    Split(usize, usize),
    Jmp(usize),
    /// Notes where an iteration of a loop starts.
    LoopStart(usize),
    /// Goes back to the loop unless the iteration matched nothing, which
    /// ends it, as Emacs's on_failure_jump_loop does.
    LoopEnd { register: usize, back: usize, out: usize },
    /// Ends a bounded repetition if its iteration matched nothing, as the
    /// same check in Emacs's loop for `\{N,M\}` does, and goes on to the next.
    LoopExit { register: usize, out: usize },
    /// As many characters of a syntax class or its complement as there
    /// are, with no going back on them: a loop Emacs judges cannot overlap
    /// what follows it, and so compiles to on_failure_keep_string_jump.
    Span(Class, bool),
    Match,
}

/// A compiled regexp.
#[derive(Debug)]
pub struct Regexp {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    groups: usize,
    loops: usize,
    fold: bool,
    /// The instructions a match must start with, or `None` if it can be
    /// empty or start with anything, as Emacs's fastmap says.
    first: Option<Vec<usize>>,
}

/// How many instructions a regexp can compile to.
const MAX_INSTS: usize = 1 << 20;

/// How many failure points the matcher keeps before giving up, as Emacs's does.
const MAX_FAILURES: usize = 4_000_000;

struct Compiler {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    loops: usize,
    fold: bool,
}

impl Compiler {
    fn push(&mut self, inst: Inst) -> Result<usize> {
        if self.insts.len() >= MAX_INSTS {
            return Err(invalid("Regular expression too big"));
        }
        self.insts.push(inst);
        Ok(self.insts.len() - 1)
    }

    fn emit(&mut self, node: &Node) -> Result<()> {
        match node {
            Node::Empty => {}
            Node::Char(c) => {
                let c = if self.fold { downcase(*c) } else { *c };
                self.push(Inst::Char(c))?;
            }
            Node::Any => {
                self.push(Inst::Any)?;
            }
            Node::Set(set) => {
                self.sets.push(set.clone());
                self.push(Inst::Set(self.sets.len() - 1))?;
            }
            Node::Syntax(class, negated) => {
                self.push(Inst::Syntax(*class, *negated))?;
            }
            Node::Category(c, negated) => {
                self.push(Inst::Category(*c, *negated))?;
            }
            Node::Assert(a) => {
                self.push(Inst::Assert(*a))?;
            }
            Node::Backref(n) => {
                self.push(Inst::Backref(*n))?;
            }
            Node::Concat(items) => {
                for (k, item) in items.iter().enumerate() {
                    // Emacs's mutually_exclusive_p takes a loop of characters
                    // that are not words, or not symbols, before \_< for one
                    // that can never give characters back, though `_` or a
                    // letter can begin a symbol; its matches are what it finds.
                    if let Node::Repeat { node, min, max: None, greedy: true } = item
                        && let Node::Syntax(class @ (Class::Word | Class::Symbol), true) = node.as_ref()
                        && matches!(items.get(k + 1), Some(Node::Assert(Assert::SymbolStart)))
                    {
                        for _ in 0..*min {
                            self.emit(node)?;
                        }
                        self.push(Inst::Span(*class, true))?;
                        continue;
                    }
                    self.emit(item)?;
                }
            }
            Node::Alt(branches) => {
                let mut ends = Vec::new();
                for (k, branch) in branches.iter().enumerate() {
                    if k + 1 < branches.len() {
                        let split = self.push(Inst::Split(0, 0))?;
                        self.emit(branch)?;
                        ends.push(self.push(Inst::Jmp(0))?);
                        let next = self.insts.len();
                        self.insts[split] = Inst::Split(split + 1, next);
                    } else {
                        self.emit(branch)?;
                    }
                }
                let end = self.insts.len();
                for j in ends {
                    self.insts[j] = Inst::Jmp(end);
                }
            }
            Node::Group(number, inner) => match number {
                Some(n) => {
                    self.push(Inst::Save(2 * n))?;
                    self.emit(inner)?;
                    self.push(Inst::Save(2 * n + 1))?;
                }
                None => self.emit(inner)?,
            },
            Node::Repeat { node, min, max, greedy } => {
                for _ in 0..*min {
                    self.emit(node)?;
                }
                match max {
                    None => {
                        let register = self.loops;
                        self.loops += 1;
                        let split = self.push(Inst::Split(0, 0))?;
                        self.push(Inst::LoopStart(register))?;
                        self.emit(node)?;
                        let end = self.push(Inst::LoopEnd { register, back: split, out: 0 })?;
                        let out = self.insts.len();
                        self.insts[end] = Inst::LoopEnd { register, back: split, out };
                        self.insts[split] = if *greedy { Inst::Split(split + 1, out) } else { Inst::Split(out, split + 1) };
                    }
                    Some(max) => {
                        // Each further iteration may be left out, and one that
                        // matches nothing ends the repetition.
                        let (mut splits, mut exits) = (Vec::new(), Vec::new());
                        for _ in *min..*max {
                            let register = self.loops;
                            self.loops += 1;
                            splits.push(self.push(Inst::Split(0, 0))?);
                            self.push(Inst::LoopStart(register))?;
                            self.emit(node)?;
                            exits.push((self.push(Inst::LoopExit { register, out: 0 })?, register));
                        }
                        let out = self.insts.len();
                        for s in splits {
                            self.insts[s] = if *greedy { Inst::Split(s + 1, out) } else { Inst::Split(out, s + 1) };
                        }
                        for (e, register) in exits {
                            self.insts[e] = Inst::LoopExit { register, out };
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// What the machine undoes when it backtracks.
enum Frame {
    Branch { pc: usize, pos: usize },
    Slot { slot: usize, old: Option<usize> },
    Loop { register: usize, old: usize },
}

impl Regexp {
    /// Compiles an Emacs regexp, folding case if `fold`.
    pub fn new(pattern: &str, fold: bool) -> Result<Regexp> {
        let chars: Vec<char> = pattern.chars().collect();
        let mut parser = Parser { chars: &chars, i: 0, groups: 0, open: Vec::new() };
        let node = parser.alternatives(false)?;
        let mut compiler = Compiler { insts: Vec::new(), sets: Vec::new(), loops: 0, fold };
        compiler.emit(&node)?;
        compiler.push(Inst::Match)?;
        let mut re = Regexp { insts: compiler.insts, sets: compiler.sets, groups: parser.groups, loops: compiler.loops, fold, first: None };
        re.first = re.first_instructions();
        Ok(re)
    }

    /// The regexp for a pattern, compiled once and kept, as Emacs caches
    /// its compiled patterns.
    pub fn cached(pattern: &str, fold: bool) -> Result<Rc<Regexp>> {
        thread_local! {
            static CACHE: RefCell<HashMap<(String, bool), Rc<Regexp>>> = RefCell::new(HashMap::new());
        }
        let key = (pattern.to_string(), fold);
        if let Some(re) = CACHE.with_borrow(|c| c.get(&key).cloned()) {
            return Ok(re);
        }
        let re = Rc::new(Regexp::new(pattern, fold)?);
        CACHE.with_borrow_mut(|c| {
            if c.len() >= 512 {
                c.clear();
            }
            c.insert(key, re.clone());
        });
        Ok(re)
    }

    /// How many groups the regexp has, numbered from 1.
    pub fn groups(&self) -> usize {
        self.groups
    }

    /// The instructions that consume the first character of any match.
    fn first_instructions(&self) -> Option<Vec<usize>> {
        let mut found = Vec::new();
        let mut seen = vec![false; self.insts.len()];
        let mut todo = vec![0];
        while let Some(pc) = todo.pop() {
            if std::mem::replace(&mut seen[pc], true) {
                continue;
            }
            match &self.insts[pc] {
                Inst::Char(_) | Inst::Any | Inst::Set(_) | Inst::Syntax(..) | Inst::Category(..) => found.push(pc),
                Inst::Assert(_) | Inst::Save(_) | Inst::LoopStart(_) => todo.push(pc + 1),
                Inst::LoopExit { out, .. } => todo.extend([pc + 1, *out]),
                // It can take nothing, so what follows may start the match too.
                Inst::Span(..) => return None,
                Inst::Split(a, b) => todo.extend([*a, *b]),
                Inst::Jmp(t) => todo.push(*t),
                Inst::LoopEnd { back, out, .. } => todo.extend([*back, *out]),
                Inst::Backref(_) | Inst::Match => return None,
            }
        }
        Some(found)
    }

    /// Whether the instruction at `pc` takes the character `c` at `pos`.
    fn takes(&self, pc: usize, h: &dyn Haystack, pos: usize, c: char) -> bool {
        match &self.insts[pc] {
            Inst::Char(want) => *want == c || (self.fold && downcase(c) == *want),
            Inst::Any => c != '\n',
            Inst::Set(i) => self.sets[*i].matches(c, h.class_at(pos, c), self.fold),
            Inst::Syntax(class, negated) => (h.class_at(pos, c) == *class) != *negated,
            Inst::Category(d, negated) => category(*d, c).unwrap_or(false) != *negated,
            _ => false,
        }
    }

    fn word_at(h: &dyn Haystack, pos: usize) -> bool {
        h.char_at(pos).is_some_and(|c| h.class_at(pos, c) == Class::Word)
    }

    fn symbol_at(h: &dyn Haystack, pos: usize) -> bool {
        h.char_at(pos).is_some_and(|c| matches!(h.class_at(pos, c), Class::Word | Class::Symbol))
    }

    fn holds(a: Assert, h: &dyn Haystack, pos: usize) -> bool {
        let (min, max) = (h.min(), h.max());
        let before = |f: fn(&dyn Haystack, usize) -> bool| pos > min && f(h, pos - 1);
        let after = |f: fn(&dyn Haystack, usize) -> bool| pos < max && f(h, pos);
        match a {
            Assert::LineStart => pos == min || h.char_at(pos - 1) == Some('\n'),
            Assert::LineEnd => pos == max || h.char_at(pos) == Some('\n'),
            Assert::BufStart => pos == min,
            Assert::BufEnd => pos == max,
            Assert::Point => h.point() == Some(pos),
            Assert::WordBound => pos == min || pos == max || before(Self::word_at) != after(Self::word_at),
            Assert::NotWordBound => pos != min && pos != max && before(Self::word_at) == after(Self::word_at),
            Assert::WordStart => after(Self::word_at) && !before(Self::word_at),
            Assert::WordEnd => before(Self::word_at) && !after(Self::word_at),
            Assert::SymbolStart => after(Self::symbol_at) && !before(Self::symbol_at),
            Assert::SymbolEnd => before(Self::symbol_at) && !after(Self::symbol_at),
        }
    }

    /// Whether a match could start at `pos`, before running the machine there.
    fn may_start(&self, h: &dyn Haystack, pos: usize, limit: usize) -> bool {
        let Some(first) = &self.first else { return true };
        pos < limit && h.char_at(pos).is_some_and(|c| first.iter().any(|&pc| self.takes(pc, h, pos, c)))
    }

    /// The match starting exactly at `start` that reads no character at or
    /// after `limit`, as Emacs's re_match_2 finds it, with its groups.
    pub fn match_at(&self, h: &dyn Haystack, start: usize, limit: usize) -> Result<Option<Groups>> {
        let mut slots: Vec<Option<usize>> = vec![None; 2 * (self.groups + 1)];
        let mut loops = vec![usize::MAX; self.loops];
        let mut stack: Vec<Frame> = Vec::new();
        let (mut pc, mut pos) = (0, start);
        let limit = limit.min(h.max());
        loop {
            let ok = match &self.insts[pc] {
                Inst::Char(_) | Inst::Any | Inst::Set(_) | Inst::Syntax(..) | Inst::Category(..) => {
                    let taken = pos < limit && h.char_at(pos).is_some_and(|c| self.takes(pc, h, pos, c));
                    if taken {
                        pos += 1;
                        pc += 1;
                    }
                    taken
                }
                Inst::Assert(a) => {
                    pc += 1;
                    Self::holds(*a, h, pos)
                }
                Inst::Backref(n) => match (slots[2 * n], slots[2 * n + 1]) {
                    (Some(s), Some(e)) if e >= s => {
                        let len = e - s;
                        let same = pos + len <= limit
                            && (0..len).all(|k| match (h.char_at(s + k), h.char_at(pos + k)) {
                                (Some(a), Some(b)) => a == b || (self.fold && downcase(a) == downcase(b)),
                                _ => false,
                            });
                        if same {
                            pos += len;
                            pc += 1;
                        }
                        same
                    }
                    // A group that took no part matches nothing, as in Emacs.
                    _ => false,
                },
                Inst::Save(slot) => {
                    stack.push(Frame::Slot { slot: *slot, old: slots[*slot] });
                    slots[*slot] = Some(pos);
                    pc += 1;
                    true
                }
                Inst::Split(a, b) => {
                    if stack.len() >= MAX_FAILURES {
                        return Err(Error::signal("error", "Stack overflow in regexp matcher", Vec::new()));
                    }
                    stack.push(Frame::Branch { pc: *b, pos });
                    pc = *a;
                    true
                }
                Inst::Jmp(t) => {
                    pc = *t;
                    true
                }
                Inst::LoopStart(r) => {
                    stack.push(Frame::Loop { register: *r, old: loops[*r] });
                    loops[*r] = pos;
                    pc += 1;
                    true
                }
                Inst::LoopEnd { register, back, out } => {
                    pc = if loops[*register] == pos { *out } else { *back };
                    true
                }
                Inst::LoopExit { register, out } => {
                    pc = if loops[*register] == pos { *out } else { pc + 1 };
                    true
                }
                Inst::Span(class, negated) => {
                    while pos < limit && h.char_at(pos).is_some_and(|c| (h.class_at(pos, c) == *class) != *negated) {
                        pos += 1;
                    }
                    pc += 1;
                    true
                }
                Inst::Match => {
                    let mut groups: Groups = (0..=self.groups).map(|g| slots[2 * g].zip(slots[2 * g + 1])).collect();
                    groups[0] = Some((start, pos));
                    return Ok(Some(groups));
                }
            };
            if !ok {
                loop {
                    match stack.pop() {
                        None => return Ok(None),
                        Some(Frame::Slot { slot, old }) => slots[slot] = old,
                        Some(Frame::Loop { register, old }) => loops[register] = old,
                        Some(Frame::Branch { pc: p, pos: at }) => {
                            pc = p;
                            pos = at;
                            break;
                        }
                    }
                }
            }
        }
    }

    /// The first match starting at or after `from` and reading nothing at
    /// or after `limit`, as re-search-forward finds it.
    pub fn search_forward(&self, h: &dyn Haystack, from: usize, limit: usize) -> Result<Option<Groups>> {
        let limit = limit.min(h.max());
        for start in from..=limit {
            if self.may_start(h, start, limit)
                && let Some(groups) = self.match_at(h, start, limit)?
            {
                return Ok(Some(groups));
            }
        }
        Ok(None)
    }

    /// The match starting nearest before `from`, at or after `bound`, that
    /// does not go past `from`, as re-search-backward finds it.
    pub fn search_backward(&self, h: &dyn Haystack, from: usize, bound: usize) -> Result<Option<Groups>> {
        let from = from.min(h.max());
        for start in (bound.max(h.min())..=from).rev() {
            if self.may_start(h, start, from)
                && let Some(groups) = self.match_at(h, start, from)?
            {
                return Ok(Some(groups));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standard(c: char) -> Class {
        crate::syntax_table::SyntaxTables::default().entry(crate::syntax_table::STANDARD, c).class
    }

    /// Emacs's match data for a string, as positions, `None` for no match.
    fn m(re: &str, s: &str) -> Option<Vec<Option<(usize, usize)>>> {
        let h = StrHaystack { chars: s.chars().collect(), class: &standard };
        Regexp::new(re, false).unwrap().search_forward(&h, 0, usize::MAX).unwrap()
    }

    #[test]
    fn matches_as_emacs_does() {
        // Each from Emacs 30's string-match and match-data.
        assert_eq!(m(r"\(a*\)*", "b"), Some(vec![Some((0, 0)), Some((0, 0))]));
        assert_eq!(m(r"\(a*\)*b", "aab"), Some(vec![Some((0, 3)), Some((2, 2))]));
        assert_eq!(m(r"\(a\|ab\)\(c\|bcd\)", "abcd"), Some(vec![Some((0, 4)), Some((0, 1)), Some((1, 4))]));
        assert_eq!(m("a+?", "aaa"), Some(vec![Some((0, 1))]));
        assert_eq!(m(r"a\{2\}*", "aaaaa"), Some(vec![Some((0, 4))]));
        assert_eq!(m(r"a\{\}", "aaa"), Some(vec![Some((0, 0))]));
        assert_eq!(m(r"\(?2:a\)\(b\)", "ab"), Some(vec![Some((0, 2)), None, Some((0, 1)), Some((1, 2))]));
        assert_eq!(m(r"\(?:a\(b\)?\)*", "aba"), Some(vec![Some((0, 3)), Some((1, 2))]));
        assert_eq!(m(r"\w+", "a_b"), Some(vec![Some((0, 1))]));
        assert_eq!(m(r"\_<foo\_>", "x foo_bar foo"), Some(vec![Some((10, 13))]));
        assert_eq!(m(r"\(a\)\1", "xaa"), Some(vec![Some((1, 3)), Some((1, 2))]));
        assert_eq!(m("[z-a]", "z"), None);
        // A repetition ends at an iteration that matches nothing.
        assert_eq!(m(r"\(.??\)\{,3\}\<\_<", "(bbA_"), Some(vec![Some((0, 1)), Some((1, 1))]));
        // Emacs never goes back into a loop of non-words before \_<.
        assert_eq!(m(r"^\Sw*\_<", "_a"), None);
        assert_eq!(m("^*a", "*a"), Some(vec![Some((0, 2))]));
        assert_eq!(m("a^b$c", "a^b$c"), Some(vec![Some((0, 5))]));
        assert_eq!(m(r"\b", ""), Some(vec![Some((0, 0))]));
        assert_eq!(m(r"\<", ""), None);
        assert!(Regexp::new(r"\(a\)\2", false).is_err());
        assert!(Regexp::new("[[:foo:]]", false).is_err());
        assert!(Regexp::new(r"a\{3,2\}", false).is_err());
    }
}
