use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::buffer::Buffer;
use crate::command::{Arg, Command, ParamKind};
use crate::commands;
use crate::error::{Error, Result};
use crate::files::{abbreviate_dir, expand_file_name};
use crate::key::{Key, KeyCode, MouseKind, format_keys};
use crate::keymap::{Keymap, Lookup};
use crate::faces::{self, Face};
use crate::modes::{MinorMode, NamedKeymap};
use crate::variables::{self, HookEntry, Value, Variable};
use crate::prefix::{PrefixArg, prefix_numeric_value};

/// A minibuffer prompt waiting for the user to type an argument.
pub(crate) struct Prompt {
    pub(crate) text: String,
    pub(crate) kind: ParamKind,
    /// The variable with earlier answers.
    pub(crate) history: String,
    /// How far back in the history M-p has gone: 0 for the input typed.
    pub(crate) history_pos: usize,
    /// The input typed, kept while M-p shows history.
    pub(crate) typed: String,
}

/// A command as it last ran, so it can be repeated (Emacs's
/// `last-repeatable-command`, with the arguments and key it ran with).
#[derive(Clone)]
struct Repeatable {
    command: Rc<Command>,
    args: Vec<Arg>,
    prefix: Option<PrefixArg>,
    key: Option<Key>,
}

/// Commands that Emacs groups into one undo step when repeated (those that
/// call `undo-auto-amalgamate`).
const AMALGAMATING: &[&str] = &["self-insert-command", "delete-char", "delete-backward-char"];

/// How many times a keyboard macro run "until an error" may repeat before
/// it is stopped, in case nothing ever fails.
const MACRO_REPEAT_LIMIT: usize = 100_000;

/// A command whose arguments are still being read.
struct PendingCall {
    command: Rc<Command>,
    args: Vec<Arg>,
    /// The prefix argument the command was started with, kept for when it runs.
    prefix: Option<PrefixArg>,
}

/// All editor state. A front end feeds it keys with [`Editor::handle_key`]
/// and reads it back to draw.
pub struct Editor {
    pub(crate) buffers: Vec<Buffer>,
    pub(crate) current: usize,
    /// How many commands are running, one inside another.
    running: usize,
    /// The command keys named, while the command it is remapped to runs.
    remapped_from: Option<String>,
    previous_buffer: Option<String>,
    pub(crate) minibuffer: Buffer,
    pub(crate) prompt: Option<Prompt>,
    pending_call: Option<PendingCall>,
    /// Keys read so far for a command parameter of kind [`ParamKind::Keys`].
    reading_keys: Option<Vec<Key>>,
    /// Keys typed so far of a multi-key binding such as `C-x C-f`.
    pending_keys: Vec<Key>,
    esc_prefix: bool,
    /// Whether the key that ran the current command had Shift removed to find
    /// its binding. Shift selection uses it.
    shift_translated: bool,
    commands: BTreeMap<String, Rc<Command>>,
    pub global_map: Keymap,
    pub minibuffer_map: Keymap,
    /// Bindings for the next key sequence only, ahead of every other keymap.
    transient_map: Option<Keymap>,
    /// A named keymap ahead of all but the transient map, while set.
    pub(crate) overriding_map: Option<String>,
    /// Keys to read next, after the current one, as Emacs's `unread-command-events`.
    unread_keys: std::collections::VecDeque<Key>,
    reading_unread: bool,
    /// Keymaps with names, such as a major mode's, that buffers and modes use.
    pub(crate) keymaps: BTreeMap<String, NamedKeymap>,
    /// Most recently registered first, which is the order keys are looked up in.
    pub(crate) minor_modes: Vec<MinorMode>,
    pub(crate) variables: BTreeMap<String, Variable>,
    pub(crate) faces: BTreeMap<String, Face>,
    pub(crate) grammars: BTreeMap<&'static str, crate::syntax::Grammar>,
    /// Global hook functions by hook name.
    pub(crate) hooks: BTreeMap<String, Vec<HookEntry>>,
    pub(crate) next_hook_id: u64,
    /// Whether the running command was started by keys or M-x rather than
    /// called from code (Emacs's `called-interactively-p`).
    interactive: bool,
    /// The prefix argument for the next command, as prefix commands leave it
    /// (Emacs's `prefix-arg`).
    prefix_arg: Option<PrefixArg>,
    /// The prefix argument of the command that is running (Emacs's
    /// `current-prefix-arg`).
    current_prefix_arg: Option<PrefixArg>,
    pub(crate) message: Option<String>,
    /// The error from the last interactive command that failed, until taken.
    last_error: Option<Error>,
    /// Whether the command the command loop is running failed.
    command_failed: bool,
    /// Whether code set this-command explicitly, so a call from code keeps it.
    this_command_set: bool,
    /// Whether `after-change-functions` are running.
    in_change_hooks: bool,
    pub(crate) kill_ring: Vec<String>,
    /// Which kill yanking takes next, counting back from the newest (Emacs's
    /// `kill-ring-yank-pointer`).
    yank_pointer: usize,
    last_repeatable: Option<Repeatable>,
    /// Counts recorded repeatable commands, so that when one command runs
    /// another, as M-x does, the innermost is the one repeated.
    repeatable_count: u64,
    /// The keys typed so far while defining a keyboard macro.
    defining_macro: Option<Vec<Key>>,
    /// Where in the macro the key sequence being typed began, so ending the
    /// macro can leave out the keys that ended it.
    macro_sequence_start: usize,
    last_macro: Option<Vec<Key>>,
    /// How many keyboard macros are running, one inside another.
    executing_macro: usize,
    last_command: Option<String>,
    this_command: Option<String>,
    pub(crate) last_key: Option<Key>,
    /// How many lines the last wheel event scrolls, like the data an Emacs
    /// wheel event carries. Set by [`Editor::wheel`].
    pub(crate) wheel_lines: usize,
    /// Where the last mouse event happened, for the commands bound to it.
    pub(crate) last_mouse: Option<crate::window::MouseEvent>,
    /// The last successful search's match, as Emacs's match data.
    pub(crate) match_data: Option<crate::search::Match>,
    pub(crate) goal_column: Option<usize>,
    self_insert_run: usize,
    pub(crate) windows: Vec<crate::window::Window>,
    pub(crate) window_tree: crate::window::WindowTree,
    pub(crate) selected_window: crate::window::WindowId,
    pub(crate) next_window_id: crate::window::WindowId,
    /// Counts window selections, to find the most recently used window.
    pub(crate) window_use: u64,
    pub(crate) quit: bool,
}

