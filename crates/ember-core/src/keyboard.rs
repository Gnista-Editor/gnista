//! The command loop's own primitives, as Emacs's keyboard.c has them:
//! reading keys partway through a command (`read-key`, `read-key-sequence`,
//! `read-char`, `read-event`), the keys that ran the command running
//! (`this-command-keys`), the keys typed lately and the commands they ran
//! (`recent-keys`, which `C-h l` shows), and recursive edits.
//!
//! Emacs's Lisp waits for the key; here the reading command returns, and
//! the key, when it comes, runs a function given with the request, in the
//! context the command read in, as questions are answered
//! (`questions.rs`). A recursive edit is the same: it is entered, the
//! editor goes on taking commands, and `exit-recursive-edit` runs what
//! waited, or `abort-recursive-edit` quits it.

use std::collections::VecDeque;

use crate::editor::{Editor, Resume};
use crate::error::{Error, Result};
use crate::key::{Key, KeyCode, format_keys};
use crate::keymap::Lookup;
use crate::variables::{HookFn, Value};

/// What is being read: one key, as `read-key` and `read-event` give it, a
/// character, as `read-char`, or a whole key sequence, as the command loop
/// reads one, by `read-key-sequence`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadKind {
    Key,
    Event,
    Char,
    KeySequence,
}

pub(crate) struct KeyReader {
    kind: ReadKind,
    prompt: String,
    keys: Vec<Key>,
    then: HookFn,
    quit: Option<HookFn>,
    resume: Resume,
}

pub(crate) struct RecursiveEdit {
    then: HookFn,
    quit: Option<HookFn>,
    /// How many minibuffers were open when it was entered, so a minibuffer
    /// opened in it is left first.
    minibuffers: usize,
    resume: Resume,
}

/// One entry of the keys typed lately: a key, or the command the keys
/// before it ran, as `recent-keys` lists `(nil . COMMAND)`.
#[derive(Clone, Debug, PartialEq)]
pub enum Lossage {
    Key(Key),
    Command(String),
}

/// How many keys `recent-keys` keeps, as Emacs's `lossage-size` starts.
pub(crate) const LOSSAGE_SIZE: usize = 300;

/// The keyboard's state that the command loop keeps.
pub(crate) struct Keyboard {
    pub(crate) reader: Option<KeyReader>,
    pub(crate) recursive_edits: Vec<RecursiveEdit>,
    pub(crate) lossage: VecDeque<Lossage>,
    pub(crate) lossage_size: usize,
    /// The keys of the command running, or that ran last.
    pub(crate) this_command_keys: Vec<Key>,
}

impl Default for Keyboard {
    fn default() -> Keyboard {
        Keyboard {
            reader: None,
            recursive_edits: Vec::new(),
            lossage: VecDeque::new(),
            lossage_size: LOSSAGE_SIZE,
            this_command_keys: Vec::new(),
        }
    }
}

impl Editor {
    /// Reads a key partway through a command, showing `prompt` in the echo
    /// area, and calls `then` with it, as Emacs's `read-key`,
    /// `read-event`, `read-char` and `read-key-sequence` return it: a key's
    /// description, such as "C-x" or "<f1>", or a key sequence's, "C-x C-f".
    /// `C-g` quits, but for a key sequence, where it is a key like others.
    pub fn read_key_event(&mut self, kind: ReadKind, prompt: &str, then: HookFn, quit: Option<HookFn>) -> Result<()> {
        if self.keyboard.reader.is_some() {
            return Err(Error::new("Already reading a key"));
        }
        let resume = self.resume_point();
        self.keyboard.reader = Some(KeyReader { kind, prompt: prompt.to_string(), keys: Vec::new(), then, quit, resume });
        self.message = (!prompt.is_empty()).then(|| prompt.to_string());
        Ok(())
    }

    /// Whether code is waiting for a key, which the next key goes to.
    pub fn reading_key(&self) -> bool {
        self.keyboard.reader.is_some()
    }

