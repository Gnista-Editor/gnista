//! TypeScript extensions for Ember, run on the QuickJS engine.
//!
//! [`Scripting`] owns the JavaScript runtime. Scripts reach the editor through
//! the `ember` global; [`type_definitions`] generates its TypeScript
//! declarations from the command registry.

pub mod config;
mod strip;
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
        let js = strip_module_types(file, source.to_string()).map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?;
        rquickjs::Module::declare(ctx.clone(), file, js)
    }
}

/// The packages that ship with Ember, in the order they load. Like the Lisp
/// that Emacs preloads, they are part of the editor: `-q` skips init.ts but
/// not these. Named by their path in the repository.
const PACKAGES: &[(&str, &str)] = &[
    ("packages/subr.ts", include_str!("../../../packages/subr.ts")),
    ("packages/simple.ts", include_str!("../../../packages/simple.ts")),
    ("packages/paragraphs.ts", include_str!("../../../packages/paragraphs.ts")),
    ("packages/indent.ts", include_str!("../../../packages/indent.ts")),
    ("packages/fill.ts", include_str!("../../../packages/fill.ts")),
    ("packages/newcomment.ts", include_str!("../../../packages/newcomment.ts")),
    ("packages/lisp.ts", include_str!("../../../packages/lisp.ts")),
    ("packages/paren.ts", include_str!("../../../packages/paren.ts")),
    ("packages/display-line-numbers.ts", include_str!("../../../packages/display-line-numbers.ts")),
    ("packages/mule.ts", include_str!("../../../packages/mule.ts")),
    ("packages/files.ts", include_str!("../../../packages/files.ts")),
    ("packages/text-mode.ts", include_str!("../../../packages/text-mode.ts")),
    ("packages/face-remap.ts", include_str!("../../../packages/face-remap.ts")),
    ("packages/case-table.ts", include_str!("../../../packages/case-table.ts")),
    ("packages/outline.ts", include_str!("../../../packages/outline.ts")),
    ("packages/prog-mode.ts", include_str!("../../../packages/prog-mode.ts")),
    ("packages/treesit.ts", include_str!("../../../packages/treesit.ts")),
    ("packages/treesit-modes.ts", include_str!("../../../packages/treesit-modes.ts")),
    ("packages/delsel.ts", include_str!("../../../packages/delsel.ts")),
    ("packages/elec-pair.ts", include_str!("../../../packages/elec-pair.ts")),
    ("packages/help.ts", include_str!("../../../packages/help.ts")),
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
    ("packages/comint.ts", include_str!("../../../packages/comint.ts")),
    ("packages/shell.ts", include_str!("../../../packages/shell.ts")),
    ("packages/xref.ts", include_str!("../../../packages/xref.ts")),
    ("packages/project.ts", include_str!("../../../packages/project.ts")),
    ("packages/replace.ts", include_str!("../../../packages/replace.ts")),
    ("packages/org-macs.ts", include_str!("../../../packages/org-macs.ts")),
    ("packages/org-table.ts", include_str!("../../../packages/org-table.ts")),
    ("packages/org.ts", include_str!("../../../packages/org.ts")),
    ("packages/org-agenda.ts", include_str!("../../../packages/org-agenda.ts")),
    ("packages/org-capture.ts", include_str!("../../../packages/org-capture.ts")),
];

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
            DEADLINE.get().is_some_and(|deadline| Instant::now() > deadline)
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
            let result = f(ctx.clone());
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
fn command_args<'js>(ctx: &Ctx<'js>, name: &str, args: Vec<Value<'js>>) -> rquickjs::Result<Vec<Arg>> {
    let kinds = with_editor(ctx, |ed| {
        let command = ed.command(name).ok_or_else(|| Error::new(format!("No such command: {name}")))?;
        Ok(command.params.iter().map(|p| p.kind).collect::<Vec<_>>())
    })?;
    args.into_iter()
        .enumerate()
        .map(|(i, value)| {
            let kind = kinds.get(i).copied().unwrap_or(ParamKind::String);
            let text = if value.is_null() || value.is_undefined() {
                String::new()
            } else if let Some(list) = value.as_array() {
                // A prefix argument as C-u gives it, [4].
                format!("({})", list.get::<Coerced<String>>(0)?.0)
            } else {
                value.get::<Coerced<String>>()?.0
            };
            Arg::from_text(kind, &text).map_err(|e| throw_error(ctx, &e))
        })
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

/// Gives a host function the editor, turning editor errors into script exceptions.
fn with_editor<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    let Some(ptr) = EDITOR.get() else {
        return Err(Exception::throw_internal(ctx, "No editor is active"));
    };
    // SAFETY: `enter` set this from a live `&mut Editor` that is not used
    // while the script runs, and restores the previous value afterwards.
    let ed = unsafe { &mut *ptr.as_ptr() };
    let result = f(ed);
    // What the call changed in a buffer sharing its text, the others see.
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

    /// Calls the function with editor values, as hooks pass their arguments.
    fn call_values(&self, ed: &mut Editor, args: &[EditorValue]) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            let args = args
                .iter()
                .map(|a| value_to_js(&ctx, a))
                .collect::<rquickjs::Result<Vec<_>>>()
                .map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Value>((Rest(args),)).map(drop).map_err(|e| js_error(&ctx, e))
        })
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

    fn into_hook(self) -> HookFn {
        Rc::new(move |ed, args| self.call_values(ed, args))
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
    install_native_variables(ctx, &native, context)?;
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
    native.set(
        "bindKey",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keys: String, binding: Value<'js>, keymap: Value<'js>| {
            let binding = value_from_js(&ctx, binding)?;
            let keymap = if keymap.is_undefined() || keymap.is_null() { EditorValue::Str("global-map".into()) } else { value_from_js(&ctx, keymap)? };
            with_editor(&ctx, |ed| {
                let parsed = Key::parse_seq(&keys)
                    .ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
                ed.define_key(&keymap, &parsed, Some(&binding))
            })
        })?,
    )?;
    native.set(
        "callInteractively",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                if ed.command(&name).is_none() {
                    return Err(Error::new(format!("No such command: {name}")));
                }
                ed.run_interactive(&name);
                Ok(())
            })
        })?,
    )?;
    // The coding and charset primitives, as coding.c and charset.c: one
    // native, by the Lisp name, for the prelude's wrappers.
    // The tree-sitter primitives, as treesit.c, likewise.
    native.set(
        "treesitPrimitive",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, args: Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
            let args = args.0.into_iter().map(|a| value_from_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>()?;
            let value = with_editor(&ctx, |ed| ed.treesit_primitive(&name, &args))?;
            value_to_js(&ctx, &value)
        })?,
    )?;
    native.set(
        "codingPrimitive",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, args: Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
            let args = args.0.into_iter().map(|a| value_from_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>()?;
            let value = with_editor(&ctx, |ed| ed.coding_primitive(&name, &args))?;
            value_to_js(&ctx, &value)
        })?,
    )?;
    native.set(
        "call",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, args: Rest<Value<'js>>| {
            let args = command_args(&ctx, &name, args.0)?;
            with_editor(&ctx, |ed| ed.call(&name, args))
        })?,
    )?;
    native.set(
        "callWithPrefix",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, prefix: Value<'js>, name: String, args: Rest<Value<'js>>| {
            let prefix = prefix_from_js(&ctx, prefix)?;
            let args = command_args(&ctx, &name, args.0)?;
            with_editor(&ctx, |ed| ed.call_with_prefix(&name, args, prefix))
        })?,
    )?;
    native.set(
        "message",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String, log: Opt<bool>| {
            with_editor(&ctx, |ed| {
                if log.0 == Some(false) {
                    ed.message_unlogged(text);
                } else {
                    ed.message(text);
                }
                Ok(())
            })
        })?,
    )?;
    native.set(
        "insert",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| ed.insert(&text))
        })?,
    )?;
    native.set(
        "insertBeforeMarkers",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: Value<'js>| {
            let text = text_from_js(&ctx, text)?;
            with_editor(&ctx, |ed| ed.insert_text_with(&text, ember_core::Insertion::BeforeMarkers))
        })?,
    )?;
    native.set(
        "undoAutoAmalgamate",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.undo_auto_amalgamate();
                Ok(())
            })
        })?,
    )?;
    native.set(
        "currentColumn",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.current_column())))?,
    )?;
    native.set(
        "moveToColumn",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, column: usize| with_editor(&ctx, |ed| Ok(ed.move_to_column(column))))?,
    )?;
    native.set(
        "insertAndInherit",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: Value<'js>| {
            let text = text_from_js(&ctx, text)?;
            with_editor(&ctx, |ed| ed.insert_text_with(&text, ember_core::Insertion::Inherit))
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
            with_editor(&ctx, |ed| ed.delete_region(start, end))
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
    native.set(
        "prefixArg",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            let arg = with_editor(&ctx, |ed| Ok(ed.current_prefix_arg()))?;
            prefix_to_js(&ctx, arg)
        })?,
    )?;
    native.set(
        "setPrefixArg",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, arg: Value<'js>| {
            let arg = prefix_from_js(&ctx, arg)?;
            with_editor(&ctx, |ed| {
                ed.set_prefix_arg(arg);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "lastKey",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(ed.last_key().map(|k| k.to_string())))
        })?,
    )?;
    native.set(
        "setTransientMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>| {
            let keymap = value_from_js(&ctx, keymap)?;
            with_editor(&ctx, |ed| {
                let map = ed.keymap_of(&keymap)?;
                ed.set_transient_map(map);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "currentKill",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, n: Opt<i64>| {
            with_editor(&ctx, |ed| ed.current_kill(n.0.unwrap_or(0)))
        })?,
    )?;
    native.set(
        "currentKillText",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, n: Opt<i64>| -> rquickjs::Result<Value<'js>> {
            let text = with_editor(&ctx, |ed| ed.current_kill_text(n.0.unwrap_or(0)))?;
            value_to_js(&ctx, &EditorValue::Text(text))
        })?,
    )?;
    native.set(
        "insertForYank",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: Value<'js>| {
            let text = match value_from_js(&ctx, text)? {
                EditorValue::Text(text) => text,
                other => ember_core::Text { string: other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string()), props: Vec::new() },
            };
            with_editor(&ctx, |ed| ed.insert_for_yank(text))
        })?,
    )?;
    native.set(
        "popKill",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.pop_kill())))?,
    )?;
    native.set(
        "lastCommand",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(ed.last_command().map(str::to_string)))
        })?,
    )?;
    native.set(
        "setThisCommand",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                ed.set_this_command(&name);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "setMark",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: Option<usize>| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().set_mark(pos);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "pushMark",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, activate: bool| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().push_mark(pos, activate);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "activateMark",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().activate_region();
                Ok(())
            })
        })?,
    )?;
    native.set(
        "deactivateMark",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().deactivate_mark();
                Ok(())
            })
        })?,
    )?;
    native.set(
        "takeChanged",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer_mut().take_changed())))?,
    )?;
    native.set(
        "setChanged",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, changed: bool| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().set_changed(changed);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "repeatLastCommand",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, arg: Value<'js>| {
            let arg = prefix_from_js(&ctx, arg)?;
            with_editor(&ctx, |ed| ed.repeat_last_command(arg))
        })?,
    )?;
    native.set(
        "startKbdMacro",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| ed.start_kbd_macro()))?,
    )?;
    native.set(
        "endKbdMacro",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| ed.end_kbd_macro()))?,
    )?;
    native.set(
        "callLastKbdMacro",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, count: i64| {
            with_editor(&ctx, |ed| ed.call_last_kbd_macro(count))
        })?,
    )?;
    native.set(
        "definingKbdMacro",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.defining_kbd_macro())))?,
    )?;
    native.set(
        "executingKbdMacro",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.executing_kbd_macro())))?,
    )?;
    ctx.globals().set("__ember", native)
}