impl Default for Editor {
    fn default() -> Editor {
        Editor::new()
    }
}

impl Editor {
    /// An editor with a `*scratch*` buffer and the built-in commands and bindings.
    pub fn new() -> Editor {
        let mut editor = Editor {
            buffers: vec![Buffer::new("*scratch*")],
            current: 0,
            running: 0,
            remapped_from: None,
            previous_buffer: None,
            minibuffer: Buffer::new(" *Minibuf*"),
            prompt: None,
            pending_call: None,
            reading_keys: None,
            pending_keys: Vec::new(),
            esc_prefix: false,
            shift_translated: false,
            commands: BTreeMap::new(),
            global_map: Keymap::default(),
            minibuffer_map: Keymap::default(),
            transient_map: None,
            keymaps: BTreeMap::new(),
            minor_modes: Vec::new(),
            variables: BTreeMap::new(),
            faces: BTreeMap::new(),
            grammars: crate::syntax::builtin_grammars().into_iter().collect(),
            hooks: BTreeMap::new(),
            next_hook_id: 0,
            interactive: false,
            prefix_arg: None,
            current_prefix_arg: None,
            message: None,
            last_error: None,
            command_failed: false,
            this_command_set: false,
            in_change_hooks: false,
            kill_ring: Vec::new(),
            yank_pointer: 0,
            last_repeatable: None,
            repeatable_count: 0,
            defining_macro: None,
            macro_sequence_start: 0,
            last_macro: None,
            executing_macro: 0,
            last_command: None,
            this_command: None,
            last_key: None,
            wheel_lines: 1,
            last_mouse: None,
            match_data: None,
            overriding_map: None,
            unread_keys: Default::default(),
            reading_unread: false,
            goal_column: None,
            self_insert_run: 0,
            windows: Vec::new(),
            window_tree: crate::window::WindowTree::Leaf(1),
            selected_window: 1,
            next_window_id: 1,
            window_use: 0,
            quit: false,
        };
        editor.windows.push(crate::window::Window {
            id: 1,
            buffer: editor.buffers[0].id,
            top_line: 0,
            width: 80,
            height: 24,
            used: 0,
        });
        variables::install(&mut editor);
        faces::install(&mut editor);
        commands::install(&mut editor);
        editor
    }

    // Commands

    /// Adds a command, replacing any existing command with the same name.
    pub fn define_command(&mut self, command: Command) {
        self.commands.insert(command.name.clone(), Rc::new(command));
    }

    pub fn command(&self, name: &str) -> Option<Rc<Command>> {
        self.commands.get(name).cloned()
    }

    /// All commands, sorted by name.
    pub fn commands(&self) -> impl Iterator<Item = &Command> {
        self.commands.values().map(|c| c.as_ref())
    }

    pub fn command_names(&self) -> impl Iterator<Item = &str> {
        self.commands.keys().map(String::as_str)
    }

    /// The command that ran before the one running now.
    pub fn last_command(&self) -> Option<&str> {
        self.last_command.as_deref()
    }

    /// Runs a command with its arguments supplied directly instead of
    /// prompting for them. This is how code, scripts and tool calls invoke
    /// commands; errors are returned rather than shown.
    pub fn call(&mut self, name: &str, args: Vec<Arg>) -> Result<()> {
        self.call_with_prefix(name, args, None)
    }

    /// Like [`Editor::call`], with a prefix argument, as if typed after C-u or M-5.
    pub fn call_with_prefix(&mut self, name: &str, args: Vec<Arg>, prefix: Option<PrefixArg>) -> Result<()> {
        let command = self
            .command(name)
            .ok_or_else(|| Error::new(format!("No such command: {name}")))?;
        if args.len() != command.params.len() {
            return Err(Error::new(format!(
                "{name} takes {} arguments, got {}",
                command.params.len(),
                args.len()
            )));
        }
        // A call from outside is an undo step of its own; one from a running
        // command is part of that command's, as a Lisp function call is.
        if self.running == 0 {
            self.buffer_mut().undo_boundary();
        }
        let saved = std::mem::replace(&mut self.current_prefix_arg, prefix);
        let interactive = std::mem::replace(&mut self.interactive, false);
        // Unlike a command that keys run, a call from code does not become
        // this-command or last-command, as calling a function from Lisp does
        // not, unless it sets this-command itself, as kill-region does.
        let this = self.this_command.clone();
        let set = std::mem::replace(&mut self.this_command_set, false);
        self.running += 1;
        let result = (command.run)(self, &args);
        self.running -= 1;
        let result = result.and(self.run_after_change_functions());
        self.deactivate_changed_regions(result.is_ok());
        if !self.this_command_set {
            self.this_command = this;
        }
        self.this_command_set |= set;
        self.interactive = interactive;
        self.current_prefix_arg = saved;
        result
    }

