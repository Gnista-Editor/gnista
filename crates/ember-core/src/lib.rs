//! Ember's editor core: buffers, commands, keymaps and the minibuffer.
//!
//! The core has no UI dependencies. A front end feeds an [`Editor`] keys with
//! [`Editor::handle_key`] and reads its state back to draw it. Tests and
//! scripts drive it the same way, with no terminal at all.

mod buffer;
pub mod casefiddle;
// Written by tests/emacs/unicode.el; not every table is read yet.
#[allow(dead_code)]
mod chartab_data;
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
mod insdel;
pub use insdel::Insertion;
mod key;
pub mod keyboard;
mod keymap;
pub mod layout;
mod minibuffer;
mod modeline;
pub use modeline::ModeLineSegment;
mod modes;
mod permissions;
mod prefix;
pub mod process;
mod properties;
mod questions;
pub mod regexp;
mod rows;
mod search;
pub mod select;
mod symbols;
mod syntax;
pub mod syntax_table;
mod timers;
mod window;
mod variables;

pub use buffer::Buffer;
pub use command::{Arg, Command, Param, ParamKind};
pub use editor::{Editor, LoggedMessage};
pub use error::{Error, Result, define_error, error_conditions};
pub use faces::{Background, Color, Face, FaceAttrs, FaceHeight, Style, face_names, is_fixed_family, palette, palette_names};
pub use fileio::{auto_save_file_name, backup_file_name};
pub use files::{abbreviate_dir, abbreviate_path, expand_file_name, expand_file_name_in};
pub use key::{Key, KeyCode, MouseKind, format_keys};
pub use keymap::{Binding, KeymapId, Keymaps, Lookup};
pub use minibuffer::{MinibufferInfo, Reading, file_name_all_completions};
pub use modes::MinorMode;
pub use prefix::{PrefixArg, prefix_numeric_value};
pub use properties::{Overlay, Props, Text};
pub use process::{ProcessSpec, Status as ProcessStatus};
pub use rows::{LineNumbers, Row, Segment};
pub use symbols::{AdviceHow, Definition};
pub use search::{BufferHaystack, Match, SearchOptions, expand_replacement, fold_case_for as search_fold_case};
pub use variables::{Function, HookFn, Value, Variable};
pub use window::{BuryOrKill, MINIBUFFER_WINDOW, FrameId, MouseEvent, WindowId, WindowRect, WindowTree, WindowView};