/// Variables, hooks, keymaps, modes and help.
fn install_native_variables<'js>(ctx: &Ctx<'js>, native: &Object<'js>, context: &Context) -> rquickjs::Result<()> {
    native.set(
        "defineVariable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, doc: String, value: Value<'js>, local: bool| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| {
                let mut var = Variable::new(&name, &doc, value);
                var.local = local;
                var.source = LOADING.with_borrow(|files| files.last().cloned());
                ed.define_variable(var);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "variable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            let value = with_editor(&ctx, |ed| Ok(ed.variable(&name)))?;
            value.map(|v| value_to_js(&ctx, &v)).transpose()
        })?,
    )?;
    native.set(
        "setVariable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| {
                ed.set_variable(&name, value);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "defaultValue",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            let value = with_editor(&ctx, |ed| Ok(ed.default_value(&name)))?;
            value.map(|v| value_to_js(&ctx, &v)).transpose()
        })?,
    )?;
    native.set(
        "setDefault",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| {
                ed.set_default(&name, value);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "makeLocalVariable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                ed.make_local_variable(&name);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "killLocalVariable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                ed.kill_local_variable(&name);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "isLocalVariable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| Ok(ed.is_local_variable(&name)))
        })?,
    )?;
    native.set(
        "variableDocumentation",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| Ok(ed.variable_definition(&name).map(|v| v.doc.clone())))
        })?,
    )?;
    native.set(
        "variableSource",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| Ok(ed.variable_definition(&name).and_then(|v| v.source.clone())))
        })?,
    )?;
    native.set(
        "isHook",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| Ok(ed.variable_definition(&name).is_some_and(|v| v.hook)))
        })?,
    )?;
    native.set(
        "killAllLocalVariables",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| ed.kill_all_local_variables()))?,
    )?;
    native.set(
        "defineHook",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, doc: String| {
            with_editor(&ctx, |ed| {
                ed.define_hook(&name, &doc);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "addHook",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, hook: String, run: Function<'js>, depth: f64, local: bool| {
                let EditorValue::Function(function) = function_from_js(&ctx, run)? else { unreachable!("a function converts to one") };
                with_editor(&ctx, |ed| Ok(ed.add_hook_function(&hook, function, depth, local) as f64))
            },
        )?,
    )?;

    native.set(
        "removeHook",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, hook: String, run: Function<'js>, local: bool| {
            let EditorValue::Function(function) = function_from_js(&ctx, run)? else { unreachable!("a function converts to one") };
            with_editor(&ctx, |ed| {
                ed.remove_hook_function(&hook, &function, local);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "runHookUntil",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, hook: String, args: Vec<Value<'js>>, success: bool| -> rquickjs::Result<Value<'js>> {
            let args = args.into_iter().map(|v| value_from_js(&ctx, v)).collect::<rquickjs::Result<Vec<_>>>()?;
            if success {
                let value = with_editor(&ctx, |ed| ed.run_hook_with_args_until_success(&hook, &args))?;
                value_to_js(&ctx, &value)
            } else {
                let all = with_editor(&ctx, |ed| ed.run_hook_with_args_until_failure(&hook, &args))?;
                Ok(Value::new_bool(ctx.clone(), all))
            }
        })?,
    )?;
    native.set(
        "runHooks",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, hook: String, args: Opt<Vec<Value<'js>>>| {
            let args = args.0.unwrap_or_default().into_iter().map(|v| value_from_js(&ctx, v)).collect::<rquickjs::Result<Vec<_>>>()?;
            with_editor(&ctx, |ed| ed.run_hook_with_args(&hook, &args))
        })?,
    )?;
    native.set(
        "defineKeymap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, parent: Opt<Option<String>>| -> rquickjs::Result<Value<'js>> {
            let map = with_editor(&ctx, |ed| Ok(ed.define_keymap(&name, parent.0.flatten().as_deref())))?;
            value_to_js(&ctx, &EditorValue::Keymap(map))
        })?,
    )?;
    native.set(
        "keymapUnset",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>, keys: String, remove: Opt<bool>| {
            let keymap = value_from_js(&ctx, keymap)?;
            with_editor(&ctx, |ed| {
                let parsed = Key::parse_seq(&keys).ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
                let nil = EditorValue::Null;
                ed.define_key(&keymap, &parsed, if remove.0 == Some(true) { None } else { Some(&nil) })
            })
        })?,
    )?;
    native.set(
        "makeSparseKeymap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, parent: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let parent = if parent.is_undefined() || parent.is_null() { None } else { Some(value_from_js(&ctx, parent)?) };
            let map = with_editor(&ctx, |ed| {
                let parent = parent.map(|p| ed.keymap_of(&p)).transpose()?;
                Ok(ed.keymaps_mut().make(parent))
            })?;
            value_to_js(&ctx, &EditorValue::Keymap(map))
        })?,
    )?;
    native.set(
        "keymapParent",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let keymap = value_from_js(&ctx, keymap)?;
            match with_editor(&ctx, |ed| Ok(ed.keymaps().parent(ed.keymap_of(&keymap)?)))? {
                Some(parent) => value_to_js(&ctx, &EditorValue::Keymap(parent)),
                None => Ok(Value::new_undefined(ctx.clone())),
            }
        })?,
    )?;
    native.set(
        "setKeymapParent",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>, parent: Value<'js>| {
            let keymap = value_from_js(&ctx, keymap)?;
            let parent = if parent.is_undefined() || parent.is_null() { None } else { Some(value_from_js(&ctx, parent)?) };
            with_editor(&ctx, |ed| {
                let map = ed.keymap_of(&keymap)?;
                let parent = parent.map(|p| ed.keymap_of(&p)).transpose()?;
                ed.keymaps_mut().set_parent(map, parent);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "lookupKey",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>, keys: String| -> rquickjs::Result<Value<'js>> {
            let keymap = value_from_js(&ctx, keymap)?;
            let found = with_editor(&ctx, |ed| {
                let parsed = Key::parse_seq(&keys).ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
                Ok(ed.keymaps().binding_of(ed.keymap_of(&keymap)?, &parsed))
            })?;
            match found {
                Some(ember_core::Binding::Command(c)) => value_to_js(&ctx, &EditorValue::Str(c)),
                Some(ember_core::Binding::Keymap(m)) => value_to_js(&ctx, &EditorValue::Keymap(m)),
                Some(ember_core::Binding::Nil) | None => Ok(Value::new_undefined(ctx.clone())),
            }
        })?,
    )?;
    native.set(
        "currentActiveMaps",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| -> rquickjs::Result<Value<'js>> {
            let maps = with_editor(&ctx, |ed| Ok(ed.current_active_maps()))?;
            value_to_js(&ctx, &EditorValue::List(maps.into_iter().map(EditorValue::Keymap).collect()))
        })?,
    )?;
    native.set(
        "useLocalMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>| {
            let keymap = if keymap.is_undefined() || keymap.is_null() { None } else { Some(value_from_js(&ctx, keymap)?) };
            with_editor(&ctx, |ed| ed.use_local_map(keymap.as_ref()))
        })?,
    )?;
    native.set(
        "registerMinorMode",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, lighter: String, keymap: String, global: bool| {
            with_editor(&ctx, |ed| {
                ed.register_minor_mode(MinorMode { name, lighter, keymap: Some(keymap), global });
                Ok(())
            })
        })?,
    )?;
    native.set(
        "enabledMinorModes",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.enabled_minor_modes())))?,
    )?;
    // Functions named for code to call, as Emacs's defun, funcall and
    // fboundp; a function is a value, so a variable or property can hold one.
    native.set(
        "defun",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, f: Function<'js>| {
            let EditorValue::Function(function) = function_from_js(&ctx, f)? else { unreachable!("a function converts to one") };
            let function = function.with_name(&name);
            with_editor(&ctx, |ed| {
                ed.defun(&name, function);
                Ok(())
            })
        })?,
    )?;
    // Propertized strings, as buffer-substring gives them and insert takes them.
    native.set(
        "bufferSubstring",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize| -> rquickjs::Result<Value<'js>> {
            let text = with_editor(&ctx, |ed| Ok(ed.buffer().substring(start.min(end)..start.max(end))))?;
            value_to_js(&ctx, &EditorValue::Text(text))
        })?,
    )?;
    native.set(
        "insertText",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: Value<'js>| {
            let EditorValue::Text(text) = value_from_js(&ctx, text)? else {
                return Err(Exception::throw_type(&ctx, "insertText takes a propertized string"));
            };
            with_editor(&ctx, |ed| ed.insert_text(&text))
        })?,
    )?;
    // Buffers as objects, by the ids they keep when renamed.
    native.set(
        "bufferIdOf",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: Opt<String>| {
            with_editor(&ctx, |ed| {
                Ok(match name.0 {
                    Some(name) => ed.find_buffer(&name).map(|i| ed.buffers()[i].id() as f64),
                    None => Some(ed.buffer().id() as f64),
                })
            })
        })?,
    )?;
    native.set(
        "bufferNameOf",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| {
                Ok(ed.buffer_with_id(id as u64).map(|i| ed.buffers()[i].name.clone()))
            })
        })?,
    )?;
    native.set(
        "put",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, symbol: String, property: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| {
                ed.put(&symbol, &property, value);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "get",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, symbol: String, property: String| -> rquickjs::Result<Value<'js>> {
            match with_editor(&ctx, |ed| Ok(ed.get(&symbol, &property).cloned()))? {
                Some(value) => value_to_js(&ctx, &value),
                None => Ok(Value::new_undefined(ctx.clone())),
            }
        })?,
    )?;
    // Advice, as nadvice.el's advice-add: calls by name go through it.
    native.set(
        "adviceAdd",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, symbol: String, how: String, f: Function<'js>, name: Option<String>, depth: Option<f64>| {
            let Some(how) = ember_core::AdviceHow::from_name(&how) else {
                return Err(Exception::throw_type(&ctx, &format!("Unknown advice kind {how:?}")));
            };
            let EditorValue::Function(function) = function_from_js(&ctx, f)? else { unreachable!("a function converts to one") };
            with_editor(&ctx, |ed| {
                ed.advice_add(&symbol, how, function, name.as_deref(), depth.unwrap_or(0.0));
                Ok(())
            })
        })?,
    )?;
    native.set(
        "adviceRemove",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, symbol: String, f: Value<'js>| {
            let f = value_from_js(&ctx, f)?;
            with_editor(&ctx, |ed| {
                ed.advice_remove(&symbol, &f);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "adviceMemberP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, f: Value<'js>, symbol: String| {
            let f = value_from_js(&ctx, f)?;
            with_editor(&ctx, |ed| Ok(ed.advice_member_p(&f, &symbol)))
        })?,
    )?;
    native.set(
        "advised",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, symbol: String| with_editor(&ctx, |ed| Ok(ed.advised(&symbol))))?,
    )?;
    native.set(
        "formatModeLine",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, format: Value<'js>| {
            let format = value_from_js(&ctx, format)?;
            with_editor(&ctx, |ed| Ok(ed.format_mode_line(&format)?.into_iter().map(|s| s.text).collect::<String>()))
        })?,
    )?;
    native.set(
        "defalias",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, definition: Value<'js>| {
            let definition = value_from_js(&ctx, definition)?;
            with_editor(&ctx, |ed| ed.defalias(&name, &definition))
        })?,
    )?;
    native.set(
        "fmakunbound",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                ed.fmakunbound(&name);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "fboundp",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| with_editor(&ctx, |ed| Ok(ed.fboundp(&name))))?,
    )?;
    native.set(
        "symbolFunction",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| -> rquickjs::Result<Value<'js>> {
            match with_editor(&ctx, |ed| Ok(ed.symbol_function(&name)))? {
                Some(f) => function_to_js(&ctx, &f),
                None => Ok(Value::new_undefined(ctx.clone())),
            }
        })?,
    )?;
    native.set(
        "funcall",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, f: Value<'js>, args: Vec<Value<'js>>| -> rquickjs::Result<Value<'js>> {
            let f = value_from_js(&ctx, f)?;
            let args = args.into_iter().map(|a| value_from_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>()?;
            let result = with_editor(&ctx, |ed| ed.funcall(&f, &args))?;
            value_to_js(&ctx, &result)
        })?,
    )?;
    native.set(
        "documentation",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| Ok(ed.command(&name).map(|c| c.doc.clone())))
        })?,
    )?;
    native.set(
        "commandSource",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| Ok(ed.command(&name).and_then(|c| c.source.clone())))
        })?,
    )?;
    native.set(
        "showHelp",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| {
                ed.show_help(&text);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "bufferFileName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(ed.buffer().path.as_ref().map(|p| p.display().to_string())))
        })?,
    )?;
    // Questions and timers take a function to call later, as hooks do.
    let ask_context = context.clone();
    native.set(
        "ask",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, kind: String, question: String, choices: Vec<String>, run: Function<'js>, quit: Opt<Option<Function<'js>>>| {
                let then = ScriptFunction { run: Persistent::save(&ctx, run), context: ask_context.clone() }.into_hook();
                let quit = quit.0.flatten().map(|f| ScriptFunction { run: Persistent::save(&ctx, f), context: ask_context.clone() }.into_hook());
                with_editor(&ctx, |ed| {
                    match kind.as_str() {
                        "yes-or-no" => ed.yes_or_no_p(&question, then),
                        "y-or-n" => ed.y_or_n_p(&question, then),
                        "answer" => ed.read_answer(&question, &choices.iter().map(String::as_str).collect::<Vec<_>>(), then),
                        _ => ed.read_char_choice(&question, &choices.iter().filter_map(|c| c.chars().next()).collect::<Vec<_>>(), then),
                    }?;
                    if let Some(quit) = quit {
                        ed.on_prompt_quit(quit);
                    }
                    Ok(())
                })
            },
        )?,
    )?;
    // Reading a key partway through a command, as Emacs's read-key,
    // read-event, read-char and read-key-sequence, and recursive edits.
    let key_context = context.clone();
    native.set(
        "readKeyEvent",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, kind: String, prompt: String, run: Function<'js>, quit: Opt<Option<Function<'js>>>| {
                let then = ScriptFunction { run: Persistent::save(&ctx, run), context: key_context.clone() }.into_hook();
                let quit = quit.0.flatten().map(|f| ScriptFunction { run: Persistent::save(&ctx, f), context: key_context.clone() }.into_hook());
                let kind = match kind.as_str() {
                    "key" => ember_core::keyboard::ReadKind::Key,
                    "event" => ember_core::keyboard::ReadKind::Event,
                    "char" => ember_core::keyboard::ReadKind::Char,
                    _ => ember_core::keyboard::ReadKind::KeySequence,
                };
                with_editor(&ctx, |ed| ed.read_key_event(kind, &prompt, then, quit))
            },
        )?,
    )?;
    let edit_context = context.clone();
    native.set(
        "recursiveEdit",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, run: Function<'js>, quit: Opt<Option<Function<'js>>>| {
            let then = ScriptFunction { run: Persistent::save(&ctx, run), context: edit_context.clone() }.into_hook();
            let quit = quit.0.flatten().map(|f| ScriptFunction { run: Persistent::save(&ctx, f), context: edit_context.clone() }.into_hook());
            with_editor(&ctx, |ed| {
                ed.recursive_edit(std::rc::Rc::new(move |ed, _| then(ed, &[]).map(|_| ())), quit);
                Ok(())
            })
        })?,
    )?;
    native.set("recursionDepth", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.recursion_depth())))?)?;
    native.set(
        "thisCommandKeys",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.this_command_keys().iter().map(|k| k.to_string()).collect::<Vec<_>>())))?,
    )?;
    native.set(
        "recentKeys",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, include_cmds: bool| -> rquickjs::Result<Vec<Value<'js>>> {
            let entries = with_editor(&ctx, |ed| Ok(ed.recent_keys(include_cmds)))?;
            entries
                .into_iter()
                .map(|e| match e {
                    ember_core::keyboard::Lossage::Key(k) => Ok(rquickjs::String::from_str(ctx.clone(), &k.to_string())?.into_value()),
                    ember_core::keyboard::Lossage::Command(c) => {
                        let object = Object::new(ctx.clone())?;
                        object.set("command", c)?;
                        Ok(object.into_value())
                    }
                })
                .collect()
        })?,
    )?;
    native.set(
        "lossageSize",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, size: Opt<usize>| {
            with_editor(&ctx, |ed| {
                if let Some(size) = size.0 {
                    ed.set_lossage_size(size)?;
                }
                Ok(ed.lossage_size())
            })
        })?,
    )?;
    native.set("inputPendingP", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.input_pending_p())))?)?;
    native.set(
        "discardInput",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.discard_input();
                Ok(())
            })
        })?,
    )?;
    // Reading from the minibuffer partway through a command, as Emacs's
    // read-from-minibuffer, completing-read and read-file-name.
    let read_context = context.clone();
    native.set(
        "read",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, kind: String, prompt: String, options: Object<'js>, run: Function<'js>, quit: Opt<Option<Function<'js>>>| {
                let then = ScriptFunction { run: Persistent::save(&ctx, run), context: read_context.clone() }.into_hook();
                let quit = quit.0.flatten().map(|f| ScriptFunction { run: Persistent::save(&ctx, f), context: read_context.clone() }.into_hook());
                let Some(kind) = ParamKind::from_name(&kind) else {
                    return Err(Exception::throw_type(&ctx, &format!("Unknown kind of reading {kind:?}")));
                };
                let mut reading = Reading::new(&prompt, kind);
                reading.collection = options.get("collection")?;
                if let Some(f) = options.get::<_, Option<Function>>("collectionFunction")? {
                    let EditorValue::Function(f) = function_from_js(&ctx, f)? else { unreachable!("a function converts to one") };
                    reading.collection_fn = Some(f);
                }
                reading.category = options.get("category")?;
                reading.require_match = options.get::<_, Option<bool>>("requireMatch")?.unwrap_or(false);
                reading.initial = options.get("initial")?;
                reading.default = options.get("default")?;
                reading.history = options.get("history")?;
                reading.dir = options.get("dir")?;
                with_editor(&ctx, |ed| {
                    ed.read_from_minibuffer(reading, then)?;
                    if let Some(quit) = quit {
                        ed.on_prompt_quit(quit);
                    }
                    Ok(())
                })
            },
        )?,
    )?;
    native.set(
        "minibufferInfo",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| -> rquickjs::Result<Option<Object<'js>>> {
            let info = with_editor(&ctx, |ed| Ok(ed.minibuffer_info()))?;
            let Some(info) = info else { return Ok(None) };
            let object = Object::new(ctx.clone())?;
            object.set("prompt", info.prompt)?;
            object.set("completing", info.completing)?;
            object.set("category", info.category)?;
            object.set("requireMatch", info.require_match)?;
            object.set("default", info.default)?;
            object.set("initial", info.initial)?;
            object.set("ignoreCase", info.ignore_case)?;
            object.set("kept", info.kept)?;
            object.set("history", info.history)?;
            Ok(Some(object))
        })?,
    )?;
    native.set(
        "minibufferPromptEnd",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.minibuffer_prompt_end())))?,
    )?;
    native.set(
        "minibufferContents",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.minibuffer_input())))?,
    )?;
    native.set(
        "completionAllSortedCompletions",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, at_end: Opt<bool>| -> rquickjs::Result<Option<Object<'js>>> {
            let sorted = with_editor(&ctx, |ed| {
                let point = if at_end.0 == Some(true) { ed.minibuffer_input().chars().count() } else { ed.minibuffer_input_point() };
                Ok(ed.completion_all_sorted_completions_at(point))
            })?;
            let Some((base, comps, fresh)) = sorted else { return Ok(None) };
            let object = Object::new(ctx.clone())?;
            object.set("base", base)?;
            object.set("completions", comps)?;
            object.set("fresh", fresh)?;
            Ok(Some(object))
        })?,
    )?;
    native.set(
        "completionTryCompletion",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, input: String, names: Option<Vec<String>>| -> rquickjs::Result<Value<'js>> {
            let found = with_editor(&ctx, |ed| Ok(ed.completion_try_with(&input, input.chars().count(), names)))?;
            Ok(match found {
                ember_core::completion::Try::None => Value::new_null(ctx.clone()),
                ember_core::completion::Try::Exact => Value::new_bool(ctx.clone(), true),
                ember_core::completion::Try::Completed { text, point } => {
                    let object = Object::new(ctx.clone())?;
                    object.set("text", text)?;
                    object.set("point", point)?;
                    object.into_value()
                }
            })
        })?,
    )?;
    native.set(
        "cacheAllSortedCompletions",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, comps: Vec<String>| {
            with_editor(&ctx, |ed| {
                ed.cache_all_sorted_completions(comps);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "whereIs",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, command: String| {
            with_editor(&ctx, |ed| Ok(ed.where_is(&command).map(|keys| ember_core::format_keys(&keys))))
        })?,
    )?;
    native.set(
        "composeLocalMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>| {
            let keymap = value_from_js(&ctx, keymap)?;
            with_editor(&ctx, |ed| ed.compose_local_map(&keymap))
        })?,
    )?;
    native.set(
        "frameSize",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                let total = ed.frame_lines();
                Ok(vec![ed.frame_cells().0 as f64, total as f64, ed.max_mini_window_lines(total) as f64])
            })
        })?,
    )?;
    let process_context = context.clone();
    let network_context = context.clone();
    native.set(
        "makeProcess",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  name: String,
                  buffer: Option<String>,
                  command: Vec<String>,
                  options: Object<'js>,
                  filter: Option<Function<'js>>,
                  sentinel: Option<Function<'js>>| {
                let hook = |f: Option<Function<'js>>| {
                    f.map(|f| ScriptFunction { run: Persistent::save(&ctx, f), context: process_context.clone() }.into_hook())
                };
                let directory: Option<String> = options.get("directory")?;
                let env: Option<Vec<Vec<String>>> = options.get("env")?;
                let merge_stderr: Option<bool> = options.get("stderr")?;
                let pty: bool = options.get::<_, Option<bool>>("pty")?.unwrap_or(false);
                let coding = coding_pair(&ctx, options.get("coding")?)?;
                let spec = ember_core::ProcessSpec {
                    name,
                    buffer,
                    command,
                    directory,
                    env: env.unwrap_or_default().into_iter().filter_map(|kv| Some((kv.first()?.clone(), kv.get(1)?.clone()))).collect(),
                    merge_stderr: merge_stderr.unwrap_or(true),
                    filter: hook(filter),
                    sentinel: hook(sentinel),
                    pty,
                    coding,
                };
                with_editor(&ctx, |ed| ed.make_process(spec))
            },
        )?,
    )?;
    native.set(
        "makeNetworkProcess",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, options: Object<'js>, filter: Option<Function<'js>>, sentinel: Option<Function<'js>>| {
                let hook = |f: Option<Function<'js>>| {
                    f.map(|f| ScriptFunction { run: Persistent::save(&ctx, f), context: network_context.clone() }.into_hook())
                };
                let spec = ember_core::NetworkSpec {
                    name: options.get("name")?,
                    buffer: options.get("buffer")?,
                    host: options.get("host")?,
                    service: options.get("service")?,
                    server: options.get::<_, Option<bool>>("server")?.unwrap_or(false),
                    filter: hook(filter),
                    sentinel: hook(sentinel),
                    coding: coding_pair(&ctx, options.get("coding")?)?,
                };
                with_editor(&ctx, |ed| ed.make_network_process(spec))
            },
        )?,
    )?;
    // The rest of process.c's functions on a process by name, by their Lisp names.
    native.set(
        "processPrimitive",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, op: String, name: String, args: Rest<Value<'js>>| -> rquickjs::Result<Value<'js>> {
            let args = args.0.into_iter().map(|a| value_from_js(&ctx, a)).collect::<rquickjs::Result<Vec<_>>>()?;
            let value = with_editor(&ctx, |ed| process_primitive(ed, &op, &name, &args))?;
            value_to_js(&ctx, &value)
        })?,
    )?;
    native.set(
        "processInfo",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| -> rquickjs::Result<Option<Object<'js>>> {
            let info = with_editor(&ctx, |ed| {
                Ok(ed.process_status(&name).map(|status| {
                    (status, ed.process_buffer(&name), ed.process_mark(&name), ed.process_command(&name).unwrap_or_default(), ed.process_id(&name), ed.process_query_on_exit(&name))
                }))
            })?;
            let Some((status, buffer, mark, command, pid, query)) = info else { return Ok(None) };
            let object = Object::new(ctx.clone())?;
            let code = match status {
                ember_core::ProcessStatus::Run => None,
                ember_core::ProcessStatus::Exit(c) | ember_core::ProcessStatus::Signal(c) => Some(c),
            };
            let kind = with_editor(&ctx, |ed| Ok(ed.process_status_name(&name).unwrap_or("exit")))?;
            object.set("status", kind)?;
            object.set("exitStatus", code)?;
            object.set("buffer", buffer)?;
            object.set("mark", mark.map(|m| m as f64))?;
            object.set("command", command)?;
            object.set("pid", pid)?;
            object.set("queryOnExit", query)?;
            Ok(Some(object))
        })?,
    )?;
    native.set(
        "processList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.process_list())))?,
    )?;
    native.set(
        "getBufferProcess",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, buffer: String| with_editor(&ctx, |ed| Ok(ed.buffer_process(&buffer))))?,
    )?;
    native.set(
        "processSendString",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, text: String| {
            with_editor(&ctx, |ed| ed.process_send_string(&name, &text))
        })?,
    )?;
    native.set(
        "processSendEof",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| with_editor(&ctx, |ed| ed.process_send_eof(&name)))?,
    )?;
    native.set(
        "signalProcess",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, signal: i32| {
            with_editor(&ctx, |ed| ed.signal_process(&name, signal))
        })?,
    )?;
    native.set(
        "deleteProcess",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| with_editor(&ctx, |ed| ed.delete_process(&name)))?,
    )?;
    native.set(
        "setProcessQueryOnExitFlag",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, query: bool| {
            with_editor(&ctx, |ed| ed.set_process_query_on_exit(&name, query))
        })?,
    )?;
    native.set(
        "callProcess",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, command: Vec<String>, directory: Option<String>, input: Option<String>| -> rquickjs::Result<Object<'js>> {
                let (code, output) = with_editor(&ctx, |ed| ed.call_process(&command, directory.as_deref(), input.as_deref()))?;
                let object = Object::new(ctx.clone())?;
                object.set("exit", code)?;
                object.set("output", output)?;
                Ok(object)
            },
        )?,
    )?;
    let waiter_context = context.clone();
    native.set(
        "afterPrompts",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, run: Function<'js>| {
            let f = ScriptFunction { run: Persistent::save(&ctx, run), context: waiter_context.clone() }.into_hook();
            with_editor(&ctx, |ed| ed.after_prompts(f))
        })?,
    )?;
    let timer_context = context.clone();
    native.set(
        "runWithTimer",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, secs: f64, repeat: Option<f64>, idle: bool, run: Function<'js>| {
                let f = ScriptFunction { run: Persistent::save(&ctx, run), context: timer_context.clone() }.into_hook();
                with_editor(&ctx, |ed| {
                    Ok(if idle { ed.run_with_idle_timer(secs, repeat.is_some(), f) } else { ed.run_with_timer(secs, repeat, f) } as f64)
                })
            },
        )?,
    )?;
    native.set(
        "cancelTimer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| {
                ed.cancel_timer(id as u64);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "fileDirectoryP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| with_editor(&ctx, |ed| ed.file_directory_p(&file)))?,
    )?;
    file_functions(ctx, native)?;
    native.set(
        "bufferList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(ed.buffer_list().into_iter().map(|i| ed.buffers()[i].name.clone()).collect::<Vec<_>>()))
        })?,
    )?;
    native.set(
        "writeVisitedFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| ed.write_visited_file()))?,
    )?;
    native.set(
        "revertToVisitedFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| ed.revert_to_visited_file()))?,
    )?;
    native.set(
        "recoverFromAutoSave",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| ed.recover_from_auto_save()))?,
    )?;
    native.set(
        "visitedFileChanged",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().visited_file_changed())))?,
    )?;
    native.set(
        "setVisitedFileName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, along: Opt<bool>| {
            with_editor(&ctx, |ed| ed.set_visited_file_name_along(&ed.expand_file_name(&file), along.0 == Some(true)))
        })?,
    )?;
    native.set(
        "expandFileName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, dir: Opt<String>| {
            with_editor(&ctx, |ed| {
                Ok(match dir.0 {
                    Some(dir) => ember_core::expand_file_name_in(&file, &ed.expand_file_name(&dir)).display().to_string(),
                    None => ed.expand_file_name(&file).display().to_string(),
                })
            })
        })?,
    )?;
    // As Emacs's getenv: an environment variable of the editor's own.
    native.set("getenv", Function::new(ctx.clone(), |name: String| std::env::var(name).ok())?)?;
    native.set(
        "fileAttributes",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| -> rquickjs::Result<Option<Object<'js>>> {
            let path = with_editor(&ctx, |ed| Ok(ed.expand_file_name(&file)))?;
            let Some(a) = ember_core::fileops::file_attributes(&path) else { return Ok(None) };
            let ms = |t: std::time::SystemTime| t.duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
            let object = Object::new(ctx.clone())?;
            let (kind, link) = match &a.kind {
                ember_core::fileops::FileKind::File => ("file", None),
                ember_core::fileops::FileKind::Directory => ("directory", None),
                ember_core::fileops::FileKind::Symlink(to) => ("symlink", Some(to.clone())),
            };
            object.set("type", kind)?;
            object.set("linkTarget", link)?;
            object.set("links", a.links as f64)?;
            object.set("uid", a.uid)?;
            object.set("gid", a.gid)?;
            object.set("user", a.user)?;
            object.set("group", a.group)?;
            object.set("size", a.size as f64)?;
            object.set("modified", ms(a.modified))?;
            object.set("accessed", ms(a.accessed))?;
            object.set("modes", a.modes)?;
            object.set("inode", a.inode as f64)?;
            Ok(Some(object))
        })?,
    )?;
    native.set(
        "directoryFiles",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, dir: String, full: Opt<bool>, pattern: Opt<Option<String>>, nosort: Opt<bool>, count: Opt<Option<usize>>| {
            with_editor(&ctx, |ed| ed.directory_files(&dir, full.0.unwrap_or(false), pattern.0.flatten().as_deref(), nosort.0.unwrap_or(false), count.0.flatten()))
        })?,
    )?;
    native.set(
        "copyFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: String, to: String, ok: bool, keep_time: bool| {
            with_editor(&ctx, |ed| {
                let to_dir = to.ends_with('/');
                ed.copy_file(&ed.expand_file_name(&from), &ed.expand_file_name(&to), to_dir, ok, keep_time).map(|p| p.display().to_string())
            })
        })?,
    )?;
    native.set(
        "copyDirectory",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: String, to: String, keep_time: bool| {
            with_editor(&ctx, |ed| ed.copy_directory(&ed.expand_file_name(&from), &ed.expand_file_name(&to), keep_time).map(|p| p.display().to_string()))
        })?,
    )?;
    native.set(
        "renameFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: String, to: String, ok: bool| {
            with_editor(&ctx, |ed| {
                let to_dir = to.ends_with('/');
                ed.rename_file(&ed.expand_file_name(&from), &ed.expand_file_name(&to), to_dir, ok).map(|p| p.display().to_string())
            })
        })?,
    )?;
    native.set(
        "deleteFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, trash: bool| {
            with_editor(&ctx, |ed| ed.delete_file(&ed.expand_file_name(&file), trash))
        })?,
    )?;
    native.set(
        "makeDirectory",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, dir: String, parents: bool| {
            with_editor(&ctx, |ed| ed.make_directory(&ed.expand_file_name(&dir), parents))
        })?,
    )?;
    native.set(
        "deleteDirectory",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, dir: String, recursive: bool, trash: bool| {
            with_editor(&ctx, |ed| ed.delete_directory(&ed.expand_file_name(&dir), recursive, trash))
        })?,
    )?;
    native.set(
        "readTextFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| {
            with_editor(&ctx, |ed| {
                let path = ed.expand_file_name(&file);
                fs::read_to_string(&path).map_err(|e| ember_core::fileops::file_error("Opening input file", &e, &[&path]))
            })
        })?,
    )?;
    native.set(
        "writeTextFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, text: String, mode: Option<u32>| {
            with_editor(&ctx, |ed| ed.write_text_file_with_mode(&ed.expand_file_name(&file), &text, mode))
        })?,
    )?;
    native.set(
        "projectFiles",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, root: String, ignores: Vec<String>| {
            with_editor(&ctx, |ed| {
                let root = ed.expand_file_name(&root);
                let files = ember_core::fileops::vc_files(&root).unwrap_or_else(|| ember_core::fileops::files_in_directory(&root, &ignores));
                Ok(files.iter().map(|p| p.display().to_string()).collect::<Vec<_>>())
            })
        })?,
    )?;
    native.set(
        "stringMatch",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pattern: String, text: String, fold: bool, start: Opt<usize>| {
            with_editor(&ctx, |ed| {
                let found = ed.string_match(&pattern, &text, start.0.unwrap_or(0), fold)?;
                let at = found.as_ref().map(|m| m.start as f64);
                if found.is_some() {
                    ed.set_match_data(found);
                }
                Ok(at)
            })
        })?,
    )?;
    native.set(
        "messages",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.messages())))?,
    )?;
    native.set(
        "killNew",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| {
                ed.kill_new(&text);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "abbreviateFileName",
        // A directory name keeps its slash, as Emacs's abbreviate-file-name.
        Function::new(ctx.clone(), |file: String| {
            let short = abbreviate_path(Path::new(&file));
            if file.ends_with('/') && !short.ends_with('/') { short + "/" } else { short }
        })?,
    )?;
    native.set(
        "fileExists",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| with_editor(&ctx, |ed| ed.file_exists_p(&file)))?,
    )?;
    native.set(
        "autoSaveFileName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| {
            with_editor(&ctx, |_| Ok(ember_core::auto_save_file_name(Path::new(&file)).display().to_string()))
        })?,
    )?;
    native.set(
        "hasNewerAutoSave",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| {
            with_editor(&ctx, |_| Ok(Editor::has_newer_auto_save(Path::new(&file))))
        })?,
    )?;
    native.set(
        "doAutoSave",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, quiet: bool| with_editor(&ctx, |ed| Ok(ed.do_auto_save(quiet))))?,
    )?;
    native.set(
        "setAutoSave",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, on: bool| {
            with_editor(&ctx, |ed| {
                ed.set_auto_save(on);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "autoSaving",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.auto_saving())))?,
    )?;
    native.set(
        "killEmacs",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| ed.kill_emacs())
        })?,
    )?;
    native.set(
        "commandExists",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| with_editor(&ctx, |ed| Ok(ed.command(&name).is_some())))?,
    )?;
    native.set(
        "thisCommand",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.this_command().map(str::to_string))))?,
    )?;
    install_native_text(ctx, native)?;
    install_native_treesit(ctx, native)?;
    install_native_windows(ctx, native)?;
    install_native_search(ctx, native)?;
    native.set(
        "regionActive",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().is_mark_active())))?,
    )?;
    native.set(
        "calledInteractively",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.called_interactively())))?,
    )?;
    Ok(())
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

