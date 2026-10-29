//! Processes, as Emacs's process.c: programs that run alongside the editor
//! while their output comes into a buffer, as compilation and grep do.
//!
//! A process is started with [`Editor::make_process`]. Threads read its
//! output and send it to the editor, which has no thread of its own: front
//! ends call [`Editor::run_timers`], which takes the output in, while
//! [`Editor::next_timer_in`] asks to be woken often while one runs. Output
//! goes to the process's filter, or by default into its buffer at its
//! mark; when it exits its sentinel runs, or by default a line saying so
//! goes into its buffer. Starting a program asks the agent's permission,
//! as running code does. [`Editor::call_process`] runs one and waits, as
//! Emacs's call-process.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};
use std::time::{Duration, Instant};

use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::{HookFn, Value};

/// How a process stands, as Emacs's `process-status`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Run,
    /// Exited with this code.
    Exit(i32),
    /// Ended by this signal.
    Signal(i32),
}

impl Status {
    /// The event a sentinel is told, as Emacs words it: "finished\n",
    /// "exited abnormally with code 2\n", "killed\n".
    pub fn event(self) -> String {
        match self {
            Status::Run => "run\n".into(),
            Status::Exit(0) => "finished\n".into(),
            Status::Exit(code) => format!("exited abnormally with code {code}\n"),
            Status::Signal(sig) => format!("{}\n", signal_name(sig)),
        }
    }
}

/// How Emacs describes a process ended by a signal.
fn signal_name(sig: i32) -> String {
    match sig {
        1 => "hangup".into(),
        2 => "interrupt".into(),
        3 => "quit".into(),
        9 => "killed".into(),
        13 => "broken pipe".into(),
        15 => "terminated".into(),
        n => format!("signal {n}"),
    }
}

pub(crate) struct Process {
    /// Unique among all processes ever started, so output read for one
    /// that has gone never reaches another of the same name.
    id: u64,
    pub(crate) name: String,
    /// The buffer it writes to, by buffer id.
    buffer: Option<u64>,
    /// Where output goes in its buffer, as `process-mark`.
    mark: Option<u64>,
    command: Vec<String>,
    status: Status,
    child: Option<Child>,
    /// Text for its standard input, written on a thread of its own so a
    /// process that does not read cannot stop the editor; None closes it.
    stdin: Option<Sender<Option<Vec<u8>>>>,
    pid: u32,
    /// Output streams still open.
    open_streams: usize,
    filter: Option<HookFn>,
    sentinel: Option<HookFn>,
    query_on_exit: bool,
    /// When it was seen to have exited, and how, while its output was still open.
    exited: Option<(Instant, Status)>,
}

enum Event {
    Output(u64, String),
    Closed(u64),
}

/// How many chunks of output wait to be taken in before readers wait,
/// so a program writing fast fills no more memory than this.
const QUEUED_CHUNKS: usize = 64;
/// How many chunks are taken in at a time, as read-process-output-max
/// limits Emacs, so a flood of output leaves the editor answering.
const CHUNKS_PER_POLL: usize = 32;

pub(crate) struct Processes {
    list: Vec<Process>,
    tx: SyncSender<Event>,
    rx: Receiver<Event>,
    next_id: u64,
}

impl Default for Processes {
    fn default() -> Processes {
        let (tx, rx) = sync_channel(QUEUED_CHUNKS);
        Processes { list: Vec::new(), tx, rx, next_id: 1 }
    }
}

impl Drop for Processes {
    /// Hangs up on the processes still running, as Emacs does when it exits.
    fn drop(&mut self) {
        for p in &mut self.list {
            if p.status == Status::Run {
                hang_up(p);
            }
        }
    }
}

/// Sends SIGHUP to a process's group, then kills what is left.
fn hang_up(p: &mut Process) {
    #[cfg(unix)]
    // SAFETY: kill only sends a signal; a stale pid fails harmlessly.
    unsafe {
        libc::kill(-(p.pid as i32), libc::SIGHUP);
    }
    if let Some(child) = p.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// What starts a process, as Emacs's make-process takes it.
pub struct ProcessSpec {
    pub name: String,
    /// The buffer it writes to, by name.
    pub buffer: Option<String>,
    /// The program and its arguments.
    pub command: Vec<String>,
    /// The directory it runs in: the buffer's default-directory if none.
    pub directory: Option<String>,
    /// Variables to set in its environment, besides TERM=dumb.
    pub env: Vec<(String, String)>,
    /// Whether what it writes to standard error comes in as output too.
    pub merge_stderr: bool,
    pub filter: Option<HookFn>,
    pub sentinel: Option<HookFn>,
}

/// Reads a stream in chunks, sending each as text, a character split
/// between chunks kept for the next.
fn read_stream(id: u64, mut stream: impl Read + Send + 'static, tx: SyncSender<Event>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(s) => s.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !text.is_empty() && tx.send(Event::Output(id, text)).is_err() {
                        return;
                    }
                }
            }
        }
        if !pending.is_empty() {
            let _ = tx.send(Event::Output(id, String::from_utf8_lossy(&pending).into_owned()));
        }
        let _ = tx.send(Event::Closed(id));
    });
}