    /// Gives a key to code waiting for one. Returns false if none waits.
    pub(crate) fn key_read(&mut self, key: Key) -> bool {
        let Some(mut reader) = self.keyboard.reader.take() else { return false };
        let quit = key == Key::parse("C-g").expect("C-g parses");
        if quit && reader.kind != ReadKind::KeySequence {
            self.message = None;
            if let Some(quit) = reader.quit {
                match self.run_resumed(&reader.resume, |ed| quit(ed, &[])) {
                    Err(e) if !e.is("quit") => self.fail(e),
                    _ => {}
                }
            }
            self.fail(Error::signal("quit", "Quit", Vec::new()));
            return true;
        }
        reader.keys.push(key);
        let answer = match reader.kind {
            ReadKind::KeySequence => {
                if self.lookup(&reader.keys) == Lookup::Prefix {
                    self.message = Some(format!("{}{}-", reader.prompt, format_keys(&reader.keys)));
                    self.keyboard.reader = Some(reader);
                    return true;
                }
                self.keyboard.this_command_keys = reader.keys.clone();
                Ok(format_keys(&reader.keys))
            }
            ReadKind::Char => match key.code {
                KeyCode::Char(_) | KeyCode::Enter | KeyCode::Tab | KeyCode::Backspace | KeyCode::Esc => Ok(key.to_string()),
                _ => Err(Error::new("Non-character input-event")),
            },
            ReadKind::Key | ReadKind::Event => Ok(key.to_string()),
        };
        self.message = None;
        let result = match answer {
            Ok(answer) => {
                let then = reader.then.clone();
                self.run_resumed(&reader.resume, |ed| then(ed, &[Value::Str(answer)]))
            }
            Err(e) => Err(e),
        };
        if let Err(e) = result {
            self.prompt_waiters_clear();
            self.fail(e);
            return true;
        }
        self.run_prompt_waiters();
        true
    }

    /// Notes a key typed, for `recent-keys`, keeping the last
    /// `lossage-size` keys.
    pub(crate) fn record_lossage_key(&mut self, key: Key) {
        let k = &mut self.keyboard;
        k.lossage.push_back(Lossage::Key(key));
        while k.lossage.iter().filter(|e| matches!(e, Lossage::Key(_))).count() > k.lossage_size {
            k.lossage.pop_front();
            while matches!(k.lossage.front(), Some(Lossage::Command(_))) {
                k.lossage.pop_front();
            }
        }
    }

    /// Notes the command the keys typed ran, for `recent-keys`.
    pub(crate) fn record_lossage_command(&mut self, name: &str) {
        if self.executing_macro == 0 {
            self.keyboard.lossage.push_back(Lossage::Command(name.to_string()));
        }
    }

    /// The keys typed lately, oldest first, as Emacs's `recent-keys`; with
    /// `include_cmds`, each command after the keys that ran it. Keys a
    /// keyboard macro replays are not among them.
    pub fn recent_keys(&self, include_cmds: bool) -> Vec<Lossage> {
        self.keyboard.lossage.iter().filter(|e| include_cmds || matches!(e, Lossage::Key(_))).cloned().collect()
    }

    /// How many keys `recent-keys` keeps, as `lossage-size`.
    pub fn lossage_size(&self) -> usize {
        self.keyboard.lossage_size
    }

    /// Keeps `size` keys from now on, the oldest forgotten if there are
    /// more, as `lossage-size` with an argument; at least 100, as Emacs has it.
    pub fn set_lossage_size(&mut self, size: usize) -> Result<()> {
        if size < 100 {
            return Err(Error::user("Value must be >= 100"));
        }
        self.keyboard.lossage_size = size;
        let keys: Vec<Key> = self.keyboard.lossage.iter().filter_map(|e| if let Lossage::Key(k) = e { Some(*k) } else { None }).collect();
        if keys.len() > size {
            let mut drop = keys.len() - size;
            while drop > 0 {
                if let Some(Lossage::Key(_)) = self.keyboard.lossage.pop_front() {
                    drop -= 1;
                }
            }
            while matches!(self.keyboard.lossage.front(), Some(Lossage::Command(_))) {
                self.keyboard.lossage.pop_front();
            }
        }
        Ok(())
    }

    /// The keys that ran the command running, as Emacs's
    /// `this-command-keys`: not those of its prefix argument, which ran
    /// commands of their own; after `read-key-sequence`, the sequence it read.
    pub fn this_command_keys(&self) -> &[Key] {
        &self.keyboard.this_command_keys
    }

    /// Keeps the keys of a command about to run.
    pub(crate) fn note_command_keys(&mut self, keys: &[Key]) {
        self.keyboard.this_command_keys = keys.to_vec();
    }