/// Searching and replacing, and the keymap primitives incremental search uses.
fn install_native_search<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    native.set(
        "search",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, pattern: String, from: Option<usize>, regexp: bool, backward: bool, bound: Option<usize>, fold: Option<bool>| {
                let found = with_editor(&ctx, |ed| {
                    let case_fold = fold.unwrap_or_else(|| ember_core::search_fold_case(ed, &pattern, false));
                    let options = ember_core::SearchOptions { regexp, backward, case_fold, bound };
                    let from = from.unwrap_or(ed.buffer().point());
                    let found = ed.search(&pattern, from, &options)?;
                    if found.is_some() {
                        ed.set_match_data(found.clone());
                    }
                    Ok(found)
                })?;
                found.map(|m| match_to_js(&ctx, &m)).transpose()
            },
        )?,
    )?;
    native.set(
        "lookingAt",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pattern: String, pos: Option<usize>, fold: Option<bool>| {
            with_editor(&ctx, |ed| {
                let case_fold = fold.unwrap_or_else(|| ed.variable("case-fold-search").is_none_or(|v| v.is_true()));
                let pos = pos.unwrap_or(ed.buffer().point());
                let found = ed.looking_at(&pattern, pos, case_fold)?;
                if found.is_some() {
                    ed.set_match_data(found.clone());
                }
                Ok(found.is_some())
            })
        })?,
    )?;
    native.set(
        "matchData",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            let m = with_editor(&ctx, |ed| Ok(ed.match_data().cloned()))?;
            m.map(|m| match_to_js(&ctx, &m)).transpose()
        })?,
    )?;
    native.set(
        "replaceMatch",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, replacement: String, literal: bool, fixed_case: bool| {
            with_editor(&ctx, |ed| ed.replace_match(&replacement, literal, fixed_case)).map(|(s, e)| vec![s, e])
        })?,
    )?;
    native.set(
        "foldCaseFor",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pattern: String, interactive: bool| {
            with_editor(&ctx, |ed| Ok(ember_core::search_fold_case(ed, &pattern, interactive)))
        })?,
    )?;
    native.set(
        "setOverridingMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>| {
            let keymap = if keymap.is_undefined() || keymap.is_null() { None } else { Some(value_from_js(&ctx, keymap)?) };
            with_editor(&ctx, |ed| ed.set_overriding_map(keymap.as_ref()))
        })?,
    )?;
    native.set(
        "overridingMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| -> rquickjs::Result<Value<'js>> {
            match with_editor(&ctx, |ed| Ok(ed.overriding_map()))? {
                Some(map) => value_to_js(&ctx, &EditorValue::Keymap(map)),
                None => Ok(Value::new_undefined(ctx.clone())),
            }
        })?,
    )?;
    native.set(
        "setKeymapDefault",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>, command: Option<String>| {
            let keymap = value_from_js(&ctx, keymap)?;
            with_editor(&ctx, |ed| {
                let map = ed.keymap_of(&keymap)?;
                ed.keymaps_mut().set_default(map, command.as_deref());
                Ok(())
            })
        })?,
    )?;
    native.set(
        "remapCommand",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Value<'js>, from: String, to: Option<String>| {
            let keymap = value_from_js(&ctx, keymap)?;
            with_editor(&ctx, |ed| {
                let map = ed.keymap_of(&keymap)?;
                ed.keymaps_mut().remap(map, &from, to.as_deref());
                Ok(())
            })
        })?,
    )?;
    native.set(
        "stringWidth",
        Function::new(ctx.clone(), |text: String| ember_core::display::display_width(&text, 8))?,
    )?;
    native.set(
        "unreadKeys",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keys: String| {
            with_editor(&ctx, |ed| {
                let keys = ember_core::Key::parse_seq(&keys)
                    .ok_or_else(|| ember_core::Error::new(format!("Invalid key sequence: {keys}")))?;
                ed.unread_keys(&keys);
                Ok(())
            })
        })?,
    )?;
    Ok(())
}

