//! Keymaps as values, as Emacs has them: a keymap binds keys to commands
//! or to other keymaps, which several keymaps can share as their prefix
//! map, as `C-x 4` is `ctl-x-4-map` wherever it is bound, and inherits the
//! bindings of a parent. Keymaps live in the editor's [`Keymaps`] and are
//! passed around by [`KeymapId`]; a named keymap is a variable whose value
//! is one, as `global-map` and `org-mode-map` are.

use std::collections::BTreeMap;

use crate::key::Key;

/// A keymap, as a value can hold one.
pub type KeymapId = usize;

/// What a key is bound to in a keymap.
#[derive(Clone, Debug, PartialEq)]
pub enum Binding {
    Command(String),
    /// A prefix key: the keys after it are looked up in that keymap.
    Keymap(KeymapId),
}

#[derive(Clone, Debug, Default)]
struct Map {
    bindings: BTreeMap<Key, Binding>,
    /// What any single key with no binding of its own runs, as an Emacs
    /// keymap's `[t]` binding does.
    default: Option<String>,
    /// Commands that run in place of others when keys in any keymap name
    /// them, as an Emacs keymap's `[remap COMMAND]` bindings.
    remaps: BTreeMap<String, String>,
    parent: Option<KeymapId>,
}

/// The result of looking up a key sequence.
#[derive(Debug, PartialEq, Eq)]
pub enum Lookup {
    Command(String),
    /// The sequence so far is a prefix; more keys are needed.
    Prefix,
    Unbound,
}

/// How far parents and prefix maps are followed, so a loop ends.
const DEPTH: usize = 32;

/// Every keymap there is. Keymaps are few and never freed.
#[derive(Debug, Default)]
pub struct Keymaps {
    maps: Vec<Map>,
}

impl Keymaps {
    /// A new empty keymap, as Emacs's `make-sparse-keymap`.
    pub fn make(&mut self, parent: Option<KeymapId>) -> KeymapId {
        self.maps.push(Map { parent, ..Map::default() });
        self.maps.len() - 1
    }

    pub fn parent(&self, map: KeymapId) -> Option<KeymapId> {
        self.maps[map].parent
    }

    /// Makes `map` inherit `parent`'s bindings, as `set-keymap-parent`.
    pub fn set_parent(&mut self, map: KeymapId, parent: Option<KeymapId>) {
        self.maps[map].parent = parent;
    }

    /// The map and its parents, nearest first.
    fn chain(&self, map: KeymapId) -> impl Iterator<Item = &Map> {
        std::iter::successors(Some(map), |&m| self.maps[m].parent).take(DEPTH).map(|m| &self.maps[m])
    }

