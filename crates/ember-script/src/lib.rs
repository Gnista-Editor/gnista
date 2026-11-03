//! TypeScript extensions for Ember, run on the QuickJS engine.
//!
//! [`Scripting`] owns the JavaScript runtime. Scripts reach the editor through
//! the `ember` global; [`type_definitions`] generates its TypeScript
//! declarations from the command registry.

pub mod config;
mod natives;
mod strip;
mod strip_js;
mod types;

pub use strip::{strip_module_types, strip_types};
pub use types::type_definitions;

use std::cell::{Cell, RefCell};
use std::fs;
use std::path::Path;
use std::ptr::NonNull;
use std::thread::LocalKey;
use std::time::{Duration, Instant};

use std::rc::Rc;

use ember_core::{
    Arg, Background, Command, Editor, Error, Face, FaceAttrs, HookFn, Key, MinorMode, ParamKind, Reading,
    PrefixArg, Result, Value as EditorValue, Variable, abbreviate_path, expand_file_name,
};
use rquickjs::context::EvalOptions;
use rquickjs::function::{Opt, Rest};
use rquickjs::{
    Coerced, Context, Ctx, Exception, FromJs, Function, Object, Persistent, Runtime, Value, qjs,
};

const PRELUDE: &str = include_str!("prelude.js");

/// The source of the package a module name names: "subr", or as the
/// loader names it, "packages/subr.ts".
fn package_source(name: &str) -> Option<(&'static str, &'static str)> {
    let feature = name.trim_start_matches("packages/").trim_end_matches(".ts");
    PACKAGES.iter().find(|(file, _)| file.trim_start_matches("packages/").trim_end_matches(".ts") == feature).copied()
}

/// Finds a package by its feature name, as Emacs's require finds a Lisp
/// file: `import { x } from "subr"` is packages/subr.ts.
struct PackageResolver;

impl rquickjs::loader::Resolver for PackageResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        package_source(name).map(|(file, _)| file.to_string()).ok_or_else(|| rquickjs::Error::new_resolving(base, name))
    }
}

include!(concat!(env!("OUT_DIR"), "/stripped.rs"));

/// Loads a package as an ES module, its types erased.
struct PackageLoader;

impl rquickjs::loader::Loader for PackageLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<rquickjs::Module<'js, rquickjs::module::Declared>> {
        let (file, source) = package_source(name).ok_or_else(|| rquickjs::Error::new_loading(name))?;
        let js = match stripped(file) {
            Some(js) => js.to_string(),
            None => strip_module_types(file, source.to_string()).map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?,
        };
        rquickjs::Module::declare(ctx.clone(), file, js)
    }
}

/// The packages that ship with Ember, in the order they load. Like the Lisp
/// that Emacs preloads, they are part of the editor: `-q` skips init.ts but
/// not these. Named by their path in the repository.
const PACKAGES: &[(&str, &str)] = &[
    ("packages/subr.ts", include_str!("../../../packages/subr.ts")),
    ("packages/simple.ts", include_str!("../../../packages/simple.ts")),
    ("packages/bindings.ts", include_str!("../../../packages/bindings.ts")),
    ("packages/iso-transl.ts", include_str!("../../../packages/iso-transl.ts")),
    ("packages/paragraphs.ts", include_str!("../../../packages/paragraphs.ts")),
    ("packages/page.ts", include_str!("../../../packages/page.ts")),
    ("packages/indent.ts", include_str!("../../../packages/indent.ts")),
    ("packages/fill.ts", include_str!("../../../packages/fill.ts")),
    ("packages/newcomment.ts", include_str!("../../../packages/newcomment.ts")),
    ("packages/lisp.ts", include_str!("../../../packages/lisp.ts")),
    ("packages/paren.ts", include_str!("../../../packages/paren.ts")),
    ("packages/display-line-numbers.ts", include_str!("../../../packages/display-line-numbers.ts")),
    ("packages/mule.ts", include_str!("../../../packages/mule.ts")),
    ("packages/mule-diag.ts", include_str!("../../../packages/mule-diag.ts")),
    ("packages/files.ts", include_str!("../../../packages/files.ts")),
    ("packages/text-mode.ts", include_str!("../../../packages/text-mode.ts")),
    ("packages/face-remap.ts", include_str!("../../../packages/face-remap.ts")),
    ("packages/case-table.ts", include_str!("../../../packages/case-table.ts")),
    ("packages/outline.ts", include_str!("../../../packages/outline.ts")),
    ("packages/prog-mode.ts", include_str!("../../../packages/prog-mode.ts")),
    ("packages/imenu.ts", include_str!("../../../packages/imenu.ts")),
    ("packages/treesit.ts", include_str!("../../../packages/treesit.ts")),
    ("packages/treesit-modes.ts", include_str!("../../../packages/treesit-modes.ts")),
    ("packages/delsel.ts", include_str!("../../../packages/delsel.ts")),
    ("packages/elec-pair.ts", include_str!("../../../packages/elec-pair.ts")),
    ("packages/help.ts", include_str!("../../../packages/help.ts")),
    ("packages/faces.ts", include_str!("../../../packages/faces.ts")),
    ("packages/image.ts", include_str!("../../../packages/image.ts")),
    ("packages/repeat.ts", include_str!("../../../packages/repeat.ts")),
    ("packages/kmacro.ts", include_str!("../../../packages/kmacro.ts")),
    ("packages/window.ts", include_str!("../../../packages/window.ts")),
    ("packages/mouse.ts", include_str!("../../../packages/mouse.ts")),
    ("packages/isearch.ts", include_str!("../../../packages/isearch.ts")),
    ("packages/icomplete.ts", include_str!("../../../packages/icomplete.ts")),
    ("packages/recentf.ts", include_str!("../../../packages/recentf.ts")),
    ("packages/savehist.ts", include_str!("../../../packages/savehist.ts")),
    ("packages/saveplace.ts", include_str!("../../../packages/saveplace.ts")),
    ("packages/ffap.ts", include_str!("../../../packages/ffap.ts")),
    ("packages/dired.ts", include_str!("../../../packages/dired.ts")),
    ("packages/compile.ts", include_str!("../../../packages/compile.ts")),
    ("packages/ansi-color.ts", include_str!("../../../packages/ansi-color.ts")),
    ("packages/comint.ts", include_str!("../../../packages/comint.ts")),
    ("packages/shell.ts", include_str!("../../../packages/shell.ts")),
    ("packages/xref.ts", include_str!("../../../packages/xref.ts")),
    ("packages/project.ts", include_str!("../../../packages/project.ts")),
    ("packages/replace.ts", include_str!("../../../packages/replace.ts")),
    ("packages/sort.ts", include_str!("../../../packages/sort.ts")),
    ("packages/rect.ts", include_str!("../../../packages/rect.ts")),
    ("packages/register.ts", include_str!("../../../packages/register.ts")),
    ("packages/dabbrev.ts", include_str!("../../../packages/dabbrev.ts")),
    ("packages/tabulated-list.ts", include_str!("../../../packages/tabulated-list.ts")),
    ("packages/buff-menu.ts", include_str!("../../../packages/buff-menu.ts")),
    ("packages/hi-lock.ts", include_str!("../../../packages/hi-lock.ts")),
    ("packages/bookmark.ts", include_str!("../../../packages/bookmark.ts")),
    ("packages/misc.ts", include_str!("../../../packages/misc.ts")),
    ("packages/whitespace.ts", include_str!("../../../packages/whitespace.ts")),
    ("packages/view.ts", include_str!("../../../packages/view.ts")),
    ("packages/diff.ts", include_str!("../../../packages/diff.ts")),
    ("packages/abbrev.ts", include_str!("../../../packages/abbrev.ts")),
    ("packages/org-macs.ts", include_str!("../../../packages/org-macs.ts")),
    ("packages/org-table.ts", include_str!("../../../packages/org-table.ts")),
    ("packages/org.ts", include_str!("../../../packages/org.ts")),
    ("packages/org-agenda.ts", include_str!("../../../packages/org-agenda.ts")),
    ("packages/org-capture.ts", include_str!("../../../packages/org-capture.ts")),
];

