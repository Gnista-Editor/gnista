//! The QuickJS engine, through rquickjs: the runtime, entering it from the
//! editor, converting values, and the natives' binding.

mod bindings;

pub(crate) use bindings::{Param, Ret};

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::rc::Rc;

use ember_core::{Arg, Command, Editor, Error, FaceAttrs, ParamKind, PrefixArg, Result, Value as EditorValue};
use rquickjs::context::EvalOptions;
use rquickjs::function::{Opt, Rest};
use rquickjs::{Coerced, Context, Ctx, Exception, FromJs, Function, Object, Persistent, Runtime, Value, qjs};

use crate::{
    EDITOR, Failure, LOADING, Outermost, PRELUDE, Restore, camel_key, editor_call, face_attribute_key, natives, nested_deadline,
    package_source, should_stop, strip_module_types, stripped,
};

thread_local! {
    /// The context of the script that is running, if any.
    static ACTIVE: Cell<Option<NonNull<qjs::JSContext>>> = const { Cell::new(None) };
    /// The contexts of the scripts running, innermost last, for functions
    /// made into editor values to call back into.
    static CONTEXTS: RefCell<Vec<Context>> = const { RefCell::new(Vec::new()) };
    /// Promises rejected with no handler yet, and why: an async command's
    /// error, reported once the code that settled it has finished.
    static UNHANDLED: RefCell<Vec<(Persistent<Value<'static>>, Persistent<Value<'static>>)>> = const { RefCell::new(Vec::new()) };
}

/// A QuickJS runtime with the `ember` global. Clones share it.
#[derive(Clone)]
pub(crate) struct Engine {
    context: Context,
}

impl Engine {
    /// Starts a runtime, installs the natives and runs the prelude.
    pub(crate) fn new(ed: &mut Editor) -> Result<Engine> {
        let runtime = Runtime::new().map_err(|e| Error::new(e.to_string()))?;
        runtime.set_loader(PackageResolver, PackageLoader);
        runtime.set_interrupt_handler(Some(Box::new(should_stop)));
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
        let engine = Engine { context };
        enter(&engine.context, ed, |ctx| {
            install_native(&ctx, &engine.context).map_err(|e| js_error(&ctx, e))?;
            ctx.eval_with_options::<(), _>(PRELUDE, eval_options("ember:prelude")).map_err(|e| js_error(&ctx, e))
        })?;
        Ok(engine)
    }

    /// Imports a package, as an ES module, and what it imports.
    pub(crate) fn import(&self, ed: &mut Editor, name: &str) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            rquickjs::Module::import(&ctx, name)
                .and_then(|promise| promise.finish::<Value>())
                .map(drop)
                .map_err(|e| js_error_with_location(&ctx, e))
        })
    }

    /// Runs a script, its types already erased, as a global script.
    pub(crate) fn run(&self, ed: &mut Editor, filename: &str, js: String) -> Result<()> {
        enter(&self.context, ed, |ctx| {
            ctx.eval_with_options::<(), _>(js, eval_options(filename)).map_err(|e| js_error_with_location(&ctx, e))
        })
    }

    /// Evaluates an expression and gives its value as JSON, or `undefined`.
    pub(crate) fn eval_json(&self, ed: &mut Editor, js: String) -> Result<String> {
        enter(&self.context, ed, |ctx| {
            let value: Value = ctx.eval_with_options(js, eval_options("expression")).map_err(|e| js_error(&ctx, e))?;
            match ctx.json_stringify(value).map_err(|e| js_error(&ctx, e))? {
                Some(json) => json.to_string().map_err(|e| js_error(&ctx, e)),
                None => Ok("undefined".to_string()),
            }
        })
    }
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
        let js = match stripped(file) {
            Some(js) => js.to_string(),
            None => strip_module_types(file, source.to_string()).map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?,
        };
        rquickjs::Module::declare(ctx.clone(), file, js)
    }
}

fn eval_options(filename: &str) -> EvalOptions {
    let mut options = EvalOptions::default();
    options.global = true;
    options.strict = true;
    options.filename = Some(filename.to_string());
    options
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
            let _deadline = nested_deadline();
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
            let outermost = Outermost::begin();
            let result = f(ctx.clone());
            outermost.unwind_if_stopped();
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


/// A command's argument as a script's command gets it.
fn arg_to_js<'js>(ctx: &Ctx<'js>, arg: &Arg) -> rquickjs::Result<Value<'js>> {
    match arg {
        Arg::Int(n) => Ok(Value::new_number(ctx.clone(), *n as f64)),
        Arg::Prefix(prefix) => prefix_to_js(ctx, *prefix),
        other => Ok(rquickjs::String::from_str(ctx.clone(), &other.to_string())?.into_value()),
    }
}

