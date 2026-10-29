//! Named keymaps and modes. A buffer has one major mode, recorded in the
//! buffer-local variables `major-mode` and `mode-name` with its keymap as the
//! buffer's local map, and any number of minor modes, each turned on by a
//! variable of its own name. The commands that turn modes on are written in
//! TypeScript; this is the part Emacs does in C.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::Key;
use crate::keymap::{Keymap, Lookup};

/// A keymap that other keymaps can be built on: lookups that find nothing
/// here continue in the parent, as with Emacs's `set-keymap-parent`.
pub(crate) struct NamedKeymap {
    pub(crate) map: Keymap,
    pub(crate) parent: Option<String>,
}

/// A minor mode, for key lookup and the mode line.
#[derive(Clone, Debug)]
pub struct MinorMode {
    /// Also the name of the variable that says whether it is on.
    pub name: String,
    /// What the mode line shows while it is on, such as " Ovwrt". Empty for nothing.
    pub lighter: String,
    pub keymap: Option<String>,
    /// Whether it applies to every buffer rather than one at a time.
    pub global: bool,
}

/// The keymaps the editor itself has, which scripts can name.
const GLOBAL_MAP: &str = "global-map";
const MINIBUFFER_MAP: &str = "minibuffer-local-map";

impl Editor {
    /// Defines a named keymap, or changes its parent if it exists.
    pub fn define_keymap(&mut self, name: &str, parent: Option<&str>) {
        let parent = parent.map(str::to_string);
        self.keymaps
            .entry(name.to_string())
            .and_modify(|k| k.parent = parent.clone())
            .or_insert(NamedKeymap { map: Keymap::default(), parent });
    }

    pub fn keymap_names(&self) -> impl Iterator<Item = &str> {
        [GLOBAL_MAP, MINIBUFFER_MAP].into_iter().chain(self.keymaps.keys().map(String::as_str))
    }

    fn keymap_mut(&mut self, name: &str) -> Option<&mut Keymap> {
        match name {
            GLOBAL_MAP => Some(&mut self.global_map),
            MINIBUFFER_MAP => Some(&mut self.minibuffer_map),
            _ => self.keymaps.get_mut(name).map(|k| &mut k.map),
        }
    }

    /// Binds a key sequence in a named keymap.
    pub fn bind_key_in(&mut self, keymap: &str, keys: &[Key], command: &str) -> Result<()> {
        let map = self
            .keymap_mut(keymap)
            .ok_or_else(|| Error::new(format!("No such keymap: {keymap}")))?;
        map.bind(keys, command);
        Ok(())
    }

    /// Makes a named keymap remap a command: wherever keys would run `from`
    /// while the keymap is active, `to` runs instead, as Emacs's
    /// `(define-key map [remap FROM] TO)`.
    pub fn remap_command(&mut self, keymap: &str, from: &str, to: Option<&str>) -> Result<()> {
        let map = self
            .keymap_mut(keymap)
            .ok_or_else(|| Error::new(format!("No such keymap: {keymap}")))?;
        map.remap(from, to);
        Ok(())
    }

    /// The command that runs in place of `command` in a named keymap or its parents.
    fn remapped_in(&self, name: &str, command: &str) -> Option<String> {
        let mut next = Some(name.to_string());
        for _ in 0..32 {
            let name = next?;
            let (map, parent) = match name.as_str() {
                GLOBAL_MAP => (&self.global_map, None),
                MINIBUFFER_MAP => (&self.minibuffer_map, None),
                _ => {
                    let k = self.keymaps.get(&name)?;
                    (&k.map, k.parent.clone())
                }
            };
            if let Some(to) = map.remapped(command) {
                return Some(to.to_string());
            }
            next = parent;
        }
        None
    }

    /// The command that runs when keys run `command`: the first remapping of
    /// it in the active keymaps, in the order keys are looked up, or `None`.
    pub fn command_remapping(&self, command: &str) -> Option<String> {
        let mut maps: Vec<String> = self.overriding_map.iter().cloned().collect();
        if self.prompt.is_some() {
            maps.push(MINIBUFFER_MAP.to_string());
        }
        maps.extend(self.mode_keymaps());
        maps.push(GLOBAL_MAP.to_string());
        maps.iter().find_map(|m| self.remapped_in(m, command))
    }

    /// Sets the command a named keymap runs for keys it does not bind.
    pub fn set_keymap_default(&mut self, keymap: &str, command: Option<&str>) -> Result<()> {
        let map = self
            .keymap_mut(keymap)
            .ok_or_else(|| Error::new(format!("No such keymap: {keymap}")))?;
        map.set_default(command);
        Ok(())
    }

