//! The editor on a thread of its own: step 3 of docs/multithreading.md.
//!
//! A [`Driver`] starts a thread, makes the editor there (it never leaves
//! it, as everything in it is single-threaded by design), and runs the
//! command loop: it takes input from one channel, keys in the order they
//! were typed, and once nothing more is waiting, redisplays and publishes
//! what each frame shows for the front end to draw. The front end never
//! waits on the editor: it sends input and draws the latest description,
//! whatever the editor is doing, so a long command no longer freezes the
//! window, and `C-g` reaches it through the quit flag.
//!
//! Anything else a front end, a test or the agent needs from the editor
//! goes as a closure to run on its thread ([`Input::Run`]), in turn with
//! the keys; [`Driver::with`] waits for one's answer.
//!
//! The loop also runs inside commands, as Emacs's does inside
//! read-from-minibuffer: a prompt waits for its answer with
//! [`Editor::wait_until`], which takes input from the same channel, one
//! at a time, until the answer comes (step 5, ADR 0053).

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::panic::AssertUnwindSafe;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::Result;
use crate::editor::Editor;
use crate::frame_description::FrameDescription;
use crate::key::{Key, KeyCode};
use crate::quit::QuitHandle;

/// Code a front end sends to run with the editor and what its setup kept.
pub type Job = Box<dyn FnOnce(&mut Editor, &dyn Any) + Send>;

/// What the editor's thread takes, in order.
pub enum Input {
    /// A key typed.
    Key(Key),
    /// `C-g`, which the front end also sent as a request to quit: it runs
    /// as a key only if no command took the quit, as Emacs reads the quit
    /// character once.
    Quit,
    /// Code to run with the editor, as a mouse event, a resize, a test's
    /// question or the agent's request, given what the setup kept alive,
    /// such as the script runtime.
    Run(Job),
    /// Something to take in, as a process's output, before redisplaying.
    Wake,
    /// The front end is closing.
    Close,
}

/// What the editor's thread last published.
#[derive(Default)]
pub struct Published {
    /// Counts publications, so a front end knows when there is a new one.
    pub generation: u64,
    /// What each frame shows, as the front end's `describe` gave it.
    pub frames: Vec<FrameDescription>,
    /// Whether the bell rang since the front end last looked.
    pub bell: bool,
    /// Whether it rings as a flash, as `visible-bell` says.
    pub visible_bell: bool,
    /// Whether the editor wants to exit, as `C-x C-c` does.
    pub exit: bool,
}

/// A handle on the editor's thread.
pub struct Driver {
    input: Sender<Input>,
    quit: QuitHandle,
    published: Arc<Mutex<Published>>,
    thread: Option<JoinHandle<()>>,
}

/// How big the editor thread's stack is: Lisp-like code recurses deeply,
/// and spawned threads get 2 MB by default on macOS, a quarter of the main
/// thread's.
const STACK: usize = 64 << 20;

impl Driver {
    /// Starts the editor's thread. `setup` makes the editor ready there,
    /// loading scripts, and returns what must live as long as the editor,
    /// as the script runtime. `describe` lays the frames out and describes
    /// them after redisplay, as the front end draws them. `wake` tells the
    /// front end there is something new to draw.
    pub fn spawn(
        setup: impl FnOnce(&mut Editor) -> Box<dyn Any> + Send + 'static,
        describe: impl FnMut(&mut Editor) -> Vec<FrameDescription> + Send + 'static,
        wake: impl Fn() + Send + 'static,
    ) -> Driver {
        let (input, rx) = channel();
        let published = Arc::new(Mutex::new(Published::default()));
        let (quit_tx, quit_rx) = channel();
        let shared = published.clone();
        let waker = input.clone();
        let thread = std::thread::Builder::new()
            .name("editor".into())
            .stack_size(STACK)
            .spawn(move || {
                let mut ed = Editor::new();
                // Process output wakes the loop, rather than waiting for its next timer.
                let waker = Mutex::new(waker);
                ed.set_process_waker(Arc::new(move || {
                    let _ = waker.lock().unwrap_or_else(|e| e.into_inner()).send(Input::Wake);
                }));
                let keep = setup(&mut ed);
                let _ = quit_tx.send(ed.quit_handle());
                run(ed, keep, rx, describe, wake, shared);
            })
            .expect("the editor's thread starts");
        let quit = quit_rx.recv().expect("the editor's thread sends its quit flag");
        Driver { input, quit, published, thread: Some(thread) }
    }

    /// Sends input to the editor's thread.
    pub fn send(&self, input: Input) {
        let _ = self.input.send(input);
    }

    /// Sends a typed key. `C-g` also asks the editor to quit, so it stops
    /// a command that is running, as Emacs's quit character does.
    pub fn key(&self, key: Key) {
        if key.ctrl && !key.meta && key.code == KeyCode::Char('g') {
            self.quit.request();
            self.send(Input::Quit);
        } else {
            self.send(Input::Key(key));
        }
    }

