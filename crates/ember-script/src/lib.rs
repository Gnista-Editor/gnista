//! TypeScript extensions for Ember, run on the QuickJS engine.
//!
//! [`Scripting`] owns the JavaScript runtime. Scripts reach the editor through
//! the `ember` global; [`type_definitions`] generates its TypeScript
//! declarations from the command registry.

pub mod config;
mod strip;
mod types;

pub use strip::strip_types;
pub use types::type_definitions;

use std::cell::{Cell, RefCell};
use std::fs;
use std::path::Path;
use std::ptr::NonNull;
use std::thread::LocalKey;
use std::time::{Duration, Instant};

use ember_core::{
    Arg, Command, Editor, Error, Key, ParamKind, Result, abbreviate_path, expand_file_name,
};
use rquickjs::context::EvalOptions;
use rquickjs::function::{Opt, Rest};
use rquickjs::{
    Coerced, Context, Ctx, Exception, FromJs, Function, Object, Persistent, Runtime, Value, qjs,
};

const PRELUDE: &str = include_str!("prelude.js");

/// How long a script may run before it is stopped, unless changed with
/// [`Scripting::set_time_limit`]. The editor is single threaded, so a script
/// stuck in a loop would otherwise freeze it.
pub const DEFAULT_TIME_LIMIT: Duration = Duration::from_secs(10);

thread_local! {
    /// The editor that host functions act on, set while a script runs. See [`enter`].
    static EDITOR: Cell<Option<NonNull<Editor>>> = const { Cell::new(None) };
    /// The context of the script that is running, if any.
    static ACTIVE: Cell<Option<NonNull<qjs::JSContext>>> = const { Cell::new(None) };
    /// When the outermost running script must stop.
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
    static TIME_LIMIT: Cell<Duration> = const { Cell::new(DEFAULT_TIME_LIMIT) };
    /// Files being loaded, innermost last, so commands know where they were defined.
    static LOADING: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// The JavaScript runtime and the `ember` API. Clones share one runtime.
#[derive(Clone)]
pub struct Scripting {
    context: Context,
}

impl Scripting {
    /// Starts a runtime, installs the `ember` global, and adds the script
    /// commands `load-file` and `eval-expression` (M-:) to the editor.
    pub fn new(ed: &mut Editor) -> Result<Scripting> {
        let runtime = Runtime::new().map_err(|e| Error::new(e.to_string()))?;
        runtime.set_interrupt_handler(Some(Box::new(|| {
            DEADLINE.get().is_some_and(|deadline| Instant::now() > deadline)
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
        Ok(scripting)
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
                    let value = scripting.eval_expression(ed, args[0].as_str()?)?;
                    ed.message(value);
                    Ok(())
                },
            )
            .param("expression", ParamKind::String, "Eval: "),
        );
        ed.global_map.bind_str("M-:", "eval-expression");
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

/// Runs `f` in the script context, giving host functions access to `ed`.
///
/// QuickJS's runtime lock is not reentrant. When a script calls a command
/// that runs another script command, the nested call reuses the context of
/// the script that is already running instead of locking it again.
fn enter<R>(context: &Context, ed: &mut Editor, f: impl for<'js> FnOnce(Ctx<'js>) -> R) -> R {
    let _editor = Restore::set(&EDITOR, Some(NonNull::from(ed)));
    match ACTIVE.get() {
        Some(raw) if raw == context.as_raw() => {
            // SAFETY: ACTIVE is only set inside `Context::with` below, so the
            // runtime lock is held, and it is this context's runtime.
            f(unsafe { Ctx::from_raw(raw) })
        }
        _ => context.with(|ctx| {
            let _active = Restore::set(&ACTIVE, Some(ctx.as_raw()));
            let _deadline = Restore::set(&DEADLINE, Some(Instant::now() + TIME_LIMIT.get()));
            f(ctx)
        }),
    }
}

/// Gives a host function the editor, turning editor errors into script exceptions.
fn with_editor<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    let Some(ptr) = EDITOR.get() else {
        return Err(Exception::throw_internal(ctx, "No editor is active"));
    };
    // SAFETY: `enter` set this from a live `&mut Editor` that is not used
    // while the script runs, and restores the previous value afterwards.
    let ed = unsafe { &mut *ptr.as_ptr() };
    f(ed).map_err(|e| Exception::throw_message(ctx, &e.to_string()))
}

/// A command implemented by a script function.
struct ScriptCommand {
    // Declared before `context` so the function is freed before the runtime can be.
    run: Persistent<Function<'static>>,
    context: Context,
}

impl ScriptCommand {
    fn into_fn(self) -> impl Fn(&mut Editor, &[Arg]) -> Result<()> {
        move |ed, args| {
            let args: Vec<String> = args.iter().map(Arg::to_string).collect();
            enter(&self.context, ed, |ctx| {
                let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
                run.call::<_, Value>((Rest(args),))
                    .map(drop)
                    .map_err(|e| js_error(&ctx, e))
            })
        }
    }
}

fn install_native<'js>(ctx: &Ctx<'js>, context: &Context) -> rquickjs::Result<()> {
    let native = Object::new(ctx.clone())?;
    let context = context.clone();
    native.set(
        "defineCommand",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, name: String, doc: String, params: Vec<Object<'js>>, run: Function<'js>| {
                let script = ScriptCommand { run: Persistent::save(&ctx, run), context: context.clone() };
                let mut command = Command::new(&name, &doc, script.into_fn());
                command.source = LOADING.with_borrow(|files| files.last().cloned());
                for param in params {
                    let param_name: String = param.get("name")?;
                    let kind: String = param.get("kind")?;
                    let prompt: String = param.get("prompt")?;
                    let Some(kind) = ParamKind::from_name(&kind) else {
                        let kinds: Vec<&str> = ParamKind::ALL.iter().map(ParamKind::name).collect();
                        let message = format!("Unknown parameter kind {kind:?}; use one of {}", kinds.join(", "));
                        return Err(Exception::throw_type(&ctx, &message));
                    };
                    command = command.param(&param_name, kind, &prompt);
                }
                with_editor(&ctx, |ed| {
                    ed.define_command(command);
                    Ok(())
                })
            },
        )?,
    )?;
    native.set(
        "bindKey",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keys: String, command: String| {
            with_editor(&ctx, |ed| {
                let parsed = Key::parse_seq(&keys)
                    .ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
                ed.global_map.bind(&parsed, &command);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "call",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, args: Rest<String>| {
            with_editor(&ctx, |ed| {
                let command = ed
                    .command(&name)
                    .ok_or_else(|| Error::new(format!("No such command: {name}")))?;
                let args = args
                    .0
                    .into_iter()
                    .enumerate()
                    .map(|(i, arg)| match command.params.get(i).map(|p| p.kind) {
                        Some(ParamKind::Keys) => Key::parse_seq(&arg)
                            .map(Arg::Keys)
                            .ok_or_else(|| Error::new(format!("Invalid key sequence: {arg:?}"))),
                        _ => Ok(Arg::Str(arg)),
                    })
                    .collect::<Result<Vec<Arg>>>()?;
                ed.call(&name, args)
            })
        })?,
    )?;
    native.set(
        "message",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| {
                ed.message(text);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "insert",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| ed.buffer_mut().insert(&text))
        })?,
    )?;
    native.set(
        "point",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().point())))?,
    )?;
    native.set(
        "gotoChar",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, position: usize| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().set_point(position);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "bufferText",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: Opt<usize>, end: Opt<usize>| {
            with_editor(&ctx, |ed| {
                let b = ed.buffer();
                let end = end.0.unwrap_or(b.len()).min(b.len());
                let start = start.0.unwrap_or(0).min(end);
                Ok(b.slice(start..end))
            })
        })?,
    )?;
    native.set(
        "deleteRegion",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize| {
            with_editor(&ctx, |ed| ed.buffer_mut().delete(start.min(end)..start.max(end)))
        })?,
    )?;
    native.set(
        "bufferName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().name.clone())))?,
    )?;
    native.set(
        "mark",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().mark())))?,
    )?;
    ctx.globals().set("__ember", native)
}

