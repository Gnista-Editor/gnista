//! Ember's editor core: buffers, commands, keymaps and the minibuffer.
//!
//! The core has no UI dependencies. A front end feeds an [`Editor`] keys with
//! [`Editor::handle_key`] and reads its state back to draw it. Tests and
//! scripts drive it the same way, with no terminal at all.

mod buffer;
pub mod coding;
mod command;
pub mod completion;
mod commands;
pub mod display;
mod editor;
mod error;
mod faces;
mod fileio;
pub mod fileops;
mod files;
mod fontify;
mod key;
mod keymap;
mod minibuffer;
mod modes;
mod permissions;
mod prefix;
pub mod process;
mod properties;
mod questions;
mod rows;
mod search;
mod syntax;
pub mod syntax_table;
mod timers;
mod window;
mod variables;

pub use buffer::Buffer;
pub use command::{Arg, Command, Param, ParamKind};
pub use editor::{Editor, LoggedMessage};
pub use error::{Error, Result, define_error, error_conditions};
pub use faces::{Background, Color, Face, FaceAttrs, Style, face_names, palette, palette_names};
pub use fileio::{auto_save_file_name, backup_file_name};
pub use files::{abbreviate_dir, abbreviate_path, expand_file_name, expand_file_name_in};
pub use key::{Key, KeyCode, MouseKind, format_keys};
pub use keymap::{Keymap, Lookup};
pub use minibuffer::{MinibufferInfo, MinibufferOverlay, Reading, file_name_all_completions};
pub use modes::MinorMode;
pub use prefix::{PrefixArg, prefix_numeric_value};
pub use properties::{Overlay, Props};
pub use process::{ProcessSpec, Status as ProcessStatus};
pub use rows::{LineNumbers, Row, Segment};
pub use search::{Match, SearchOptions, expand_replacement, fold_case_for as search_fold_case, looking_at, search, string_match, translate_regexp};
pub use variables::{HookFn, Value, Variable};
pub use window::{FrameId, MouseEvent, WindowId, WindowRect, WindowTree, WindowView};