/// Windows, as Emacs's window primitives.
fn install_native_windows<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    native.set(
        "splitWindow",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: Option<u64>, side_by_side: bool, size: Option<i64>| {
            with_editor(&ctx, |ed| ed.split_window_sized(window, side_by_side, size))
        })?,
    )?;
    native.set(
        "deleteWindow",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: Option<u64>| with_editor(&ctx, |ed| ed.delete_window(window)))?,
    )?;
    native.set(
        "selectWindow",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| ed.select_window(window)))?,
    )?;
    native.set(
        "selectedWindow",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(if ed.minibuffer_window_selected() { ember_core::MINIBUFFER_WINDOW } else { ed.selected_window() }))
        })?,
    )?;
    native.set(
        "windowList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            // The minibuffer's window comes last while a prompt is open, as in Emacs's window-list.
            with_editor(&ctx, |ed| {
                let mut windows = ed.window_list();
                if ed.prompt().is_some() {
                    windows.push(ember_core::MINIBUFFER_WINDOW);
                }
                Ok(windows)
            })
        })?,
    )?;
    native.set(
        "minibufferDepth",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.minibuffer_depth())))?,
    )?;
    native.set(
        "lastMouseEvent",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            let Some(event) = with_editor(&ctx, |ed| Ok(ed.last_mouse_event()))? else { return Ok::<_, rquickjs::Error>(None) };
            let object = Object::new(ctx.clone())?;
            object.set("window", event.window)?;
            object.set("position", event.position)?;
            if let Some((window, position)) = event.start {
                let start = Object::new(ctx.clone())?;
                start.set("window", window)?;
                start.set("position", position)?;
                object.set("start", start)?;
            }
            Ok(Some(object))
        })?,
    )?;
    native.set(
        "screenLine",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            let (start, end, continued) = with_editor(&ctx, |ed| Ok(ed.screen_line(pos)))?;
            let object = Object::new(ctx.clone())?;
            object.set("start", start)?;
            object.set("end", end)?;
            object.set("continued", continued)?;
            Ok::<_, rquickjs::Error>(object)
        })?,
    )?;
    native.set(
        "windowBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| {
            with_editor(&ctx, |ed| {
                if window == ember_core::MINIBUFFER_WINDOW {
                    return Ok(Some(ed.minibuffer().name.clone()));
                }
                Ok(ed.window_buffer_name(window).map(str::to_string))
            })
        })?,
    )?;
    native.set(
        "setReadOnly",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, on: bool| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().read_only = on;
                Ok(())
            })
        })?,
    )?;
    native.set(
        "bufferReadOnly",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().read_only)))?,
    )?;
    native.set(
        "setCurrentBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| with_editor(&ctx, |ed| ed.set_current_buffer(&name)))?,
    )?;
    native.set(
        "getBufferCreate",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                ed.get_buffer_create(&name);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "findFileNoselect",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| {
            with_editor(&ctx, |ed| ed.find_file_noselect(&ed.expand_file_name(&file)))
        })?,
    )?;
    native.set(
        "makeFrame",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, buffer: Option<String>| {
            with_editor(&ctx, |ed| ed.make_frame(buffer.as_deref()))
        })?,
    )?;
    native.set(
        "deleteFrame",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, frame: Option<u64>| with_editor(&ctx, |ed| ed.delete_frame(frame)))?,
    )?;
    native.set(
        "selectFrame",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, frame: u64| with_editor(&ctx, |ed| ed.select_frame(frame)))?,
    )?;
    native.set(
        "selectedFrame",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.selected_frame())))?,
    )?;
    native.set(
        "frameList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.frame_list())))?,
    )?;
    native.set(
        "setWindowBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, buffer: String| {
            with_editor(&ctx, |ed| ed.set_window_buffer(window, &buffer))
        })?,
    )?;
    native.set(
        "windowSize",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| {
            with_editor(&ctx, |ed| {
                let total = ed.window_total_sizes().into_iter().find(|s| s.0 == window);
                let full = usize::from(ed.window_full_width(window));
                Ok(ed.window_size(window).zip(total).map(|((w, h), (_, tw, th))| vec![w, h, tw, th, full]))
            })
        })?,
    )?;
    native.set(
        "windowUseTime",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| Ok(ed.window_use_time(window))))?,
    )?;
    native.set(
        "resizeWindow",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: Option<u64>, delta: i64, horizontal: bool, apply: bool| {
            with_editor(&ctx, |ed| ed.resize_window(window, delta, horizontal, apply))
        })?,
    )?;
    native.set(
        "balanceWindows",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.balance_windows();
                Ok(())
            })
        })?,
    )?;
    Ok(())
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