/// How long a script may run before it is stopped, unless changed with
/// [`Scripting::set_time_limit`]: a backstop for a script that ignores
/// `C-g`, which quits it at its next call into the editor or loop check.
pub const DEFAULT_TIME_LIMIT: Duration = Duration::from_secs(60);

/// How many times `C-g` stops a script that has not answered it: the
/// emergency exit, which runs none of its `finally` blocks.
const QUITS_TO_STOP: u32 = 3;

thread_local! {
    /// The editor that host functions act on, set while a script runs. See [`enter`].
    static EDITOR: Cell<Option<NonNull<Editor>>> = const { Cell::new(None) };
    /// The context of the script that is running, if any.
    static ACTIVE: Cell<Option<NonNull<qjs::JSContext>>> = const { Cell::new(None) };
    /// When the outermost running script must stop.
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
    static TIME_LIMIT: Cell<Duration> = const { Cell::new(DEFAULT_TIME_LIMIT) };
    /// The running editor's quit flag, which the interrupt handler reads.
    static QUITTING: RefCell<Option<std::sync::Arc<ember_core::QuitState>>> = const { RefCell::new(None) };
    /// Whether the outermost script was stopped by `C-g` rather than the time limit.
    static STOPPED_BY_QUIT: Cell<bool> = const { Cell::new(false) };
    /// Whether the outermost script was stopped without unwinding, so what
    /// it bound is restored from the binding stack.
    static STOPPED: Cell<bool> = const { Cell::new(false) };
    /// Files being loaded, innermost last, so commands know where they were defined.
    static LOADING: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The contexts of the scripts running, innermost last, for functions
    /// made into editor values to call back into.
    static CONTEXTS: RefCell<Vec<Context>> = const { RefCell::new(Vec::new()) };
    /// Promises rejected with no handler yet, and why: an async command's
    /// error, reported once the code that settled it has finished.
    static UNHANDLED: RefCell<Vec<(Persistent<Value<'static>>, Persistent<Value<'static>>)>> = const { RefCell::new(Vec::new()) };
}

/// The JavaScript runtime and the `ember` API. Clones share one runtime.
#[derive(Clone)]
pub struct Scripting {
    context: Context,
}

impl Scripting {
    /// Starts a runtime, installs the `ember` global, adds the script commands
    /// `load-file` and `eval-expression` (M-:) to the editor, and loads the
    /// packages that ship with Ember.
    pub fn new(ed: &mut Editor) -> Result<Scripting> {
        let (scripting, failures) = Scripting::start(ed)?;
        match failures.into_iter().next() {
            Some(e) => Err(e),
            None => Ok(scripting),
        }
    }

    /// As [`Scripting::new`], but a package that fails to load is left
    /// out and the rest load, as an error in one Lisp file leaves Emacs
    /// running: returns the failures, for the front ends to show.
    pub fn start(ed: &mut Editor) -> Result<(Scripting, Vec<Error>)> {
        let runtime = Runtime::new().map_err(|e| Error::new(e.to_string()))?;
        runtime.set_loader(PackageResolver, PackageLoader);
        runtime.set_interrupt_handler(Some(Box::new(|| {
            // C-g pressed again and again while the script went on, or the time limit.
            let quit = QUITTING.with_borrow(|q| q.as_ref().is_some_and(|q| q.presses() >= QUITS_TO_STOP));
            if quit {
                STOPPED_BY_QUIT.set(true);
            }
            let stop = quit || DEADLINE.get().is_some_and(|deadline| Instant::now() > deadline);
            if stop {
                STOPPED.set(true);
            }
            stop
        })));
        runtime.set_host_promise_rejection_tracker(Some(Box::new(|ctx, promise, reason, handled| {
            UNHANDLED.with_borrow_mut(|unhandled| {
                if handled {
                    unhandled.retain(|(p, _)| p.clone().restore(&ctx).map_or(true, |p| p != promise));
                } else {
                    unhandled.push((Persistent::save(&ctx, promise), Persistent::save(&ctx, reason)));
                }
            })
        })));
        let context = Context::full(&runtime).map_err(|e| Error::new(e.to_string()))?;
        let scripting = Scripting { context };
        let context = scripting.context.clone();
        enter(&scripting.context, ed, |ctx| {
            install_native(&ctx, &context).map_err(|e| js_error(&ctx, e))?;
            ctx.eval_with_options::<(), _>(PRELUDE, eval_options("ember:prelude"))
                .map_err(|e| js_error(&ctx, e))
        })?;
        scripting.define_commands(ed);
        let mut failures = Vec::new();
        // Each package is an ES module, imported in this order; one that
        // imports another not yet loaded loads it first, as require does.
        for (name, _) in PACKAGES {
            LOADING.with_borrow_mut(|files| files.push(name.to_string()));
            let result = enter(&scripting.context, ed, |ctx| {
                rquickjs::Module::import(&ctx, *name)
                    .and_then(|promise| promise.finish::<Value>())
                    .map(drop)
                    .map_err(|e| js_error_with_location(&ctx, e))
            });
            if let Err(e) = result {
                failures.push(e);
            }
            LOADING.with_borrow_mut(|files| files.pop());
        }
        Ok((scripting, failures))
    }

    /// Changes how long a script may run before it is stopped.
    pub fn set_time_limit(&self, limit: Duration) {
        TIME_LIMIT.set(limit);
    }

    /// Runs a TypeScript file as a script.
    pub fn load_file(&self, ed: &mut Editor, path: &Path) -> Result<()> {
        let name = abbreviate_path(path);
        let source = fs::read_to_string(path).map_err(|e| Error::new(format!("{name}: {e}")))?;
        LOADING.with_borrow_mut(|files| files.push(name.clone()));
        let result = self.eval_typescript(ed, &name, source);
        LOADING.with_borrow_mut(|files| files.pop());
        result
    }

