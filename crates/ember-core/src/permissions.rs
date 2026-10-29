//! Permission for effects outside buffers, as the brief's safety rules
//! have it: while an agent acts, writing files, discarding unsaved work,
//! quitting and running code wait for the user's approval.
//!
//! The primitive that would have the effect asks
//! [`Editor::check_permission`], which refuses while an agent acts unless
//! the user allowed that effect, and records the request. Whoever runs
//! the agent asks the user, and on yes allows the effect and runs the
//! agent's action again. Nothing the agent does can allow an effect.

use crate::editor::Editor;
use crate::error::{Error, Result};

#[derive(Default)]
pub(crate) struct Permissions {
    /// Whether an agent is acting, rather than the user.
    agent_acting: bool,
    /// Effects the user allowed for the agent's current action.
    allowed: Vec<String>,
    /// The effect last refused, for asking the user about.
    requested: Option<String>,
}

impl Editor {
    /// Marks the agent as acting, or the user again.
    pub fn set_agent_acting(&mut self, acting: bool) {
        self.permissions.agent_acting = acting;
    }

    pub fn agent_acting(&self) -> bool {
        self.permissions.agent_acting
    }

    /// Allows an effect, described as [`Editor::check_permission`] got it,
    /// until [`Editor::clear_permissions`].
    pub fn allow_effect(&mut self, effect: &str) {
        self.permissions.allowed.push(effect.to_string());
    }

    /// Forgets the effects allowed and the one requested.
    pub fn clear_permissions(&mut self) {
        self.permissions.allowed.clear();
        self.permissions.requested = None;
    }

    /// Says whether an effect outside buffers, such as "write ~/notes.org",
    /// may happen: always for the user, and for an agent only once the
    /// user allowed it. Otherwise it fails and records the request.
    pub fn check_permission(&mut self, effect: &str) -> Result<()> {
        if !self.permissions.agent_acting || self.permissions.allowed.iter().any(|e| e == effect) {
            return Ok(());
        }
        self.permissions.requested = Some(effect.to_string());
        Err(Error::new(format!("Needs the user's approval: {effect}")))
    }

    /// The effect an agent's action was refused, if any, taken.
    pub fn take_permission_request(&mut self) -> Option<String> {
        self.permissions.requested.take()
    }

    /// Whether an agent's action is waiting for the user's approval.
    pub fn permission_requested(&self) -> bool {
        self.permissions.requested.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_agent_needs_approval_and_only_until_cleared() {
        let mut ed = Editor::new();
        assert!(ed.check_permission("write a.txt").is_ok(), "the user needs none");
        ed.set_agent_acting(true);
        let refused = ed.check_permission("write a.txt").unwrap_err();
        assert_eq!(refused.to_string(), "Needs the user's approval: write a.txt");
        assert_eq!(ed.take_permission_request().as_deref(), Some("write a.txt"));
        ed.allow_effect("write a.txt");
        assert!(ed.check_permission("write a.txt").is_ok());
        assert!(ed.check_permission("quit Ember").is_err(), "allowing one effect allows no other");
        ed.clear_permissions();
        assert!(ed.check_permission("write a.txt").is_err());
    }
}
