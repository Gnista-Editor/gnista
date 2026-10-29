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

use std::rc::Rc;

use ember_core::{
    Arg, Background, Command, Editor, Error, Face, FaceAttrs, HookFn, Key, Keymap, MinibufferOverlay, MinorMode, ParamKind, Reading,
    PrefixArg, Result, Value as EditorValue, Variable, abbreviate_path, expand_file_name,
};
use rquickjs::context::EvalOptions;
use rquickjs::function::{Opt, Rest};
use rquickjs::{
    Coerced, Context, Ctx, Exception, FromJs, Function, Object, Persistent, Runtime, Value, qjs,
};

const PRELUDE: &str = include_str!("prelude.js");

/// The packages that ship with Ember, in the order they load. Like the Lisp
/// that Emacs preloads, they are part of the editor: `-q` skips init.ts but
/// not these. Named by their path in the repository.
const PACKAGES: &[(&str, &str)] = &[
    ("packages/simple.ts", include_str!("../../../packages/simple.ts")),
    ("packages/files.ts", include_str!("../../../packages/files.ts")),
    ("packages/text-mode.ts", include_str!("../../../packages/text-mode.ts")),
    ("packages/outline.ts", include_str!("../../../packages/outline.ts")),
    ("packages/prog-mode.ts", include_str!("../../../packages/prog-mode.ts")),
    ("packages/treesit-modes.ts", include_str!("../../../packages/treesit-modes.ts")),
    ("packages/delsel.ts", include_str!("../../../packages/delsel.ts")),
    ("packages/help.ts", include_str!("../../../packages/help.ts")),
    ("packages/repeat.ts", include_str!("../../../packages/repeat.ts")),
    ("packages/kmacro.ts", include_str!("../../../packages/kmacro.ts")),
    ("packages/window.ts", include_str!("../../../packages/window.ts")),
    ("packages/mouse.ts", include_str!("../../../packages/mouse.ts")),
    ("packages/isearch.ts", include_str!("../../../packages/isearch.ts")),
    ("packages/icomplete.ts", include_str!("../../../packages/icomplete.ts")),
    ("packages/replace.ts", include_str!("../../../packages/replace.ts")),
    ("packages/org-table.ts", include_str!("../../../packages/org-table.ts")),
    ("packages/org.ts", include_str!("../../../packages/org.ts")),
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
        for (name, source) in PACKAGES {
            LOADING.with_borrow_mut(|files| files.push(name.to_string()));
            let result = scripting.eval_typescript(ed, name, source.to_string());
            LOADING.with_borrow_mut(|files| files.pop());
            result?;
        }
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

/// A script's string arguments for a command, as the command's parameters take them.
fn command_args(ed: &Editor, name: &str, args: Vec<String>) -> Result<Vec<Arg>> {
    let command = ed.command(name).ok_or_else(|| Error::new(format!("No such command: {name}")))?;
    args.into_iter()
        .enumerate()
        .map(|(i, arg)| match command.params.get(i).map(|p| p.kind) {
            Some(ParamKind::Keys) => Key::parse_seq(&arg)
                .map(Arg::Keys)
                .ok_or_else(|| Error::new(format!("Invalid key sequence: {arg:?}"))),
            _ => Ok(Arg::Str(arg)),
        })
        .collect()
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
/// A script function the editor holds on to, as a command or a hook function.
struct ScriptFunction {
    // Declared before `context` so the function is freed before the runtime can be.
    run: Persistent<Function<'static>>,
    context: Context,
}

impl ScriptFunction {
    fn call(&self, ed: &mut Editor, args: Vec<String>) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            let run = self.run.clone().restore(&ctx).map_err(|e| js_error(&ctx, e))?;
            run.call::<_, Value>((Rest(args),))
                .map(drop)
                .map_err(|e| js_error(&ctx, e))
        })
    }

    fn into_command(self) -> impl Fn(&mut Editor, &[Arg]) -> Result<()> {
        move |ed, args| self.call(ed, args.iter().map(Arg::to_string).collect())
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

    fn into_hook(self) -> HookFn {
        Rc::new(move |ed, args| self.call_values(ed, args))
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
            move |ctx: Ctx<'js>, name: String, doc: String, params: Vec<Object<'js>>, run: Function<'js>| {
                let script = ScriptFunction { run: Persistent::save(&ctx, run), context: context.clone() };
                let mut command = Command::new(&name, &doc, script.into_command());
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keys: String, command: String, keymap: Opt<String>| {
            with_editor(&ctx, |ed| {
                let parsed = Key::parse_seq(&keys)
                    .ok_or_else(|| Error::new(format!("Invalid key sequence: {keys:?}")))?;
                ed.bind_key_in(keymap.0.as_deref().unwrap_or("global-map"), &parsed, &command)
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
    native.set(
        "call",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, args: Rest<String>| {
            with_editor(&ctx, |ed| {
                let args = command_args(ed, &name, args.0)?;
                ed.call(&name, args)
            })
        })?,
    )?;
    native.set(
        "callWithPrefix",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, prefix: Value<'js>, name: String, args: Rest<String>| {
            let prefix = prefix_from_js(&ctx, prefix)?;
            with_editor(&ctx, |ed| {
                let args = command_args(ed, &name, args.0)?;
                ed.call_with_prefix(&name, args, prefix)
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
            with_editor(&ctx, |ed| {
                ed.buffer_mut().insert(&text)?;
                ed.run_after_change_functions()
            })
        })?,
    )?;
    native.set(
        "insertBeforeMarkers",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().insert_before_markers(&text)?;
                ed.run_after_change_functions()
            })
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            with_editor(&ctx, |ed| {
                ed.buffer_mut().insert_and_inherit(&text)?;
                ed.run_after_change_functions()
            })
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
            with_editor(&ctx, |ed| {
                let deleted = ed.buffer_mut().delete(start.min(end)..start.max(end))?;
                ed.run_after_change_functions()?;
                Ok(deleted)
            })
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, bindings: Object<'js>| {
            let mut map = Keymap::default();
            for entry in bindings.props::<String, String>() {
                let (keys, command) = entry?;
                let Some(parsed) = Key::parse_seq(&keys) else {
                    return Err(Exception::throw_message(&ctx, &format!("Invalid key sequence: {keys:?}")));
                };
                map.bind(&parsed, &command);
            }
            with_editor(&ctx, |ed| {
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
    let hook_context = context.clone();
    native.set(
        "addHook",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, hook: String, name: String, run: Function<'js>, local: bool| {
                let script = ScriptFunction { run: Persistent::save(&ctx, run), context: hook_context.clone() };
                with_editor(&ctx, |ed| Ok(ed.add_hook(&hook, &name, script.into_hook(), local) as f64))
            },
        )?,
    )?;
    native.set(
        "hookContains",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, hook: String, id: f64, local: bool| {
            with_editor(&ctx, |ed| Ok(ed.hook_contains(&hook, id as u64, local)))
        })?,
    )?;
    native.set(
        "removeHook",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, hook: String, id: f64, local: bool| {
            with_editor(&ctx, |ed| {
                ed.remove_hook(&hook, id as u64, local);
                Ok(())
            })
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String, parent: Opt<Option<String>>| {
            with_editor(&ctx, |ed| {
                ed.define_keymap(&name, parent.0.flatten().as_deref());
                Ok(())
            })
        })?,
    )?;
    native.set(
        "useLocalMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: Option<String>| {
            with_editor(&ctx, |ed| {
                ed.use_local_map(name.as_deref());
                Ok(())
            })
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
            move |ctx: Ctx<'js>, kind: String, question: String, choices: Vec<String>, run: Function<'js>| {
                let then = ScriptFunction { run: Persistent::save(&ctx, run), context: ask_context.clone() }.into_hook();
                with_editor(&ctx, |ed| match kind.as_str() {
                    "yes-or-no" => ed.yes_or_no_p(&question, then),
                    "y-or-n" => ed.y_or_n_p(&question, then),
                    "answer" => ed.read_answer(&question, &choices.iter().map(String::as_str).collect::<Vec<_>>(), then),
                    _ => ed.read_char_choice(&question, &choices.iter().filter_map(|c| c.chars().next()).collect::<Vec<_>>(), then),
                })
            },
        )?,
    )?;
    // Reading from the minibuffer partway through a command, as Emacs's
    // read-from-minibuffer, completing-read and read-file-name.
    let read_context = context.clone();
    native.set(
        "read",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, kind: String, prompt: String, options: Object<'js>, run: Function<'js>| {
                let then = ScriptFunction { run: Persistent::save(&ctx, run), context: read_context.clone() }.into_hook();
                let Some(kind) = ParamKind::from_name(&kind) else {
                    return Err(Exception::throw_type(&ctx, &format!("Unknown kind of reading {kind:?}")));
                };
                let mut reading = Reading::new(&prompt, kind);
                reading.collection = options.get("collection")?;
                reading.category = options.get("category")?;
                reading.require_match = options.get::<_, Option<bool>>("requireMatch")?.unwrap_or(false);
                reading.initial = options.get("initial")?;
                reading.default = options.get("default")?;
                reading.history = options.get("history")?;
                reading.dir = options.get("dir")?;
                with_editor(&ctx, |ed| ed.read_from_minibuffer(reading, then))
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
            Ok(Some(object))
        })?,
    )?;
    native.set(
        "completionAllSortedCompletions",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, at_end: Opt<bool>| -> rquickjs::Result<Option<Object<'js>>> {
            let sorted = with_editor(&ctx, |ed| {
                let point = if at_end.0 == Some(true) { ed.minibuffer_input().chars().count() } else { ed.minibuffer().point() };
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
        "setMinibufferOverlay",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, before: Option<String>, texts: Vec<String>, faces: Vec<Vec<String>>| {
            with_editor(&ctx, |ed| {
                let overlay = before.map(|before| MinibufferOverlay { before, after: texts.into_iter().zip(faces).collect() });
                ed.set_minibuffer_overlay(overlay);
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, name: String| {
            with_editor(&ctx, |ed| {
                ed.compose_local_map(&name);
                Ok(())
            })
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
        Function::new(ctx.clone(), |file: String| expand_file_name(&file).is_dir())?,
    )?;
    native.set(
        "bufferList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| Ok(ed.buffers().iter().map(|b| b.name.clone()).collect::<Vec<_>>()))
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| {
            with_editor(&ctx, |ed| ed.set_visited_file_name(&expand_file_name(&file)))
        })?,
    )?;
    native.set(
        "expandFileName",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| {
            with_editor(&ctx, |_| Ok(expand_file_name(&file).display().to_string()))
        })?,
    )?;
    native.set(
        "fileExists",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, file: String| with_editor(&ctx, |_| Ok(Path::new(&file).exists())))?,
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
                    let found = ember_core::search(ed.buffer(), &pattern, from, &options)?;
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: Option<String>| {
            with_editor(&ctx, |ed| ed.set_overriding_map(keymap.as_deref()))
        })?,
    )?;
    native.set(
        "overridingMap",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.overriding_map().map(str::to_string))))?,
    )?;
    native.set(
        "setKeymapDefault",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: String, command: Option<String>| {
            with_editor(&ctx, |ed| ed.set_keymap_default(&keymap, command.as_deref()))
        })?,
    )?;
    native.set(
        "remapCommand",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, keymap: String, from: String, to: Option<String>| {
            with_editor(&ctx, |ed| ed.remap_command(&keymap, &from, to.as_deref()))
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
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.selected_window())))?,
    )?;
    native.set(
        "windowList",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| with_editor(&ctx, |ed| Ok(ed.window_list())))?,
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
            with_editor(&ctx, |ed| Ok(ed.window_buffer_name(window).map(str::to_string)))
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
            with_editor(&ctx, |ed| ed.find_file_noselect(&ember_core::expand_file_name(&file)))
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
    native.set(
        "nextPropertyChange",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            with_editor(&ctx, |ed| Ok(ed.buffer().next_property_change(pos)))
        })?,
    )?;
    native.set(
        "nextCharPropertyChange",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, pos: usize| {
            with_editor(&ctx, |ed| Ok(ed.buffer().next_char_property_change(pos)))
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
        inherit: text("inherit")?,
    })
}

fn face_attrs_to_js<'js>(ctx: &Ctx<'js>, attrs: &FaceAttrs) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    for (key, value) in [("foreground", &attrs.foreground), ("background", &attrs.background), ("inherit", &attrs.inherit)] {
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
    })
}

fn value_from_js<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<EditorValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(EditorValue::Null);
    }
    if let Some(b) = value.as_bool() {
        return Ok(EditorValue::Bool(b));
    }
    if let Some(n) = value.as_number() {
        return Ok(EditorValue::Number(n));
    }
    if let Some(s) = value.as_string() {
        return Ok(EditorValue::Str(s.to_string()?));
    }
    if let Some(list) = value.as_array() {
        let items = (0..list.len())
            .map(|i| value_from_js(ctx, list.get(i)?))
            .collect::<rquickjs::Result<Vec<_>>>()?;
        return Ok(EditorValue::List(items));
    }
    Err(Exception::throw_type(
        ctx,
        "A variable holds null, a boolean, a number, a string, or an array of these",
    ))
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