/// Syntax trees, as Emacs's treesit.el.
fn install_native_treesit<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    native.set(
        "treesitLanguages",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(ed.treesit_languages().into_iter().map(String::from).collect::<Vec<_>>()))
        })?,
    )?;
    native.set(
        "treesitSetLanguage",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, language: Option<String>| {
            with_editor(&ctx, |ed| ed.set_buffer_language(language.as_deref()))
        })?,
    )?;
    native.set(
        "treesitLanguage",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer_language().map(String::from))))?,
    )?;
    native.set(
        "treesitNodeAt",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            let node = with_editor(&ctx, |ed| Ok(ed.syntax_node_at(pos)))?;
            node.map(|(kind, start, end)| {
                let object = Object::new(ctx.clone())?;
                object.set("type", kind)?;
                object.set("start", start)?;
                object.set("end", end)?;
                Ok::<_, rquickjs::Error>(object)
            })
            .transpose()
        })?,
    )?;
    Ok(())
}

/// Text properties, overlays, faces and invisibility.
fn install_native_text<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    native.set(
        "putTextProperty",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize, name: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| {
                ed.buffer_mut().put_text_property(start..end, &name, value);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "addFaceTextProperty",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize, face: String, append: bool| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().add_face_text_property(start..end, &face, append);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "removeTextProperty",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize, name: String| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().remove_text_property(start..end, &name);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "textPropertiesAt",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            let props = with_editor(&ctx, |ed| Ok(ed.buffer().text_properties_at(pos).cloned().unwrap_or_default()))?;
            props_to_js(&ctx, &props)
        })?,
    )?;
    native.set(
        "charProperty",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, name: String| {
            let value = with_editor(&ctx, |ed| Ok(ed.buffer().char_property(pos, &name).cloned()))?;
            value.map(|v| value_to_js(&ctx, &v)).transpose()
        })?,
    )?;
    // Where a property changes, as textprop.c's searches: KIND names
    // which, PROP the property for the -single- ones.
    native.set(
        "propertyChange",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, kind: String, pos: usize, prop: Option<String>, limit: Option<usize>| {
            with_editor(&ctx, |ed| {
                let b = ed.buffer();
                let prop = prop.as_deref().unwrap_or("");
                Ok(match kind.as_str() {
                    "next" => b.next_property_change(pos).filter(|&p| p < b.len()).map(|p| limit.map_or(p, |l| p.min(l))).or(limit),
                    "previous" => b.previous_property_change(pos).filter(|&p| p > 0 && p < pos).map(|p| limit.map_or(p, |l| p.max(l))).or(limit),
                    "next-single" => b.next_single_property_change(pos, prop, limit),
                    "previous-single" => b.previous_single_property_change(pos, prop, limit),
                    "next-single-char" => Some(b.next_single_char_property_change(pos, prop, limit)),
                    "previous-single-char" => Some(b.previous_single_char_property_change(pos, prop, limit)),
                    "next-char" => Some(b.next_char_property_change(pos).min(limit.unwrap_or(b.point_max()))),
                    "previous-char" => Some(b.previous_char_property_change(pos, limit)),
                    "next-overlay" => Some(b.next_overlay_change(pos)),
                    "previous-overlay" => Some(b.previous_overlay_change(pos)),
                    _ => None,
                })
            })
        })?,
    )?;
    native.set(
        "textPropertySearch",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, matching: bool, start: usize, end: usize, prop: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| {
                let b = ed.buffer();
                Ok(if matching { b.text_property_any(start, end, &prop, &value) } else { b.text_property_not_all(start, end, &prop, &value) })
            })
        })?,
    )?;
    native.set(
        "getPosProperty",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, prop: String| {
            let value = with_editor(&ctx, |ed| Ok(ed.get_pos_property(pos, &prop)))?;
            value.map(|v| value_to_js(&ctx, &v)).transpose()
        })?,
    )?;
    // Fields, as editfns.c's: the bounds of the one around POS.
    native.set(
        "findField",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, merge: bool, beg_limit: Option<usize>, end_limit: Option<usize>| {
            with_editor(&ctx, |ed| {
                let (beg, end) = ed.find_field(pos, merge, beg_limit, end_limit);
                Ok(vec![beg, end])
            })
        })?,
    )?;
    native.set(
        "constrainToField",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, new: usize, old: usize, escape: bool, only_in_line: bool, capture: Option<String>| {
            with_editor(&ctx, |ed| Ok(ed.constrain_to_field(new, old, escape, only_in_line, capture.as_deref())))
        })?,
    )?;
    native.set(
        "makeOverlay",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize, front: bool, rear: bool| {
            with_editor(&ctx, |ed| Ok(ed.buffer_mut().make_overlay_advancing(start..end, front, rear) as f64))
        })?,
    )?;
    native.set(
        "overlayPut",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64, name: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| ed.buffer_mut().overlay_put(id as u64, &name, value))
        })?,
    )?;
    native.set(
        "overlayGet",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64, name: String| {
            let value =
                with_editor(&ctx, |ed| Ok(ed.buffer().overlay(id as u64).and_then(|o| o.props.get(&name).cloned())))?;
            value.map(|v| value_to_js(&ctx, &v)).transpose()
        })?,
    )?;
    native.set(
        "prepareChangeGroup",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer_mut().prepare_change_group())))?,
    )?;
    native.set(
        "cancelChangeGroup",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, handle: usize| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().cancel_change_group(handle);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "acceptChangeGroup",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, handle: usize| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().accept_change_group(handle);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "windowStart",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: Opt<u64>| {
            with_editor(&ctx, |ed| {
                let id = window.0.unwrap_or(ed.selected_window());
                ed.window_start(id).ok_or_else(|| Error::new("No such window"))
            })
        })?,
    )?;
    native.set(
        "setWindowStart",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, pos: usize| with_editor(&ctx, |ed| ed.set_window_start(window, pos)))?,
    )?;
    char_table_functions(ctx, native)?;
    for (name, case) in [
        ("upcase", ember_core::casefiddle::Case::Up),
        ("downcase", ember_core::casefiddle::Case::Down),
        ("capitalize", ember_core::casefiddle::Case::Capitalize),
        ("upcaseInitials", ember_core::casefiddle::Case::UpcaseInitials),
    ] {
        native.set(name, Function::new(ctx.clone(), move |ctx: Ctx<'js>, s: String| with_editor(&ctx, |ed| Ok(ed.casify_string(case, &s))))?)?;
    }
    native.set(
        "windowEnd",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| ed.window_end(window).ok_or_else(|| Error::new("No such window"))))?,
    )?;
    native.set(
        "posVisibleInWindowP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, window: u64, partially: bool| with_editor(&ctx, |ed| Ok(ed.pos_visible_in_window_p(pos, window, partially))))?,
    )?;
    native.set(
        "posnAtPoint",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, window: u64| -> rquickjs::Result<Value<'js>> {
            let posn = with_editor(&ctx, |ed| Ok(ed.posn_at_point(pos, window)))?;
            posn_to_js(&ctx, posn)
        })?,
    )?;
    native.set(
        "posnAtXY",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, x: f64, y: f64, window: u64| -> rquickjs::Result<Value<'js>> {
            let posn = with_editor(&ctx, |ed| Ok(ed.posn_at_x_y(x as f32, y as f32, window)))?;
            posn_to_js(&ctx, posn)
        })?,
    )?;
    native.set(
        "windowTextPixelSize",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, from: usize, to: usize| {
            with_editor(&ctx, |ed| {
                let (w, h) = ed.window_text_pixel_size(window, from, to).ok_or_else(|| Error::new("No such window"))?;
                Ok(vec![w as f64, h as f64])
            })
        })?,
    )?;
    native.set("linePixelHeight", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.line_pixel_height() as f64)))?)?;
    native.set("defaultFontWidth", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.default_font_width() as f64)))?)?;
    native.set("defaultFontHeight", Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.default_font_height() as f64)))?)?;
    native.set(
        "windowPoint",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| ed.window_point(window).ok_or_else(|| Error::new("No such window"))))?,
    )?;
    native.set(
        "setWindowPoint",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, pos: usize| with_editor(&ctx, |ed| ed.set_window_point(window, pos)))?,
    )?;
    native.set(
        "switchToPrevBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, how: Opt<String>| {
            with_editor(&ctx, |ed| {
                let how = match how.0.as_deref() {
                    None => None,
                    Some("bury") => Some(ember_core::BuryOrKill::Bury),
                    Some("kill") => Some(ember_core::BuryOrKill::Kill),
                    Some("append") => Some(ember_core::BuryOrKill::Append),
                    Some(other) => return Err(Error::new(format!("switchToPrevBuffer takes bury, kill or append, not {other}"))),
                };
                ed.switch_to_prev_buffer(window, how)
            })
        })?,
    )?;
    native.set(
        "switchToNextBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| ed.switch_to_next_buffer(window)))?,
    )?;
    native.set(
        "buryBufferInternal",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, buffer: String| with_editor(&ctx, |ed| ed.bury_buffer_internal(&buffer)))?,
    )?;
    native.set(
        "windowParameter",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, name: String| -> rquickjs::Result<Value<'js>> {
            match with_editor(&ctx, |ed| Ok(ed.window_parameter(window, &name).cloned()))? {
                Some(v) => value_to_js(&ctx, &v),
                None => Ok(Value::new_undefined(ctx.clone())),
            }
        })?,
    )?;
    native.set(
        "setWindowParameter",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, name: String, value: Value<'js>| {
            let value = value_from_js(&ctx, value)?;
            with_editor(&ctx, |ed| ed.set_window_parameter(window, &name, value))
        })?,
    )?;
    native.set(
        "windowParameterNames",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| Ok(ed.window_parameters(window).into_iter().map(|(k, _)| k).collect::<Vec<_>>())))?,
    )?;
    native.set(
        "windowDedicatedP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| -> rquickjs::Result<Value<'js>> {
            let v = with_editor(&ctx, |ed| Ok(ed.window_dedicated(window)))?;
            value_to_js(&ctx, &v)
        })?,
    )?;
    native.set(
        "setWindowDedicatedP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, flag: Value<'js>| {
            let flag = value_from_js(&ctx, flag)?;
            with_editor(&ctx, |ed| ed.set_window_dedicated(window, flag))
        })?,
    )?;
    native.set(
        "windowPrevBuffers",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| -> rquickjs::Result<Value<'js>> {
            let entries = with_editor(&ctx, |ed| Ok(ed.window_prev_buffers(window)))?;
            let list = entries.into_iter().map(|(b, s, p)| EditorValue::List(vec![EditorValue::Str(b), EditorValue::Number(s as f64), EditorValue::Number(p as f64)])).collect();
            value_to_js(&ctx, &EditorValue::List(list))
        })?,
    )?;
    native.set(
        "setWindowPrevBuffers",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, buffers: Value<'js>| {
            let EditorValue::List(items) = value_from_js(&ctx, buffers)? else {
                return Err(Exception::throw_type(&ctx, "setWindowPrevBuffers takes [buffer, start, point] entries"));
            };
            let entries = items
                .into_iter()
                .filter_map(|e| match e {
                    EditorValue::List(e) => match e.as_slice() {
                        [b, s, p] => Some((b.as_str()?.to_string(), s.as_number()? as usize, p.as_number()? as usize)),
                        _ => None,
                    },
                    _ => None,
                })
                .collect();
            with_editor(&ctx, |ed| ed.set_window_prev_buffers(window, entries))
        })?,
    )?;
    native.set(
        "windowNextBuffers",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64| with_editor(&ctx, |ed| Ok(ed.window_next_buffers(window))))?,
    )?;
    native.set(
        "setWindowNextBuffers",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, window: u64, buffers: Vec<String>| with_editor(&ctx, |ed| ed.set_window_next_buffers(window, buffers)))?,
    )?;
    native.set(
        "currentWindowConfiguration",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.current_window_configuration())))?,
    )?;
    native.set(
        "setWindowConfiguration",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: u64| with_editor(&ctx, |ed| ed.set_window_configuration(id)))?,
    )?;
    native.set(
        "freeWindowConfiguration",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: u64| {
            with_editor(&ctx, |ed| {
                ed.free_window_configuration(id);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "defineError",
        Function::new(ctx.clone(), |symbol: String, parent: String| ember_core::define_error(&symbol, &parent))?,
    )?;
    native.set("errorConditions", Function::new(ctx.clone(), |symbol: String| ember_core::error_conditions(&symbol))?)?;
    native.set(
        "killRegion",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, beg: usize, end: usize| with_editor(&ctx, |ed| ed.kill_region(beg, end)))?,
    )?;
    native.set(
        "makeSyntaxTable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, parent: Option<String>| {
            with_editor(&ctx, |ed| {
                if let Some(p) = &parent
                    && !ed.syntax_tables.exists(p)
                {
                    return Err(Error::new(format!("No such syntax table: {p}")));
                }
                ed.syntax_tables.make(&name, parent.as_deref());
                Ok(())
            })
        })?,
    )?;
    native.set(
        "modifySyntaxEntry",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, chars: String, descriptor: String, table: Option<String>| {
            with_editor(&ctx, |ed| {
                let entry = ember_core::syntax_table::Entry::parse(&descriptor)?;
                // The standard table can change too, as in Emacs, for every
                // table that inherits from it.
                let table = table.unwrap_or_else(|| ed.buffer().syntax_table.clone());
                for c in chars.chars() {
                    ed.syntax_tables.modify(&table, c, entry);
                }
                Ok(())
            })
        })?,
    )?;
    native.set(
        "syntaxTable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().syntax_table.clone())))?,
    )?;
    native.set(
        "setSyntaxTable",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                if !ed.syntax_tables.exists(&name) {
                    return Err(Error::new(format!("No such syntax table: {name}")));
                }
                ed.buffer_mut().syntax_table = name;
                Ok(())
            })
        })?,
    )?;
    native.set(
        "syntaxEntry",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, c: String| {
            with_editor(&ctx, |ed| Ok(c.chars().next().map(|c| ed.char_syntax(c).descriptor())))
        })?,
    )?;
    native.set(
        "scanLists",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: usize, count: f64, depth: f64, sexp: bool| {
            with_editor(&ctx, |ed| {
                let to = if count > 0.0 { ed.buffer().point_max() } else { from };
                ed.syntax_propertize(to)?;
                ed.scanner().scan_lists(from, count as i64, depth as i64, sexp)
            })
        })?,
    )?;
    native.set(
        "forwardComment",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, count: f64| {
            with_editor(&ctx, |ed| {
                let to = if count > 0.0 { ed.buffer().point_max() } else { ed.buffer().point() };
                ed.syntax_propertize(to)?;
                let (pos, all) = ed.scanner().forward_comment(ed.buffer().point(), count as i64);
                ed.buffer_mut().set_point(pos);
                Ok(all)
            })
        })?,
    )?;
    native.set(
        "backwardPrefixChars",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.syntax_propertize(ed.buffer().point())?;
                let pos = ed.scanner().backward_prefix_chars(ed.buffer().point());
                ed.buffer_mut().set_point(pos);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "parsePartialSexp",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: Option<usize>, to: usize| -> rquickjs::Result<Object<'js>> {
            let st = with_editor(&ctx, |ed| {
                ed.syntax_propertize(to)?;
                let scanner = ed.scanner();
                // With no start, from the start of the buffer through its kept states, as syntax-ppss.
                Ok(match from {
                    None => scanner.ppss(to),
                    Some(from) => {
                        let (from, to) = (from.clamp(scanner.min, scanner.max), to.clamp(scanner.min, scanner.max));
                        scanner.parse(from, to, Default::default())
                    }
                })
            })?;
            let object = Object::new(ctx.clone())?;
            object.set("depth", st.depth as f64)?;
            object.set("innermostStart", st.innermost_start)?;
            object.set("lastComplete", st.last_complete)?;
            object.set("inString", st.in_string.map(|c| c.to_string()))?;
            object.set("inComment", st.in_comment.map(|n| n as f64))?;
            object.set("quoted", st.quoted)?;
            object.set("minDepth", st.min_depth as f64)?;
            object.set("commentStyle", st.comment_style)?;
            object.set("start", st.string_or_comment_start)?;
            object.set("openParens", st.open_parens)?;
            Ok(object)
        })?,
    )?;
    native.set(
        "substCharInRegion",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize, from: String, to: String| {
            let (Some(from), Some(to)) = (from.chars().next(), to.chars().next()) else {
                return Err(rquickjs::Error::new_from_js_message("string", "char", "substCharInRegion takes characters"));
            };
            with_editor(&ctx, |ed| ed.subst_char_in_region(start, end, from, to))
        })?,
    )?;
    native.set(
        "makeMarker",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize, buffer: Option<String>, advances: bool| {
            with_editor(&ctx, |ed| {
                let b = match &buffer {
                    Some(name) => ed.buffer_named_mut(name).ok_or_else(|| Error::new(format!("No such buffer: {name}")))?,
                    None => ed.buffer_mut(),
                };
                Ok(b.make_marker(pos, advances) as f64)
            })
        })?,
    )?;
    native.set(
        "deleteMarker",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| {
                ed.delete_marker(id as u64);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "markerPosition",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| Ok(ed.marker_position(id as u64).map(|(_, p)| p)))
        })?,
    )?;
    native.set(
        "markerBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| Ok(ed.marker_position(id as u64).map(|(b, _)| b.to_string())))
        })?,
    )?;
    native.set(
        "setMarker",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64, pos: Option<usize>, buffer: Option<String>| {
            with_editor(&ctx, |ed| {
                let name = match (pos, buffer) {
                    (None, _) => None,
                    (Some(_), Some(name)) => Some(name),
                    // Where it is, or the current buffer if nowhere.
                    (Some(_), None) => Some(
                        ed.marker_position(id as u64).map(|(b, _)| b.to_string()).unwrap_or_else(|| ed.buffer().name.clone()),
                    ),
                };
                ed.set_marker(id as u64, name.as_deref(), pos.unwrap_or(0))
            })
        })?,
    )?;
    native.set(
        "overlayRange",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| Ok(ed.buffer().overlay(id as u64).map(|o| vec![o.start, o.end])))
        })?,
    )?;
    native.set(
        "moveOverlay",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64, start: usize, end: usize| {
            with_editor(&ctx, |ed| ed.buffer_mut().move_overlay(id as u64, start..end))
        })?,
    )?;
    native.set(
        "deleteOverlay",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, id: f64| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().delete_overlay(id as u64);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "overlaysIn",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize| {
            with_editor(&ctx, |ed| {
                // Overlays that overlap the range, and empty ones inside it, as Emacs's overlays-in.
                Ok(ed
                    .buffer()
                    .overlays()
                    .iter()
                    .filter(|o| (o.start < end && o.end > start) || (o.start == o.end && o.start >= start && o.start <= end))
                    .map(|o| o.id as f64)
                    .collect::<Vec<f64>>())
            })
        })?,
    )?;
    native.set(
        "lineCount",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().line_count())))?,
    )?;
    native.set(
        "lineOf",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            with_editor(&ctx, |ed| Ok(ed.buffer().line_of(pos.min(ed.buffer().len()))))
        })?,
    )?;
    native.set(
        "lineStart",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, line: usize| {
            with_editor(&ctx, |ed| Ok(accessible_line(ed.buffer(), line).0))
        })?,
    )?;
    native.set(
        "lineEnd",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, line: usize| {
            with_editor(&ctx, |ed| Ok(accessible_line(ed.buffer(), line).1))
        })?,
    )?;
    native.set(
        "lineText",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, line: usize| {
            with_editor(&ctx, |ed| {
                let (start, end) = accessible_line(ed.buffer(), line);
                Ok(ed.buffer().slice(start..end))
            })
        })?,
    )?;
    native.set(
        "bufferSize",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().len())))?,
    )?;
    native.set(
        "pointMin",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().point_min())))?,
    )?;
    native.set(
        "pointMax",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().point_max())))?,
    )?;
    native.set(
        "narrowToRegion",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: usize, end: usize| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().narrow(start, end);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "widen",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().widen();
                Ok(())
            })
        })?,
    )?;
    native.set(
        "bufferModified",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().is_modified())))?,
    )?;
    native.set(
        "setBufferModified",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, modified: bool| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().set_modified(modified);
                Ok(())
            })
        })?,
    )?;
    // The undo history as data, as buffer-undo-list: true when undo is off.
    native.set(
        "bufferUndoList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            let list = with_editor(&ctx, |ed| {
                // An indirect buffer's is its base's.
                let current = ed.buffer_with_id(ed.buffer().id()).expect("current");
                ed.claim_undo(current);
                Ok(ed.buffer().undo_list())
            })?;
            value_to_js(&ctx, &list.unwrap_or(EditorValue::Bool(true)))
        })?,
    )?;
    // Indirect buffers, as buffer.c's: ids, as buffer objects refer to them.
    native.set(
        "makeIndirectBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, base: String, name: String, clone: bool| {
            with_editor(&ctx, |ed| {
                let index = ed.make_indirect_buffer(&base, &name, clone)?;
                Ok(ed.buffers()[index].id() as f64)
            })
        })?,
    )?;
    native.set(
        "bufferBaseBuffer",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                let index = ed.find_buffer(&name).ok_or_else(|| ember_core::Error::new(format!("No such buffer {name}")))?;
                Ok(ed.buffers()[index].base_buffer().map(|id| id as f64))
            })
        })?,
    )?;
    native.set(
        "generateNewBufferName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| with_editor(&ctx, |ed| Ok(ed.unique_buffer_name(&name))))?,
    )?;
    native.set(
        "setUndoEnabled",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, on: bool| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().set_undo_enabled(on);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "bufferModifiedTick",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.buffer().modified_tick() as f64)))?,
    )?;
    native.set(
        "invisibleAt",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            with_editor(&ctx, |ed| Ok(ed.invisible_in(ed.buffer(), pos).is_some()))
        })?,
    )?;
    native.set(
        "defineFace",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, name: String, doc: String, attrs: Object<'js>, dark: Object<'js>, light: Object<'js>| {
                let mut face = Face::new(&name, &doc, face_attrs_from_js(&attrs)?);
                face.dark = face_attrs_from_js(&dark)?;
                face.light = face_attrs_from_js(&light)?;
                face.source = LOADING.with_borrow(|files| files.last().cloned());
                with_editor(&ctx, |ed| {
                    ed.define_face(face);
                    Ok(())
                })
            },
        )?,
    )?;
    native.set(
        "setFaceAttribute",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, attrs: Object<'js>, background: String| {
            let attrs = face_attrs_from_js(&attrs)?;
            let background = match background.as_str() {
                "dark" => Background::Dark,
                "light" => Background::Light,
                _ => Background::Both,
            };
            with_editor(&ctx, |ed| {
                ed.set_face_attributes(&name, attrs, background);
                Ok(())
            })
        })?,
    )?;
    native.set(
        "faceAttributes",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, dark: bool| {
            let attrs = with_editor(&ctx, |ed| Ok(ed.face_attrs(&name, dark)))?;
            face_attrs_to_js(&ctx, &attrs)
        })?,
    )?;
    native.set(
        "faceInfo",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| -> rquickjs::Result<Option<Object<'js>>> {
            let face = with_editor(&ctx, |ed| Ok(ed.face(&name).cloned()))?;
            let Some(face) = face else { return Ok(None) };
            let info = Object::new(ctx.clone())?;
            info.set("doc", face.doc)?;
            info.set("source", face.source)?;
            info.set("attributes", face_attrs_to_js(&ctx, &face.attrs)?)?;
            info.set("dark", face_attrs_to_js(&ctx, &face.dark)?)?;
            info.set("light", face_attrs_to_js(&ctx, &face.light)?)?;
            Ok(Some(info))
        })?,
    )?;
    Ok(())
}