    /// Runs TypeScript source as a script. `filename` is used in error locations.
    ///
    /// Each script runs in its own block scope, so its top-level `const` and
    /// `let` do not clash with other scripts or with an earlier load of the
    /// same file. The opening brace shares line 1, so line numbers are unchanged.
    pub fn eval_typescript(&self, ed: &mut Editor, filename: &str, source: String) -> Result<()> {
        let js = format!("{{{}\n}}", strip_types(filename, source)?);
        enter(&self.context, ed, |ctx| {
            ctx.eval_with_options::<(), _>(js, eval_options(filename))
                .map_err(|e| js_error_with_location(&ctx, e))
        })
    }

    /// Evaluates a TypeScript expression and returns its value as JSON, or
    /// `undefined`, as M-: does.
    pub fn eval_expression(&self, ed: &mut Editor, source: &str) -> Result<String> {
        let js = strip_types("expression", format!("({source}\n)"))?;
        enter(&self.context, ed, |ctx| {
            let value: Value = ctx
                .eval_with_options(js, eval_options("expression"))
                .map_err(|e| js_error(&ctx, e))?;
            match ctx.json_stringify(value).map_err(|e| js_error(&ctx, e))? {
                Some(json) => json.to_string().map_err(|e| js_error(&ctx, e)),
                None => Ok("undefined".to_string()),
            }
        })
    }

    fn define_commands(&self, ed: &mut Editor) {
        let scripting = self.clone();
        ed.define_command(
            Command::new(
                "load-file",
                "Run a TypeScript file, such as init.ts after editing it.\n\nCommands it defines replace existing commands with the same name.",
                move |ed, args| {
                    let path = expand_file_name(args[0].as_str()?);
                    ed.check_permission(&format!("run the TypeScript in {}", abbreviate_path(&path)))?;
                    scripting.load_file(ed, &path)?;
                    ed.message(format!("Loaded {}", abbreviate_path(&path)));
                    Ok(())
                },
            )
            .param("file", ParamKind::File, "Load file: "),
        );
        let scripting = self.clone();
        ed.define_command(
            Command::new(
                "eval-expression",
                "Evaluate a TypeScript expression and show its value.\n\nThe `ember` API is available, as in init.ts.",
                move |ed, args| {
                    ed.check_permission("run TypeScript")?;
                    let value = scripting.eval_expression(ed, args[0].as_str()?)?;
                    ed.message(value);
                    Ok(())
                },
            )
            .param("expression", ParamKind::String, "Eval: "),
        );
        let map = ed.global_map();
        ed.keymaps_mut().bind_str(map, "M-:", "eval-expression");
    }
}

fn eval_options(filename: &str) -> EvalOptions {
    let mut options = EvalOptions::default();
    options.global = true;
    options.strict = true;
    options.filename = Some(filename.to_string());
    options
}

/// Sets a thread-local cell and puts the old value back when dropped, even on panic.
struct Restore<T: Copy + 'static> {
    cell: &'static LocalKey<Cell<T>>,
    old: T,
}

impl<T: Copy + 'static> Restore<T> {
    fn set(cell: &'static LocalKey<Cell<T>>, value: T) -> Restore<T> {
        Restore { cell, old: cell.replace(value) }
    }
}

impl<T: Copy + 'static> Drop for Restore<T> {
    fn drop(&mut self) {
        self.cell.set(self.old);
    }
}

/// Takes the running script's context off [`CONTEXTS`] when dropped.
struct Popped;

impl Drop for Popped {
    fn drop(&mut self) {
        CONTEXTS.with_borrow_mut(|c| c.pop());
    }
}

/// Runs `f` in the script context, giving host functions access to `ed`.
///
/// QuickJS's runtime lock is not reentrant. When a script calls a command
/// that runs another script command, the nested call reuses the context of
/// the script that is already running instead of locking it again.
fn enter<R>(context: &Context, ed: &mut Editor, f: impl for<'js> FnOnce(Ctx<'js>) -> Result<R>) -> Result<R> {
    let _editor = Restore::set(&EDITOR, Some(NonNull::from(ed)));
    match ACTIVE.get() {
        Some(raw) if raw == context.as_raw() => {
            // SAFETY: ACTIVE is only set inside `Context::with` below, so the
            // runtime lock is held, and it is this context's runtime.
            let ctx = unsafe { Ctx::from_raw(raw) };
            // A command run while a prompt waits gets a time limit of its
            // own, as waiting cleared the asker's.
            let _deadline = DEADLINE.get().is_none().then(|| Restore::set(&DEADLINE, Some(Instant::now() + TIME_LIMIT.get())));
            let result = f(ctx.clone());
            // A prompt answered from code already running, as keys a macro
            // replays, lets its command carry on here, where Emacs's would,
            // rather than once all the code has finished. Rejections nothing
            // handles are reported by the outermost call.
            while ctx.execute_pending_job() {}
            result
        }
        _ => context.with(|ctx| {
            CONTEXTS.with_borrow_mut(|c| c.push(context.clone()));
            let _context = Popped;
            let _active = Restore::set(&ACTIVE, Some(ctx.as_raw()));
            let _deadline = Restore::set(&DEADLINE, Some(Instant::now() + TIME_LIMIT.get()));
            let state = with_editor_ref(|ed| ed.quit_state().clone());
            let previous = QUITTING.with_borrow_mut(|q| std::mem::replace(q, state));
            let _quitting = scopeguard_quitting(previous);
            STOPPED_BY_QUIT.set(false);
            STOPPED.set(false);
            let depth = with_editor_ref(|ed| ed.specpdl_depth()).unwrap_or(0);
            let result = f(ctx.clone());
            if STOPPED.get() {
                // Stopped where no finally ran: restore what it bound, as
                // Emacs's emergency escape unwinds to top level.
                if let Some(ptr) = EDITOR.get() {
                    // SAFETY: as in `with_editor`; the script has stopped.
                    unsafe { &mut *ptr.as_ptr() }.unbind_to(depth);
                }
            }
            // What waits on promises settled meanwhile runs now, before the
            // editor goes on: an async command awaiting a prompt carries on
            // as soon as the answer comes.
            while ctx.execute_pending_job() {}
            let unhandled = UNHANDLED.take();
            match (result, unhandled.into_iter().next()) {
                (Ok(_), Some((_, reason))) => Err(rejection_error(&ctx, reason)),
                (result, _) => result,
            }
        }),
    }
}

/// A script's arguments for a command, as the command's parameters take
/// them: numbers for counts and positions, Emacs's forms for a prefix
/// argument, and text, from which any of them can be read too.
fn command_args(ed: &Editor, name: &str, args: Vec<natives::ArgText>) -> Result<Vec<Arg>> {
    let command = ed.command(name).ok_or_else(|| Error::new(format!("No such command: {name}")))?;
    args.into_iter()
        .enumerate()
        .map(|(i, text)| Arg::from_text(command.params.get(i).map_or(ParamKind::String, |p| p.kind), &text.0))
        .collect()
}

/// A command's argument as a script's command gets it.
fn arg_to_js<'js>(ctx: &Ctx<'js>, arg: &Arg) -> rquickjs::Result<Value<'js>> {
    match arg {
        Arg::Int(n) => Ok(Value::new_number(ctx.clone(), *n as f64)),
        Arg::Prefix(prefix) => prefix_to_js(ctx, *prefix),
        other => Ok(rquickjs::String::from_str(ctx.clone(), &other.to_string())?.into_value()),
    }
}