    /// Whether the running command was started by keys or M-x rather than
    /// called from code. Commands use it to decide whether to show a message.
    pub fn called_interactively(&self) -> bool {
        self.interactive
    }

    /// The command that is running, or about to run while `pre-command-hook` runs.
    pub fn this_command(&self) -> Option<&str> {
        self.this_command.as_deref()
    }

    // Prefix arguments

    /// The prefix argument of the running command, if it was given one.
    pub fn current_prefix_arg(&self) -> Option<PrefixArg> {
        self.current_prefix_arg
    }

    /// The running command's prefix argument as a count: 1 when there is none.
    pub fn prefix_numeric(&self) -> i64 {
        prefix_numeric_value(self.current_prefix_arg)
    }

    /// Gives the next command a prefix argument, as prefix commands such as
    /// C-u do. A command that leaves one is transparent: it does not become
    /// the last command, so C-k C-u 2 C-k still joins the kills.
    pub fn set_prefix_arg(&mut self, arg: Option<PrefixArg>) {
        self.prefix_arg = arg;
    }

    /// Binds keys for the next key sequence only, ahead of every other
    /// keymap, as Emacs's `set-transient-map` does. Prefix commands use it
    /// so that digits continue the argument.
    pub fn set_transient_map(&mut self, map: Keymap) {
        self.transient_map = Some(map);
    }

    /// Names the running command, for commands that should count as another
    /// one afterwards. Deleting with a prefix argument kills, so it counts
    /// as `kill-region` and the next kill joins onto it.
    pub fn set_this_command(&mut self, name: &str) {
        self.this_command = Some(name.to_string());
        self.this_command_set = true;
    }

    /// The last key typed: the one that ran the current command.
    pub fn last_key(&self) -> Option<Key> {
        self.last_key
    }

    /// Runs a command the way a key binding does: prompting in the minibuffer
    /// for any parameters, and showing errors in the echo area.
    pub fn run_interactive(&mut self, name: &str) {
        let shifted = std::mem::take(&mut self.shift_translated);
        let prefix = self.prefix_arg.take();
        let Some(command) = self.command(name) else {
            self.message = Some(format!("No such command: {name}"));
            return;
        };
        if !command.params.is_empty() && (self.prompt.is_some() || self.reading_keys.is_some()) {
            self.message = Some("Command attempted to use minibuffer while in minibuffer".into());
            return;
        }
        // Runs of typing, or of C-d or DEL, share an undo step, as in Emacs:
        // the first and up to 20 more (amalgamating-undo-limit).
        // A remapped command, such as org's for typing, amalgamates as the
        // command it stands in for.
        let base = self.remapped_from.take();
        let amalgamate = AMALGAMATING.contains(&base.as_deref().unwrap_or(name))
            && self.last_command() == Some(name)
            && self.self_insert_run <= 20;
        self.self_insert_run = if amalgamate { self.self_insert_run + 1 } else { 1 };
        if !amalgamate {
            self.buffer_mut().undo_boundary();
        }
        if command.shift_select {
            self.shift_select(shifted);
        }
        if command.params.is_empty() {
            self.execute(command, Vec::new(), prefix);
        } else {
            self.pending_call = Some(PendingCall { command, args: Vec::new(), prefix });
            self.read_next_arg();
        }
    }

    /// Emacs's shift selection: a movement with Shift starts a region at
    /// point, or keeps extending one Shift started; a movement without Shift
    /// ends a region Shift started.
    fn shift_select(&mut self, shifted: bool) {
        let b = self.buffer_mut();
        if shifted {
            if !b.is_shift_selected() {
                b.start_shift_selection();
            }
        } else if b.is_shift_selected() {
            b.deactivate_mark();
        }
    }

    fn read_next_arg(&mut self) {
        let Some(call) = &self.pending_call else { return };
        if let Some(param) = call.command.params.get(call.args.len()) {
            if param.kind == ParamKind::Keys {
                self.reading_keys = Some(Vec::new());
                self.message = Some(param.prompt.clone());
            } else {
                let initial = self.initial_input(param.kind);
                let history = param.history.clone().unwrap_or_else(|| param.kind.history().to_string());
                self.prompt = Some(Prompt {
                    text: param.prompt.clone(),
                    kind: param.kind,
                    history,
                    history_pos: 0,
                    typed: String::new(),
                });
                self.minibuffer.set_text(&initial);
                self.minibuffer.set_point(self.minibuffer.len());
            }
            return;
        }
        let call = self.pending_call.take().expect("checked above");
        self.execute(call.command, call.args, call.prefix);
    }

    /// Hands the next argument to the command waiting for it.
    pub(crate) fn supply_arg(&mut self, arg: Arg) {
        if let Some(call) = &mut self.pending_call {
            call.args.push(arg);
            self.read_next_arg();
        }
    }

    /// Cancels any prompt and pending command, as `C-g` does.
    pub(crate) fn abort(&mut self) {
        self.prompt = None;
        self.pending_call = None;
        self.reading_keys = None;
        self.pending_keys.clear();
        self.minibuffer.set_text("");
        self.transient_map = None;
        self.prefix_arg = None;
    }

    fn execute(&mut self, command: Rc<Command>, args: Vec<Arg>, prefix: Option<PrefixArg>) {
        if let Err(e) = self.run_command(command, args, prefix) {
            self.message = Some(e.to_string());
            self.last_error = Some(e);
            self.command_failed = true;
        }
    }

