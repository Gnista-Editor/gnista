use std::fmt;

/// A key, independent of any terminal library.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum KeyCode {
    Char(char),
    Enter,
    Tab,
    Backspace,
    Delete,
    Esc,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
}

/// A key press with its modifiers, written in Emacs notation such as `C-x` or `M-<`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Key {
    pub code: KeyCode,
    pub ctrl: bool,
    pub meta: bool,
}

impl Key {
    pub fn new(code: KeyCode) -> Key {
        Key { code, ctrl: false, meta: false }
    }

    pub fn char(c: char) -> Key {
        Key::new(KeyCode::Char(c))
    }

    pub fn ctrl(mut self) -> Key {
        self.ctrl = true;
        self
    }

    pub fn meta(mut self) -> Key {
        self.meta = true;
        self
    }

    /// The character this key inserts, if it is a plain printable character.
    pub fn printable(&self) -> Option<char> {
        match self.code {
            KeyCode::Char(c) if !self.ctrl && !self.meta && !c.is_control() => Some(c),
            _ => None,
        }
    }

    /// Parses one key in Emacs notation: `a`, `C-x`, `M-f`, `C-M-f`, `RET`, `SPC`, `<left>`.
    pub fn parse(s: &str) -> Option<Key> {
        let mut rest = s;
        let (mut ctrl, mut meta) = (false, false);
        loop {
            if rest.len() > 2 && rest.starts_with("C-") {
                ctrl = true;
                rest = &rest[2..];
            } else if rest.len() > 2 && rest.starts_with("M-") {
                meta = true;
                rest = &rest[2..];
            } else {
                break;
            }
        }
        let code = match rest {
            "RET" => KeyCode::Enter,
            "TAB" => KeyCode::Tab,
            "DEL" => KeyCode::Backspace,
            "ESC" => KeyCode::Esc,
            "SPC" => KeyCode::Char(' '),
            "<delete>" => KeyCode::Delete,
            "<left>" => KeyCode::Left,
            "<right>" => KeyCode::Right,
            "<up>" => KeyCode::Up,
            "<down>" => KeyCode::Down,
            "<home>" => KeyCode::Home,
            "<end>" => KeyCode::End,
            "<prior>" => KeyCode::PageUp,
            "<next>" => KeyCode::PageDown,
            _ => {
                let mut chars = rest.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None;
                }
                KeyCode::Char(c)
            }
        };
        Some(Key { code, ctrl, meta })
    }

    /// Parses a space separated key sequence such as `C-x C-f`.
    pub fn parse_seq(s: &str) -> Option<Vec<Key>> {
        let keys: Option<Vec<Key>> = s.split_whitespace().map(Key::parse).collect();
        keys.filter(|k| !k.is_empty())
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.ctrl {
            f.write_str("C-")?;
        }
        if self.meta {
            f.write_str("M-")?;
        }
        let name = match self.code {
            KeyCode::Char(' ') => "SPC",
            KeyCode::Char(c) => return write!(f, "{c}"),
            KeyCode::Enter => "RET",
            KeyCode::Tab => "TAB",
            KeyCode::Backspace => "DEL",
            KeyCode::Esc => "ESC",
            KeyCode::Delete => "<delete>",
            KeyCode::Left => "<left>",
            KeyCode::Right => "<right>",
            KeyCode::Up => "<up>",
            KeyCode::Down => "<down>",
            KeyCode::Home => "<home>",
            KeyCode::End => "<end>",
            KeyCode::PageUp => "<prior>",
            KeyCode::PageDown => "<next>",
        };
        f.write_str(name)
    }
}

/// Writes a key sequence in Emacs notation, for example `C-x C-f`.
pub fn format_keys(keys: &[Key]) -> String {
    keys.iter().map(Key::to_string).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_prints_emacs_notation() {
        for s in ["a", "C-x", "M-f", "C-M-f", "RET", "SPC", "M-<", "M->", "C--", "<left>", "M-DEL"] {
            let key = Key::parse(s).unwrap_or_else(|| panic!("failed to parse {s}"));
            assert_eq!(key.to_string(), s);
        }
        assert_eq!(Key::parse("C-x"), Some(Key::char('x').ctrl()));
        assert_eq!(Key::parse("M-"), None);
        assert_eq!(Key::parse("ab"), None);
    }

    #[test]
    fn parses_sequences() {
        let keys = Key::parse_seq("C-x  C-f").unwrap();
        assert_eq!(keys, vec![Key::char('x').ctrl(), Key::char('f').ctrl()]);
        assert_eq!(format_keys(&keys), "C-x C-f");
        assert_eq!(Key::parse_seq(""), None);
    }
}
