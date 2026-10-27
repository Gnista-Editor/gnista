use std::rc::Rc;

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::key::Key;

/// What kind of value a command parameter takes. Decides how the minibuffer
/// reads it and what it completes against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    /// Free text.
    String,
    /// A file name, completed from the file system.
    File,
    /// A buffer name, completed from open buffers.
    Buffer,
    /// A command name, completed from the command registry.
    Command,
    /// A key sequence, read key by key rather than typed as text.
    Keys,
}

impl ParamKind {
    pub fn describe(&self) -> &'static str {
        match self {
            ParamKind::String => "text",
            ParamKind::File => "file name",
            ParamKind::Buffer => "buffer name",
            ParamKind::Command => "command name",
            ParamKind::Keys => "key sequence",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Param {
    pub name: String,
    pub kind: ParamKind,
    pub prompt: String,
}

/// An argument value passed to a command.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Str(String),
    Keys(Vec<Key>),
}

impl Arg {
    pub fn as_str(&self) -> Result<&str> {
        match self {
            Arg::Str(s) => Ok(s),
            Arg::Keys(_) => Err(Error::new("Expected text, got a key sequence")),
        }
    }

    pub fn as_keys(&self) -> Result<&[Key]> {
        match self {
            Arg::Keys(k) => Ok(k),
            Arg::Str(_) => Err(Error::new("Expected a key sequence, got text")),
        }
    }
}

pub type CommandFn = Rc<dyn Fn(&mut Editor, &[Arg]) -> Result<()>>;

/// A named, documented editor action. One definition serves key bindings,
/// M-x (which prompts for each parameter) and calls from code, which pass
/// the arguments directly.
pub struct Command {
    pub name: String,
    pub doc: String,
    pub params: Vec<Param>,
    pub run: CommandFn,
}

impl Command {
    pub fn new(
        name: &str,
        doc: &str,
        run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static,
    ) -> Command {
        Command {
            name: name.to_string(),
            doc: doc.to_string(),
            params: Vec::new(),
            run: Rc::new(run),
        }
    }

    /// Adds a parameter. Interactive calls prompt for parameters in order.
    pub fn param(mut self, name: &str, kind: ParamKind, prompt: &str) -> Command {
        self.params.push(Param {
            name: name.to_string(),
            kind,
            prompt: prompt.to_string(),
        });
        self
    }

    /// The first line of the documentation.
    pub fn summary(&self) -> &str {
        self.doc.lines().next().unwrap_or("")
    }
}