    /// Runs a command interactively with its arguments and prefix argument,
    /// and remembers it for `repeat`.
    fn run_command(&mut self, command: Rc<Command>, args: Vec<Arg>, prefix: Option<PrefixArg>) -> Result<()> {
        let saved = std::mem::replace(&mut self.current_prefix_arg, prefix);
        let interactive = std::mem::replace(&mut self.interactive, true);
        let last = self.last_command.clone();
        let key = self.last_key;
        let count = self.repeatable_count;
        let result = self.invoke(command.clone(), args.clone());
        self.interactive = interactive;
        self.current_prefix_arg = saved;
        if self.prefix_arg.is_some() {
            // A prefix command leaves an argument for the next command and stays
            // out of the way, as Emacs's prefix-command-preserve-state does.
            self.last_command = last;
        } else if self.repeatable_count == count && command.name != "repeat" {
            // Only the innermost command is remembered: after M-x forward-char,
            // repeat runs forward-char, not M-x.
            self.last_repeatable = Some(Repeatable { command, args, prefix, key });
            self.repeatable_count += 1;
        }
        result
    }

    /// Runs the last repeatable command again, with the same arguments and
    /// key, and with `prefix` if given or else its own prefix argument.
    pub fn repeat_last_command(&mut self, prefix: Option<PrefixArg>) -> Result<()> {
        let last = self
            .last_repeatable
            .clone()
            .ok_or_else(|| Error::new("There is nothing to repeat"))?;
        self.last_key = last.key;
        self.buffer_mut().undo_boundary();
        self.run_command(last.command, last.args, prefix.or(last.prefix))
    }

    // Keyboard macros

    /// Starts recording keys into a keyboard macro.
    pub fn start_kbd_macro(&mut self) -> Result<()> {
        if self.defining_macro.is_some() {
            return Err(Error::new("Already defining keyboard macro"));
        }
        self.defining_macro = Some(Vec::new());
        self.macro_sequence_start = 0;
        Ok(())
    }

    /// Finishes the keyboard macro being defined. The keys that ended it
    /// are left out.
    pub fn end_kbd_macro(&mut self) -> Result<()> {
        let mut keys = self
            .defining_macro
            .take()
            .ok_or_else(|| Error::new("Not defining kbd macro"))?;
        keys.truncate(self.macro_sequence_start);
        self.last_macro = Some(keys);
        Ok(())
    }

    /// Types the last keyboard macro `count` times, or until an error if
    /// `count` is 0. The first error stops it, as it would stop the macro in
    /// Emacs, and becomes this call's error.
    pub fn call_last_kbd_macro(&mut self, count: i64) -> Result<()> {
        let keys = self
            .last_macro
            .clone()
            .ok_or_else(|| Error::new("No kbd macro has been defined"))?;
        if count < 0 {
            return Err(Error::new("Negative repetition argument"));
        }
        self.executing_macro += 1;
        let result = self.type_keys(&keys, count);
        self.executing_macro -= 1;
        result
    }

    fn type_keys(&mut self, keys: &[Key], count: i64) -> Result<()> {
        let mut done = 0;
        while count == 0 || done < count {
            for &key in keys {
                self.handle_key(key);
                if let Some(e) = self.take_error() {
                    return Err(e);
                }
            }
            done += 1;
            if count == 0 && done as usize >= MACRO_REPEAT_LIMIT {
                return Err(Error::new("Keyboard macro repeated too many times"));
            }
        }
        Ok(())
    }

    pub fn defining_kbd_macro(&self) -> bool {
        self.defining_macro.is_some()
    }

    pub fn executing_kbd_macro(&self) -> bool {
        self.executing_macro > 0
    }

    /// Runs `after-change-functions` for each change to the current buffer
    /// since they last ran, with where the new text starts and ends and how
    /// long the old text was, as Emacs runs them after each change. Changes
    /// the functions make themselves do not run them again, as with Emacs's
    /// `inhibit-modification-hooks`.
    /// An error stops them and is returned, and, as in Emacs, the buffer's
    /// own functions are removed from the hook.
    pub fn run_after_change_functions(&mut self) -> Result<()> {
        if self.in_change_hooks {
            self.buffer_mut().pending_changes.clear();
            return Ok(());
        }
        let changes = std::mem::take(&mut self.buffer_mut().pending_changes);
        if changes.is_empty() || !self.hook_has_functions("after-change-functions") {
            return Ok(());
        }
        self.in_change_hooks = true;
        let mut result = Ok(());
        for (beg, end, old) in changes {
            let args = [Value::Number(beg as f64), Value::Number(end as f64), Value::Number(old as f64)];
            if let Err(e) = self.run_hook_with_args("after-change-functions", &args) {
                self.buffer_mut().local_hooks.remove("after-change-functions");
                result = Err(e);
                break;
            }
        }
        self.buffer_mut().pending_changes.clear();
        self.in_change_hooks = false;
        result
    }

    /// Point's column as Emacs's `current-column` counts it: tabs to tab
    /// stops, wide characters as two, and text hidden without an ellipsis as none.
    pub fn current_column(&self) -> usize {
        let b = self.buffer();
        crate::commands::current_column(self, b, b.point())
    }

    /// Moves point to a column of its line, as Emacs's `move-to-column` does
    /// without forcing, and returns the column reached.
    pub fn move_to_column(&mut self, column: usize) -> usize {
        // What font-lock hides counts, so the line is fontified first, as
        // redisplay would have done.
        let p = self.buffer().point();
        let _ = self.fontify_region(p..p);
        let b = self.buffer();
        let pos = crate::commands::move_to_column_on(self, b, b.line_of(b.point()), column);
        self.buffer_mut().set_point(pos);
        self.current_column()
    }

