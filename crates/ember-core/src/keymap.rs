use std::collections::BTreeMap;

use crate::key::Key;

#[derive(Clone, Debug)]
enum Binding {
    Command(String),
    Prefix(Keymap),
}

/// Maps key sequences to command names. Multi-key sequences such as
/// `C-x C-f` go through nested prefix keymaps, as in Emacs.
#[derive(Clone, Debug, Default)]
pub struct Keymap {
    bindings: BTreeMap<Key, Binding>,
    /// What any single key with no binding of its own runs, as an Emacs
    /// keymap's `[t]` binding does.
    default: Option<String>,
}

/// The result of looking up a key sequence.
#[derive(Debug, PartialEq, Eq)]
pub enum Lookup {
    Command(String),
    /// The sequence so far is a prefix; more keys are needed.
    Prefix,
    Unbound,
}

impl Keymap {
    /// Binds a key sequence to a command, replacing any binding that was in the way.
    pub fn bind(&mut self, keys: &[Key], command: &str) {
        let (last, prefix) = keys.split_last().expect("empty key sequence");
        let mut map = self;
        for key in prefix {
            let entry = map
                .bindings
                .entry(*key)
                .or_insert_with(|| Binding::Prefix(Keymap::default()));
            if let Binding::Command(_) = entry {
                *entry = Binding::Prefix(Keymap::default());
            }
            map = match entry {
                Binding::Prefix(m) => m,
                Binding::Command(_) => unreachable!(),
            };
        }
        map.bindings.insert(*last, Binding::Command(command.to_string()));
    }

    /// Binds a sequence written in Emacs notation, such as `C-x C-f`.
    /// Panics on a malformed sequence, since bindings are written by programmers.
    pub fn bind_str(&mut self, seq: &str, command: &str) {
        let keys = Key::parse_seq(seq).unwrap_or_else(|| panic!("bad key sequence {seq:?}"));
        self.bind(&keys, command);
    }

    /// Sets or removes the command for keys with no binding of their own.
    pub fn set_default(&mut self, command: Option<&str>) {
        self.default = command.map(str::to_string);
    }

    pub fn lookup(&self, keys: &[Key]) -> Lookup {
        let mut map = self;
        for (i, key) in keys.iter().enumerate() {
            match map.bindings.get(key) {
                None if i == 0 && keys.len() == 1 && self.default.is_some() => {
                    return Lookup::Command(self.default.clone().expect("checked"));
                }
                None => return Lookup::Unbound,
                Some(Binding::Command(c)) if i + 1 == keys.len() => {
                    return Lookup::Command(c.clone());
                }
                Some(Binding::Command(_)) => return Lookup::Unbound,
                Some(Binding::Prefix(m)) => map = m,
            }
        }
        Lookup::Prefix
    }

    /// Every binding as (key sequence, command name), in key order.
    pub fn bindings(&self) -> Vec<(Vec<Key>, String)> {
        let mut out = Vec::new();
        self.collect(&mut Vec::new(), &mut out);
        out
    }

    fn collect(&self, prefix: &mut Vec<Key>, out: &mut Vec<(Vec<Key>, String)>) {
        for (key, binding) in &self.bindings {
            prefix.push(*key);
            match binding {
                Binding::Command(c) => out.push((prefix.clone(), c.clone())),
                Binding::Prefix(m) => m.collect(prefix, out),
            }
            prefix.pop();
        }
    }

    /// The key sequences bound to a command.
    pub fn keys_for(&self, command: &str) -> Vec<Vec<Key>> {
        self.bindings()
            .into_iter()
            .filter(|(_, c)| c == command)
            .map(|(k, _)| k)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(s: &str) -> Vec<Key> {
        Key::parse_seq(s).unwrap()
    }

    #[test]
    fn looks_up_prefix_sequences() {
        let mut map = Keymap::default();
        map.bind_str("C-x C-f", "find-file");
        map.bind_str("C-f", "forward-char");
        assert_eq!(map.lookup(&keys("C-x")), Lookup::Prefix);
        assert_eq!(map.lookup(&keys("C-x C-f")), Lookup::Command("find-file".into()));
        assert_eq!(map.lookup(&keys("C-x C-z")), Lookup::Unbound);
        assert_eq!(map.lookup(&keys("C-f C-f")), Lookup::Unbound);
        assert_eq!(map.keys_for("find-file"), vec![keys("C-x C-f")]);
    }
}
