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

use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::editor::Editor;
use crate::frame_description::FrameDescription;
use crate::key::{Key, KeyCode};
use crate::quit::QuitHandle;

/// Code a front end sends to run with the editor and what its setup kept.
pub type Job = Box<dyn FnOnce(&mut Editor, &mut dyn Any) + Send>;

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

/// The command loop: input in order, timers when due, and a redisplay and
/// publication once nothing waits, as Emacs redisplays only when no input
/// is pending.
fn run(
    mut ed: Editor,
    mut keep: Box<dyn Any>,
    rx: Receiver<Input>,
    mut describe: impl FnMut(&mut Editor) -> Vec<FrameDescription>,
    wake: impl Fn(),
    published: Arc<Mutex<Published>>,
) {
    let mut first = true;
    loop {
        if !first {
            let timeout = ed.next_timer_in().unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(timeout) {
                Ok(input) => {
                    if !handle(&mut ed, &mut *keep, input) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            while let Ok(input) = rx.try_recv() {
                if !handle(&mut ed, &mut *keep, input) {
                    return;
                }
            }
        }
        first = false;
        guarded(&mut ed, |ed| ed.run_timers());
        let frames = std::panic::catch_unwind(AssertUnwindSafe(|| describe(&mut ed))).unwrap_or_default();
        {
            let mut p = published.lock().unwrap_or_else(|e| e.into_inner());
            p.generation += 1;
            p.frames = frames;
            p.bell |= ed.take_bell();
            p.visible_bell = ed.variable("visible-bell").is_some_and(|v| v.is_true());
            p.exit = ed.should_quit();
        }
        wake();
        if ed.should_quit() {
            return;
        }
    }
}

/// Handles one input; false when the front end is closing.
fn handle(ed: &mut Editor, keep: &mut dyn Any, input: Input) -> bool {
    match input {
        Input::Key(key) => guarded(ed, |ed| ed.handle_key(key)),
        // Taken by a command it stopped, or still waiting to be read.
        Input::Quit => {
            if ed.quit_state().requested() {
                ed.quit_state().clear();
                guarded(ed, |ed| ed.handle_key(Key { code: KeyCode::Char('g'), ctrl: true, meta: false, shift: false }));
            }
        }
        Input::Run(f) => guarded(ed, |ed| f(ed, keep)),
        Input::Wake => {}
        Input::Close => return false,
    }
    true
}

/// Runs editor code so a panic in it reports in the echo area and the
/// loop goes on, as Emacs carries on after an error.
fn guarded(ed: &mut Editor, f: impl FnOnce(&mut Editor)) {
    if let Err(panic) = std::panic::catch_unwind(AssertUnwindSafe(|| f(ed))) {
        let what = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
        ed.message(format!("Internal error: {what}"));
    }
}