    /// Takes the error from the last interactive command that failed. An
    /// undefined key is not an error, as in Emacs: it only shows a message.
    pub fn take_error(&mut self) -> Option<Error> {
        self.last_error.take()
    }

    fn invoke(&mut self, command: Rc<Command>, args: Vec<Arg>) -> Result<()> {
        self.this_command = Some(command.name.clone());
        self.this_command_set = false;
        self.running += 1;
        let result = (command.run)(self, &args);
        self.running -= 1;
        let result = result.and(self.run_after_change_functions());
        // A command that ran another command (as M-x does) leaves that one as the last command.
        if let Some(name) = self.this_command.take() {
            self.last_command = Some(name);
        }
        self.deactivate_changed_regions(result.is_ok());
        result
    }

    /// Editing deactivates the region, as in Emacs's transient-mark-mode,
    /// unless the command failed: Emacs's command loop skips deactivating
    /// then, and the next command starts afresh. A command called from code
    /// that fails leaves its changes for the command around it.
    fn deactivate_changed_regions(&mut self, succeeded: bool) {
        if !succeeded && self.running > 0 {
            return;
        }
        for b in self.buffers.iter_mut().chain(std::iter::once(&mut self.minibuffer)) {
            if b.take_changed() && succeeded {
                b.deactivate_mark();
            }
        }
    }

    /// Runs a command for a key, as Emacs's command loop does: first
    /// `pre-command-hook`, which can change this-command, and that command
    /// runs instead; then `post-command-hook`.
    fn command_loop_run(&mut self, name: &str) {
        self.this_command = Some(name.to_string());
        if let Err(e) = self.run_hooks("pre-command-hook") {
            self.message = Some(format!("Error in pre-command-hook: {e}"));
        }
        let mut name = self.this_command.take().unwrap_or_else(|| name.to_string());
        if let Some(to) = self.command_remapping(&name) {
            self.remapped_from = Some(std::mem::replace(&mut name, to));
        }
        let (old_point, old_buffer, old_tick) = (self.buffer().point(), self.buffer().id, self.buffer().modified_tick());
        self.command_failed = false;
        self.run_interactive(&name);
        self.this_command = self.last_command.clone();
        if let Err(e) = self.run_hooks("post-command-hook") {
            self.message = Some(format!("Error in post-command-hook: {e}"));
        }
        self.this_command = None;
        // As in Emacs's command loop, point is adjusted after post-command-hook
        // has run, and not at all after an error.
        let modified = self.buffer().id != old_buffer || self.buffer().modified_tick() != old_tick;
        if !self.command_failed {
            self.adjust_point_for_invisible(old_point, modified);
        }
    }

    // Keys

    /// Handles one key press: runs the command it completes, waits for more
    /// keys after a prefix, or inserts it if it is a plain unbound character.
    pub fn handle_key(&mut self, key: Key) {
        // While a keyboard macro is being defined, record the keys typed.
        if self.executing_macro == 0
            && let Some(keys) = &mut self.defining_macro
        {
            let starts_sequence =
                self.pending_keys.is_empty() && !self.esc_prefix && self.reading_keys.is_none();
            if starts_sequence {
                self.macro_sequence_start = keys.len();
            }
            keys.push(key);
        }
        self.dispatch_key(key);
        // Keys a command gave back are read next, but not recorded again.
        if !self.reading_unread {
            self.reading_unread = true;
            while let Some(key) = self.unread_keys.pop_front() {
                self.dispatch_key(key);
            }
            self.reading_unread = false;
        }
    }

    /// Makes keys the next ones read, after the command running now, as
    /// pushing onto Emacs's `unread-command-events` does.
    pub fn unread_keys(&mut self, keys: &[Key]) {
        for key in keys.iter().rev() {
            self.unread_keys.push_front(*key);
        }
    }

    fn dispatch_key(&mut self, mut key: Key) {
        if self.esc_prefix {
            self.esc_prefix = false;
            key.meta = true;
        } else if key == Key::new(KeyCode::Esc) {
            self.esc_prefix = true;
            self.message = Some("ESC-".into());
            return;
        }

        if let Some(keys) = &mut self.reading_keys {
            keys.push(key);
            if self.global_map.lookup(keys) == Lookup::Prefix {
                self.message = Some(format!("{}-", format_keys(keys)));
                return;
            }
            let keys = self.reading_keys.take().expect("checked above");
            self.message = None;
            self.supply_arg(Arg::Keys(keys));
            return;
        }

        self.message = None;
        self.pending_keys.push(key);
        match self.lookup(&self.pending_keys) {
            Lookup::Prefix => {
                self.shift_translated = false;
                self.message = Some(format!("{}-", format_keys(&self.pending_keys)));
            }
            Lookup::Command(name) => {
                self.pending_keys.clear();
                self.transient_map = None;
                self.last_key = Some(key);
                self.command_loop_run(&name);
            }
            // Shift translation, as in Emacs: a shifted key with no binding of
            // its own acts as the key without Shift, so S-<right> runs
            // forward-char and Shift selection applies.
            Lookup::Unbound if key.shift => {
                self.pending_keys.pop();
                self.shift_translated = true;
                self.dispatch_key(key.unshifted());
            }
            // As in Emacs, an unbound button press is dropped, and an unbound
            // drag or repeated click acts as a plain click.
            Lookup::Unbound if self.pending_keys.len() == 1 && matches!(key.code, KeyCode::Mouse(..)) => {
                self.pending_keys.clear();
                match key.code {
                    KeyCode::Mouse(MouseKind::Down | MouseKind::Click, _) => {
                        if matches!(key.code, KeyCode::Mouse(MouseKind::Click, _)) {
                            self.message = Some(format!("{key} is undefined"));
                        }
                    }
                    KeyCode::Mouse(_, n) => self.dispatch_key(Key { code: KeyCode::Mouse(MouseKind::Click, n), ..key }),
                    _ => unreachable!(),
                }
            }
            Lookup::Unbound => {
                self.shift_translated = false;
                self.transient_map = None;
                let keys = std::mem::take(&mut self.pending_keys);
                if keys.len() == 1 && key.printable().is_some() {
                    self.last_key = Some(key);
                    self.command_loop_run("self-insert-command");
                } else {
                    self.message = Some(format!("{} is undefined", format_keys(&keys)));
                    // Emacs runs the command `undefined` for the keys, so the
                    // next command does not follow the one before them.
                    self.last_command = Some("undefined".into());
                }
            }
        }
    }

