//! Variables and hooks, as Emacs has them: each variable is documented and
//! has a global value, and a buffer can have its own value. A hook is a
//! named list of functions that the editor runs at a particular moment.

use std::fmt;
use std::rc::Rc;

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::Result;

/// A variable's value. These are the values scripts can hold too.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    List(Vec<Value>),
}

impl Value {
    /// Whether the value counts as true: anything but null and false, as
    /// anything but nil counts as true in Emacs.
    pub fn is_true(&self) -> bool {
        !matches!(self, Value::Null | Value::Bool(false))
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
}

impl fmt::Display for Value {
    /// As a script would write it: `null`, `true`, `8`, `"text"`, `["a", 1]`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Null => f.write_str("null"),
            Value::Bool(b) => write!(f, "{b}"),
            Value::Number(n) if n.fract() == 0.0 && n.abs() < 1e15 => write!(f, "{}", *n as i64),
            Value::Number(n) => write!(f, "{n}"),
            Value::Str(s) => write!(f, "{s:?}"),
            Value::List(items) => {
                f.write_str("[")?;
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        f.write_str(", ")?;
                    }
                    write!(f, "{item}")?;
                }
                f.write_str("]")
            }
        }
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}

impl From<f64> for Value {
    fn from(n: f64) -> Value {
        Value::Number(n)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::Str(s.to_string())
    }
}

/// A documented variable.
#[derive(Clone, Debug)]
pub struct Variable {
    pub name: String,
    pub doc: String,
    /// The global value, which buffers without their own value see.
    pub default: Value,
    /// Whether setting it always gives the current buffer its own value,
    /// as with Emacs's `defvar-local`.
    pub local: bool,
    /// Whether it is a hook, whose value is its functions.
    pub hook: bool,
    /// Whether a buffer keeps its own value when its major mode changes, as
    /// Emacs's `permanent-local` property says.
    pub permanent: bool,
    /// Where it was defined, such as a script file. `None` for built-in variables.
    pub source: Option<String>,
}

impl Variable {
    pub fn new(name: &str, doc: &str, default: impl Into<Value>) -> Variable {
        Variable {
            name: name.to_string(),
            doc: doc.to_string(),
            default: default.into(),
            local: false,
            hook: false,
            permanent: false,
            source: None,
        }
    }

    /// Makes buffers keep their own values when their major mode changes.
    pub fn permanent(mut self) -> Variable {
        self.permanent = true;
        self
    }

    /// Makes the variable automatically buffer-local.
    pub fn local(mut self) -> Variable {
        self.local = true;
        self
    }
}

/// A hook function, called with the hook's arguments, if it has any.
pub type HookFn = Rc<dyn Fn(&mut Editor, &[Value]) -> Result<()>>;

#[derive(Clone)]
pub(crate) struct HookEntry {
    id: u64,
    /// What `describe-variable` shows for the function.
    name: String,
    run: HookFn,
}

impl Editor {
    /// Defines a variable, as Emacs's `defvar` does: if it already has a
    /// value, that value is kept, and only the documentation changes.
    pub fn define_variable(&mut self, var: Variable) {
        match self.variables.get_mut(&var.name) {
            Some(existing) => {
                existing.doc = var.doc;
                existing.local = var.local;
                existing.hook |= var.hook;
                if var.source.is_some() {
                    existing.source = var.source;
                }
            }
            None => {
                self.variables.insert(var.name.clone(), var);
            }
        }
    }

    pub fn variable_definition(&self, name: &str) -> Option<&Variable> {
        self.variables.get(name)
    }

    /// All variables, hooks included, sorted by name.
    pub fn variables(&self) -> impl Iterator<Item = &Variable> {
        self.variables.values()
    }

    /// A variable's value in the current buffer: the buffer's own value if
    /// it has one, otherwise the global value. A hook's value is the names
    /// of its functions.
    pub fn variable(&self, name: &str) -> Option<Value> {
        self.variable_in(self.buffer(), name)
    }

