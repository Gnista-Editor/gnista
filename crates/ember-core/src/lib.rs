//! Ember's editor core: buffers, commands, keymaps and the minibuffer.
//!
//! The core has no UI dependencies. A front end feeds an [`Editor`] keys with
//! [`Editor::handle_key`] and reads its state back to draw it. Tests and
//! scripts drive it the same way, with no terminal at all.

mod buffer;
mod command;
mod commands;
pub mod display;
mod editor;
mod error;
mod files;
mod key;
mod keymap;
mod prefix;

pub use buffer::Buffer;
pub use command::{Arg, Command, Param, ParamKind};
pub use editor::Editor;
pub use error::{Error, Result};
pub use files::{abbreviate_dir, abbreviate_path, expand_file_name};
pub use key::{Key, KeyCode, format_keys};
pub use keymap::{Keymap, Lookup};
pub use prefix::{PrefixArg, prefix_numeric_value};
