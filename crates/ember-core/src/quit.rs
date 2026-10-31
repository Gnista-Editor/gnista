//! Quitting, as Emacs's `quit-flag` and `maybe_quit`: `C-g` sets a flag
//! that running code checks at safe points, signalling `quit` there unless
//! `inhibit-quit` is set, in which case the flag waits until it is not.
//!
//! The flag belongs to an editor but is set from anywhere: a front end's
//! input thread, a test, the agent, through a [`QuitHandle`]. Code checks it
//! with [`Editor::maybe_quit`], or with [`QuitState::check`] where it has no
//! editor, as the regexp matcher and the syntax scanners do: between whole
//! steps, never inside one change, so a quit leaves the buffer consistent.
//! The command loop clears the flag before each command, and a key read
//! while it is set reads as `C-g`, so `keyboard-quit` runs as bound.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crate::editor::Editor;
use crate::error::{Error, Result};

/// The flag and what decides whether it fires.
#[derive(Debug, Default)]
pub struct QuitState {
    flag: AtomicBool,
    /// How many times quitting was asked for since the flag was last
    /// answered, for the emergency exit after three.
    presses: AtomicU32,
    /// `inhibit-quit`'s value, kept here as the variable changes so checks
    /// need no lookup.
    inhibit: AtomicBool,
}

impl QuitState {
    /// Whether quitting has been asked for and not yet answered.
    pub fn requested(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// Signals `quit` if the flag is set and `inhibit-quit` is not,
    /// clearing the flag, as Emacs's `maybe_quit`.
    pub fn check(&self) -> Result<()> {
        if self.flag.load(Ordering::Relaxed) && !self.inhibit.load(Ordering::Relaxed) {
            self.clear();
            return Err(quit_error());
        }
        Ok(())
    }

    /// Answers the flag without quitting.
    pub fn clear(&self) {
        self.flag.store(false, Ordering::Relaxed);
        self.presses.store(0, Ordering::Relaxed);
    }

    /// How many times quitting was asked for while the flag went unanswered.
    pub fn presses(&self) -> u32 {
        self.presses.load(Ordering::Relaxed)
    }

    pub(crate) fn set_inhibit(&self, inhibit: bool) {
        self.inhibit.store(inhibit, Ordering::Relaxed);
    }

    pub fn inhibited(&self) -> bool {
        self.inhibit.load(Ordering::Relaxed)
    }
}

/// What another thread holds to make an editor quit.
#[derive(Clone, Debug)]
pub struct QuitHandle(Arc<QuitState>);

impl QuitHandle {
    /// Asks the editor to quit, as `C-g` sets `quit-flag`.
    pub fn request(&self) {
        self.0.flag.store(true, Ordering::Relaxed);
        self.0.presses.fetch_add(1, Ordering::Relaxed);
    }

    pub fn state(&self) -> &QuitState {
        &self.0
    }
}

/// Emacs's `quit` signal.
pub fn quit_error() -> Error {
    Error::signal("quit", "Quit", Vec::new())
}

impl Editor {
    /// A handle another thread can use to make this editor quit.
    pub fn quit_handle(&self) -> QuitHandle {
        QuitHandle(self.quitting.clone())
    }

    /// The flag, for code that checks it without the editor.
    pub fn quit_state(&self) -> &Arc<QuitState> {
        &self.quitting
    }

    /// Asks this editor to quit, as `C-g` does.
    pub fn request_quit(&self) {
        self.quit_handle().request();
    }

    /// Signals `quit` if quitting was asked for and `inhibit-quit` is not
    /// set, as Emacs's `maybe_quit`.
    pub fn maybe_quit(&self) -> Result<()> {
        self.quitting.check()
    }
}
