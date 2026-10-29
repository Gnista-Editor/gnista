//! Coding systems: how a file's bytes become a buffer's text and back.
//!
//! As Emacs's coding systems, a file's coding is detected when it is
//! visited and used again to save it: its line ends (Unix, DOS or Mac),
//! whether it starts with a UTF-8 signature, and whether it is UTF-8 at
//! all, Latin-1 otherwise, as Emacs decides for a file that is not valid
//! UTF-8. The buffer itself always ends lines with `\n`.

/// How lines end in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eol {
    Unix,
    Dos,
    Mac,
}

/// How characters are written as bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Charset {
    /// Only ASCII seen so far: Emacs's `undecided`, which saves as UTF-8.
    Undecided,
    Utf8,
    /// UTF-8 starting with a byte order mark.
    Utf8WithSignature,
    Latin1,
}

/// A coding system, as Emacs names them: `utf-8-unix`, `undecided-dos`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Coding {
    pub charset: Charset,
    pub eol: Eol,
}

impl Default for Coding {
    /// What a new file is written with: `undecided-unix`.
    fn default() -> Coding {
        Coding { charset: Charset::Undecided, eol: Eol::Unix }
    }
}

const SIGNATURE: &[u8] = b"\xEF\xBB\xBF";

impl Coding {
    /// The name Emacs gives this coding system, as `buffer-file-coding-system` shows it.
    pub fn name(&self) -> String {
        let charset = match self.charset {
            Charset::Undecided => "undecided",
            Charset::Utf8 => "utf-8",
            Charset::Utf8WithSignature => "utf-8-with-signature",
            Charset::Latin1 => "iso-latin-1",
        };
        let eol = match self.eol {
            Eol::Unix => "unix",
            Eol::Dos => "dos",
            Eol::Mac => "mac",
        };
        format!("{charset}-{eol}")
    }

    /// Reads a coding system's name, with or without its line ends, and
    /// Emacs's aliases for Latin-1. A name without line ends keeps `eol`.
    pub fn parse(name: &str, eol: Eol) -> Option<Coding> {
        let (base, eol) = match name.rsplit_once('-') {
            Some((base, "unix")) => (base, Eol::Unix),
            Some((base, "dos")) => (base, Eol::Dos),
            Some((base, "mac")) => (base, Eol::Mac),
            _ => (name, eol),
        };
        let charset = match base {
            "undecided" => Charset::Undecided,
            "utf-8" | "utf8" | "mule-utf-8" | "prefer-utf-8" => Charset::Utf8,
            "utf-8-with-signature" => Charset::Utf8WithSignature,
            "iso-latin-1" | "latin-1" | "iso-8859-1" | "latin1" => Charset::Latin1,
            _ => return None,
        };
        Some(Coding { charset, eol })
    }

