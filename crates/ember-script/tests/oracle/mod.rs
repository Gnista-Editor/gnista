//! What both oracle tests share: the case and golden file formats, and
//! running a case through Ember the way record.el runs it through Emacs.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use ember_core::{Editor, Key, PrefixArg};
use ember_script::Scripting;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct Case {
    pub name: String,
    pub text: String,
    pub keys: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub point: usize,
    /// Modes to turn on before typing the keys.
    #[serde(default)]
    pub modes: Vec<String>,
    /// A command and its arguments to call before the keys, for commands
    /// that read the minibuffer, which batch Emacs reads from stdin.
    #[serde(default)]
    pub call: Vec<String>,
    /// The Emacs `system-type` the case holds on, if only one.
    pub platform: Option<String>,
}

#[derive(Deserialize)]
pub struct Golden {
    pub emacs_version: String,
    /// The Emacs `system-type` the golden file was recorded on.
    pub system_type: String,
    pub cases: Vec<Recorded>,
}

#[derive(Deserialize)]
pub struct Recorded {
    pub name: String,
    pub input: Input,
    #[serde(flatten)]
    pub state: State,
}

#[derive(Deserialize, PartialEq)]
pub struct Input {
    pub text: String,
    pub point: usize,
    pub keys: String,
    #[serde(default)]
    pub modes: Vec<String>,
    #[serde(default)]
    pub call: Vec<String>,
    pub platform: Option<String>,
}

/// What a case leaves behind, as both editors report it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct State {
    pub text: String,
    /// The text without what is invisible, once fontified.
    pub visible: String,
    pub point: usize,
    pub mark: Option<usize>,
    pub mark_active: bool,
    /// Newest first, as Emacs lists it.
    pub kill_ring: Vec<String>,
    pub modified: bool,
    pub error: Option<String>,
}

/// This platform as Emacs's `system-type` names it.
pub fn system_type() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows-nt"
    } else {
        "gnu/linux"
    }
}

pub fn oracle_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs")
}

/// Runs a case through Ember the way record.el runs it through Emacs.
pub fn run(case: &Case) -> State {
    let mut ed = Editor::new();
    let _scripting = Scripting::new(&mut ed).expect("scripting starts");
    let b = ed.window_buffer_mut();
    // record.el's buffer, which some messages name.
    b.name = "*ember-oracle*".into();
    b.set_text(&case.text);
    b.set_point(case.point);
    for mode in &case.modes {
        ed.call_with_prefix(mode, Vec::new(), Some(PrefixArg::Number(1)))
            .unwrap_or_else(|e| panic!("{}: turning on {mode}: {e}", case.name));
    }
    // Fontified as redisplay would before the keys; record.el does the same.
    ed.font_lock_ensure().unwrap_or_else(|e| panic!("{}: fontifying: {e}", case.name));
    let keys = Key::parse_seq(&case.keys)
        .unwrap_or_else(|| panic!("{}: keys {:?} are not valid Emacs notation", case.name, case.keys));
    let mut error = None;
    if let Some((name, args)) = case.call.split_first() {
        let args = args.iter().map(|a| ember_core::Arg::Str(a.clone())).collect();
        if let Err(e) = ed.call(name, args) {
            error = Some(e.to_string());
        }
    }
    for key in keys {
        ed.handle_key(key);
        if let Some(e) = ed.take_error() {
            error.get_or_insert(e.to_string());
        }
        // record.el makes reading the minibuffer an error, as batch Emacs
        // would read it from standard input; do the same here.
        if ed.prompt().is_some() {
            ed.handle_key(Key::parse("C-g").expect("C-g parses"));
            ed.take_error();
            error.get_or_insert("Minibuffer read in batch".into());
        }
    }
    ed.font_lock_ensure().unwrap_or_else(|e| panic!("{}: fontifying: {e}", case.name));
    let b = ed.window_buffer();
    let visible = (0..b.len()).filter(|&p| ed.invisible_in(b, p).is_none()).filter_map(|p| b.char_at(p)).collect();
    State {
        text: b.slice(0..b.len()),
        visible,
        point: b.point(),
        mark: b.mark(),
        mark_active: b.is_mark_active(),
        kill_ring: ed.kill_ring().iter().rev().cloned().collect(),
        modified: b.is_modified(),
        error,
    }
}

/// The fields where Ember differs from Emacs, one per line.
pub fn differences(emacs: &State, ember: &State) -> String {
    let mut out = Vec::new();
    macro_rules! compare {
        ($($field:ident),*) => {$(
            if emacs.$field != ember.$field {
                out.push(format!(
                    "    {}: Emacs {:?}, Ember {:?}",
                    stringify!($field), emacs.$field, ember.$field
                ));
            }
        )*};
    }
    compare!(text, visible, point, mark, mark_active, kill_ring, modified, error);
    out.join("\n")
}


fn is_zero(n: &usize) -> bool {
    *n == 0
}