    /// A variable's value as a given buffer sees it.
    pub fn variable_in(&self, b: &Buffer, name: &str) -> Option<Value> {
        if let Some(value) = b.locals.get(name) {
            return Some(value.clone());
        }
        let var = self.variables.get(name)?;
        if var.hook {
            let names = self.hook_function_names_in(b, name);
            return Some(Value::List(names.into_iter().map(Value::Str).collect()));
        }
        Some(var.default.clone())
    }

    /// A number variable in a buffer, or `default` if it is unset or not a number.
    pub fn number_in(&self, b: &Buffer, name: &str, default: f64) -> f64 {
        self.variable_in(b, name).and_then(|v| v.as_number()).unwrap_or(default)
    }

    /// Sets a variable as Emacs's `setq` does: the current buffer's own value
    /// if it has one or the variable is automatically buffer-local,
    /// otherwise the global value. Setting an unknown variable defines it.
    pub fn set_variable(&mut self, name: &str, value: Value) {
        let local = self.variables.get(name).is_some_and(|v| v.local);
        let b = self.buffer_mut();
        if local || b.locals.contains_key(name) {
            b.locals.insert(name.to_string(), value);
        } else {
            self.set_default(name, value);
        }
    }

    /// Sets the global value, which buffers without their own value see.
    pub fn set_default(&mut self, name: &str, value: Value) {
        match self.variables.get_mut(name) {
            Some(var) => var.default = value,
            None => {
                self.variables.insert(name.to_string(), Variable::new(name, "", value));
            }
        }
    }

    pub fn default_value(&self, name: &str) -> Option<Value> {
        self.variables.get(name).map(|v| v.default.clone())
    }

    /// Gives the current buffer its own value of a variable, starting from
    /// the value it sees now, as Emacs's `make-local-variable` does.
    pub fn make_local_variable(&mut self, name: &str) {
        let value = self.variable(name).unwrap_or(Value::Null);
        self.buffer_mut().locals.entry(name.to_string()).or_insert(value);
    }

    /// Removes the current buffer's own value, so it sees the global one again.
    pub fn kill_local_variable(&mut self, name: &str) {
        self.buffer_mut().locals.remove(name);
    }

    pub fn is_local_variable(&self, name: &str) -> bool {
        self.buffer().locals.contains_key(name)
    }

    /// Removes all of the current buffer's own values, local hooks and
    /// local keymap, as a new major mode does first. Runs
    /// `change-major-mode-hook` beforehand, as Emacs does.
    pub fn kill_all_local_variables(&mut self) -> Result<()> {
        let result = self.run_hooks("change-major-mode-hook");
        let permanent: Vec<String> = self.variables.values().filter(|v| v.permanent).map(|v| v.name.clone()).collect();
        let b = self.buffer_mut();
        b.locals.retain(|name, _| permanent.contains(name));
        b.forget_shift_selection();
        b.local_hooks.clear();
        b.local_map.clear();
        b.syntax = None;
        b.fontified.clear();
        result
    }

    // Hooks

    /// Defines a hook: a documented variable whose value is its functions.
    pub fn define_hook(&mut self, name: &str, doc: &str) {
        let mut var = Variable::new(name, doc, Value::List(Vec::new()));
        var.hook = true;
        self.define_variable(var);
    }

    /// Adds a function to a hook, first in line, as Emacs's `add-hook` adds.
    /// With `local`, only for the current buffer. Returns an id for
    /// [`Editor::remove_hook`].
    pub fn add_hook(&mut self, hook: &str, name: &str, run: HookFn, local: bool) -> u64 {
        self.next_hook_id += 1;
        let entry = HookEntry { id: self.next_hook_id, name: name.to_string(), run };
        let list = if local {
            self.buffer_mut().local_hooks.entry(hook.to_string()).or_default()
        } else {
            self.hooks.entry(hook.to_string()).or_default()
        };
        list.insert(0, entry);
        self.next_hook_id
    }

    /// Whether the function added with `id` is still on a hook: a buffer's
    /// local hooks go when its major mode changes, and the minibuffer's
    /// when a prompt opens.
    pub fn hook_contains(&self, hook: &str, id: u64, local: bool) -> bool {
        let list = if local { self.buffer().local_hooks.get(hook) } else { self.hooks.get(hook) };
        list.is_some_and(|list| list.iter().any(|entry| entry.id == id))
    }