/// The editor functions scripts call are kept by their JavaScript
/// functions here, and freed with them: nothing to forget.
pub(crate) fn forget_function(_id: u64) {}

/// Collects garbage in the running script's runtime.
pub(crate) fn collect_garbage() {
    if let Some(raw) = ACTIVE.get() {
        // SAFETY: ACTIVE is the context of the script running, whose runtime lock is held.
        unsafe { Ctx::from_raw(raw) }.run_gc();
    }
}

/// Runs a native's body so that a panic in it, in the native or in the
/// core under it, is an error the script sees, as on V8.
pub(crate) fn catching<'js, T>(ctx: &Ctx<'js>, f: impl FnOnce() -> rquickjs::Result<T>) -> rquickjs::Result<T> {
    match crate::catch_native(f) {
        Ok(result) => result,
        Err(panic) => Err(throw_error(ctx, &Error::new(format!("Internal error: {}", crate::panic_message(&*panic))))),
    }
}

/// Gives a native the editor, throwing its error to the script. See [`editor_call`].
pub(crate) fn with_editor<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    editor_call(true, f).map_err(|e| throw_error(ctx, &e))
}

/// As [`with_editor`], but not a safe point.
pub(crate) fn with_editor_unchecked<T>(ctx: &Ctx<'_>, f: impl FnOnce(&mut Editor) -> Result<T>) -> rquickjs::Result<T> {
    editor_call(false, f).map_err(|e| throw_error(ctx, &e))
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

fn props_to_js<'js>(ctx: &Ctx<'js>, props: &ember_core::Props) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    for (name, value) in props {
        object.set(name.as_str(), value_to_js(ctx, value)?)?;
    }
    Ok(object)
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
            // A frozen function cannot keep its identity, and works without
            // it, as on V8.
            if f.set(FUNCTION_ID, function.id() as f64).is_err() {
                let _ = ctx.catch();
            }
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
        && let Ok(n) = list.get::<f64>(0)
    {
        return Ok(Some(PrefixArg::Universal(n as i64)));
    }
    Err(Exception::throw_type(ctx, "A prefix argument is null, a number, \"-\" or [n]"))
}

/// What a failed script threw.
fn failure(ctx: &Ctx<'_>, err: rquickjs::Error) -> Failure {
    if !err.is_exception() {
        return Failure { message: err.to_string(), is_bug: true, location: None, symbol: None, data: Vec::new() };
    }
    let value = ctx.catch();
    let Some(exception) = value.as_exception() else {
        // An object with a message, as an error class of a script's own
        // not built on Error, is read as an error is, as on V8.
        if let Some(object) = value.as_object()
            && let Ok(Some(message)) = object.get::<_, Option<String>>("message")
        {
            let name: String = object.get::<_, Option<String>>("name").ok().flatten().unwrap_or_default();
            let stack: Option<String> = object.get("stack").ok().flatten();
            let symbol: Option<String> = object.get("symbol").ok().flatten();
            let data: Vec<EditorValue> = object
                .get::<_, Option<Vec<Value>>>("data")
                .ok()
                .flatten()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v| value_from_js(ctx, v).ok())
                .collect();
            return Failure::thrown(&name, message, stack.as_deref(), symbol, data);
        }
        let message = Coerced::<String>::from_js(ctx, value)
            .map(|s| s.0)
            .unwrap_or_else(|_| "Script threw a value that is not an Error".into());
        return Failure { message, is_bug: false, location: None, symbol: None, data: Vec::new() };
    };
    let message = exception.message().unwrap_or_default();
    let name: String = exception.get("name").unwrap_or_default();
    let stack = exception.stack();
    if name == "InternalError" && message == "interrupted" {
        return Failure::stopped(stack.as_deref().and_then(crate::first_location));
    }
    let symbol: Option<String> = exception.get("symbol").ok().flatten();
    let data: Vec<EditorValue> = exception
        .get::<_, Option<Vec<Value>>>("data")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| value_from_js(ctx, v).ok())
        .collect();
    Failure::thrown(&name, message, stack.as_deref(), symbol, data)
}

/// An error for a failed command.
fn js_error(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    failure(ctx, err).into_error()
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

/// An error for a failed file load.
fn js_error_with_location(ctx: &Ctx<'_>, err: rquickjs::Error) -> Error {
    failure(ctx, err).into_error_with_location()
}
