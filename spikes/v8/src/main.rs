//! A spike for Ember's step 4: the same JavaScript on QuickJS (rquickjs, as
//! Ember embeds it) and on V8 (the v8 crate), with the same host functions,
//! and whether V8 runs `finally` blocks when execution is terminated.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

static LINES: OnceLock<Vec<String>> = OnceLock::new();

const WORKLOADS: [&str; 5] = ["host", "parse", "shift", "fontify", "search"];
const REPS: usize = 7;

fn lines() -> &'static [String] {
    LINES.get().unwrap()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn quickjs(source: &str) {
    use rquickjs::{Context, Function, Runtime};
    let t = Instant::now();
    let rt = Runtime::new().unwrap();
    rt.set_max_stack_size(64 << 20);
    let ctx = Context::full(&rt).unwrap();
    ctx.with(|ctx| {
        let g = ctx.globals();
        g.set("lineText", Function::new(ctx.clone(), |i: usize| lines()[i].clone()).unwrap()).unwrap();
        g.set("lineCount", Function::new(ctx.clone(), || lines().len()).unwrap()).unwrap();
        ctx.eval::<(), _>(source).unwrap();
        println!("quickjs: start and load {:.2} ms", t.elapsed().as_secs_f64() * 1000.0);
        let run: Function = g.get("run").unwrap();
        for name in WORKLOADS {
            let mut times = vec![];
            let mut result = 0.0;
            for _ in 0..REPS {
                let t = Instant::now();
                result = run.call::<_, f64>((name,)).unwrap();
                times.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            println!("quickjs: {name:8} {:9.2} ms, first {:9.2} ms  ({result})", median(times.clone()), times[0]);
        }
    });
}

fn line_text(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue<v8::Value>) {
    let i = args.get(0).integer_value(scope).unwrap() as usize;
    rv.set(v8::String::new(scope, &lines()[i]).unwrap().into());
}

fn line_count(scope: &mut v8::PinScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue<v8::Value>) {
    rv.set(v8::Integer::new(scope, lines().len() as i32).into());
}

fn eval<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str) -> Option<v8::Local<'s, v8::Value>> {
    let code = v8::String::new(scope, source).unwrap();
    v8::Script::compile(scope, code, None)?.run(scope)
}

fn v8_engine(source: &str) {
    let t = Instant::now();
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let global = context.global(scope);
    let key = v8::String::new(scope, "lineText").unwrap();
    let func = v8::Function::new(scope, line_text).unwrap();
    global.set(scope, key.into(), func.into());
    let key = v8::String::new(scope, "lineCount").unwrap();
    let func = v8::Function::new(scope, line_count).unwrap();
    global.set(scope, key.into(), func.into());
    eval(scope, source).unwrap();
    println!("v8:      start and load {:.2} ms", t.elapsed().as_secs_f64() * 1000.0);
    let key = v8::String::new(scope, "run").unwrap();
    let run = v8::Local::<v8::Function>::try_from(global.get(scope, key.into()).unwrap()).unwrap();
    let undefined = v8::undefined(scope).into();
    for name in WORKLOADS {
        let mut times = vec![];
        let mut result = 0.0;
        for _ in 0..REPS {
            let arg = v8::String::new(scope, name).unwrap().into();
            let t = Instant::now();
            let r = run.call(scope, undefined, &[arg]).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            result = r.number_value(scope).unwrap();
        }
        println!("v8:      {name:8} {:9.2} ms, first {:9.2} ms  ({result})", median(times.clone()), times[0]);
    }
}

/// Whether `finally` and `catch` run when another thread terminates the script.
fn v8_termination() {
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    let handle = isolate.thread_safe_handle();
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        handle.terminate_execution();
    });
    let t = Instant::now();
    let result = eval(
        scope,
        "globalThis.ran = []; try { try { for (;;) {} } catch (e) { ran.push('catch') } finally { ran.push('inner finally') } } finally { ran.push('outer finally') }",
    );
    stopper.join().unwrap();
    println!("v8 terminate: stopped after {:.0} ms, result {:?}, terminating {}", t.elapsed().as_secs_f64() * 1000.0, result.is_some(), scope.is_execution_terminating());
    scope.cancel_terminate_execution();
    let ran = eval(scope, "JSON.stringify(ran)").unwrap();
    println!("v8 terminate: blocks that ran: {}", ran.to_rust_string_lossy(scope));
}

fn main() {
    let text = std::fs::read_to_string(std::env::args().nth(1).expect("an Org file")).unwrap();
    LINES.set(text.lines().map(String::from).collect()).unwrap();
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/bench.js")).unwrap();
    let t = Instant::now();
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
    println!("v8:      initialize {:.2} ms", t.elapsed().as_secs_f64() * 1000.0);
    v8_termination();
    quickjs(&source);
    v8_engine(&source);
}
