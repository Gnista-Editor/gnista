//! Indirect buffers, as Emacs's buffer.c makes them: buffers that share
//! their text, its properties, its undo history and whether it is modified
//! with a base buffer, each with its own point, narrowing, markers,
//! overlays, local variables and major mode, as Org's
//! `org-tree-to-indirect-buffer` and `clone-indirect-buffer` use them.
//!
//! Emacs keeps one copy of the text for them all. Gnista keeps one in each
//! buffer, cheaply, as ropes share what they have in common, and makes each
//! change in one in the others too: after every edit through the editor,
//! after each call a script makes, and after each command. Undo has one
//! history for them all, which moves to whichever buffer is edited.

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};

impl Editor {
    /// Makes a buffer sharing `base`'s text, as Emacs's `make-indirect-buffer`:
    /// the base of an indirect buffer is its own base. With `clone`, it
    /// starts with `base`'s major mode, local variables and overlays, and
    /// runs `clone-indirect-buffer-hook` in it; otherwise it is in
    /// Fundamental mode. Returns its index.
    pub fn make_indirect_buffer(&mut self, base: &str, name: &str, clone: bool) -> Result<usize> {
        let index = self.find_buffer(base).ok_or_else(|| Error::new(format!("No such buffer: ‘{base}’")))?;
        if name.is_empty() {
            return Err(Error::new("Empty string for buffer name is not allowed"));
        }
        if self.find_buffer(name).is_some() {
            return Err(Error::new(format!("Buffer name ‘{name}’ is in use")));
        }
        self.sync_shared_text();
        let base = match self.buffers[index].base_buffer() {
            Some(id) => self.buffer_with_id(id).expect("a base outlives its indirect buffers"),
            None => index,
        };
        if self.buffers[base].id == self.minibuffer_id {
            return Err(Error::new("Cannot make an indirect buffer of the minibuffer"));
        }
        let made = self.buffers[base].indirect(name, clone);
        let language = clone.then(|| self.buffers[base].primary_syntax().map(|s| s.language.clone())).flatten();
        self.buffers.push(made);
        self.has_indirect_buffers = true;
        let made = self.buffers.len() - 1;
        if clone {
            let id = self.buffers[made].id;
            let old = self.buffers[self.current].id;
            self.current = made;
            let result = match language {
                Some(language) => self.set_buffer_language(Some(&language)),
                None => Ok(()),
            };
            let hooks = result.and_then(|()| self.run_hooks("clone-indirect-buffer-hook"));
            self.current = self.buffer_with_id(old).unwrap_or(self.current);
            hooks?;
            return Ok(self.buffer_with_id(id).expect("just made"));
        }
        Ok(made)
    }

    /// The buffers sharing the text of the buffer at `index`, other than it.
    fn sharing(&self, index: usize) -> Vec<usize> {
        let b = &self.buffers[index];
        let base = b.base_buffer().unwrap_or(b.id);
        (0..self.buffers.len())
            .filter(|&i| i != index && (self.buffers[i].id == base || self.buffers[i].base_buffer() == Some(base)))
            .collect()
    }

    /// Makes the changes each buffer sharing its text made in the others,
    /// with the text properties and modified flag of the one that changed
    /// them, as if they were one text, as they are in Emacs.
    pub fn sync_shared_text(&mut self) {
        if !self.has_indirect_buffers {
            return;
        }
        for i in 0..self.buffers.len() {
            let b = &mut self.buffers[i];
            let generation = b.properties_generation();
            let modified = b.is_modified();
            let Some(shared) = &mut b.shared else { continue };
            let changes = std::mem::take(&mut shared.changes);
            let props = shared.props != generation;
            let flag = shared.modified != modified;
            if changes.is_empty() && !props && !flag {
                continue;
            }
            for j in self.sharing(i) {
                let (from, to) = pair(&mut self.buffers, i, j);
                for change in &changes {
                    to.mirror(change, from);
                }
                if props || !changes.is_empty() {
                    to.mirror_properties(from);
                }
                if flag || !changes.is_empty() {
                    to.set_modified(modified);
                }
                to.mark_shared();
            }
            self.buffers[i].mark_shared();
        }
    }

    /// Gives the buffer at `index` the undo history its family shares, from
    /// whichever of them last changed the text, before it records a change.
    pub fn claim_undo(&mut self, index: usize) {
        if !self.has_indirect_buffers || self.buffers[index].shared.as_ref().is_none_or(|s| s.holds_undo) {
            return;
        }
        let Some(holder) = self.sharing(index).into_iter().find(|&j| self.buffers[j].shared.as_ref().is_some_and(|s| s.holds_undo)) else {
            return;
        };
        let state = self.buffers[holder].take_undo();
        self.buffers[index].put_undo(state);
        for (i, holds) in [(holder, false), (index, true)] {
            if let Some(shared) = &mut self.buffers[i].shared {
                shared.holds_undo = holds;
            }
        }
    }

    /// Before a buffer goes: its indirect buffers go first, as Emacs kills
    /// them with their base, and an indirect buffer leaves the undo history
    /// with its base. Returns the names of the indirect buffers to kill.
    pub(crate) fn indirect_buffers_of(&mut self, index: usize) -> Vec<String> {
        if !self.has_indirect_buffers {
            return Vec::new();
        }
        self.sync_shared_text();
        let b = &self.buffers[index];
        match b.base_buffer().and_then(|id| self.buffer_with_id(id)) {
            Some(base) => {
                self.claim_undo(base);
                Vec::new()
            }
            None => {
                let id = b.id;
                self.buffers.iter().filter(|o| o.base_buffer() == Some(id)).map(|o| o.name.clone()).collect()
            }
        }
    }
}

/// Two buffers of the list, the first to read and the second to change.
fn pair(buffers: &mut [Buffer], i: usize, j: usize) -> (&Buffer, &mut Buffer) {
    if i < j {
        let (left, right) = buffers.split_at_mut(j);
        (&left[i], &mut right[0])
    } else {
        let (left, right) = buffers.split_at_mut(i);
        (&right[0], &mut left[j])
    }
}

impl Buffer {
    /// Notes that what the buffer has is shared with the others now.
    fn mark_shared(&mut self) {
        let (generation, modified) = (self.properties_generation(), self.is_modified());
        if let Some(shared) = &mut self.shared {
            shared.changes.clear();
            shared.props = generation;
            shared.modified = modified;
        }
    }
}