/// The running editor's quit flag, read at the outermost entry.
fn with_editor_ref<T>(f: impl FnOnce(&Editor) -> T) -> Option<T> {
    // SAFETY: as in `with_editor`; only read, before the script runs.
    EDITOR.get().map(|ptr| f(unsafe { ptr.as_ref() }))
}

/// Runs `f`, which waits for input, with the script's time limit stopped:
/// the time the person takes to answer is not the script's (ADR 0053).
fn waiting<T>(f: impl FnOnce() -> T) -> T {
    let deadline = DEADLINE.take();
    let result = f();
    DEADLINE.set(deadline.map(|_| Instant::now() + TIME_LIMIT.get()));
    result
}

/// Puts back the quit flag the interrupt handler read before a script ran.
struct QuittingRestore(Option<std::sync::Arc<ember_core::QuitState>>);

impl Drop for QuittingRestore {
    fn drop(&mut self) {
        let previous = self.0.take();
        QUITTING.with_borrow_mut(|q| *q = previous);
    }
}

fn scopeguard_quitting(previous: Option<std::sync::Arc<ember_core::QuitState>>) -> QuittingRestore {
    QuittingRestore(previous)
}

/// Gives a host function the editor, turning editor errors into script
/// exceptions. Every call is a safe point: a quit asked for since the
/// script last called in is signalled here, as `quit`, which the script
/// can catch, as Lisp's primitives check `quit-flag`.
fn with_editor<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    let Some(ptr) = EDITOR.get() else {
        return Err(Exception::throw_internal(ctx, "No editor is active"));
    };
    // SAFETY: `enter` set this from a live `&mut Editor` that is not used
    // while the script runs, and restores the previous value afterwards.
    let ed = unsafe { &mut *ptr.as_ptr() };
    if let Err(e) = ed.maybe_quit() {
        return Err(throw_error(ctx, &e));
    }
    let result = f(ed);
    // What the call changed in a buffer sharing its text, the others see.
    ed.sync_shared_text();
    result.map_err(|e| throw_error(ctx, &e))
}

/// As [`with_editor`], but not a safe point: for natives that run while a
/// quit unwinds, as `unbind`, or that read the quit flag themselves.
fn with_editor_unchecked<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    let Some(ptr) = EDITOR.get() else {
        return Err(Exception::throw_internal(ctx, "No editor is active"));
    };
    // SAFETY: as in `with_editor`.
    let ed = unsafe { &mut *ptr.as_ptr() };
    let result = f(ed);
    ed.sync_shared_text();
    result.map_err(|e| throw_error(ctx, &e))
}

/// Throws a core error to a script as an Error carrying its condition, as
/// Emacs's signal: `.symbol`, `.data` and `.conditions`, for conditionCase.
fn throw_error(ctx: &Ctx<'_>, e: &Error) -> rquickjs::Error {
    let exception = match Exception::from_message(ctx.clone(), e.message()) {
        Ok(exception) => exception,
        Err(err) => return err,
    };
    let data: Vec<Value> = e.data().iter().filter_map(|v| value_to_js(ctx, v).ok()).collect();
    let _ = exception.set("symbol", e.symbol());
    let _ = exception.set("data", data);
    let _ = exception.set("conditions", ember_core::error_conditions(e.symbol()));
    ctx.throw(exception.into_value())
}

/// A script function the editor holds on to, as a command or a hook function.
struct ScriptFunction {
    // Declared before `context` so the function is freed before the runtime can be.
    run: Persistent<Function<'static>>,
    context: Context,
}

impl ScriptFunction {
    /// Runs the function as a command, with its arguments as scripts take them.
    fn call(&self, ed: &mut Editor, args: &[Arg]) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            let args = args.iter().map(|a| arg_to_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>().map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Value>((Rest(args),))
                .map(drop)
                .map_err(|e| js_error(&ctx, e))
        })
    }

    fn into_command(self) -> impl Fn(&mut Editor, &[Arg]) -> Result<()> {
        move |ed, args| self.call(ed, args)
    }

    /// Calls the function with editor values and returns what it returns,
    /// as a function value's call; what is not an editor value, such as an object, is t.
    fn call_returning(&self, ed: &mut Editor, args: &[EditorValue]) -> Result<EditorValue> {
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            let args = args
                .iter()
                .map(|a| value_to_js(&ctx, a))
                .collect::<rquickjs::Result<Vec<_>>>()
                .map_err(|e| js_error(&ctx, e))?;
            let value: Value = run.call((Rest(args),)).map_err(|e| js_error(&ctx, e))?;
            // What is no editor value, such as an object, is still not nil: t.
            convert_from_js(&ctx, value).map(|v| v.unwrap_or(EditorValue::Bool(true))).map_err(|e| js_error(&ctx, e))
        })
    }

    /// Calls the function with the arguments read so far, for the names it
    /// returns, as a parameter's collection.
    fn call_for_names(&self, ed: &mut Editor, args: &[Arg]) -> Result<Vec<String>> {
        let args: Vec<String> = args.iter().map(Arg::to_string).collect();
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Vec<Coerced<String>>>((Rest(args),)).map(|v| v.into_iter().map(|s| s.0).collect()).map_err(|e| js_error(&ctx, e))
        })
    }

    /// Calls the function with the arguments read so far, for the text it
    /// returns, as a parameter's prompt.
    fn call_for_text(&self, ed: &mut Editor, args: &[Arg]) -> Result<String> {
        let args: Vec<String> = args.iter().map(Arg::to_string).collect();
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Coerced<String>>((Rest(args),)).map(|s| s.0).map_err(|e| js_error(&ctx, e))
        })
    }
}