fn props_to_js<'js>(ctx: &Ctx<'js>, props: &ember_core::Props) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    for (name, value) in props {
        object.set(name.as_str(), value_to_js(ctx, value)?)?;
    }
    Ok(object)
}

/// Face attributes from an object such as `{ foreground: "accent", bold: true }`.
fn face_attrs_from_js<'js>(object: &Object<'js>) -> rquickjs::Result<FaceAttrs> {
    let text = |key: &str| object.get::<_, Option<String>>(key);
    let flag = |key: &str| object.get::<_, Option<bool>>(key);
    Ok(FaceAttrs {
        foreground: text("foreground")?,
        background: text("background")?,
        bold: flag("bold")?,
        italic: flag("italic")?,
        underline: flag("underline")?,
        strike: flag("strike")?,
        height: object.get::<_, Option<f64>>("height")?.map(ember_core::FaceHeight::from_number),
        family: text("family")?,
        inherit: text("inherit")?,
    })
}

/// A character as scripts give one: a code point, or a string of one character.
fn char_code(value: &Value) -> Option<u32> {
    if let Some(n) = value.as_number() {
        return Some(n as u32);
    }
    value.as_string().and_then(|s| s.to_string().ok()).and_then(|s| s.chars().next()).map(|c| c as u32)
}