    /// Looks a key sequence up in the active keymaps, in Emacs's order: a
    /// transient map, the minibuffer's map while it is active, the maps of
    /// minor modes that are on, the major mode's map, and the global map.
    /// The first that binds the keys wins.
    pub fn lookup(&self, keys: &[Key]) -> Lookup {
        if let Some(map) = &self.transient_map {
            match map.lookup(keys) {
                Lookup::Unbound => {}
                found => return found,
            }
        }
        if let Some(name) = &self.overriding_map {
            match self.lookup_in(name, keys) {
                Lookup::Unbound => {}
                found => return found,
            }
        }
        if self.prompt.is_some() {
            match self.minibuffer_map.lookup(keys) {
                Lookup::Unbound => {}
                found => return found,
            }
        }
        for map in self.mode_keymaps() {
            match self.lookup_in(&map, keys) {
                Lookup::Unbound => {}
                found => return found,
            }
        }
        self.global_map.lookup(keys)
    }

    /// Feeds a mouse wheel or trackpad scroll of `lines` whole lines: positive
    /// towards the end of the buffer. It arrives as `<wheel-down>` or
    /// `<wheel-up>`, bound to `mwheel-scroll`, so it can be rebound and
    /// described like any key.
    pub fn wheel(&mut self, lines: isize) {
        self.wheel_in(None, lines);
    }

    /// Feeds a wheel scroll over a window, which scrolls that window
    /// whether or not it is selected, as Emacs's `mouse-wheel-follow-mouse`.
    pub fn wheel_in(&mut self, window: Option<crate::window::WindowId>, lines: isize) {
        if lines == 0 {
            return;
        }
        self.last_mouse = window.map(|window| crate::window::MouseEvent { window, position: None, start: None });
        self.wheel_lines = lines.unsigned_abs();
        let code = if lines > 0 { KeyCode::WheelDown } else { KeyCode::WheelUp };
        self.handle_key(Key::new(code));
        self.wheel_lines = 1;
    }

    /// Feeds a key sequence in Emacs notation, such as `C-x C-s`, as if typed.
    pub fn press(&mut self, seq: &str) -> Result<()> {
        let keys = Key::parse_seq(seq)
            .ok_or_else(|| Error::new(format!("Invalid key sequence: {seq}")))?;
        for key in keys {
            self.handle_key(key);
        }
        Ok(())
    }