fn install_native<'js>(ctx: &Ctx<'js>, context: &Context) -> rquickjs::Result<()> {
    let native = Object::new(ctx.clone())?;
    let api = Object::new(ctx.clone())?;
    natives::install(ctx, &native, &api)?;
    ctx.globals().set("__emberApi", api)?;
    // The one native that needs the engine itself: a command keeps the
    // script's functions for its prompts, collections and starting input.
    let context = context.clone();
    native.set(
        "defineCommand",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, name: String, doc: String, params: Vec<Object<'js>>, run: Function<'js>, shift_select: Opt<bool>| {
                let script = ScriptFunction { run: Persistent::save(&ctx, run), context: context.clone() };
                let mut command = Command::new(&name, &doc, script.into_command());
                command.shift_select = shift_select.0 == Some(true);
                command.source = LOADING.with_borrow(|files| files.last().cloned());
                for param in params {
                    let param_name: String = param.get("name")?;
                    let kind: String = param.get("kind")?;
                    let prompt_value: Value = param.get("prompt")?;
                    let prompt_fn = prompt_value.as_function().map(|f| ScriptFunction { run: Persistent::save(&ctx, f.clone()), context: context.clone() });
                    let prompt: String = if prompt_fn.is_some() { String::new() } else { param.get("prompt")? };
                    let Some(kind) = ParamKind::from_name(&kind) else {
                        let kinds: Vec<&str> = ParamKind::ALL.iter().map(ParamKind::name).collect();
                        let message = format!("Unknown parameter kind {kind:?}; use one of {}", kinds.join(", "));
                        return Err(Exception::throw_type(&ctx, &message));
                    };
                    command = command.param(&param_name, kind, &prompt);
                    if let Some(f) = prompt_fn {
                        command = command.prompt_with(move |ed, args| f.call_for_text(ed, args));
                    }
                    let collection: Value = param.get("collection")?;
                    if let Some(f) = collection.as_function() {
                        let f = ScriptFunction { run: Persistent::save(&ctx, f.clone()), context: context.clone() };
                        let require_match = param.get::<_, Option<bool>>("requireMatch")?.unwrap_or(false);
                        command = command.collection(require_match, move |ed, args| f.call_for_names(ed, args));
                    }
                    let initial: Value = param.get("initial")?;
                    if let Some(f) = initial.as_function() {
                        let f = ScriptFunction { run: Persistent::save(&ctx, f.clone()), context: context.clone() };
                        command = command.initial_with(move |ed, args| f.call_for_text(ed, args));
                    } else if let Some(text) = initial.as_string() {
                        let text = text.to_string()?;
                        command = command.initial_with(move |_, _| Ok(text.clone()));
                    }
                    if let Some(history) = param.get::<_, Option<String>>("history")? {
                        command = command.history(&history);
                    }
                }
                with_editor(&ctx, |ed| {
                    ed.define_command(command);
                    Ok(())
                })
            },
        )?,
    )?;
    ctx.globals().set("__ember", native)
}

/// A match as a script sees it: `{ start, end, groups }`.
fn match_to_js<'js>(ctx: &Ctx<'js>, m: &ember_core::Match) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    object.set("start", m.start)?;
    object.set("end", m.end)?;
    let groups: Vec<Option<Vec<usize>>> = m.groups.iter().map(|g| g.map(|(s, e)| vec![s, e])).collect();
    object.set("groups", groups)?;
    Ok(object)
}

/// Where a line starts and ends within the accessible portion, as Emacs's
/// `line-beginning-position` and `line-end-position` stop at `point-min`
/// and `point-max` in a narrowed buffer: a line the narrowing cuts through
/// is only its accessible part. A line wholly outside is left whole, as
/// code that looks there is looking past the buffer's ends.
fn accessible_line(b: &ember_core::Buffer, line: usize) -> (usize, usize) {
    let line = line.min(b.line_count() - 1);
    let (start, end) = (b.line_start(line), b.line_end(line));
    let (min, max) = (b.point_min(), b.point_max());
    if end < min || start > max {
        return (start, end);
    }
    let start = start.clamp(min, max);
    (start, end.clamp(start, max))
}

fn props_to_js<'js>(ctx: &Ctx<'js>, props: &ember_core::Props) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    for (name, value) in props {
        object.set(name.as_str(), value_to_js(ctx, value)?)?;
    }
    Ok(object)
}

/// The Emacs attribute a script's face attribute key stands for: `weight`
/// is `:weight`, `inverseVideo` `:inverse-video`, and `bold`, `italic` and
/// `strike` are shorthands for `:weight bold`, `:slant italic` and
/// `:strike-through`.
fn face_attribute_key(key: &str) -> String {
    match key {
        "strike" => ":strike-through".into(),
        _ if key.starts_with(':') => key.into(),
        _ => {
            let mut out = String::from(":");
            for c in key.chars() {
                if c.is_ascii_uppercase() {
                    out.push('-');
                    out.push(c.to_ascii_lowercase());
                } else {
                    out.push(c);
                }
            }
            out
        }
    }
}

/// A face attribute's key as scripts give it: `:inverse-video` is `inverseVideo`.
fn camel_key(key: &str) -> String {
    let mut name = String::new();
    let mut upper = false;
    for c in key.trim_start_matches(':').chars() {
        if c == '-' {
            upper = true;
        } else {
            name.push(if upper { c.to_ascii_uppercase() } else { c });
            upper = false;
        }
    }
    name
}

/// Face attributes from an object such as `{ foreground: "accent", weight:
/// "bold", underline: { color: "red", style: "wave" } }`, each value as
/// Emacs gives it, an object standing for a plist.
fn face_attrs_from_js<'js>(object: &Object<'js>) -> rquickjs::Result<FaceAttrs> {
    let mut attrs = FaceAttrs::default();
    for (key, value) in face_attr_values_from_js(object)? {
        attrs.set(&key, &value);
    }
    Ok(attrs)
}

/// Each attribute in such an object, as its Emacs name and value.
fn face_attr_values_from_js<'js>(object: &Object<'js>) -> rquickjs::Result<Vec<(String, EditorValue)>> {
    let ctx = object.ctx().clone();
    let mut values = Vec::new();
    for key in object.keys::<String>() {
        let key = key?;
        let value: Value<'js> = object.get(&key)?;
        if value.is_undefined() {
            continue;
        }
        let value = match value.as_object() {
            Some(inner) if !value.is_array() && !value.is_function() && value.as_string().is_none() => {
                let mut plist = Vec::new();
                for k in inner.keys::<String>() {
                    let k = k?;
                    let v: Value<'js> = inner.get(&k)?;
                    plist.push(EditorValue::Symbol(face_attribute_key(&k)));
                    plist.push(value_from_js(&ctx, v)?);
                }
                EditorValue::List(plist)
            }
            _ => value_from_js(&ctx, value)?,
        };
        values.push((face_attribute_key(&key), value));
    }
    Ok(values)
}

/// A place in a window as scripts see it, as Emacs's posn: the window,
/// the buffer position, x and y from the top left of the text area, and
/// the column and row in default characters; undefined for none.
fn posn_to_js<'js>(ctx: &Ctx<'js>, posn: Option<ember_core::layout::Posn>) -> rquickjs::Result<Value<'js>> {
    let Some(posn) = posn else { return Ok(Value::new_undefined(ctx.clone())) };
    let object = Object::new(ctx.clone())?;
    object.set("window", posn.window)?;
    object.set("point", posn.point)?;
    object.set("x", posn.x as f64)?;
    object.set("y", posn.y as f64)?;
    object.set("col", posn.col as f64)?;
    object.set("row", posn.row)?;
    Ok(object.into_value())
}

/// Face attributes as scripts see them: an object of the attributes that
/// are set, keyed as scripts give them (`weight`, `inverseVideo`), each
/// value as Emacs's `face-attribute` gives it, with `bold` and `italic`
/// added where the weight and slant say so.
fn face_attrs_to_js<'js>(ctx: &Ctx<'js>, attrs: &FaceAttrs) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    let plist = attrs.to_plist();
    for pair in plist.chunks(2) {
        let [key, value] = pair else { break };
        let Some(key) = key.as_str() else { continue };
        object.set(camel_key(key).as_str(), plist_or_value_to_js(ctx, value)?)?;
    }
    if attrs.is_bold() {
        object.set("bold", true)?;
    }
    if attrs.is_italic() {
        object.set("italic", true)?;
    }
    Ok(object)
}