    /// Whether code waits for a single key, which takes ESC as it comes,
    /// as Emacs's `read-key` does, rather than as a prefix for Meta.
    pub(crate) fn reading_single_key(&self) -> bool {
        self.keyboard.reader.as_ref().is_some_and(|r| r.kind != ReadKind::KeySequence)
    }

    /// Whether keys are waiting to be read, as Emacs's `input-pending-p`:
    /// keys a command gave back with `unread-command-events`.
    pub fn input_pending_p(&self) -> bool {
        !self.unread_keys.is_empty()
    }

    /// Forgets keys waiting to be read, as `discard-input`.
    pub fn discard_input(&mut self) {
        self.unread_keys.clear();
    }

    /// Enters a recursive edit, as Emacs's `recursive-edit`: the editor
    /// goes on taking commands, the mode line shows `[` `]` around the
    /// modes for each level, and `exit-recursive-edit` (`C-M-c`) calls
    /// `then`, or `abort-recursive-edit` (`C-]`) quits it, calling `quit`.
    pub fn recursive_edit(&mut self, then: HookFn, quit: Option<HookFn>) {
        let resume = self.resume_point();
        let minibuffers = self.minibuffer_depth();
        self.keyboard.recursive_edits.push(RecursiveEdit { then, quit, minibuffers, resume });
        self.update_mode_lines();
    }

    /// How deep in recursive edits and minibuffers the editor is, as
    /// Emacs's `recursion-depth`.
    pub fn recursion_depth(&self) -> usize {
        self.keyboard.recursive_edits.len() + self.minibuffer_depth()
    }

    /// How many recursive edits are open, which the mode line's `%[` shows.
    pub fn recursive_edit_depth(&self) -> usize {
        self.keyboard.recursive_edits.len()
    }

    /// Whether the innermost level is a minibuffer opened inside the
    /// innermost recursive edit, or there is no recursive edit.
    fn minibuffer_innermost(&self) -> bool {
        match self.keyboard.recursive_edits.last() {
            Some(edit) => self.minibuffer_depth() > edit.minibuffers,
            None => self.minibuffer_depth() > 0,
        }
    }

    /// Leaves the innermost recursive edit and runs what waited for it, as
    /// Emacs's `exit-recursive-edit`; in a minibuffer opened inside it, the
    /// minibuffer is left as RET leaves it.
    pub fn exit_recursive_edit(&mut self) -> Result<()> {
        if self.minibuffer_innermost() {
            return self.call("exit-minibuffer", Vec::new());
        }
        let Some(edit) = self.keyboard.recursive_edits.pop() else {
            return Err(Error::user("No recursive edit is in progress"));
        };
        self.update_mode_lines();
        let then = edit.then.clone();
        let result = self.run_resumed(&edit.resume, |ed| then(ed, &[]));
        self.run_prompt_waiters();
        result.map(|_| ())
    }

    /// Quits the innermost recursive edit or minibuffer, as Emacs's
    /// `abort-recursive-edit`: what waited for it is told it was quit.
    pub fn abort_recursive_edit(&mut self) -> Result<()> {
        if self.minibuffer_innermost() {
            self.abort();
            return Err(Error::signal("quit", "Quit", Vec::new()));
        }
        let Some(edit) = self.keyboard.recursive_edits.pop() else {
            return Err(Error::user("No recursive edit is in progress"));
        };
        self.update_mode_lines();
        if let Some(quit) = edit.quit {
            match self.run_resumed(&edit.resume, |ed| quit(ed, &[])) {
                Err(e) if !e.is("quit") => self.fail(e),
                _ => {}
            }
        }
        Err(Error::signal("quit", "Quit", Vec::new()))
    }

    /// Leaves every recursive edit and minibuffer, back to the top level,
    /// as Emacs's `top-level`.
    pub fn top_level(&mut self) {
        for _ in 0..self.minibuffer_depth() {
            self.abort();
        }
        while let Some(edit) = self.keyboard.recursive_edits.pop() {
            if let Some(quit) = edit.quit {
                match self.run_resumed(&edit.resume, |ed| quit(ed, &[])) {
                    Err(e) if !e.is("quit") => self.fail(e),
                    _ => {}
                }
            }
        }
        self.keyboard.reader = None;
        self.update_mode_lines();
        self.message("Back to top level");
    }
}
