//! Batch mode, as `emacs --batch`: Gnista without a frame, running what its
//! arguments say in order and exiting, so a package's tests run in CI:
//!
//! ```text
//! gnista --batch -l test/org-roam-tests.ts -f ert-run-tests-batch-and-exit
//! ```
//!
//! `-l FILE` imports a TypeScript file as a module, `-f FUNCTION` calls a
//! function or command by name, and `--eval EXPRESSION` evaluates one.
//! Messages are printed to standard error. `init.ts` is not loaded. The
//! program exits with the status `kill-emacs` was given, 255 after an
//! error, as Emacs does, and else 0 once the arguments are done.

use std::path::Path;

use gnista_core::{Editor, Error, Value};

use crate::{Scripting, config};

/// Runs batch mode's arguments, those after `--batch`, and gives the status
/// to exit with.
pub fn run(ed: &mut Editor, args: &[String]) -> i32 {
    ed.set_noninteractive(true);
    let Some(scripting) = config::setup_batch(ed) else { return 255 };
    run_with(ed, &scripting, args)
}

/// As [`run`], with scripting already started.
pub fn run_with(ed: &mut Editor, scripting: &Scripting, args: &[String]) -> i32 {
    ed.set_noninteractive(true);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = |option: &str| args.next().cloned().ok_or_else(|| Error::new(format!("Option `{option}' requires an argument")));
        let result = match arg.as_str() {
            "-l" | "--load" => value(arg).and_then(|file| scripting.load_module(ed, Path::new(&file))),
            "-f" | "--funcall" => value(arg).and_then(|name| ed.funcall(&Value::Symbol(name), &[]).map(drop)),
            "--eval" => value(arg).and_then(|expression| scripting.eval_expression(ed, &expression).map(drop)),
            other => Err(Error::new(format!("Unknown option `{other}'"))),
        };
        if let Err(e) = result {
            eprintln!("{e}");
            return 255;
        }
        if ed.should_quit() {
            return ed.exit_status();
        }
    }
    // As Emacs in batch mode once its arguments are done.
    if let Err(e) = ed.kill_emacs() {
        eprintln!("{e}");
        return 255;
    }
    ed.exit_status()
}