/// A face attribute's value as scripts see it: a plist such as an
/// underline's `(:color "red" :style wave)` as an object, `{ color: "red",
/// style: "wave" }`, anything else as it is.
fn plist_or_value_to_js<'js>(ctx: &Ctx<'js>, value: &EditorValue) -> rquickjs::Result<Value<'js>> {
    let EditorValue::List(items) = value else { return value_to_js(ctx, value) };
    if !items.first().and_then(EditorValue::as_str).is_some_and(|k| k.starts_with(':')) {
        return value_to_js(ctx, value);
    }
    let object = Object::new(ctx.clone())?;
    for pair in items.chunks(2) {
        let [key, v] = pair else { break };
        let Some(key) = key.as_str() else { continue };
        object.set(camel_key(key).as_str(), value_to_js(ctx, v)?)?;
    }
    Ok(object.into_value())
}

/// A variable's value as scripts see it: null, a boolean, a number, a string or an array.
fn value_to_js<'js>(ctx: &Ctx<'js>, value: &EditorValue) -> rquickjs::Result<Value<'js>> {
    Ok(match value {
        EditorValue::Null => Value::new_null(ctx.clone()),
        EditorValue::Bool(b) => Value::new_bool(ctx.clone(), *b),
        EditorValue::Number(n) => Value::new_number(ctx.clone(), *n),
        EditorValue::Str(s) => rquickjs::String::from_str(ctx.clone(), s)?.into_value(),
        EditorValue::List(items) => {
            let list = rquickjs::Array::new(ctx.clone())?;
            for (i, item) in items.iter().enumerate() {
                list.set(i, value_to_js(ctx, item)?)?;
            }
            list.into_value()
        }
        EditorValue::Function(function) => function_to_js(ctx, function)?,
        // The prelude's object for the buffer, the same one each time.
        EditorValue::Buffer(id) => {
            let make: Function = ctx.globals().get("__emberBuffer")?;
            make.call((*id as f64,))?
        }
        // The prelude's object for the keymap, the same one each time.
        EditorValue::Keymap(id) => {
            let make: Function = ctx.globals().get("__emberKeymap")?;
            make.call((*id as f64,))?
        }
        // And for the char-table.
        EditorValue::CharTable(id) => {
            let make: Function = ctx.globals().get("__emberCharTable")?;
            make.call((*id as f64,))?
        }
        // The prelude's objects for tree-sitter parsers and nodes.
        EditorValue::Treesit(object) => {
            let make: Function = ctx.globals().get("__emberTreesit")?;
            let (kind, raw): (&str, Vec<f64>) = match object {
                ember_core::treesitfns::TsObject::Parser { buffer, parser } => ("parser", vec![*buffer as f64, *parser as f64]),
                ember_core::treesitfns::TsObject::Node(r) => {
                    ("node", [r.buffer as f64, r.parser as f64, r.generation as f64].into_iter().chain(r.path.iter().map(|&i| i as f64)).collect())
                }
            };
            make.call((kind, raw))?
        }
        // The prelude's Font, holding its kind and its properties.
        EditorValue::Font(font) => {
            let make: Function = ctx.globals().get("__emberFont")?;
            let plist = value_to_js(ctx, &EditorValue::List(font.to_plist()))?;
            make.call((font.kind.name(), plist))?
        }
        // The prelude's Marker for the id, the one the value was made from.
        EditorValue::Marker(id) => {
            let make: Function = ctx.globals().get("__emberMarker")?;
            make.call((*id as f64,))?
        }
        // A symbol is JavaScript's registered symbol of its name, interned as Emacs's are.
        EditorValue::Symbol(name) => {
            let symbol: Object = ctx.globals().get("Symbol")?;
            let make: Function = symbol.get("for")?;
            make.call((name.as_str(),))?
        }
        // The prelude's PropertizedString, with its runs as [start, end, properties].
        EditorValue::Text(text) => {
            let runs = rquickjs::Array::new(ctx.clone())?;
            for (i, (range, props)) in text.props.iter().enumerate() {
                let object = Object::new(ctx.clone())?;
                for (name, value) in props {
                    object.set(name.as_str(), value_to_js(ctx, value)?)?;
                }
                let run = rquickjs::Array::new(ctx.clone())?;
                run.set(0, range.start as f64)?;
                run.set(1, range.end as f64)?;
                run.set(2, object)?;
                runs.set(i, run)?;
            }
            let make: Function = ctx.globals().get("__emberText")?;
            make.call((text.string.as_str(), runs))?
        }
    })
}

/// The property a buffer object keeps its buffer's id in.
const BUFFER_ID: &str = "__emberBufferId";

/// A string or propertized string from a script, as text to insert.
fn text_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<ember_core::Text> {
    Ok(match value_from_js(ctx, value)? {
        EditorValue::Text(text) => text,
        other => ember_core::Text { string: other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string()), props: Vec::new() },
    })
}

/// The property a script function keeps its editor identity in, so the
/// same function passed twice is one value, as one lambda is `eq` to itself.
const FUNCTION_ID: &str = "__emberFunctionId";

/// A function value as a script sees it: a script's own function given
/// back as itself, and any other as a function that calls it.
fn function_to_js<'js>(ctx: &Ctx<'js>, function: &ember_core::Function) -> rquickjs::Result<Value<'js>> {
    if let Some(script) = function.origin().and_then(|o| o.downcast_ref::<ScriptFunction>())
        && let Ok(f) = script.run.clone().restore(ctx)
    {
        return Ok(f.into_value());
    }
    let call = function.clone();
    let js = Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
        let args = args.0.into_iter().map(|a| value_from_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>()?;
        let result = with_editor(&ctx, |ed| call.call(ed, &args))?;
        value_to_js(&ctx, &result)
    })?;
    js.set(FUNCTION_ID, function.id() as f64)?;
    if let Some(name) = function.name() {
        let _ = js.set("displayName", name);
    }
    Ok(js.into_value())
}

/// A script's function as an editor value, keeping the identity it had
/// the last time it was one.
fn function_from_js<'js>(ctx: &Ctx<'js>, f: Function<'js>) -> rquickjs::Result<EditorValue> {
    let Some(context) = CONTEXTS.with_borrow(|c| c.last().cloned()) else {
        return Err(Exception::throw_internal(ctx, "No script is running"));
    };
    let known: Option<f64> = f.get(FUNCTION_ID)?;
    let name: Option<String> = f.get::<_, Option<Coerced<String>>>("name").ok().flatten().map(|n| n.0).filter(|n| !n.is_empty());
    let script = Rc::new(ScriptFunction { run: Persistent::save(ctx, f.clone()), context });
    let call = script.clone();
    let function = ember_core::Function::new(name.as_deref(), move |ed, args| call.call_returning(ed, args)).with_origin(script);
    Ok(EditorValue::Function(match known {
        Some(id) => function.with_id(id as u64),
        None => {
            f.set(FUNCTION_ID, function.id() as f64)?;
            function
        }
    }))
}