/// A range as scripts give one: null for the default, a character, or [from, to].
fn char_range(value: &Value) -> Option<ember_core::chartab::CharRange> {
    use ember_core::chartab::CharRange;
    if value.is_null() || value.is_undefined() {
        return Some(CharRange::Default);
    }
    if let Some(pair) = value.as_array() {
        let (from, to): (Value, Value) = (pair.get(0).ok()?, pair.get(1).ok()?);
        return Some(CharRange::Range(char_code(&from)?, char_code(&to)?));
    }
    char_code(value).map(CharRange::Char)
}

/// The file primitives as fileio.c, dired.c and filelock.c give them to
/// Lisp, each offered first to a handler in file-name-handler-alist.
fn file_functions<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    let predicates: [(&str, FilePredicate); 7] = [
        ("fileExistsP", |ed, f| ed.file_exists_p(f)),
        ("fileReadableP", |ed, f| ed.file_readable_p(f)),
        ("fileWritableP", |ed, f| ed.file_writable_p(f)),
        ("fileExecutableP", |ed, f| ed.file_executable_p(f)),
        ("fileRegularP", |ed, f| ed.file_regular_p(f)),
        ("fileAccessibleDirectoryP", |ed, f| ed.file_accessible_directory_p(f)),
        ("fileNameAbsoluteP", |_, f| Ok(ember_core::file_name_absolute_p(f))),
    ];
    for (name, test) in predicates {
        native.set(name, Function::new(ctx.clone(), move |ctx: Ctx<'js>, file: String| with_editor(&ctx, |ed| test(ed, &file)))?)?;
    }
    native.set("fileSymlinkP", Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| with_editor(&ctx, |ed| ed.file_symlink_p(&file)))?)?;
    native.set(
        "fileNewerThanFileP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, a: String, b: String| with_editor(&ctx, |ed| ed.file_newer_than_file_p(&a, &b)))?,
    )?;
    native.set(
        "fileModes",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, nofollow: Opt<bool>| with_editor(&ctx, |ed| ed.file_modes(&file, nofollow.0.unwrap_or(false))))?,
    )?;
    native.set("setFileModes", Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, mode: u32| with_editor(&ctx, |ed| ed.set_file_modes(&file, mode)))?)?;
    native.set(
        "setFileTimes",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, time: Opt<Option<f64>>| with_editor(&ctx, |ed| ed.set_file_times(&file, time.0.flatten())))?,
    )?;
    native.set("fileTruename", Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| with_editor(&ctx, |ed| ed.file_truename(&file)))?)?;
    native.set(
        "substituteInFileName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| with_editor(&ctx, |_| ember_core::substitute_in_file_name(&file)))?,
    )?;
    native.set(
        "fileNameConcat",
        Function::new(ctx.clone(), |parts: Vec<String>| ember_core::file_name_concat(&parts.iter().map(String::as_str).collect::<Vec<_>>()))?,
    )?;
    native.set(
        "makeTempFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, prefix: String, dir: bool, suffix: String, text: Opt<Option<String>>| {
            with_editor(&ctx, |ed| ed.make_temp_file(&prefix, dir, &suffix, text.0.flatten().as_deref()))
        })?,
    )?;
    native.set(
        "findFileNameHandler",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, operation: String| -> rquickjs::Result<Value<'js>> {
            let handler = with_editor(&ctx, |ed| Ok(ed.find_file_name_handler(&file, &operation)))?;
            value_to_js(&ctx, &handler.unwrap_or(EditorValue::Null))
        })?,
    )?;
    native.set(
        "insertFileContents",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String, options: Object<'js>| -> rquickjs::Result<Value<'js>> {
            let visit = options.get::<_, Option<bool>>("visit")?.unwrap_or(false);
            let replace = options.get::<_, Option<bool>>("replace")?.unwrap_or(false);
            let (beg, end) = (options.get::<_, Option<usize>>("beg")?, options.get::<_, Option<usize>>("end")?);
            let (name, n) = with_editor(&ctx, |ed| ed.insert_file_contents(&file, visit, beg, end, replace))?;
            value_to_js(&ctx, &EditorValue::List(vec![EditorValue::Str(name), EditorValue::Number(n as f64)]))
        })?,
    )?;
    native.set(
        "writeRegion",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, start: Value<'js>, end: Option<usize>, file: String, options: Object<'js>| {
            let append = options.get::<_, Option<bool>>("append")?.unwrap_or(false);
            let quiet = options.get::<_, Option<bool>>("quiet")?.unwrap_or(false);
            let mustbenew = options.get::<_, Option<bool>>("mustbenew")?.unwrap_or(false);
            let visit: Value<'js> = options.get("visit")?;
            let source = if start.is_null() || start.is_undefined() {
                ember_core::WriteSource::Buffer
            } else if let Some(text) = start.as_string() {
                ember_core::WriteSource::Text(text.to_string()?)
            } else {
                let a = start.as_number().unwrap_or(0.0) as usize;
                ember_core::WriteSource::Region(a, end.unwrap_or(a))
            };
            let visit = if let Some(name) = visit.as_string() {
                ember_core::Visit::Name(name.to_string()?)
            } else if visit.as_bool() == Some(true) {
                ember_core::Visit::Yes
            } else if quiet {
                ember_core::Visit::Quiet
            } else {
                ember_core::Visit::No
            };
            with_editor(&ctx, |ed| ed.write_region(source, &file, append, visit, mustbenew))
        })?,
    )?;
    native.set(
        "fileLockedP",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| -> rquickjs::Result<Value<'js>> {
            let owner = with_editor(&ctx, |ed| ed.file_locked_p(&file))?;
            Ok(match owner {
                ember_core::filelock::LockOwner::None => Value::new_undefined(ctx.clone()),
                ember_core::filelock::LockOwner::Me => Value::new_bool(ctx.clone(), true),
                ember_core::filelock::LockOwner::Other(owner) => rquickjs::String::from_str(ctx.clone(), &owner)?.into_value(),
            })
        })?,
    )?;
    Ok(())
}