    /// Makes a named keymap take precedence over every other but a transient
    /// map, or stops that with `None`, as Emacs's
    /// `overriding-terminal-local-map`. Incremental search uses it.
    pub fn set_overriding_map(&mut self, keymap: Option<&str>) -> Result<()> {
        if let Some(name) = keymap
            && self.keymap_names().all(|n| n != name)
        {
            return Err(Error::new(format!("No such keymap: {name}")));
        }
        self.overriding_map = keymap.map(str::to_string);
        Ok(())
    }

    pub fn overriding_map(&self) -> Option<&str> {
        self.overriding_map.as_deref()
    }

    /// Looks keys up in a named keymap and then its parents.
    pub(crate) fn lookup_in(&self, name: &str, keys: &[Key]) -> Lookup {
        let mut next = Some(name.to_string());
        // A parent loop would otherwise never end.
        for _ in 0..32 {
            let Some(name) = next else { break };
            let (map, parent) = match name.as_str() {
                GLOBAL_MAP => (&self.global_map, None),
                MINIBUFFER_MAP => (&self.minibuffer_map, None),
                _ => match self.keymaps.get(&name) {
                    Some(k) => (&k.map, k.parent.clone()),
                    None => return Lookup::Unbound,
                },
            };
            match map.lookup(keys) {
                Lookup::Unbound => next = parent,
                found => return found,
            }
        }
        Lookup::Unbound
    }

    /// Makes a named keymap the current buffer's local map, the major
    /// mode's keymap, as Emacs's `use-local-map` does.
    pub fn use_local_map(&mut self, name: Option<&str>) {
        self.buffer_mut().local_map = name.map(str::to_string).into_iter().collect();
    }

    /// Puts a named keymap in front of the current buffer's local map, as
    /// Emacs's `(use-local-map (make-composed-keymap MAP (current-local-map)))`.
    pub fn compose_local_map(&mut self, name: &str) {
        let maps = &mut self.buffer_mut().local_map;
        maps.retain(|m| m != name);
        maps.insert(0, name.to_string());
    }

    /// Registers a minor mode, replacing one with the same name. Modes
    /// registered later take precedence in key lookup, as in Emacs.
    pub fn register_minor_mode(&mut self, mode: MinorMode) {
        self.minor_modes.retain(|m| m.name != mode.name);
        self.minor_modes.insert(0, mode);
    }

    pub fn minor_modes(&self) -> &[MinorMode] {
        &self.minor_modes
    }

    fn minor_mode_on(&self, b: &Buffer, name: &str) -> bool {
        self.variable_in(b, name).is_some_and(|v| v.is_true())
    }

    /// The minor modes that are on in the current buffer.
    pub fn enabled_minor_modes(&self) -> Vec<String> {
        let b = self.buffer();
        self.minor_modes
            .iter()
            .filter(|m| self.minor_mode_on(b, &m.name))
            .map(|m| m.name.clone())
            .collect()
    }

    /// The keymaps that apply to the current buffer, in the order keys are
    /// looked up: minor modes that are on, then the major mode's local map.
    /// The transient, minibuffer and global maps come before and after these.
    pub(crate) fn mode_keymaps(&self) -> Vec<String> {
        let b = self.buffer();
        let mut maps: Vec<String> = self
            .minor_modes
            .iter()
            .filter(|m| self.minor_mode_on(b, &m.name))
            .filter_map(|m| m.keymap.clone())
            .collect();
        maps.extend(b.local_map.iter().cloned());
        maps
    }

    /// The keys bound to a command in the keymaps that apply to the current
    /// buffer: the global map, then the major mode's and minor modes' maps.
    pub fn keys_for(&self, command: &str) -> Vec<Vec<Key>> {
        let mut keys = self.global_map.keys_for(command);
        for name in self.mode_keymaps() {
            if let Some(k) = self.keymaps.get(&name) {
                keys.extend(k.map.keys_for(command));
            }
        }
        keys
    }

    /// The window buffer's `tab-width`, for drawing tabs.
    pub fn tab_width(&self) -> usize {
        self.tab_width_in(self.window_buffer())
    }

    pub fn tab_width_in(&self, b: &Buffer) -> usize {
        self.number_in(b, "tab-width", 8.0).max(1.0) as usize
    }

    /// The window buffer's major mode as the mode line shows it, such as "Text".
    pub fn mode_name(&self) -> String {
        self.mode_name_in(self.window_buffer())
    }

    pub fn mode_name_in(&self, b: &Buffer) -> String {
        self.variable_in(b, "mode-name")
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "Fundamental".to_string())
    }

    /// What the window buffer's minor modes add to the mode line, each with
    /// its leading space as Emacs writes lighters: " Ovwrt".
    pub fn mode_lighters(&self) -> Vec<String> {
        self.mode_lighters_in(self.window_buffer())
    }

    pub fn mode_lighters_in(&self, b: &Buffer) -> Vec<String> {
        self.minor_modes
            .iter()
            .rev()
            .filter(|m| !m.lighter.is_empty() && self.minor_mode_on(b, &m.name))
            .map(|m| m.lighter.clone())
            .collect()
    }
}