    /// The names `parse` takes, for completing them.
    pub const NAMES: [&'static str; 4] = ["undecided", "utf-8", "utf-8-with-signature", "iso-latin-1"];

    /// What the mode line shows for it, as Emacs's `mode-line-mule-info`:
    /// a letter for the charset and a sign for the line ends.
    pub fn mnemonic(&self) -> String {
        let charset = match self.charset {
            Charset::Undecided => '-',
            Charset::Utf8 | Charset::Utf8WithSignature => 'U',
            Charset::Latin1 => '1',
        };
        let eol = match self.eol {
            Eol::Unix => ':',
            Eol::Dos => '\\',
            Eol::Mac => '/',
        };
        format!("{charset}{eol}")
    }

    /// Detects a file's coding and decodes it, as visiting a file does.
    pub fn decode(bytes: &[u8]) -> (String, Coding) {
        let (charset, text) = if let Some(rest) = bytes.strip_prefix(SIGNATURE) {
            (Charset::Utf8WithSignature, String::from_utf8_lossy(rest).into_owned())
        } else {
            match std::str::from_utf8(bytes) {
                Ok(s) if s.is_ascii() => (Charset::Undecided, s.to_string()),
                Ok(s) => (Charset::Utf8, s.to_string()),
                Err(_) => (Charset::Latin1, bytes.iter().map(|&b| b as char).collect()),
            }
        };
        let eol = detect_eol(&text);
        let text = match eol {
            Eol::Unix => text,
            Eol::Dos => text.replace("\r\n", "\n"),
            Eol::Mac => text.replace('\r', "\n"),
        };
        (text, Coding { charset, eol })
    }

    /// Encodes text for saving. Text this coding cannot hold, such as a
    /// character beyond Latin-1, is saved as UTF-8 instead, and the coding
    /// that was used is returned with the bytes.
    pub fn encode(&self, text: &str) -> (Vec<u8>, Coding) {
        let mut coding = *self;
        let text = match self.eol {
            Eol::Unix => std::borrow::Cow::Borrowed(text),
            Eol::Dos => text.replace('\n', "\r\n").into(),
            Eol::Mac => text.replace('\n', "\r").into(),
        };
        let bytes = match self.charset {
            Charset::Latin1 if text.chars().all(|c| (c as u32) < 0x100) => text.chars().map(|c| c as u8).collect(),
            Charset::Latin1 => {
                coding.charset = Charset::Utf8;
                text.into_owned().into_bytes()
            }
            Charset::Utf8WithSignature => [SIGNATURE, text.as_bytes()].concat(),
            // Text that is no longer only ASCII is saved as UTF-8, and the
            // buffer's coding becomes that, as Emacs chooses for undecided.
            Charset::Undecided if !text.is_ascii() => {
                coding.charset = Charset::Utf8;
                text.into_owned().into_bytes()
            }
            Charset::Undecided | Charset::Utf8 => text.into_owned().into_bytes(),
        };
        (bytes, coding)
    }
}

/// Lines end as DOS if every line feed follows a carriage return, as Mac
/// if there are carriage returns and no line feeds, and otherwise as Unix,
/// as Emacs decides, keeping stray carriage returns as text.
fn detect_eol(text: &str) -> Eol {
    let bytes = text.as_bytes();
    let mut lf = 0;
    let mut crlf = 0;
    let mut cr = false;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'\n' => {
                lf += 1;
                if i > 0 && bytes[i - 1] == b'\r' {
                    crlf += 1;
                }
            }
            b'\r' => cr = true,
            _ => {}
        }
    }
    if lf > 0 && crlf == lf {
        Eol::Dos
    } else if lf == 0 && cr {
        Eol::Mac
    } else {
        Eol::Unix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_and_round_trips() {
        for (bytes, name) in [
            (&b"plain\n"[..], "undecided-unix"),
            (b"caf\xC3\xA9\n", "utf-8-unix"),
            (b"caf\xE9\n", "iso-latin-1-unix"),
            (b"a\r\nb\r\n", "undecided-dos"),
            (b"a\rb\r", "undecided-mac"),
            (b"\xEF\xBB\xBFsigned\n", "utf-8-with-signature-unix"),
            (b"mixed\r\nends\n", "undecided-unix"),
        ] {
            let (text, coding) = Coding::decode(bytes);
            assert_eq!(coding.name(), name, "{bytes:?}");
            assert_eq!(coding.encode(&text).0, bytes, "{name}");
        }
        assert_eq!(Coding::decode(b"a\r\nb\r\n").0, "a\nb\n");
        assert_eq!(Coding::decode(b"caf\xE9").0, "café");
    }

    #[test]
    fn text_a_coding_cannot_hold_is_saved_as_utf8() {
        let latin = Coding { charset: Charset::Latin1, eol: Eol::Unix };
        let (bytes, coding) = latin.encode("€");
        assert_eq!(bytes, "€".as_bytes());
        assert_eq!(coding.name(), "utf-8-unix");
        assert_eq!(Coding::default().encode("é").1.name(), "utf-8-unix");
    }

    #[test]
    fn names_parse_as_emacs_spells_them() {
        assert_eq!(Coding::parse("utf-8-dos", Eol::Unix).unwrap().name(), "utf-8-dos");
        assert_eq!(Coding::parse("latin-1", Eol::Dos).unwrap().name(), "iso-latin-1-dos");
        assert_eq!(Coding::parse("utf-8", Eol::Mac).unwrap().mnemonic(), "U/");
        assert!(Coding::parse("klingon", Eol::Unix).is_none());
    }
}