    /// Runs `f` with the editor on its thread, after the input sent before
    /// it, and waits for its answer.
    pub fn with<T: Send + 'static>(&self, f: impl FnOnce(&mut Editor) -> T + Send + 'static) -> T {
        let (tx, rx) = channel();
        self.run(move |ed| {
            let _ = tx.send(f(ed));
        });
        rx.recv().expect("the editor's thread answers")
    }

    /// Runs `f` with the editor on its thread, after the input sent before
    /// it, without waiting.
    pub fn run(&self, f: impl FnOnce(&mut Editor) + Send + 'static) {
        self.send(Input::Run(Box::new(move |ed, _| f(ed))));
    }

    /// What the editor last published.
    pub fn published(&self) -> std::sync::MutexGuard<'_, Published> {
        self.published.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The editor's quit flag, which `C-g` sets.
    pub fn quit_handle(&self) -> &QuitHandle {
        &self.quit
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.send(Input::Close);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A command loop code can run again from inside a command until a
/// condition holds, as a prompt waits for its answer.
pub trait NestedLoop {
    /// Takes input until `done` says, or fails with `quit` when the editor closes.
    fn wait(&self, ed: &mut Editor, done: &mut dyn FnMut(&Editor) -> bool) -> Result<()>;
}

/// The editor thread's command loop: input in order, timers when due, and
/// a redisplay and publication once nothing waits, as Emacs redisplays
/// only when no input is pending.
struct CommandLoop<D> {
    rx: Receiver<Input>,
    keep: Box<dyn Any>,
    describe: RefCell<D>,
    wake: Box<dyn Fn()>,
    published: Arc<Mutex<Published>>,
    closing: Cell<bool>,
}

impl<D: FnMut(&mut Editor) -> Vec<FrameDescription>> CommandLoop<D> {
    /// Redisplays and publishes what each frame shows, and tells the front end.
    fn publish(&self, ed: &mut Editor) {
        let frames = std::panic::catch_unwind(AssertUnwindSafe(|| (self.describe.borrow_mut())(ed))).unwrap_or_default();
        {
            let mut p = self.published.lock().unwrap_or_else(|e| e.into_inner());
            p.generation += 1;
            p.frames = frames;
            p.bell |= ed.take_bell();
            p.visible_bell = ed.variable("visible-bell").is_some_and(|v| v.is_true());
            p.exit = ed.should_quit();
        }
        (self.wake)();
    }

    /// Handles one input; false when the front end is closing.
    fn handle(&self, ed: &mut Editor, input: Input) -> bool {
        match input {
            Input::Key(key) => guarded(ed, |ed| ed.handle_key(key)),
            // Taken by a command it stopped, or still waiting to be read.
            Input::Quit => {
                if ed.quit_state().requested() {
                    ed.quit_state().clear();
                    guarded(ed, |ed| ed.handle_key(Key { code: KeyCode::Char('g'), ctrl: true, meta: false, shift: false }));
                }
            }
            Input::Run(f) => guarded(ed, |ed| f(ed, &*self.keep)),
            Input::Wake => {}
            Input::Close => return false,
        }
        true
    }
}

impl<D: FnMut(&mut Editor) -> Vec<FrameDescription>> NestedLoop for CommandLoop<D> {
    fn wait(&self, ed: &mut Editor, done: &mut dyn FnMut(&Editor) -> bool) -> Result<()> {
        loop {
            if done(ed) {
                return Ok(());
            }
            if self.closing.get() || ed.should_quit() {
                return Err(crate::quit::quit_error());
            }
            // One input at a time, so what comes after an answer waits for
            // the command that asked, as in Emacs.
            let input = match self.rx.try_recv() {
                Ok(input) => input,
                Err(TryRecvError::Disconnected) => {
                    self.closing.set(true);
                    continue;
                }
                Err(TryRecvError::Empty) => {
                    // Nothing waiting: timers, then show where things are, then wait.
                    guarded(ed, |ed| ed.run_timers());
                    if done(ed) {
                        return Ok(());
                    }
                    self.publish(ed);
                    let timeout = ed.next_timer_in().unwrap_or(Duration::from_secs(3600));
                    match self.rx.recv_timeout(timeout) {
                        Ok(input) => input,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => {
                            self.closing.set(true);
                            continue;
                        }
                    }
                }
            };
            if !self.handle(ed, input) {
                self.closing.set(true);
            }
        }
    }
}

/// Runs the command loop until the editor exits or the front end closes.
fn run(
    mut ed: Editor,
    keep: Box<dyn Any>,
    rx: Receiver<Input>,
    describe: impl FnMut(&mut Editor) -> Vec<FrameDescription> + 'static,
    wake: impl Fn() + 'static,
    published: Arc<Mutex<Published>>,
) {
    let command_loop = Rc::new(CommandLoop {
        rx,
        keep,
        describe: RefCell::new(describe),
        wake: Box::new(wake),
        published,
        closing: Cell::new(false),
    });
    ed.command_loop = Some(command_loop.clone());
    let _ = command_loop.wait(&mut ed, &mut |ed| ed.should_quit());
    command_loop.publish(&mut ed);
    // The loop holds what setup kept, as the script runtime, which goes
    // before the editor it was made for.
    ed.command_loop = None;
    drop(command_loop);
}

/// Runs editor code so a panic in it reports in the echo area and the
/// loop goes on, as Emacs carries on after an error.
fn guarded(ed: &mut Editor, f: impl FnOnce(&mut Editor)) {
    if let Err(panic) = std::panic::catch_unwind(AssertUnwindSafe(|| f(ed))) {
        let what = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
        ed.message(format!("Internal error: {what}"));
    }
}