/// What a failed script threw: its message, whether it looks like a bug in
/// the script rather than a deliberate error, and where it was thrown.
struct Failure {
    message: String,
    is_bug: bool,
    location: Option<String>,
}

fn failure(ctx: &Ctx<'_>, err: rquickjs::Error) -> Failure {
    if !err.is_exception() {
        return Failure { message: err.to_string(), is_bug: true, location: None };
    }
    let value = ctx.catch();
    let Some(exception) = value.as_exception() else {
        let message = Coerced::<String>::from_js(ctx, value)
            .map(|s| s.0)
            .unwrap_or_else(|_| "Script threw a value that is not an Error".into());
        return Failure { message, is_bug: false, location: None };
    };
    let message = exception.message().unwrap_or_default();
    let name: String = exception.get("name").unwrap_or_default();
    let location = exception.stack().and_then(|stack| first_location(&stack));
    if name == "InternalError" && message == "interrupted" {
        let message = format!("Script stopped after running for {:?}", TIME_LIMIT.get());
        return Failure { message, is_bug: false, location };
    }
    // Errors the engine raises point at mistakes in the script; include their type.
    let is_bug = matches!(
        name.as_str(),
        "TypeError" | "ReferenceError" | "SyntaxError" | "RangeError" | "InternalError"
    );
    let message = if is_bug { format!("{name}: {message}") } else { message };
    Failure { message, is_bug, location }
}

/// An error for a failed command. Deliberate errors show just their message,
/// as in Emacs; script bugs also say where they happened.
fn js_error(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    let f = failure(ctx, err);
    match f.location {
        Some(location) if f.is_bug => Error::new(format!("{} ({location})", f.message)),
        _ => Error::new(f.message),
    }
}

/// An error for a failed file load, which always says where it happened.
fn js_error_with_location(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    let f = failure(ctx, err);
    match f.location {
        Some(location) => Error::new(format!("{location}: {}", f.message)),
        None => Error::new(f.message),
    }
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
