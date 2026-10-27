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
use crate::key::{Key, KeyCode, format_keys};
use crate::keymap::{Keymap, Lookup};

/// A minibuffer prompt waiting for the user to type an argument.
pub(crate) struct Prompt {
    pub(crate) text: String,
    pub(crate) kind: ParamKind,
}

/// A command whose arguments are still being read.
struct PendingCall {
    command: Rc<Command>,
    args: Vec<Arg>,
}

/// All editor state. A front end feeds it keys with [`Editor::handle_key`]
/// and reads it back to draw.
pub struct Editor {
    buffers: Vec<Buffer>,
    current: usize,
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
    pub(crate) message: Option<String>,
    pub(crate) kill_ring: Vec<String>,
    last_command: Option<String>,
    this_command: Option<String>,
    pub(crate) last_key: Option<Key>,
    pub(crate) goal_column: Option<usize>,
    self_insert_run: usize,
    viewport_height: usize,
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
            message: None,
            kill_ring: Vec::new(),
            last_command: None,
            this_command: None,
            last_key: None,
            goal_column: None,
            self_insert_run: 0,
            viewport_height: 24,
            quit: false,
        };
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
        self.buffer_mut().undo_boundary();
        self.invoke(command, args)
    }

    /// Runs a command the way a key binding does: prompting in the minibuffer
    /// for any parameters, and showing errors in the echo area.
    pub fn run_interactive(&mut self, name: &str) {
        let shifted = std::mem::take(&mut self.shift_translated);
        let Some(command) = self.command(name) else {
            self.message = Some(format!("No such command: {name}"));
            return;
        };
        if !command.params.is_empty() && (self.prompt.is_some() || self.reading_keys.is_some()) {
            self.message = Some("Command attempted to use minibuffer while in minibuffer".into());
            return;
        }
        // Consecutive self-inserts share an undo step, up to 20 characters, as in Emacs.
        let amalgamate = name == "self-insert-command"
            && self.last_command() == Some(name)
            && self.self_insert_run < 20;
        self.self_insert_run = if amalgamate { self.self_insert_run + 1 } else { 1 };
        if !amalgamate {
            self.buffer_mut().undo_boundary();
        }
        if command.shift_select {
            self.shift_select(shifted);
        }
        if command.params.is_empty() {
            self.execute(command, Vec::new());
        } else {
            self.pending_call = Some(PendingCall { command, args: Vec::new() });
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
                self.prompt = Some(Prompt { text: param.prompt.clone(), kind: param.kind });
                self.minibuffer.set_text(&initial);
                self.minibuffer.set_point(self.minibuffer.len());
            }
            return;
        }
        let call = self.pending_call.take().expect("checked above");
        self.execute(call.command, call.args);
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
    }

    fn execute(&mut self, command: Rc<Command>, args: Vec<Arg>) {
        if let Err(e) = self.invoke(command, args) {
            self.message = Some(e.to_string());
        }
    }

    fn invoke(&mut self, command: Rc<Command>, args: Vec<Arg>) -> Result<()> {
        self.this_command = Some(command.name.clone());
        let result = (command.run)(self, &args);
        // A command that ran another command (as M-x does) leaves that one as the last command.
        if let Some(name) = self.this_command.take() {
            self.last_command = Some(name);
        }
        // Editing deactivates the region, as in Emacs's transient-mark-mode.
        for b in self.buffers.iter_mut().chain(std::iter::once(&mut self.minibuffer)) {
            if b.take_changed() {
                b.deactivate_mark();
            }
        }
        result
    }

    // Keys

    /// Handles one key press: runs the command it completes, waits for more
    /// keys after a prefix, or inserts it if it is a plain unbound character.
    pub fn handle_key(&mut self, mut key: Key) {
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
                self.last_key = Some(key);
                self.run_interactive(&name);
            }
            // Shift translation, as in Emacs: a shifted key with no binding of
            // its own acts as the key without Shift, so S-<right> runs
            // forward-char and Shift selection applies.
            Lookup::Unbound if key.shift => {
                self.pending_keys.pop();
                self.shift_translated = true;
                self.handle_key(key.unshifted());
            }
            Lookup::Unbound => {
                self.shift_translated = false;
                let keys = std::mem::take(&mut self.pending_keys);
                if keys.len() == 1 && key.printable().is_some() {
                    self.last_key = Some(key);
                    self.run_interactive("self-insert-command");
                } else {
                    self.message = Some(format!("{} is undefined", format_keys(&keys)));
                }
            }
        }
    }

    /// Looks a key sequence up in the active keymaps: the minibuffer's first
    /// while it is active, then the global map.
    pub fn lookup(&self, keys: &[Key]) -> Lookup {
        if self.prompt.is_some() {
            match self.minibuffer_map.lookup(keys) {
                Lookup::Unbound => {}
                found => return found,
            }
        }
        self.global_map.lookup(keys)
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
        self.buffers.remove(index);
        if self.buffers.is_empty() {
            self.buffers.push(Buffer::new("*scratch*"));
        }
        let target = if showing { next } else { Some(current_name) };
        self.current = target.and_then(|n| self.find_buffer(&n)).unwrap_or(0);
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

    /// Completion candidates for minibuffer input of a given kind.
    pub fn completions(&self, kind: ParamKind, input: &str) -> Vec<String> {
        match kind {
            ParamKind::Command => self
                .command_names()
                .filter(|name| name.starts_with(input))
                .map(str::to_string)
                .collect(),
            ParamKind::Buffer => self
                .buffers
                .iter()
                .map(|b| b.name.clone())
                .filter(|name| name.starts_with(input))
                .collect(),
            ParamKind::File => file_completions(input),
            ParamKind::String | ParamKind::Keys => Vec::new(),
        }
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

    pub fn viewport_height(&self) -> usize {
        self.viewport_height
    }

    /// Tells the editor how many lines the window shows. Front ends call this when they draw.
    pub fn set_viewport_height(&mut self, lines: usize) {
        self.viewport_height = lines.max(1);
    }

    /// Scrolls the window so point is visible, recentring when it has moved off screen.
    pub fn ensure_point_visible(&mut self) {
        let height = self.viewport_height;
        let buffer = self.window_buffer_mut();
        let line = buffer.line_of(buffer.point());
        if line < buffer.top_line || line >= buffer.top_line + height {
            buffer.top_line = line.saturating_sub(height / 2);
        }
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