fn value_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<EditorValue> {
    match convert_from_js(ctx, value)? {
        Some(value) => Ok(value),
        None => Err(Exception::throw_type(
            ctx,
            "A variable holds null, a boolean, a number, a string, a function, or an array of these",
        )),
    }
}

/// A script value as an editor value, or `None` if it is not one, such as an object.
fn convert_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Option<EditorValue>> {
    if value.is_null() || value.is_undefined() {
        return Ok(Some(EditorValue::Null));
    }
    if let Some(b) = value.as_bool() {
        return Ok(Some(EditorValue::Bool(b)));
    }
    if let Some(n) = value.as_number() {
        return Ok(Some(EditorValue::Number(n)));
    }
    if let Some(s) = value.as_string() {
        return Ok(Some(EditorValue::Str(s.to_string()?)));
    }
    if let Some(list) = value.as_array() {
        let mut items = Vec::with_capacity(list.len());
        for i in 0..list.len() {
            match convert_from_js(ctx, list.get(i)?)? {
                Some(item) => items.push(item),
                None => return Ok(None),
            }
        }
        return Ok(Some(EditorValue::List(items)));
    }
    if let Some(f) = value.as_function() {
        return function_from_js(ctx, f.clone()).map(Some);
    }
    if let Some(symbol) = value.as_symbol() {
        let name: Option<String> = symbol.description()?.as_string().map(|s| s.to_string()).transpose()?;
        return Ok(name.map(EditorValue::Symbol));
    }
    if let Some(object) = value.as_object()
        && let Some(id) = object.get::<_, Option<f64>>(BUFFER_ID)?
    {
        return Ok(Some(EditorValue::Buffer(id as u64)));
    }
    if let Some(object) = value.as_object()
        && let Some(id) = object.get::<_, Option<f64>>("__emberKeymapId")?
    {
        return Ok(Some(EditorValue::Keymap(id as usize)));
    }
    if let Some(object) = value.as_object()
        && let Some(raw) = object.get::<_, Option<Vec<f64>>>("__emberTreesitParser")?
        && raw.len() == 2
    {
        return Ok(Some(EditorValue::Treesit(ember_core::treesitfns::TsObject::Parser { buffer: raw[0] as u64, parser: raw[1] as u64 })));
    }
    if let Some(object) = value.as_object()
        && let Some(raw) = object.get::<_, Option<Vec<f64>>>("__emberTreesitNode")?
        && raw.len() >= 3
    {
        let r = ember_core::treesitfns::NodeRef {
            buffer: raw[0] as u64,
            parser: raw[1] as u64,
            generation: raw[2] as u64,
            path: raw[3..].iter().map(|&i| i as u32).collect(),
        };
        return Ok(Some(EditorValue::Treesit(ember_core::treesitfns::TsObject::Node(r))));
    }
    if let Some(object) = value.as_object()
        && let Some(kind) = object.get::<_, Option<String>>("__emberFontKind")?
        && let Some(kind) = ember_core::FontKind::from_name(&kind)
    {
        let plist = match convert_from_js(ctx, object.get("__emberFontPlist")?)? {
            Some(EditorValue::List(items)) => items,
            _ => Vec::new(),
        };
        let font = ember_core::Font::from_plist(kind, &plist).map_err(|e| rquickjs::Error::new_from_js_message("value", "font", e.to_string()))?;
        return Ok(Some(EditorValue::Font(Box::new(font))));
    }
    // A marker the editor now holds, which collecting the script's object
    // must no longer delete, as a Lisp marker lives while a variable has it.
    if let Some(object) = value.as_object()
        && let Some(id) = object.get::<_, Option<f64>>("__emberMarkerId")?
    {
        let keep: Function = ctx.globals().get("__emberKeepMarker")?;
        keep.call::<_, ()>((object.clone(),))?;
        return Ok(Some(EditorValue::Marker(id as u64)));
    }
    if let Some(object) = value.as_object()
        && let Some(id) = object.get::<_, Option<f64>>("__emberCharTableId")?
    {
        return Ok(Some(EditorValue::CharTable(id as u64)));
    }
    if let Some(object) = value.as_object()
        && object.get::<_, Option<bool>>("__emberText")? == Some(true)
    {
        let string: String = object.get("string")?;
        let runs: Vec<rquickjs::Array> = object.get("properties")?;
        let mut props = Vec::new();
        for run in runs {
            let (start, end): (f64, f64) = (run.get(0)?, run.get(1)?);
            let names: Object = run.get(2)?;
            let mut map = ember_core::Props::new();
            for key in names.keys::<String>() {
                let key = key?;
                match convert_from_js(ctx, names.get(key.as_str())?)? {
                    Some(v) => {
                        map.insert(key, v);
                    }
                    None => return Ok(None),
                }
            }
            // Counted in characters, and within the string.
            let n = string.chars().count();
            let (start, end) = ((start.max(0.0) as usize).min(n), (end.max(0.0) as usize).min(n));
            if end > start && !map.is_empty() {
                props.push((start..end, map));
            }
        }
        return Ok(Some(EditorValue::Text(ember_core::Text { string, props })));
    }
    Ok(None)
}

/// A prefix argument as scripts see it, in Emacs's forms: null, a number,
/// "-", or a one-element array such as [4] for C-u.
fn prefix_to_js<'js>(ctx: &Ctx<'js>, arg: Option<PrefixArg>) -> rquickjs::Result<Value<'js>> {
    Ok(match arg {
        None => Value::new_null(ctx.clone()),
        Some(PrefixArg::Number(n)) => Value::new_number(ctx.clone(), n as f64),
        Some(PrefixArg::Minus) => rquickjs::String::from_str(ctx.clone(), "-")?.into_value(),
        Some(PrefixArg::Universal(n)) => {
            let list = rquickjs::Array::new(ctx.clone())?;
            list.set(0, n as f64)?;
            list.into_value()
        }
    })
}

fn prefix_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Option<PrefixArg>> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if let Some(n) = value.as_number() {
        return Ok(Some(PrefixArg::Number(n as i64)));
    }
    if let Some(s) = value.as_string()
        && s.to_string()? == "-"
    {
        return Ok(Some(PrefixArg::Minus));
    }
    if let Some(list) = value.as_array()
        && list.len() == 1
    {
        let n: f64 = list.get(0)?;
        return Ok(Some(PrefixArg::Universal(n as i64)));
    }
    Err(Exception::throw_type(ctx, "A prefix argument is null, a number, \"-\" or [n]"))
}

/// What a failed script threw: its message, whether it looks like a bug in
/// the script rather than a deliberate error, and where it was thrown.
struct Failure {
    message: String,
    is_bug: bool,
    location: Option<String>,
    /// The condition and data a script's error carries, as ember.signal gives them.
    symbol: Option<String>,
    data: Vec<EditorValue>,
}

