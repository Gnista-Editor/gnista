//! An editor on a driver's thread, for tests that answer a prompt in a
//! later step than the keys that open it (ADR 0053). A prompt a command
//! opens waits for its answer in the command loop, as in Emacs, so the
//! test's thread must be another: it sends keys, which return once the
//! editor waits for more, and asks the editor what it shows.

#![allow(dead_code)]

use std::any::Any;

use ember_core::Editor;
use ember_core::driver::{Driver, Input};
use ember_script::Scripting;

pub struct Driven(pub Driver);

impl Driven {
    /// An editor with the packages loaded, after running `source`.
    pub fn new(source: &str) -> Driven {
        let d = Driven(Driver::spawn(|ed| Box::new(Scripting::new(ed).unwrap()) as Box<dyn Any>, |_| Vec::new(), || {}));
        if !source.is_empty() {
            d.eval(source);
        }
        d
    }

    /// Runs TypeScript with the editor's script runtime, panicking on an error.
    pub fn eval(&self, source: &str) {
        let source = source.to_string();
        self.with_scripting(move |ed, s| s.eval_typescript(ed, "test.ts", source)).unwrap_or_else(|e| panic!("{e}"));
    }

    /// Loads a TypeScript file, as M-x load-file.
    pub fn load_file(&self, path: &str) {
        let path = std::path::PathBuf::from(path);
        self.with_scripting(move |ed, s| s.load_file(ed, &path)).unwrap_or_else(|e| panic!("{e}"));
    }

    /// The value of an expression, as JSON.
    pub fn eval_expression(&self, expression: &str) -> String {
        let expression = expression.to_string();
        self.with_scripting(move |ed, s| s.eval_expression(ed, &expression)).unwrap_or_else(|e| panic!("{e}"))
    }

    fn with_scripting<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Editor, &Scripting) -> ember_core::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.0.send(Input::Run(Box::new(move |ed, keep| {
            let _ = tx.send(f(ed, keep.downcast_ref::<Scripting>().unwrap()).map_err(|e| e.to_string()));
        })));
        rx.recv().unwrap()
    }

    /// Starts TypeScript that may wait for input, as a prompt it opens,
    /// and waits until the editor waits for more, without its result.
    pub fn start_eval(&self, source: &str) {
        let source = source.to_string();
        self.0.send(Input::Run(Box::new(move |ed, keep| {
            let scripting = keep.downcast_ref::<Scripting>().unwrap();
            if let Err(e) = scripting.eval_typescript(ed, "test.ts", source) {
                ed.message(e.to_string());
            }
        })));
        self.0.settle();
    }

    /// Runs code with the editor that may wait for input, as a command
    /// called by name that prompts, and waits until the editor waits for more.
    pub fn start(&self, f: impl FnOnce(&mut Editor) + Send + 'static) {
        self.0.run(f);
        self.0.settle();
    }

    /// Waits until the text of the selected window's buffer satisfies
    /// `done`, as output from a process comes in.
    pub fn until(&self, done: impl Fn(&str) -> bool) {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(10) {
            if done(&self.text()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("never: {:?}", self.text());
    }

    /// Types keys, as `C-x C-f`, and waits until the editor waits for more.
    pub fn press(&self, keys: &str) {
        self.0.press(keys);
    }

    /// Types text, a newline as RET.
    pub fn type_text(&self, text: &str) {
        self.0.type_text(text);
    }

    /// Runs a command by name, as M-x NAME RET.
    pub fn mx(&self, name: &str) {
        self.press("M-x");
        self.type_text(name);
        self.press("RET");
    }

    /// Runs `f` with the editor, in turn with the keys, and gives back its answer.
    pub fn with<T: Send + 'static>(&self, f: impl FnOnce(&mut Editor) -> T + Send + 'static) -> T {
        self.0.with(f)
    }

    /// The text of the buffer the selected window shows.
    pub fn text(&self) -> String {
        self.with(|ed| ed.window_buffer().slice(0..ed.window_buffer().len()))
    }

    /// The name of the buffer the selected window shows.
    pub fn buffer_name(&self) -> String {
        self.with(|ed| ed.window_buffer().name.clone())
    }

    pub fn point(&self) -> usize {
        self.with(|ed| ed.window_buffer().point())
    }

    pub fn prompt(&self) -> Option<String> {
        self.with(|ed| ed.prompt().map(str::to_string))
    }

    pub fn minibuffer_input(&self) -> String {
        self.with(|ed| ed.minibuffer_input())
    }

    /// The echo area's message.
    pub fn message(&self) -> Option<String> {
        self.with(|ed| ed.echo().map(str::to_string))
    }

    /// A variable's value, as a script would write it.
    pub fn variable(&self, name: &str) -> Option<String> {
        let name = name.to_string();
        self.with(move |ed| ed.variable(&name).map(|v| v.to_string()))
    }
}
