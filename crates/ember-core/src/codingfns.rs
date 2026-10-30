//! The coding and charset primitives Lisp calls, as coding.c, charset.c
//! and the parts of mule.el and mule-cmds.el around them: encoding and
//! decoding strings and regions, finding a coding from bytes, asking about
//! coding systems by name, and which codings can write some text.
//!
//! Scripts hold bytes as strings of characters U+0000 to U+00FF, one for
//! each byte, as Emacs's unibyte strings print. A string with other
//! characters stands for the bytes Emacs keeps it in, UTF-8, as Emacs's
//! multibyte strings do when decoded.

use crate::charset;
use crate::coding::{self, Coding, Eol, bytes_of_string, raw_byte_char, string_of_bytes};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// Emacs's error for a name that is no coding system.
pub fn coding_system_error(name: &str) -> Error {
    Error::signal("coding-system-error", format!("Invalid coding system: {name}"), vec![Value::Str(name.to_string())])
}

/// The coding system a name names, or Emacs's error, as `check-coding-system`.
pub fn check_coding_system(name: &str) -> Result<Coding> {
    Coding::parse(name).ok_or_else(|| coding_system_error(name))
}

/// The bytes a string stands for: its characters as bytes, or the UTF-8
/// Emacs keeps multibyte text in.
fn string_bytes(s: &str) -> Vec<u8> {
    bytes_of_string(s).unwrap_or_else(|| Coding::named("raw-text").encode_lossy(s).0)
}

/// Text in a buffer as the bytes Emacs keeps it in: raw bytes as themselves,
/// anything else as UTF-8.
fn text_bytes(s: &str) -> Vec<u8> {
    Coding::named("raw-text").encode_lossy(s).0
}

/// The base coding systems that can write all of `text`, as
/// `find-coding-systems-string`: `undecided` alone for ASCII.
pub fn find_coding_systems(text: &str) -> Vec<String> {
    if text.is_ascii() {
        return vec!["undecided".into()];
    }
    let mut found: Vec<String> = Coding::base_systems()
        .filter(|c| !matches!(c.system().name, "undecided" | "prefer-utf-8"))
        .filter(|c| text.chars().all(|ch| c.can_encode(ch)))
        .map(|c| c.system().name.to_string())
        .collect();
    // Emacs's preferred coding first.
    if let Some(i) = found.iter().position(|n| n == "utf-8") {
        let utf8 = found.remove(i);
        found.insert(0, utf8);
    }
    found
}

/// Where in `text`, counted from `start`, the characters `coding` cannot
/// write are, at most `count` of them.
fn unencodable(text: &str, start: usize, coding: Coding, count: usize) -> Vec<usize> {
    text.chars().enumerate().filter(|(_, c)| !coding.can_encode(*c)).take(count).map(|(i, _)| start + i).collect()
}

fn num(n: usize) -> Value {
    Value::Number(n as f64)
}

fn strings(names: impl IntoIterator<Item = String>) -> Value {
    Value::List(names.into_iter().map(Value::Str).collect())
}

/// An argument as text: a string, or a symbol's name.
fn text_arg(args: &[Value], i: usize) -> Result<String> {
    match args.get(i) {
        Some(v) => v.as_str().map(str::to_string).ok_or_else(|| Error::new(format!("Wrong type argument: stringp, {v:?}"))),
        None => Err(Error::new("Wrong number of arguments")),
    }
}

fn number_arg(args: &[Value], i: usize) -> Result<usize> {
    args.get(i).and_then(Value::as_number).map(|n| n.max(0.0) as usize).ok_or_else(|| Error::new("Wrong type argument: integer-or-marker-p"))
}

fn given(args: &[Value], i: usize) -> bool {
    args.get(i).is_some_and(Value::is_true)
}

