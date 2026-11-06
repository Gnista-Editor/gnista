//! Character sets, as Emacs's charset.c: named sets of characters, each
//! with code points of its own, as `encode-char` and `decode-char` convert
//! them. Emacs defines a few hundred; E8 those its coding systems use.

use crate::coding::{Coding, char_raw_byte, raw_byte_char};

/// How a charset's code points map to characters.
#[derive(Clone, Copy, Debug)]
enum Map {
    /// Code points are the characters', from 0 to the limit.
    Unicode(u32),
    /// Emacs's own: Unicode, then the raw bytes.
    Emacs,
    /// Raw bytes, codes 80 to FF.
    EightBit,
    /// A single-byte coding's bytes, all 256 or, for a 96-character ISO
    /// 8859 set, A0 to FF as codes 20 to 7F.
    Bytes(&'static str, bool),
    /// A 94×94 set as an EUC coding holds it, codes with each byte's top
    /// bit clear, with a prefix byte for JIS X 0212's.
    Euc(&'static str, Option<u8>),
    /// A double-byte coding's bytes as the code, as Big5's and GBK's.
    Double(&'static str),
    /// JIS X 0201's katakana, codes 21 to 5F.
    Katakana,
}

struct Charset {
    name: &'static str,
    map: Map,
}

macro_rules! charsets {
    ($(($name:literal, $map:expr)),* $(,)?) => { &[$(Charset { name: $name, map: $map }),*] };
}

/// The charsets, in Emacs's priority order.
static CHARSETS: &[Charset] = charsets![
    ("ascii", Map::Unicode(0x7F)),
    ("iso-8859-1", Map::Unicode(0xFF)),
    ("unicode", Map::Unicode(0x10FFFF)),
    ("latin-iso8859-1", Map::Bytes("iso-latin-1", true)),
    ("iso-8859-2", Map::Bytes("iso-latin-2", false)),
    ("latin-iso8859-2", Map::Bytes("iso-latin-2", true)),
    ("iso-8859-3", Map::Bytes("iso-latin-3", false)),
    ("latin-iso8859-3", Map::Bytes("iso-latin-3", true)),
    ("iso-8859-4", Map::Bytes("iso-latin-4", false)),
    ("latin-iso8859-4", Map::Bytes("iso-latin-4", true)),
    ("iso-8859-5", Map::Bytes("cyrillic-iso-8bit", false)),
    ("cyrillic-iso8859-5", Map::Bytes("cyrillic-iso-8bit", true)),
    ("iso-8859-7", Map::Bytes("greek-iso-8bit", false)),
    ("greek-iso8859-7", Map::Bytes("greek-iso-8bit", true)),
    ("iso-8859-8", Map::Bytes("hebrew-iso-8bit", false)),
    ("hebrew-iso8859-8", Map::Bytes("hebrew-iso-8bit", true)),
    ("iso-8859-9", Map::Bytes("iso-latin-5", false)),
    ("latin-iso8859-9", Map::Bytes("iso-latin-5", true)),
    ("iso-8859-10", Map::Bytes("iso-latin-6", false)),
    ("latin-iso8859-10", Map::Bytes("iso-latin-6", true)),
    ("iso-8859-11", Map::Bytes("iso-8859-11", false)),
    ("thai-iso8859-11", Map::Bytes("iso-8859-11", true)),
    ("iso-8859-13", Map::Bytes("iso-latin-7", false)),
    ("latin-iso8859-13", Map::Bytes("iso-latin-7", true)),
    ("iso-8859-14", Map::Bytes("iso-latin-8", false)),
    ("latin-iso8859-14", Map::Bytes("iso-latin-8", true)),
    ("iso-8859-15", Map::Bytes("iso-latin-9", false)),
    ("latin-iso8859-15", Map::Bytes("iso-latin-9", true)),
    ("iso-8859-16", Map::Bytes("iso-latin-10", false)),
    ("latin-iso8859-16", Map::Bytes("iso-latin-10", true)),
    ("thai-tis620", Map::Bytes("thai-tis620", false)),
    ("chinese-gb2312", Map::Euc("chinese-iso-8bit", None)),
    ("chinese-gbk", Map::Double("chinese-gbk")),
    ("big5", Map::Double("chinese-big5")),
    ("japanese-jisx0208", Map::Euc("japanese-iso-8bit", None)),
    ("japanese-jisx0212", Map::Euc("japanese-iso-8bit", Some(0x8F))),
    ("korean-ksc5601", Map::Euc("korean-iso-8bit", None)),
    ("koi8-r", Map::Bytes("cyrillic-koi8", false)),
    ("cp866", Map::Bytes("cp866", false)),
    ("koi8-u", Map::Bytes("koi8-u", false)),
    ("windows-1250", Map::Bytes("windows-1250", false)),
    ("windows-1251", Map::Bytes("windows-1251", false)),
    ("windows-1252", Map::Bytes("windows-1252", false)),
    ("windows-1253", Map::Bytes("windows-1253", false)),
    ("windows-1254", Map::Bytes("windows-1254", false)),
    ("windows-1255", Map::Bytes("windows-1255", false)),
    ("windows-1256", Map::Bytes("windows-1256", false)),
    ("windows-1257", Map::Bytes("windows-1257", false)),
    ("windows-1258", Map::Bytes("windows-1258", false)),
    ("cp874", Map::Bytes("cp874", false)),
    ("unicode-bmp", Map::Unicode(0xFFFF)),
    ("mac-roman", Map::Bytes("mac-roman", false)),
    ("emacs", Map::Emacs),
    ("eight-bit", Map::EightBit),
    ("katakana-jisx0201", Map::Katakana),
];

/// Emacs's other names for charsets.
const ALIASES: [(&str, &str); 3] = [("ucs", "unicode"), ("iso-10646-1", "unicode"), ("latin-1", "iso-8859-1")];

fn find(name: &str) -> Option<&'static Charset> {
    let name = ALIASES.iter().find(|(alias, _)| *alias == name).map_or(name, |(_, n)| n);
    CHARSETS.iter().find(|c| c.name == name)
}

/// Whether a charset by this name exists, as `charsetp`.
pub fn charsetp(name: &str) -> bool {
    find(name).is_some()
}

/// The charsets, as `charset-list` gives them, in priority order.
pub fn charset_list() -> Vec<&'static str> {
    CHARSETS.iter().map(|c| c.name).collect()
}

/// The single byte a coding writes `c` as, if it writes it as one.
fn single_byte(coding: &str, c: char) -> Option<u8> {
    let coding = Coding::named(coding);
    if !coding.can_encode(c) || char_raw_byte(c).is_some() {
        return None;
    }
    match coding.encode_lossy(&c.to_string()).0.as_slice() {
        [b] => Some(*b),
        _ => None,
    }
}

/// The code point of `c` in a charset, as `encode-char`, if it has it.
pub fn encode_char(c: char, charset: &str) -> Option<u32> {
    let n = c as u32;
    match find(charset)?.map {
        Map::Unicode(limit) => (n <= limit && char_raw_byte(c).is_none()).then_some(n),
        Map::Emacs => Some(char_raw_byte(c).map_or(n, |b| 0x3FFF00 + b as u32)),
        Map::EightBit => char_raw_byte(c).map(u32::from),
        Map::Bytes(coding, upper) => {
            let b = single_byte(coding, c)?;
            if upper { (b >= 0xA0).then(|| b as u32 - 0x80) } else { Some(b as u32) }
        }
        Map::Euc(coding, prefix) => {
            let coding = Coding::named(coding);
            if c.is_ascii() || !coding.can_encode(c) {
                return None;
            }
            match (coding.encode_lossy(&c.to_string()).0.as_slice(), prefix) {
                ([a, b], None) if *a >= 0xA1 && *b >= 0xA1 => Some((((a & 0x7F) as u32) << 8) | (b & 0x7F) as u32),
                ([p, a, b], Some(q)) if p == &q => Some((((a & 0x7F) as u32) << 8) | (b & 0x7F) as u32),
                _ => None,
            }
        }
        Map::Double(coding) => {
            let coding = Coding::named(coding);
            if c.is_ascii() || !coding.can_encode(c) {
                return None;
            }
            match coding.encode_lossy(&c.to_string()).0.as_slice() {
                [a, b] => Some(((*a as u32) << 8) | *b as u32),
                _ => None,
            }
        }
        Map::Katakana => (0xFF61..=0xFF9F).contains(&n).then(|| n - 0xFF61 + 0x21),
    }
}

/// The character at a code point of a charset, as `decode-char`.
pub fn decode_char(charset: &str, code: u32) -> Option<char> {
    let decode = |coding: &str, bytes: &[u8]| -> Option<char> {
        let (text, _) = Coding::named(coding).with_eol(Some(crate::coding::Eol::Unix)).decode(bytes);
        let mut chars = text.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if char_raw_byte(c).is_none() => Some(c),
            _ => None,
        }
    };
    match find(charset)?.map {
        Map::Unicode(limit) => (code <= limit).then(|| char::from_u32(code)).flatten(),
        Map::Emacs => match code {
            0x3FFF80..=0x3FFFFF => Some(raw_byte_char((code - 0x3FFF00) as u8)),
            _ => char::from_u32(code),
        },
        Map::EightBit => (0x80..=0xFF).contains(&code).then(|| raw_byte_char(code as u8)),
        Map::Bytes(coding, upper) => {
            let byte = if upper { (0x20..=0x7F).contains(&code).then_some(code + 0x80)? } else { (code <= 0xFF).then_some(code)? };
            decode(coding, &[byte as u8])
        }
        Map::Euc(coding, prefix) => {
            let (a, b) = ((code >> 8) as u8, code as u8);
            if !(0x21..=0x7E).contains(&a) || !(0x21..=0x7E).contains(&b) || code > 0xFFFF {
                return None;
            }
            let bytes: Vec<u8> = prefix.into_iter().chain([a | 0x80, b | 0x80]).collect();
            decode(coding, &bytes)
        }
        Map::Double(coding) => (code > 0xFF && code <= 0xFFFF).then(|| decode(coding, &[(code >> 8) as u8, code as u8])).flatten(),
        Map::Katakana => (0x21..=0x5F).contains(&code).then(|| char::from_u32(0xFF61 + code - 0x21)).flatten(),
    }
}