    pub fn remove_hook(&mut self, hook: &str, id: u64, local: bool) {
        let list = if local {
            self.buffer_mut().local_hooks.get_mut(hook)
        } else {
            self.hooks.get_mut(hook)
        };
        if let Some(list) = list {
            list.retain(|entry| entry.id != id);
        }
    }

    /// Runs a hook's functions: the current buffer's own first, then the
    /// global ones. The first error stops it.
    pub fn run_hooks(&mut self, hook: &str) -> Result<()> {
        self.run_hook_with_args(hook, &[])
    }

    /// Whether a hook has any functions for the current buffer.
    pub(crate) fn hook_has_functions(&self, hook: &str) -> bool {
        self.buffer().local_hooks.get(hook).is_some_and(|l| !l.is_empty()) || self.hooks.get(hook).is_some_and(|l| !l.is_empty())
    }

    /// Runs a hook's functions with arguments, as Emacs's `run-hook-with-args`.
    pub fn run_hook_with_args(&mut self, hook: &str, args: &[Value]) -> Result<()> {
        let b = self.buffer();
        let functions: Vec<HookFn> = b
            .local_hooks
            .get(hook)
            .into_iter()
            .chain(self.hooks.get(hook))
            .flatten()
            .map(|entry| entry.run.clone())
            .collect();
        for run in functions {
            run(self, args)?;
        }
        Ok(())
    }

    fn hook_function_names_in(&self, b: &Buffer, hook: &str) -> Vec<String> {
        b.local_hooks
            .get(hook)
            .into_iter()
            .chain(self.hooks.get(hook))
            .flatten()
            .map(|entry| entry.name.clone())
            .collect()
    }
}