impl Editor {
    /// Runs one of the coding and charset primitives by its Lisp name, as
    /// scripts call them.
    pub fn coding_primitive(&mut self, name: &str, args: &[Value]) -> Result<Value> {
        let coding = |i: usize| -> Result<Coding> { check_coding_system(&text_arg(args, i)?) };
        Ok(match name {
            "coding-system-p" => Value::Bool(args.first().and_then(Value::as_str).is_some_and(|n| Coding::parse(n).is_some())),
            "check-coding-system" => Value::Str(coding(0)?.name()),
            "coding-system-list" => {
                let base_only = given(args, 0);
                let mut names = Vec::new();
                for c in Coding::base_systems() {
                    names.push(c.name());
                    if !base_only && c.with_eol(Some(Eol::Unix)) != c {
                        names.extend([Eol::Unix, Eol::Dos, Eol::Mac].map(|e| c.with_eol(Some(e)).name()));
                    }
                }
                strings(names)
            }
            "coding-system-aliases" => {
                let c = coding(0)?;
                // Each with the line ends asked about, as `utf-8-unix`'s are `mule-utf-8-unix` and on.
                let suffix = c.name()[c.system().name.len()..].to_string();
                strings(std::iter::once(c.system().name).chain(c.system().aliases.iter().copied()).map(|n| format!("{n}{suffix}")))
            }
            "coding-system-base" => Value::Str(coding(0)?.system().name.to_string()),
            "coding-system-type" => Value::Str(coding(0)?.system().coding_type.to_string()),
            "coding-system-eol-type" => {
                let c = coding(0)?;
                match c.eol {
                    Some(eol) => num(eol.number() as usize),
                    None => strings([Eol::Unix, Eol::Dos, Eol::Mac].map(|e| c.with_eol(Some(e)).name())),
                }
            }
            "coding-system-change-eol-conversion" => {
                let c = coding(0)?;
                let eol = match args.get(1) {
                    Some(Value::Number(n)) => Eol::from_number(*n as u8),
                    Some(v) => match v.as_str() {
                        Some("unix") => Some(Eol::Unix),
                        Some("dos") => Some(Eol::Dos),
                        Some("mac") => Some(Eol::Mac),
                        _ => None,
                    },
                    None => None,
                };
                Value::Str(c.with_eol(eol).name())
            }
            "coding-system-change-text-conversion" => Value::Str(coding(0)?.with_text(coding(1)?).name()),
            "coding-system-get" => {
                let c = coding(0)?;
                let prop = text_arg(args, 1)?;
                match prop.trim_start_matches(':') {
                    "mime-charset" => c.system().mime_charset.map_or(Value::Null, |m| Value::Str(m.to_string())),
                    "mnemonic" => Value::Str(c.system().mnemonic.to_string()),
                    "name" => Value::Str(c.system().name.to_string()),
                    "coding-type" => Value::Str(c.system().coding_type.to_string()),
                    _ => Value::Null,
                }
            }
            "encode-coding-string" => {
                let (bytes, used) = coding(1)?.encode_lossy(&text_arg(args, 0)?);
                self.set_variable("last-coding-system-used", Value::Str(used.name()));
                Value::Str(string_of_bytes(&bytes))
            }
            "decode-coding-string" => {
                let (text, used) = coding(1)?.decode(&string_bytes(&text_arg(args, 0)?));
                self.set_variable("last-coding-system-used", Value::Str(used.name()));
                Value::Str(text)
            }
            "encode-coding-region" | "decode-coding-region" => {
                let c = coding(2)?;
                let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                let (start, end) = (start.min(end), start.max(end).min(self.buffer().len()));
                let text = self.buffer().slice(start..end);
                let (new, used) = if name == "encode-coding-region" {
                    let (bytes, used) = c.encode_lossy(&text);
                    (bytes.into_iter().map(raw_byte_char).collect::<String>(), used)
                } else {
                    c.decode(&text_bytes(&text))
                };
                self.replace_range(start, end, &new)?;
                self.set_variable("last-coding-system-used", Value::Str(used.name()));
                num(new.chars().count())
            }
            "detect-coding-string" | "detect-coding-region" => {
                let (bytes, highest) = if name == "detect-coding-string" {
                    (string_bytes(&text_arg(args, 0)?), given(args, 1))
                } else {
                    let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                    let b = self.buffer();
                    (text_bytes(&b.slice(start.min(end)..start.max(end).min(b.len()))), given(args, 2))
                };
                let found = coding::detect(&bytes);
                // With the line ends found too, as Emacs gives them.
                let eol = found[0].decode(&bytes).1.eol;
                let found: Vec<String> = found.iter().map(|c| if c.eol.is_none() && eol != Some(Eol::Unix) { c.with_eol(eol).name() } else { c.name() }).collect();
                if highest { Value::Str(found[0].clone()) } else { strings(found) }
            }
            "find-coding-systems-string" => strings(find_coding_systems(&text_arg(args, 0)?)),
            "find-coding-systems-region" => {
                let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                let b = self.buffer();
                strings(find_coding_systems(&b.slice(start.min(end)..start.max(end).min(b.len()))))
            }
            "unencodable-char-position" => {
                let (start, end, c) = (number_arg(args, 0)?, number_arg(args, 1)?, coding(2)?);
                let count = args.get(3).and_then(Value::as_number).map(|n| n as usize);
                let text = match args.get(4).and_then(Value::as_str) {
                    Some(s) => s.chars().skip(start).take(end.saturating_sub(start)).collect(),
                    None => self.buffer().slice(start..end.min(self.buffer().len())),
                };
                let found = unencodable(&text, start, c, count.unwrap_or(1));
                match count {
                    Some(_) if !found.is_empty() => Value::List(found.into_iter().map(num).collect()),
                    _ => found.first().map_or(Value::Null, |&p| num(p)),
                }
            }
            "check-coding-systems-region" => {
                let (start, end) = (number_arg(args, 0)?, number_arg(args, 1)?);
                let text = self.buffer().slice(start.min(end)..start.max(end).min(self.buffer().len()));
                let names: Vec<String> = match args.get(2) {
                    Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                    _ => Vec::new(),
                };
                let mut failing = Vec::new();
                for n in names {
                    let found = unencodable(&text, start.min(end), check_coding_system(&n)?, usize::MAX);
                    if !found.is_empty() {
                        failing.push(Value::List(std::iter::once(Value::Str(n)).chain(found.into_iter().map(num)).collect()));
                    }
                }
                if failing.is_empty() { Value::Null } else { Value::List(failing) }
            }
            "charsetp" => Value::Bool(args.first().and_then(Value::as_str).is_some_and(charset::charsetp)),
            "charset-list" => strings(charset::charset_list().into_iter().map(String::from)),
            "charset-priority-list" => {
                let all = charset::charset_list();
                strings(if given(args, 0) { all[..1].to_vec() } else { all }.into_iter().map(String::from))
            }
            "char-charset" => {
                let c = text_arg(args, 0)?.chars().next().ok_or_else(|| Error::new("Wrong type argument: characterp"))?;
                let restriction: Option<Vec<String>> = match args.get(1) {
                    Some(Value::List(items)) => Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
                    _ => None,
                };
                charset::char_charset(c, restriction.as_deref()).map_or(Value::Null, |n| Value::Str(n.to_string()))
            }
            "encode-char" => {
                let c = text_arg(args, 0)?.chars().next().ok_or_else(|| Error::new("Wrong type argument: characterp"))?;
                let set = text_arg(args, 1)?;
                if !charset::charsetp(&set) {
                    return Err(Error::signal("error", format!("Invalid charset: {set}"), vec![]));
                }
                charset::encode_char(c, &set).map_or(Value::Null, |n| num(n as usize))
            }
            "decode-char" => {
                let set = text_arg(args, 0)?;
                if !charset::charsetp(&set) {
                    return Err(Error::signal("error", format!("Invalid charset: {set}"), vec![]));
                }
                charset::decode_char(&set, number_arg(args, 1)? as u32).map_or(Value::Null, |c| Value::Str(c.to_string()))
            }
            _ => return Err(Error::new(format!("No coding primitive {name}"))),
        })
    }
}