/// A file predicate, as fileio.c's `file-*-p`.
type FilePredicate = fn(&mut Editor, &str) -> Result<bool>;

/// The editor's current or standard table of a kind.
type TableGetter = fn(&mut Editor) -> u64;
/// Making a table the current or standard one of its kind.
type TableSetter = fn(&mut Editor, u64) -> Result<()>;
/// Whether a char-table is one of a kind.
type TableTest = fn(&Editor, u64) -> bool;

/// Char-tables, case tables and category tables, as chartab.c, casetab.c
/// and category.c give them to Lisp.
fn char_table_functions<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    let table = |v: EditorValue| -> Result<u64> {
        match v {
            EditorValue::CharTable(id) => Ok(id),
            _ => Err(Error::signal("wrong-type-argument", "Wrong type argument: char-table-p", Vec::new())),
        }
    };
    let optional = move |v: Opt<Value<'js>>, ctx: &Ctx<'js>| -> rquickjs::Result<Option<u64>> {
        match v.0 {
            Some(v) if !v.is_null() && !v.is_undefined() => match value_from_js(ctx, v)? {
                EditorValue::CharTable(id) => Ok(Some(id)),
                _ => Err(Exception::throw_type(ctx, "Expected a char-table")),
            },
            _ => Ok(None),
        }
    };
    let ct = |id: u64| EditorValue::CharTable(id);
    native.set(
        "makeCharTable",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, subtype: String, init: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let init = value_from_js(&ctx, init)?;
            let id = with_editor(&ctx, |ed| ed.make_char_table(&subtype, init))?;
            value_to_js(&ctx, &ct(id))
        })?,
    )?;
    native.set(
        "charTableP",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, v: Value<'js>| {
            let v = value_from_js(&ctx, v).unwrap_or(EditorValue::Null);
            with_editor(&ctx, |ed| Ok(matches!(v, EditorValue::CharTable(id) if ed.char_table_p(id))))
        })?,
    )?;
    native.set(
        "charTableSubtype",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>| {
            let t = table(value_from_js(&ctx, t)?);
            with_editor(&ctx, |ed| ed.char_table_subtype(t?))
        })?,
    )?;
    native.set(
        "charTableParent",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let t = table(value_from_js(&ctx, t)?);
            let parent = with_editor(&ctx, |ed| ed.char_table_parent(t?))?;
            value_to_js(&ctx, &parent.map_or(EditorValue::Null, ct))
        })?,
    )?;
    native.set(
        "setCharTableParent",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>, parent: Opt<Value<'js>>| {
            let t = table(value_from_js(&ctx, t)?);
            let parent = optional(parent, &ctx)?;
            with_editor(&ctx, |ed| ed.set_char_table_parent(t?, parent))
        })?,
    )?;
    native.set(
        "charTableExtraSlot",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>, n: usize| -> rquickjs::Result<Value<'js>> {
            let t = table(value_from_js(&ctx, t)?);
            let v = with_editor(&ctx, |ed| ed.char_table_extra_slot(t?, n))?;
            value_to_js(&ctx, &v)
        })?,
    )?;
    native.set(
        "setCharTableExtraSlot",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>, n: usize, v: Value<'js>| {
            let t = table(value_from_js(&ctx, t)?);
            let v = value_from_js(&ctx, v)?;
            with_editor(&ctx, |ed| ed.set_char_table_extra_slot(t?, n, v))
        })?,
    )?;
    native.set(
        "charTableRange",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>, range: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let t = table(value_from_js(&ctx, t)?);
            let range = char_range(&range).ok_or_else(|| Exception::throw_type(&ctx, "A range is null, a character or [from, to]"))?;
            let v = with_editor(&ctx, |ed| ed.char_table_range(t?, range))?;
            value_to_js(&ctx, &v)
        })?,
    )?;
    native.set(
        "setCharTableRange",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>, range: Value<'js>, v: Value<'js>| {
            let t = table(value_from_js(&ctx, t)?);
            let range = char_range(&range).ok_or_else(|| Exception::throw_type(&ctx, "A range is null, a character or [from, to]"))?;
            let v = value_from_js(&ctx, v)?;
            with_editor(&ctx, |ed| ed.set_char_table_range(t?, range, v))
        })?,
    )?;
    native.set(
        "mapCharTable",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let t = table(value_from_js(&ctx, t)?);
            let runs = with_editor(&ctx, |ed| ed.map_char_table(t?))?;
            let list = runs
                .into_iter()
                .map(|(first, last, v)| {
                    let key = if first == last { EditorValue::Number(first as f64) } else { EditorValue::List(vec![EditorValue::Number(first as f64), EditorValue::Number(last as f64)]) };
                    EditorValue::List(vec![key, v])
                })
                .collect();
            value_to_js(&ctx, &EditorValue::List(list))
        })?,
    )?;
    native.set(
        "copyCharTable",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>| -> rquickjs::Result<Value<'js>> {
            let t = table(value_from_js(&ctx, t)?);
            let id = with_editor(&ctx, |ed| ed.copy_char_table(t?))?;
            value_to_js(&ctx, &ct(id))
        })?,
    )?;
    let tables: [(&str, TableGetter); 4] = [
        ("standardCaseTable", |ed| ed.standard_case_table()),
        ("currentCaseTable", |ed| ed.current_case_table()),
        ("standardCategoryTable", |ed| ed.standard_category_table()),
        ("categoryTable", |ed| ed.category_table()),
    ];
    for (name, get) in tables {
        native.set(
            name,
            Function::new(ctx.clone(), move |ctx: Ctx<'js>| -> rquickjs::Result<Value<'js>> {
                let id = with_editor(&ctx, |ed| Ok(get(ed)))?;
                value_to_js(&ctx, &ct(id))
            })?,
        )?;
    }
    native.set(
        "makeCategoryTable",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>| -> rquickjs::Result<Value<'js>> {
            let id = with_editor(&ctx, |ed| Ok(ed.make_category_table()))?;
            value_to_js(&ctx, &ct(id))
        })?,
    )?;
    native.set(
        "copyCategoryTable",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Opt<Value<'js>>| -> rquickjs::Result<Value<'js>> {
            let t = optional(t, &ctx)?;
            let id = with_editor(&ctx, |ed| ed.copy_category_table(t))?;
            value_to_js(&ctx, &ct(id))
        })?,
    )?;
    let setters: [(&str, TableSetter); 3] = [
        ("setCaseTable", |ed, id| ed.set_case_table(id)),
        ("setStandardCaseTable", |ed, id| ed.set_standard_case_table(id)),
        ("setCategoryTable", |ed, id| ed.set_category_table(id)),
    ];
    for (name, set) in setters {
        native.set(
            name,
            Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Value<'js>| {
                let t = table(value_from_js(&ctx, t)?);
                with_editor(&ctx, |ed| set(ed, t?))
            })?,
        )?;
    }
    let predicates: [(&str, TableTest); 2] = [("caseTableP", |ed, id| ed.case_table_p(id)), ("categoryTableP", |ed, id| ed.category_table_p(id))];
    for (name, test) in predicates {
        native.set(
            name,
            Function::new(ctx.clone(), move |ctx: Ctx<'js>, v: Value<'js>| {
                let v = value_from_js(&ctx, v).unwrap_or(EditorValue::Null);
                with_editor(&ctx, |ed| Ok(matches!(v, EditorValue::CharTable(id) if test(ed, id))))
            })?,
        )?;
    }
    native.set(
        "defineCategory",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, d: String, doc: String, t: Opt<Value<'js>>| {
            let t = optional(t, &ctx)?;
            let d = d.chars().next().unwrap_or(' ');
            with_editor(&ctx, |ed| ed.define_category(d, &doc, t))
        })?,
    )?;
    native.set(
        "categoryDocstring",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, d: String, t: Opt<Value<'js>>| {
            let t = optional(t, &ctx)?;
            let d = d.chars().next().unwrap_or(' ');
            with_editor(&ctx, |ed| ed.category_docstring(d, t))
        })?,
    )?;
    native.set(
        "getUnusedCategory",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, t: Opt<Value<'js>>| {
            let t = optional(t, &ctx)?;
            with_editor(&ctx, |ed| Ok(ed.get_unused_category(t)?.map(|c| c.to_string())))
        })?,
    )?;
    native.set(
        "charCategorySet",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, c: Value<'js>| {
            let c = char_code(&c).and_then(char::from_u32).ok_or_else(|| Exception::throw_type(&ctx, "Expected a character"))?;
            with_editor(&ctx, |ed| Ok(ed.char_category_set(c)))
        })?,
    )?;
    native.set(
        "modifyCategoryEntry",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, range: Value<'js>, d: String, t: Opt<Value<'js>>, reset: Opt<bool>| {
            let range = char_range(&range).ok_or_else(|| Exception::throw_type(&ctx, "A range is a character or [from, to]"))?;
            let t = optional(t, &ctx)?;
            let d = d.chars().next().unwrap_or(' ');
            with_editor(&ctx, |ed| ed.modify_category_entry(range, d, t, reset.0.unwrap_or(false)))
        })?,
    )?;
    Ok(())
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

fn face_attrs_to_js<'js>(ctx: &Ctx<'js>, attrs: &FaceAttrs) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    if let Some(height) = attrs.height {
        object.set("height", height.as_number())?;
    }
    for (key, value) in [("foreground", &attrs.foreground), ("background", &attrs.background), ("family", &attrs.family), ("inherit", &attrs.inherit)] {
        if let Some(v) = value {
            object.set(key, v.as_str())?;
        }
    }
    for (key, value) in [("bold", attrs.bold), ("italic", attrs.italic), ("underline", attrs.underline), ("strike", attrs.strike)] {
        if let Some(v) = value {
            object.set(key, v)?;
        }
    }
    Ok(object)
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
        let message = format!("Script stopped after running for {:?}", TIME_LIMIT.get());
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
fn coding_pair<'js>(ctx: &Ctx<'js>, value: Option<Value<'js>>) -> rquickjs::Result<Option<(ember_core::coding::Coding, ember_core::coding::Coding)>> {
    let Some(value) = value.filter(|v| !v.is_undefined() && !v.is_null()) else { return Ok(None) };
    let names: Vec<String> = match value_from_js(ctx, value)? {
        EditorValue::List(items) => items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        v => v.as_str().map(|s| vec![s.to_string(), s.to_string()]).unwrap_or_default(),
    };
    let parse = |n: Option<&String>| -> rquickjs::Result<ember_core::coding::Coding> {
        let n = n.ok_or_else(|| rquickjs::Exception::throw_type(ctx, "A coding system for each way"))?;
        ember_core::coding::Coding::parse(n).ok_or_else(|| rquickjs::Exception::throw_type(ctx, &format!("Invalid coding system: {n}")))
    };
    Ok(Some((parse(names.first())?, parse(names.get(1).or(names.first()))?)))
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