fn failure(ctx: &Ctx<'_>, err: rquickjs::Error) -> Failure {
    if !err.is_exception() {
        return Failure { message: err.to_string(), is_bug: true, location: None, symbol: None, data: Vec::new() };
    }
    let value = ctx.catch();
    let Some(exception) = value.as_exception() else {
        let message = Coerced::<String>::from_js(ctx, value)
            .map(|s| s.0)
            .unwrap_or_else(|_| "Script threw a value that is not an Error".into());
        return Failure { message, is_bug: false, location: None, symbol: None, data: Vec::new() };
    };
    let message = exception.message().unwrap_or_default();
    let name: String = exception.get("name").unwrap_or_default();
    let location = exception.stack().and_then(|stack| first_location(&stack));
    let symbol: Option<String> = exception.get("symbol").ok().flatten();
    let data: Vec<EditorValue> = exception
        .get::<_, Option<Vec<Value>>>("data")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| value_from_js(ctx, v).ok())
        .collect();
    if name == "InternalError" && message == "interrupted" {
        let message = if STOPPED_BY_QUIT.get() {
            "Quit: the command was stopped".to_string()
        } else {
            format!("Script stopped after running for {:?}", TIME_LIMIT.get())
        };
        return Failure { message, is_bug: false, location, symbol: Some("quit".into()), data };
    }
    // Errors the engine raises point at mistakes in the script; include their type.
    let is_bug = matches!(
        name.as_str(),
        "TypeError" | "ReferenceError" | "SyntaxError" | "RangeError" | "InternalError"
    );
    let message = if is_bug { format!("{name}: {message}") } else { message };
    Failure { message, is_bug, location, symbol, data }
}

/// An error for a failed command. Deliberate errors show just their message,
/// as in Emacs; script bugs also say where they happened.
fn js_error(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    let f = failure(ctx, err);
    let message = match f.location {
        Some(location) if f.is_bug => format!("{} ({location})", f.message),
        _ => f.message,
    };
    Error::signal(f.symbol.as_deref().unwrap_or("error"), message, f.data)
}

/// The error a promise was rejected with, as the editor shows it.
fn rejection_error(ctx: &Ctx<'_>, reason: Persistent<Value<'static>>) -> Error {
    match reason.restore(ctx) {
        Ok(reason) => {
            let thrown = ctx.throw(reason);
            js_error(ctx, thrown)
        }
        Err(e) => js_error(ctx, e),
    }
}

/// An error for a failed file load, which always says where it happened.
fn js_error_with_location(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    let f = failure(ctx, err);
    let message = match f.location {
        Some(location) => format!("{location}: {}", f.message),
        None => f.message,
    };
    Error::signal(f.symbol.as_deref().unwrap_or("error"), message, f.data)
}

/// The first `file:line:col` in a QuickJS stack trace that is not in the prelude.
fn first_location(stack: &str) -> Option<String> {
    stack.lines().find_map(|line| {
        let line = line.trim().strip_prefix("at ")?;
        let location = match line.rfind('(') {
            Some(i) => line[i + 1..].trim_end_matches(')'),
            None => line,
        };
        let looks_like_location = location.contains(':') && !location.starts_with("ember:prelude");
        looks_like_location.then(|| location.to_string())
    })
}

/// A process's codings from a script: one name for both ways, or [decode, encode].
fn coding_pair(value: Option<&EditorValue>) -> Result<Option<(ember_core::coding::Coding, ember_core::coding::Coding)>> {
    let Some(value) = value else { return Ok(None) };
    let names: Vec<String> = match value {
        EditorValue::List(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        v => v.as_str().map(|s| vec![s.to_string(), s.to_string()]).unwrap_or_default(),
    };
    let parse = |n: Option<&String>| -> Result<ember_core::coding::Coding> {
        let n = n.ok_or_else(|| Error::signal("wrong-type-argument", "A coding system for each way", Vec::new()))?;
        ember_core::coding::Coding::parse(n)
            .ok_or_else(|| Error::signal("wrong-type-argument", format!("Invalid coding system: {n}"), Vec::new()))
    };
    Ok(Some((parse(names.first())?, parse(names.get(1).or(names.first()))?)))
}

/// A script's function as a hook function, as a process's filter or a timer runs it.
fn hook_of(f: ember_core::Function) -> HookFn {
    Rc::new(move |ed, args| f.call(ed, args).map(drop))
}

/// The keymap a value names, or none for null.
fn keymap_or_none(ed: &Editor, value: &EditorValue) -> Result<Option<ember_core::KeymapId>> {
    if matches!(value, EditorValue::Null) { Ok(None) } else { ed.keymap_of(value).map(Some) }
}

/// The signal a name gives, as signal-process takes them: "SIGINT", "int", or a number.
fn signal_number(value: Option<&EditorValue>) -> Option<i32> {
    match value? {
        EditorValue::Number(n) => Some(*n as i32),
        v => ember_core::process::signal_number(v.as_str()?),
    }
}

fn process_primitive(ed: &mut Editor, op: &str, name: &str, args: &[EditorValue]) -> ember_core::Result<EditorValue> {
    let flag = |i: usize| args.get(i).is_some_and(EditorValue::is_true);
    Ok(match op {
        "process-coding-system" => match ed.process_coding_system(name) {
            Some((d, e)) => EditorValue::List(vec![EditorValue::Str(d.name()), EditorValue::Str(e.name())]),
            None => EditorValue::Null,
        },
        "set-process-coding-system" => {
            let coding = |i: usize| -> ember_core::Result<ember_core::coding::Coding> {
                let n = args.get(i).and_then(EditorValue::as_str).unwrap_or("undecided");
                ember_core::coding::Coding::parse(n).ok_or_else(|| ember_core::Error::new(format!("Invalid coding system: {n}")))
            };
            ed.set_process_coding_system(name, coding(0)?, coding(1)?)?;
            EditorValue::Null
        }
        "process-tty-name" => ed.process_tty_name(name).map_or(EditorValue::Null, EditorValue::Str),
        "process-type" => ed.process_type(name).map_or(EditorValue::Null, |t| EditorValue::Str(t.into())),
        "process-contact" => match ed.process_contact(name) {
            None => EditorValue::Bool(true),
            Some((c, server)) => {
                let s = |x: Option<String>| x.map_or(EditorValue::Null, EditorValue::Str);
                match args.first().and_then(EditorValue::as_str).map(|k| k.trim_start_matches(':')) {
                    None => EditorValue::List(vec![s(c.host), EditorValue::Str(c.service)]),
                    Some("host") => s(c.host),
                    Some("service") => EditorValue::Str(c.service),
                    Some("remote") => s(c.remote),
                    Some("server") => EditorValue::Bool(server),
                    Some(_) => EditorValue::Null,
                }
            }
        },
        "set-process-window-size" => {
            let n = |i: usize| args.get(i).and_then(EditorValue::as_number).unwrap_or(0.0) as u16;
            EditorValue::Bool(ed.set_process_window_size(name, n(0), n(1))?)
        }
        "signal-process" => {
            let signal = signal_number(args.first()).ok_or_else(|| ember_core::Error::new("Undefined signal name"))?;
            ed.signal_process_group(name, signal, flag(1))?;
            EditorValue::Null
        }
        _ => return Err(ember_core::Error::new(format!("No process primitive {op}"))),
    })
}