/// The variables and hooks the core itself uses.
pub(crate) fn install(ed: &mut Editor) {
    for var in [
        Variable::new(
            "major-mode",
            "The current buffer's major mode, as the name of the command that turns it on.",
            "fundamental-mode",
        )
        .local(),
        Variable::new("mode-name", "The current buffer's major mode as the mode line shows it.", "Fundamental")
            .local(),
        Variable::new("tab-width", "How many columns apart tab stops are, for showing tab characters.", 8.0)
            .local(),
        Variable::new(
            "indent-tabs-mode",
            "Whether indenting uses tabs as well as spaces, a tab for every tab-width columns.",
            true,
        )
        .local(),
        Variable::new(
            "delete-active-region",
            "Whether DEL and <delete> delete the active region rather than one character.\n\nIf the value is \"kill\", they kill the region instead, so it can be yanked back.",
            true,
        ),
        Variable::new(
            "buffer-invisibility-spec",
            "Which text the invisible property hides.\n\nIf true, any text whose invisible property is true is hidden. If a list, text is hidden when its invisible property names an entry: \"name\", or [\"name\", true] to show \"...\" in its place.",
            true,
        )
        .local(),
        Variable::new(
            "frame-background-mode",
            "Whether the terminal's background is \"dark\" or \"light\", for choosing face colours there. The graphical front end follows the system instead.",
            "dark",
        ),
        Variable::new(
            "overwrite-mode",
            "Whether typed characters replace the text after point rather than being inserted.\n\nThe command overwrite-mode, on <insert>, turns it on and off.",
            false,
        )
        .local(),
        Variable::new(
            "truncate-lines",
            "Whether long lines are cut off at the window's edge rather than continued on the next screen line.\n\nWhen on, the window scrolls sideways to keep point in view. The command toggle-truncate-lines changes it.",
            false,
        )
        .local(),
        Variable::new(
            "completion-styles",
            "How minibuffer input matches what it completes to, as a list of styles tried in order until one matches.\n\n\
             basic matches names that start with the input. partial-completion matches each word of the input, \
             up to a -, _, / or ., against the start of a word in turn, so f-f matches find-file. substring \
             matches names containing the input, and flex names containing its characters in order.",
            Value::List(["basic", "partial-completion", "emacs22"].map(|s| Value::Str(s.into())).to_vec()),
        ),
        Variable::new("history-length", "How many earlier answers each minibuffer history keeps.", 100.0),
        Variable::new(
            "completion-category-defaults",
            "The completion styles kinds of completion try before completion-styles, as [category, styles] pairs: buffer names match by substring too, and a project's files only by substring.",
            Value::List(vec![
                Value::List(vec![Value::Str("buffer".into()), Value::List(vec![Value::Str("basic".into()), Value::Str("substring".into())])]),
                Value::List(vec![Value::Str("project-file".into()), Value::List(vec![Value::Str("substring".into())])]),
            ]),
        ),
        Variable::new(
            "completion-category-overrides",
            "Completion styles for kinds of completion, as completion-category-defaults has them, that win over those.",
            Value::List(Vec::new()),
        ),
        Variable::new("completion-ignore-case", "Whether minibuffer completion ignores the case of letters.", false),
        Variable::new(
            "delete-by-moving-to-trash",
            "Whether deleting files and directories moves them to the system's trash, from where they can be put back. Ember turns it on, where Emacs leaves it off.",
            true,
        ),
        Variable::new(
            "user-emacs-directory",
            "The directory Ember's configuration and its saved state are in, such as recentf's list of recent files: ~/.config/ember unless EMBER_CONFIG_DIR or XDG_CONFIG_HOME say otherwise. Nil when there is none, as in tests.",
            Value::Bool(false),
        ),
        Variable::new(
            "default-directory",
            "Where the buffer looks up relative file names, as a directory name ending in /. Nil means the directory of its file, or else the directory Ember started in. Dired sets it to the directory it lists.",
            Value::Bool(false),
        ),
        Variable::new(
            "read-file-name-completion-ignore-case",
            "Whether completing file names ignores the case of letters: on where the file system does, as on macOS and Windows.",
            cfg!(any(target_os = "macos", target_os = "windows")),
        ),
        Variable::new("read-buffer-completion-ignore-case", "Whether completing buffer names ignores the case of letters.", false),
        Variable::new(
            "completion-ignored-extensions",
            "Endings of file names that completion lists leave out, such as icomplete's: compiled files, backups, and version control directories.",
            Value::List(
                [
                    ".o", "~", ".bin", ".lbin", ".so", ".a", ".ln", ".blg", ".bbl", ".elc", ".lof", ".glo", ".idx", ".lot",
                    ".svn/", ".hg/", ".git/", ".bzr/", "CVS/", "_darcs/", "_MTN/", ".fmt", ".tfm", ".class", ".fas", ".lib",
                    ".mem", ".x86f", ".sparcf", ".dfsl", ".pfsl", ".d64fsl", ".p64fsl", ".lx64fsl", ".lx32fsl", ".dx64fsl",
                    ".dx32fsl", ".fx64fsl", ".fx32fsl", ".sx64fsl", ".sx32fsl", ".wx64fsl", ".wx32fsl", ".fasl", ".ufsl",
                    ".fsl", ".dxl", ".lo", ".la", ".gmo", ".mo", ".toc", ".aux", ".cp", ".fn", ".ky", ".pg", ".tp", ".vr",
                    ".cps", ".fns", ".kys", ".pgs", ".tps", ".vrs", ".pyc", ".pyo",
                ]
                .map(|s| Value::Str(s.into()))
                .to_vec(),
            ),
        ),
        Variable::new(
            "max-mini-window-height",
            "The most the echo area grows to for a long minibuffer, such as a vertical list of completions: a fraction of the frame's height, or a number of lines.",
            0.25,
        ),
        Variable::new(
            "resize-mini-windows",
            "How the echo area fits what the minibuffer shows: grow-only grows it as needed until the prompt closes, and t also shrinks it.",
            Value::Str("grow-only".into()),
        ),
        Variable::new("minibuffer-history", "Earlier answers to minibuffer prompts for text, newest first.", Value::List(Vec::new())),
        Variable::new("extended-command-history", "Commands run with M-x, newest first.", Value::List(Vec::new())),
        Variable::new("file-name-history", "File names answered in the minibuffer, newest first.", Value::List(Vec::new())),
        Variable::new("buffer-name-history", "Buffer names answered in the minibuffer, newest first.", Value::List(Vec::new())),
        Variable::new("variable-name-history", "Variable names answered in the minibuffer, newest first.", Value::List(Vec::new())),
        Variable::new("face-name-history", "Face names answered in the minibuffer, newest first.", Value::List(Vec::new())),
        Variable::new(
            "case-fold-search",
            "Whether searches match upper and lower case letters to each other.",
            true,
        )
        .local(),
        Variable::new(
            "search-upper-case",
            "Whether an upper case letter in a search string typed interactively makes that search match case exactly.",
            true,
        ),
        Variable::new(
            "line-move-visual",
            "Whether C-n and C-p move by screen lines where long lines are continued, rather than by lines of text.",
            true,
        ),
        Variable::new(
            "word-wrap",
            "Whether continued lines break at spaces and tabs rather than in the middle of a word.\n\nvisual-line-mode turns it on.",
            false,
        )
        .local(),
        Variable::new(
            "buffer-file-coding-system",
            "How the visited file's text is written as bytes: its charset and line ends, such as utf-8-unix or undecided-dos.\n\nVisiting a file sets it to what the file uses, and saving writes it that way.",
            "utf-8-unix",
        )
        .local()
        .permanent(),
        Variable::new(
            "word-constituents",
            "Characters besides letters and digits that are part of words in this buffer, for word motion and killing. It stands in for Emacs's syntax tables: Text mode, and the modes built on it, add the apostrophe.",
            "$%",
        )
        .local(),
        Variable::new(
            "make-backup-files",
            "Whether the first save of a file in a session keeps the old file as a backup, name~ beside it.\n\nFiles in the temporary directory are not backed up.",
            true,
        ),
        Variable::new(
            "backup-by-copying",
            "Whether backups are made by copying the old file, rather than renaming it and writing a new one. Files with more than one hard link are always copied.",
            false,
        ),
        Variable::new(
            "file-precious-flag",
            "Whether saving writes a new file and then renames it over the old one, so a failed save cannot leave the file half written. It breaks hard links.",
            false,
        ),
        Variable::new(
            "auto-save-default",
            "Whether buffers visiting files auto-save, to #name# beside the file.",
            true,
        ),
        Variable::new(
            "auto-save-interval",
            "How many keys typed between auto-saves. 0 turns off auto-saving by keys.",
            300.0,
        ),
        Variable::new(
            "auto-save-timeout",
            "How many seconds idle before auto-saving. 0 turns off auto-saving when idle.",
            30.0,
        ),
        Variable::new(
            "delete-auto-save-files",
            "Whether saving a buffer deletes its auto-save file.",
            true,
        ),
        Variable::new(
            "truncate-partial-width-windows",
            "Windows narrower than this many columns that share the frame's width with others truncate lines, whatever truncate-lines says.\n\nSet it to 0 to let narrow windows continue lines too.",
            50.0,
        ),
    ] {
        ed.define_variable(var);
    }
    for (name, doc) in [
        ("pre-command-hook", "Run before each command that keys run. A function can change this-command, and that command runs instead."),
        ("post-command-hook", "Run after each command that keys run."),
        ("minibuffer-setup-hook", "Run when a prompt opens, in the minibuffer."),
        ("minibuffer-exit-hook", "Run when a prompt closes, in the minibuffer, before the answer is used."),
        (
            "jit-lock-functions",
            "Called with a start and an end to fontify that stretch of whole lines, just before it is shown. A major mode adds its function here, buffer-locally, and the function puts face and other properties on the text. Editing a line refontifies it and everything after it.",
        ),
        (
            "after-change-functions",
            "Called after each change to the text with where the new text starts and ends and how long the old text was: an insertion has an old length of 0, a deletion starts and ends where the text went. Changes the functions make do not call them again.",
        ),
        ("find-file-hook", "Run after visiting a file, once its major mode is chosen."),
        ("kill-buffer-hook", "Run in a buffer just before it is killed."),
        ("kill-emacs-hook", "Run when Ember exits, as C-x C-c does."),
        ("before-save-hook", "Run before saving a buffer to its file."),
        ("after-save-hook", "Run after saving a buffer to its file."),
        ("change-major-mode-hook", "Run before a major mode clears the buffer's own variables."),
        ("after-change-major-mode-hook", "Run after a major mode and its hooks have run."),
    ] {
        ed.define_hook(name, doc);
    }
}