/// The charset of a character, as `char-charset`: `ascii`, `eight-bit`
/// for a raw byte, else `unicode`, as Emacs's priorities give them; with
/// `restriction`, the first of those charsets that has it.
pub fn char_charset(c: char, restriction: Option<&[String]>) -> Option<&'static str> {
    match restriction {
        Some(names) => CHARSETS.iter().find(|cs| names.iter().any(|n| find(n).is_some_and(|f| f.name == cs.name)) && encode_char(c, cs.name).is_some()).map(|cs| cs.name),
        None if c.is_ascii() => Some("ascii"),
        None if char_raw_byte(c).is_some() => Some("eight-bit"),
        None => Some("unicode"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_points_as_emacs_gives_them() {
        assert_eq!(encode_char('あ', "japanese-jisx0208"), Some(0x2422));
        assert_eq!(decode_char("japanese-jisx0208", 0x2422), Some('あ'));
        assert_eq!(encode_char('中', "chinese-gb2312"), Some(22096));
        assert_eq!(encode_char('é', "iso-8859-1"), Some(233));
        assert_eq!(encode_char('é', "unicode"), Some(233));
        assert_eq!(encode_char('é', "latin-iso8859-1"), Some(105));
        assert_eq!(encode_char('ｱ', "katakana-jisx0201"), Some(49));
        assert_eq!(encode_char('ア', "katakana-jisx0201"), None);
        assert_eq!(encode_char('中', "big5"), Some(42148));
        assert_eq!(encode_char('한', "korean-ksc5601"), Some(18257));
        assert_eq!(encode_char('丂', "chinese-gbk"), Some(33088));
        assert_eq!(encode_char(raw_byte_char(0xE9), "eight-bit"), Some(233));
        assert_eq!(encode_char('é', "eight-bit"), None);
        assert_eq!(decode_char("eight-bit", 233), Some(raw_byte_char(0xE9)));
        assert_eq!(decode_char("ucs", 233), Some('é'));
        assert_eq!(decode_char("japanese-jisx0212", 0x3021), Some('丂'));
        assert_eq!(char_charset('a', None), Some("ascii"));
        assert_eq!(char_charset('é', None), Some("unicode"));
        assert!(charsetp("japanese-jisx0208") && !charsetp("nope"));
    }
}