    /// What one key is bound to in some maps and their parents, in order:
    /// each binding found, so a prefix key's maps can be merged.
    fn bindings_of_key<'a>(&'a self, maps: &[KeymapId], key: &Key) -> Vec<&'a Binding> {
        maps.iter().flat_map(|&m| self.chain(m)).filter_map(|m| m.bindings.get(key)).collect()
    }

    /// Binds a key sequence in a keymap, as Emacs's `define-key`, replacing
    /// any binding that was in the way. A prefix key with no keymap of its
    /// own in `map` gets one.
    pub fn bind(&mut self, map: KeymapId, keys: &[Key], binding: Binding) {
        let (last, prefix) = keys.split_last().expect("empty key sequence");
        let mut map = map;
        for key in prefix {
            map = match self.maps[map].bindings.get(key) {
                Some(Binding::Keymap(m)) => *m,
                _ => {
                    let new = self.make(None);
                    self.maps[map].bindings.insert(*key, Binding::Keymap(new));
                    new
                }
            };
        }
        self.maps[map].bindings.insert(*last, binding);
    }

    /// Takes a key sequence's binding out of a keymap, so its parents' shows.
    pub fn unbind(&mut self, map: KeymapId, keys: &[Key]) {
        let (last, prefix) = keys.split_last().expect("empty key sequence");
        let mut map = map;
        for key in prefix {
            map = match self.maps[map].bindings.get(key) {
                Some(Binding::Keymap(m)) => *m,
                _ => return,
            };
        }
        self.maps[map].bindings.remove(last);
    }

    /// Binds a sequence written in Emacs notation, such as `C-x C-f`, to a
    /// command. Panics on a malformed sequence, since bindings are written
    /// by programmers.
    pub fn bind_str(&mut self, map: KeymapId, seq: &str, command: &str) {
        let keys = Key::parse_seq(seq).unwrap_or_else(|| panic!("bad key sequence {seq:?}"));
        self.bind(map, &keys, Binding::Command(command.to_string()));
    }

    /// What a key sequence is bound to, as Emacs's `lookup-key`: a
    /// command, a prefix map, or nothing. Where a keymap and its parent
    /// both bind a prefix key to keymaps, the keys after it are looked up
    /// in the keymap's first and then the parent's, as Emacs composes them.
    pub fn binding_of(&self, map: KeymapId, keys: &[Key]) -> Option<Binding> {
        let mut maps = vec![map];
        for (i, key) in keys.iter().enumerate() {
            let last = i + 1 == keys.len();
            let found = self.bindings_of_key(&maps, key);
            match found.first() {
                Some(Binding::Keymap(m)) if last => return Some(Binding::Keymap(*m)),
                Some(Binding::Keymap(_)) => {
                    maps.clear();
                    for b in found {
                        if let Binding::Keymap(m) = b
                            && !maps.contains(m)
                            && maps.len() < DEPTH
                        {
                            maps.push(*m);
                        }
                    }
                }
                Some(Binding::Command(c)) if last => return Some(Binding::Command(c.clone())),
                Some(Binding::Command(_)) => return None,
                None => {
                    let default = maps.iter().flat_map(|&m| self.chain(m)).find_map(|m| m.default.clone());
                    return default.filter(|_| last).map(Binding::Command);
                }
            }
        }
        None
    }

    pub fn lookup(&self, map: KeymapId, keys: &[Key]) -> Lookup {
        match self.binding_of(map, keys) {
            Some(Binding::Command(c)) => Lookup::Command(c),
            Some(Binding::Keymap(_)) => Lookup::Prefix,
            None => Lookup::Unbound,
        }
    }

    /// Makes `to` run wherever keys run `from` while this keymap is active,
    /// or stops that with `None`.
    pub fn remap(&mut self, map: KeymapId, from: &str, to: Option<&str>) {
        let remaps = &mut self.maps[map].remaps;
        match to {
            Some(to) => remaps.insert(from.to_string(), to.to_string()),
            None => remaps.remove(from),
        };
    }

    /// The command that runs in place of `command`, if this keymap or its parents remap it.
    pub fn remapped(&self, map: KeymapId, command: &str) -> Option<&str> {
        self.chain(map).find_map(|m| m.remaps.get(command)).map(String::as_str)
    }

    /// Sets or removes the command for keys with no binding of their own.
    pub fn set_default(&mut self, map: KeymapId, command: Option<&str>) {
        self.maps[map].default = command.map(str::to_string);
    }

    /// Every binding of a keymap as (key sequence, command name), in key
    /// order, through its prefix maps; not its parents'.
    pub fn bindings(&self, map: KeymapId) -> Vec<(Vec<Key>, String)> {
        let mut out = Vec::new();
        self.collect(map, &mut Vec::new(), &mut out);
        out
    }

    fn collect(&self, map: KeymapId, prefix: &mut Vec<Key>, out: &mut Vec<(Vec<Key>, String)>) {
        if prefix.len() >= DEPTH {
            return;
        }
        for (key, binding) in &self.maps[map].bindings {
            prefix.push(*key);
            match binding {
                Binding::Command(c) => out.push((prefix.clone(), c.clone())),
                Binding::Keymap(m) => self.collect(*m, prefix, out),
            }
            prefix.pop();
        }
    }

    /// The key sequences bound to a command in a keymap and its parents,
    /// those that the keymap's own bindings shadow left out.
    pub fn keys_for(&self, map: KeymapId, command: &str) -> Vec<Vec<Key>> {
        let mut keys = Vec::new();
        for m in std::iter::successors(Some(map), |&m| self.maps[m].parent).take(DEPTH) {
            for (k, c) in self.bindings(m) {
                if c == command && !keys.contains(&k) && self.lookup(map, &k) == Lookup::Command(c) {
                    keys.push(k);
                }
            }
        }
        keys
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
        let mut maps = Keymaps::default();
        let map = maps.make(None);
        maps.bind_str(map, "C-x C-f", "find-file");
        maps.bind_str(map, "C-f", "forward-char");
        assert_eq!(maps.lookup(map, &keys("C-x")), Lookup::Prefix);
        assert_eq!(maps.lookup(map, &keys("C-x C-f")), Lookup::Command("find-file".into()));
        assert_eq!(maps.lookup(map, &keys("C-x C-z")), Lookup::Unbound);
        assert_eq!(maps.lookup(map, &keys("C-f C-f")), Lookup::Unbound);
        assert_eq!(maps.keys_for(map, "find-file"), vec![keys("C-x C-f")]);
    }

    #[test]
    fn a_prefix_map_is_shared_and_a_child_inherits_its_parent_after_a_prefix() {
        let mut maps = Keymaps::default();
        let (global, ctl_x_4, mode) = (maps.make(None), maps.make(None), maps.make(None));
        maps.bind(global, &keys("C-x 4"), Binding::Keymap(ctl_x_4));
        maps.bind(mode, &keys("C-c 4"), Binding::Keymap(ctl_x_4));
        maps.bind_str(ctl_x_4, "f", "find-file-other-window");
        assert_eq!(maps.lookup(global, &keys("C-x 4 f")), Lookup::Command("find-file-other-window".into()));
        assert_eq!(maps.lookup(mode, &keys("C-c 4 f")), Lookup::Command("find-file-other-window".into()));
        // A child's C-x map, made by binding under it, is merged with the
        // parent's, even what the parent binds later.
        let child = maps.make(Some(global));
        maps.bind_str(child, "C-x C-q", "child-command");
        maps.bind_str(global, "C-x C-s", "save-buffer");
        assert_eq!(maps.lookup(child, &keys("C-x C-s")), Lookup::Command("save-buffer".into()));
        assert_eq!(maps.lookup(child, &keys("C-x 4 f")), Lookup::Command("find-file-other-window".into()));
        assert_eq!(maps.lookup(global, &keys("C-x C-q")), Lookup::Unbound);
        // A map that is its own prefix map does not loop.
        maps.bind(ctl_x_4, &keys("4"), Binding::Keymap(ctl_x_4));
        assert!(!maps.bindings(ctl_x_4).is_empty());
    }
}