    /// Types text one character at a time; a newline presses RET and a tab presses TAB.
    pub fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            let key = match c {
                '\n' => Key::new(KeyCode::Enter),
                '\t' => Key::new(KeyCode::Tab),
                c => Key::char(c),
            };
            self.handle_key(key);
        }
    }

    // Buffers

    /// The buffer commands act on: the minibuffer while a prompt is open,
    /// otherwise the buffer shown in the window.
    pub fn buffer(&self) -> &Buffer {
        if self.prompt.is_some() { &self.minibuffer } else { &self.buffers[self.current] }
    }

    pub fn buffer_mut(&mut self) -> &mut Buffer {
        if self.prompt.is_some() {
            &mut self.minibuffer
        } else {
            &mut self.buffers[self.current]
        }
    }

    /// The buffer shown in the window, even while the minibuffer is active.
    pub fn window_buffer(&self) -> &Buffer {
        &self.buffers[self.current]
    }

    pub fn window_buffer_mut(&mut self) -> &mut Buffer {
        &mut self.buffers[self.current]
    }

    pub fn buffers(&self) -> &[Buffer] {
        &self.buffers
    }

    pub fn find_buffer(&self, name: &str) -> Option<usize> {
        self.buffers.iter().position(|b| b.name == name)
    }

    fn select(&mut self, index: usize) {
        if index != self.current {
            self.previous_buffer = Some(self.buffers[self.current].name.clone());
            self.current = index;
            self.selected_window_shows(index);
        }
    }

    /// Shows the named buffer, creating an empty one if there is none.
    pub fn switch_to_buffer(&mut self, name: &str) {
        let index = self.find_buffer(name).unwrap_or_else(|| {
            self.buffers.push(Buffer::new(name));
            self.buffers.len() - 1
        });
        self.select(index);
    }

    /// The buffer to offer when switching buffers: the one shown before this one.
    pub fn other_buffer(&self) -> Option<&str> {
        let current = &self.buffers[self.current].name;
        self.previous_buffer
            .as_deref()
            .filter(|name| self.find_buffer(name).is_some() && *name != current)
            .or_else(|| {
                self.buffers
                    .iter()
                    .map(|b| b.name.as_str())
                    .find(|name| name != current)
            })
    }

    pub fn kill_buffer(&mut self, name: &str) -> Result<()> {
        let index = self
            .find_buffer(name)
            .ok_or_else(|| Error::new(format!("No such buffer: {name}")))?;
        let buffer = &self.buffers[index];
        if buffer.path.is_some() && buffer.is_modified() {
            return Err(Error::new(format!("Buffer {name} is modified; save it first")));
        }
        let showing = index == self.current;
        let next = self.other_buffer().map(str::to_string);
        let current_name = self.buffers[self.current].name.clone();
        let gone = self.buffers.remove(index).id;
        if self.buffers.is_empty() {
            self.buffers.push(Buffer::new("*scratch*"));
        }
        let target = if showing { next.clone() } else { Some(current_name) };
        self.current = target.and_then(|n| self.find_buffer(&n)).unwrap_or(0);
        self.selected_window_shows(self.current);
        // Other windows showing it show what the selected window now does,
        // or the buffer it would switch to.
        let replacement = next.and_then(|n| self.find_buffer(&n)).filter(|_| !showing).unwrap_or(self.current);
        self.replace_buffer_in_windows(gone, replacement);
        Ok(())
    }

    /// Visits a file in a buffer, reusing the buffer if the file is already open.
    pub fn visit_file(&mut self, path: &Path) -> Result<()> {
        if path.is_dir() {
            return Err(Error::new(format!("{} is a directory", path.display())));
        }
        if let Some(index) = self.buffers.iter().position(|b| b.path.as_deref() == Some(path)) {
            self.select(index);
            return Ok(());
        }
        let is_new = !path.exists();
        let mut buffer = Buffer::visit(path)?;
        buffer.name = self.unique_buffer_name(&buffer.name);
        self.buffers.push(buffer);
        self.select(self.buffers.len() - 1);
        if is_new {
            self.message = Some("(New file)".into());
        }
        // As Emacs's after-find-file does: choose the major mode, then run the hook.
        if self.command("normal-mode").is_some()
            && let Err(e) = self.call("normal-mode", Vec::new())
        {
            self.message = Some(format!("File mode specification error: {e}"));
        }
        if let Err(e) = self.run_hooks("find-file-hook") {
            self.message = Some(format!("Error in find-file-hook: {e}"));
        }
        Ok(())
    }

    pub(crate) fn unique_buffer_name(&self, base: &str) -> String {
        if self.find_buffer(base).is_none() {
            return base.to_string();
        }
        (2..)
            .map(|n| format!("{base}<{n}>"))
            .find(|name| self.find_buffer(name).is_none())
            .expect("some name is free")
    }

    /// Shows text in the read-only `*Help*` buffer.
    pub fn show_help(&mut self, text: &str) {
        let index = self.find_buffer("*Help*").unwrap_or_else(|| {
            let mut help = Buffer::new("*Help*");
            help.read_only = true;
            self.buffers.push(help);
            self.buffers.len() - 1
        });
        self.buffers[index].set_text(text);
        self.select(index);
        if self.command("help-mode").is_some() {
            let _ = self.call("help-mode", Vec::new());
        }
    }

    /// Where relative file names are looked up: the directory of the current
    /// file, or the working directory.
    pub fn default_directory(&self) -> PathBuf {
        self.window_buffer()
            .path
            .as_deref()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .or_else(|| env::current_dir().ok())
            .unwrap_or_default()
    }

    // Kill ring

    /// Adds killed text to the kill ring. Kills made by consecutive kill
    /// commands join into one entry, as in Emacs.
    pub(crate) fn kill(&mut self, text: String, prepend: bool) {
        let continuing = self
            .last_command()
            .is_some_and(|c| commands::KILL_COMMANDS.contains(&c));
        self.yank_pointer = 0;
        match self.kill_ring.last_mut() {
            Some(last) if continuing => {
                if prepend {
                    last.insert_str(0, &text);
                } else {
                    last.push_str(&text);
                }
            }
            _ => self.kill_ring.push(text),
        }
    }

    /// The kill `n` entries back from the one yanked last, moving the yank
    /// pointer there, as Emacs's `current-kill` does. 0 is the kill yanking
    /// would insert now; M-y asks for 1, the one before it.
    pub fn current_kill(&mut self, n: i64) -> Result<String> {
        if self.kill_ring.is_empty() {
            return Err(Error::new("Kill ring is empty"));
        }
        let len = self.kill_ring.len() as i64;
        self.yank_pointer = (self.yank_pointer as i64 + n).rem_euclid(len) as usize;
        Ok(self.kill_ring[(len - 1) as usize - self.yank_pointer].clone())
    }

    pub fn kill_ring(&self) -> &[String] {
        &self.kill_ring
    }

    // Minibuffer

    /// The open prompt's text, such as `Find file: `.
    pub fn prompt(&self) -> Option<&str> {
        self.prompt.as_ref().map(|p| p.text.as_str())
    }

    pub fn minibuffer(&self) -> &Buffer {
        &self.minibuffer
    }

    fn initial_input(&self, kind: ParamKind) -> String {
        match kind {
            ParamKind::File => abbreviate_dir(&self.default_directory()),
            _ => String::new(),
        }
    }

    /// Completion candidates for minibuffer input of a given kind, matched
    /// by the styles in `completion-styles`. File names complete by prefix.
    pub fn completions(&self, kind: ParamKind, input: &str) -> Vec<String> {
        let names: Vec<String> = match kind {
            ParamKind::Command => self.command_names().map(str::to_string).collect(),
            ParamKind::Buffer => self.buffers.iter().map(|b| b.name.clone()).collect(),
            ParamKind::File => return file_completions(input),
            ParamKind::Variable => self.variables.keys().cloned().collect(),
            ParamKind::Face => self.faces.keys().cloned().collect(),
            ParamKind::String | ParamKind::Keys => return Vec::new(),
        };
        crate::completion::complete(&self.completion_styles(), input, &names)
    }

    /// The styles in `completion-styles`, in order.
    fn completion_styles(&self) -> Vec<String> {
        match self.variable("completion-styles") {
            Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => vec!["basic".to_string()],
        }
    }

    /// Adds an answer to a history variable, newest first, as the minibuffer
    /// does on RET: not an empty answer or a repeat of the newest, and no
    /// more than `history-length` of them.
    pub(crate) fn add_to_history(&mut self, history: &str, answer: &str) {
        if answer.is_empty() {
            return;
        }
        let mut items = match self.variable(history) {
            Some(Value::List(items)) => items,
            _ => Vec::new(),
        };
        if items.first().and_then(Value::as_str) == Some(answer) {
            return;
        }
        items.insert(0, Value::Str(answer.to_string()));
        let max = self.number_in(self.window_buffer(), "history-length", 100.0).max(1.0) as usize;
        items.truncate(max);
        if self.variables.contains_key(history) {
            self.set_variable(history, Value::List(items));
        } else {
            self.define_variable(Variable::new(history, "Earlier answers to minibuffer prompts, newest first.", Value::List(items)));
        }
    }

    /// Shows an earlier or later answer in the minibuffer: `step` back
    /// through the history if positive, forward if negative.
    pub(crate) fn minibuffer_history(&mut self, step: i64) -> Result<()> {
        let prompt = self.prompt.as_ref().ok_or_else(|| Error::new("Not in the minibuffer"))?;
        let items: Vec<String> = match self.variable(&prompt.history) {
            Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let pos = prompt.history_pos as i64 + step;
        if pos > items.len() as i64 {
            return Err(Error::new("Beginning of history; no preceding item"));
        }
        if pos < 0 {
            return Err(Error::new("End of history; no default available"));
        }
        let input = self.minibuffer.slice(0..self.minibuffer.len());
        let prompt = self.prompt.as_mut().expect("checked above");
        if prompt.history_pos == 0 {
            prompt.typed = input;
        }
        prompt.history_pos = pos as usize;
        let text = if pos == 0 { prompt.typed.clone() } else { items[pos as usize - 1].clone() };
        self.minibuffer.set_text(&text);
        self.minibuffer.set_point(self.minibuffer.len());
        Ok(())
    }

    /// Candidates for the open prompt as they should be listed: file names
    /// without the directory part the user has already typed.
    pub fn minibuffer_completions(&self) -> Vec<String> {
        let Some(prompt) = &self.prompt else { return Vec::new() };
        let input = self.minibuffer.slice(0..self.minibuffer.len());
        let candidates = self.completions(prompt.kind, &input);
        if prompt.kind != ParamKind::File {
            return candidates;
        }
        let dir_len = input.rfind('/').map_or(0, |i| i + 1);
        candidates.into_iter().map(|c| c[dir_len..].to_string()).collect()
    }

    // Echo area and display

    /// The message in the echo area, if any. It clears on the next key.
    pub fn echo(&self) -> Option<&str> {
        self.message.as_deref()
    }

    pub fn message(&mut self, text: impl Into<String>) {
        self.message = Some(text.into());
    }

    /// Lines of text in the selected window.
    pub fn viewport_height(&self) -> usize {
        self.selected_window_height()
    }

    /// Tells the editor how many lines the selected window shows. With more
    /// than one window, front ends use [`Editor::set_window_size`] instead.
    pub fn set_viewport_height(&mut self, lines: usize) {
        self.set_selected_window_height(lines);
    }

    /// Scrolls the selected window so point is visible, recentring when it
    /// has moved off screen.
    pub fn ensure_point_visible(&mut self) {
        let height = self.viewport_height();
        let b = self.window_buffer();
        let wrap = self.wrap_in(self.selected_window, b);
        let point_row = self.row_line_in(b, b.line_of(b.point()));
        let mut top = self.row_line_in(b, b.top_line.min(b.line_count() - 1));
        // Screen rows from the top of the window down to point's, counting
        // continued lines, up to the window's height.
        let mut visible = point_row >= top;
        if visible {
            let (_, k, _) = self.screen_position(b, b.point(), wrap);
            let (mut line, mut rows) = (top, k);
            while line < point_row && rows < height {
                rows += self.screen_height_in(b, line, wrap);
                line = self.move_rows_in(b, line, 1).0;
            }
            visible = rows < height;
        }
        if !visible {
            let (_, k, _) = self.screen_position(b, b.point(), wrap);
            let back = (height / 2).saturating_sub(k) as i64;
            top = if back == 0 { point_row } else { self.move_screen_rows_in(b, point_row, -back, wrap).0 };
        }
        self.window_buffer_mut().top_line = top;
    }

    pub fn should_quit(&self) -> bool {
        self.quit
    }
}

fn file_completions(input: &str) -> Vec<String> {
    let (dir_part, name_part) = match input.rfind('/') {
        Some(i) => (&input[..=i], &input[i + 1..]),
        None => ("", input),
    };
    let dir = if dir_part.is_empty() {
        env::current_dir().unwrap_or_default()
    } else {
        expand_file_name(dir_part)
    };
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let hidden = name.starts_with('.') && !name_part.starts_with('.');
            if hidden || !name.starts_with(name_part) {
                return None;
            }
            let slash = if e.path().is_dir() { "/" } else { "" };
            Some(format!("{dir_part}{name}{slash}"))
        })
        .collect();
    out.sort();
    out
}