impl Editor {
    /// Starts a program running alongside the editor, as Emacs's
    /// make-process, and returns its name, made unique with "<1>" and so
    /// on as Emacs does. Asks the agent's permission first.
    pub fn make_process(&mut self, spec: ProcessSpec) -> Result<String> {
        let program = spec.command.first().ok_or_else(|| Error::new("No program to run"))?.clone();
        self.check_permission(&format!("run {}", spec.command.join(" ")))?;
        let buffer = spec.buffer.as_ref().map(|name| self.get_buffer_create(name));
        let dir = match &spec.directory {
            Some(d) => self.expand_file_name(d),
            None => self.expand_file_name("."),
        };
        let mut command = Command::new(&program);
        command
            .args(&spec.command[1..])
            .current_dir(&dir)
            .env("TERM", "dumb")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if spec.merge_stderr { Stdio::piped() } else { Stdio::null() });
        for (k, v) in &spec.env {
            command.env(k, v);
        }
        // Its own process group, so signals reach what it starts too, as
        // Emacs's processes on a terminal of their own.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| Error::new(format!("Searching for program: {e}, {program}")))?;
        let mut name = spec.name.clone();
        let mut n = 1;
        while self.processes.list.iter().any(|p| p.name == name) {
            name = format!("{}<{n}>", spec.name);
            n += 1;
        }
        let id = self.processes.next_id;
        self.processes.next_id += 1;
        let mut open_streams = 0;
        if let Some(out) = child.stdout.take() {
            read_stream(id, out, self.processes.tx.clone());
            open_streams += 1;
        }
        if let Some(err) = child.stderr.take() {
            read_stream(id, err, self.processes.tx.clone());
            open_streams += 1;
        }
        let stdin = child.stdin.take().map(|mut input| {
            let (tx, rx) = channel::<Option<Vec<u8>>>();
            std::thread::spawn(move || {
                while let Ok(Some(bytes)) = rx.recv() {
                    if input.write_all(&bytes).and_then(|_| input.flush()).is_err() {
                        break;
                    }
                }
            });
            tx
        });
        let (buffer_id, mark) = match buffer {
            Some(index) => {
                let b = &mut self.buffers[index];
                let end = b.len();
                (Some(b.id), Some(b.make_marker(end, false)))
            }
            None => (None, None),
        };
        self.processes.list.push(Process {
            id,
            name: name.clone(),
            buffer: buffer_id,
            mark,
            command: spec.command,
            status: Status::Run,
            pid: child.id(),
            stdin,
            child: Some(child),
            open_streams,
            filter: spec.filter,
            sentinel: spec.sentinel,
            query_on_exit: true,
            exited: None,
        });
        Ok(name)
    }

    fn process(&self, name: &str) -> Result<&Process> {
        self.processes.list.iter().find(|p| p.name == name).ok_or_else(|| Error::new(format!("Process {name} does not exist")))
    }

    fn process_mut(&mut self, name: &str) -> Result<&mut Process> {
        self.processes.list.iter_mut().find(|p| p.name == name).ok_or_else(|| Error::new(format!("Process {name} does not exist")))
    }

    /// The processes, oldest first, as Emacs's process-list.
    pub fn process_list(&self) -> Vec<String> {
        self.processes.list.iter().map(|p| p.name.clone()).collect()
    }

    pub fn process_status(&self, name: &str) -> Option<Status> {
        self.process(name).ok().map(|p| p.status)
    }

    pub fn process_command(&self, name: &str) -> Option<Vec<String>> {
        self.process(name).ok().map(|p| p.command.clone())
    }

    pub fn process_id(&self, name: &str) -> Option<u32> {
        self.process(name).ok().map(|p| p.pid)
    }

    /// The name of the buffer a process writes to.
    pub fn process_buffer(&self, name: &str) -> Option<String> {
        let id = self.process(name).ok()?.buffer?;
        self.buffers.iter().find(|b| b.id == id).map(|b| b.name.clone())
    }

    /// The marker where a process's output goes, as process-mark.
    pub fn process_mark(&self, name: &str) -> Option<u64> {
        self.process(name).ok()?.mark
    }

    /// The process writing to a buffer, if one is, as get-buffer-process.
    pub fn buffer_process(&self, buffer: &str) -> Option<String> {
        let id = self.buffers.iter().find(|b| b.name == buffer)?.id;
        self.processes.list.iter().find(|p| p.buffer == Some(id)).map(|p| p.name.clone())
    }

    pub fn process_query_on_exit(&self, name: &str) -> bool {
        self.process(name).is_ok_and(|p| p.query_on_exit)
    }

    pub fn set_process_query_on_exit(&mut self, name: &str, query: bool) -> Result<()> {
        self.process_mut(name)?.query_on_exit = query;
        Ok(())
    }

    /// Sends text to a process's standard input, as process-send-string.
    pub fn process_send_string(&mut self, name: &str, text: &str) -> Result<()> {
        let p = self.process_mut(name)?;
        let stdin = p.stdin.as_ref().ok_or_else(|| Error::new(format!("Process {name} not running")))?;
        stdin.send(Some(text.as_bytes().to_vec())).map_err(|_| Error::new(format!("Process {name} not running")))
    }

    /// Closes a process's standard input, as process-send-eof.
    pub fn process_send_eof(&mut self, name: &str) -> Result<()> {
        if let Some(stdin) = self.process_mut(name)?.stdin.take() {
            let _ = stdin.send(None);
        }
        Ok(())
    }

    /// Hangs up on every process still running, as exiting Emacs does.
    pub(crate) fn hang_up_processes(&mut self) {
        for p in &mut self.processes.list {
            if p.status == Status::Run {
                hang_up(p);
            }
        }
    }

    /// Sends a signal to a process and what it started, as signal-process:
    /// 2 interrupts (interrupt-process), 9 kills (kill-process).
    pub fn signal_process(&mut self, name: &str, signal: i32) -> Result<()> {
        let p = self.process_mut(name)?;
        if p.status != Status::Run {
            return Ok(());
        }
        #[cfg(unix)]
        {
            // The whole group, as the process leads it.
            let pid = p.pid as i32;
            // SAFETY: kill only sends a signal; a stale pid fails harmlessly.
            unsafe {
                libc::kill(-pid, signal);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            if let Some(child) = p.child.as_mut() {
                let _ = child.kill();
            }
        }
        Ok(())
    }

    /// Kills a process and forgets it, as delete-process. Its sentinel runs.
    pub fn delete_process(&mut self, name: &str) -> Result<()> {
        if self.process(name)?.status == Status::Run {
            self.signal_process(name, 9)?;
        }
        let i = self.processes.list.iter().position(|p| p.name == name).expect("found above");
        let mut p = self.processes.list.remove(i);
        let status = match p.child.as_mut().map(|c| c.wait()) {
            Some(Ok(status)) => exit_status(status),
            _ => Status::Signal(9),
        };
        if p.status == Status::Run {
            p.status = status;
            self.notify(&p);
        }
        if let Some(id) = p.mark {
            self.delete_marker(id);
        }
        Ok(())
    }

    /// Whether a process is running, so front ends should wake to take its output in.
    pub(crate) fn processes_running(&self) -> bool {
        self.processes.list.iter().any(|p| p.status == Status::Run)
    }

    /// Takes in what processes have written and notices those that have
    /// ended, running filters and sentinels, as Emacs's wait_reading_process_output.
    pub(crate) fn poll_processes(&mut self) {
        let mut drained = false;
        for _ in 0..CHUNKS_PER_POLL {
            let Ok(event) = self.processes.rx.try_recv() else {
                drained = true;
                break;
            };
            let name = |ed: &Editor, id: u64| ed.processes.list.iter().find(|p| p.id == id).map(|p| p.name.clone());
            match event {
                Event::Output(id, text) => {
                    if let Some(name) = name(self, id) {
                        self.process_output(&name, &text);
                    }
                }
                Event::Closed(id) => {
                    if let Some(p) = self.processes.list.iter_mut().find(|p| p.id == id) {
                        p.open_streams = p.open_streams.saturating_sub(1);
                    }
                }
            }
        }
        // Those that have exited, once their output has all come; or, when
        // something they started keeps their output open, a moment after
        // they exited with nothing more arriving, as Emacs notices them.
        let mut ended = Vec::new();
        let now = Instant::now();
        for p in &mut self.processes.list {
            if p.status != Status::Run {
                continue;
            }
            let exited = match p.exited {
                Some(exit) => Some(exit),
                None => match p.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(status))) => {
                        p.exited = Some((now, exit_status(status)));
                        p.exited
                    }
                    _ => None,
                },
            };
            let Some((when, status)) = exited else { continue };
            if p.open_streams == 0 || (drained && now.duration_since(when) >= Duration::from_millis(200)) {
                p.status = status;
                p.stdin = None;
                ended.push(p.name.clone());
            }
        }
        for name in ended {
            let Some(i) = self.processes.list.iter().position(|p| p.name == name) else { continue };
            // A process that has ended stays listed, as in Emacs, until deleted;
            // its sentinel runs with it still there.
            let sentinel = self.processes.list[i].sentinel.clone();
            let event = self.processes.list[i].status.event();
            match sentinel {
                Some(f) => {
                    if let Err(e) = f(self, &[Value::Str(name.clone()), Value::Str(event)]) {
                        self.message(format!("error in process sentinel: {e}"));
                    }
                }
                None => {
                    let p = &self.processes.list[i];
                    let line = format!("\nProcess {} {}", p.name, p.status.event());
                    let (buffer, mark) = (p.buffer, p.mark);
                    self.insert_process_text(buffer, mark, &line, false);
                }
            }
            // Gone from the list once ended and reported, as a process whose
            // status has been noticed and which nothing refers to.
            if let Some(i) = self.processes.list.iter().position(|p| p.name == name && p.status != Status::Run) {
                let p = self.processes.list.remove(i);
                if let Some(id) = p.mark {
                    self.delete_marker(id);
                }
            }
        }
    }

    fn notify(&mut self, p: &Process) {
        let event = p.status.event();
        match &p.sentinel {
            Some(f) => {
                if let Err(e) = f(self, &[Value::Str(p.name.clone()), Value::Str(event)]) {
                    self.message(format!("error in process sentinel: {e}"));
                }
            }
            None => {
                let line = format!("\nProcess {} {}", p.name, event);
                self.insert_process_text(p.buffer, p.mark, &line, false);
            }
        }
    }

    fn process_output(&mut self, name: &str, text: &str) {
        let Ok(p) = self.process(name) else { return };
        match p.filter.clone() {
            Some(f) => {
                if let Err(e) = f(self, &[Value::Str(name.to_string()), Value::Str(text.to_string())]) {
                    self.message(format!("error in process filter: {e}"));
                }
            }
            None => {
                let (buffer, mark) = (p.buffer, p.mark);
                self.insert_process_text(buffer, mark, text, true);
            }
        }
    }

    /// Inserts text at a process's mark in its buffer, as Emacs's default
    /// filter: point moves along if it was at the mark.
    fn insert_process_text(&mut self, buffer: Option<u64>, mark: Option<u64>, text: &str, advance: bool) {
        let (Some(id), Some(mark)) = (buffer, mark) else { return };
        let Some(b) = self.buffers.iter_mut().find(|b| b.id == id) else { return };
        // At the mark even outside a narrowing, before markers, as Emacs
        // inserts output: point, the mark and other windows' points there
        // move along with it.
        let at = b.marker(mark).unwrap_or(b.len());
        if b.insert_before_markers_at(at, text).is_ok() && !advance {
            // A note of the end goes after the output without moving the mark.
            b.set_marker(mark, at);
        }
    }

    /// Waits up to `timeout` for processes to write or end, then takes their
    /// output in, as accept-process-output. Returns once none runs.
    pub fn accept_process_output(&mut self, timeout: Duration) {
        let until = Instant::now() + timeout;
        loop {
            self.poll_processes();
            if !self.processes_running() || Instant::now() >= until {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Runs a program and waits for it, as Emacs's call-process, returning
    /// its exit code and what it wrote, standard error after standard
    /// output. Asks the agent's permission first.
    pub fn call_process(&mut self, command: &[String], directory: Option<&str>, input: Option<&str>) -> Result<(i32, String)> {
        let program = command.first().ok_or_else(|| Error::new("No program to run"))?;
        self.check_permission(&format!("run {}", command.join(" ")))?;
        let dir = self.expand_file_name(directory.unwrap_or("."));
        let mut child = Command::new(program)
            .args(&command[1..])
            .current_dir(&dir)
            .env("TERM", "dumb")
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::new(format!("Searching for program: {e}, {program}")))?;
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            let text = text.to_string();
            std::thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        }
        let output = child.wait_with_output().map_err(|e| Error::new(format!("Running {program}: {e}")))?;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        let code = match exit_status(output.status) {
            Status::Exit(c) => c,
            Status::Signal(s) => 128 + s,
            Status::Run => 0,
        };
        Ok((code, text))
    }
}

fn exit_status(status: std::process::ExitStatus) -> Status {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return Status::Signal(sig);
        }
    }
    Status::Exit(status.code().unwrap_or(-1))
}
