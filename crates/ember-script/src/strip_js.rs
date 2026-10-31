//! TypeScript to JavaScript by erasing types.
//!
//! Types are replaced with whitespace rather than compiled away, so every line
//! and column in the JavaScript matches the TypeScript source and error
//! locations need no source map. As in Node, only erasable syntax is allowed:
//! `enum`, `namespace` with values and parameter properties are rejected.
//!
//! Each loop then gets a check for quitting at the start of its body, as
//! Emacs's bytecode interpreter checks `quit-flag` on every backward jump:
//! a countdown that calls `ember.maybeQuit` once every 1024 iterations, so a
//! loop that calls no primitive can still be stopped with `C-g`. The check
//! goes on the body's first line, so line numbers still match the source;
//! columns after a loop's opening brace on that line move right.

use std::sync::{Arc, Mutex};

use swc_common::errors::{DiagnosticBuilder, Emitter, Handler};
use swc_common::sync::Lrc;
use swc_common::{FileName, SourceMap, Span, Spanned};
use swc_ecma_ast::{DoWhileStmt, ForInStmt, ForOfStmt, ForStmt, Stmt, WhileStmt};
use swc_ecma_parser::{Parser, StringInput, Syntax};
use swc_ecma_visit::{Visit, VisitWith};
use swc_ts_fast_strip::{Mode, Options, operate};

type Diagnostics = Arc<Mutex<Vec<(String, Option<Span>)>>>;

/// Collects parser diagnostics so the first one can be reported with its location.
struct Collector(Diagnostics);

impl Emitter for Collector {
    fn emit(&mut self, db: &mut DiagnosticBuilder<'_>) {
        let entry = (db.message(), db.span.primary_span());
        self.0.lock().expect("collector lock").push(entry);
    }
}

/// Erases a script's types and puts in the loop checks, or says what is
/// wrong with it and where. Shared with the build script, which strips the
/// packages that ship with Ember when it is built, so it uses no editor types.
pub fn strip_js(filename: &str, source: String, module: bool) -> Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let diagnostics: Diagnostics = Default::default();
    let handler = Handler::with_emitter(true, false, Box::new(Collector(diagnostics.clone())));
    let options = Options {
        module: Some(module),
        filename: Some(filename.to_string()),
        mode: Mode::StripOnly,
        ..Default::default()
    };
    let result = operate(&cm, &handler, source, options);
    let first = diagnostics.lock().expect("collector lock").first().cloned();
    match (result, first) {
        (Ok(output), None) => Ok(add_quit_checks(output.code, module)),
        (_, Some((message, Some(span)))) => {
            let loc = cm.lookup_char_pos(span.lo);
            Err(format!("{filename}:{}:{}: {message}", loc.line, loc.col.0 + 1))
        }
        (_, Some((message, None))) => Err(format!("{filename}: {message}")),
        (Err(e), None) => Err(format!("{filename}: {}", e.message)),
    }
}

/// What goes at the start of each loop's body.
pub const QUIT_CHECK: &str = "if (--globalThis.__emberQuit < 0) ember.maybeQuit();";

/// Where each loop's body starts, and whether it is a block.
#[derive(Default)]
struct Loops(Vec<(u32, u32, bool)>);

impl Loops {
    fn body(&mut self, body: &Stmt) {
        let span = body.span();
        self.0.push((span.lo.0, span.hi.0, matches!(body, Stmt::Block(_))));
    }
}

impl Visit for Loops {
    fn visit_for_stmt(&mut self, n: &ForStmt) {
        self.body(&n.body);
        n.visit_children_with(self);
    }
    fn visit_for_in_stmt(&mut self, n: &ForInStmt) {
        self.body(&n.body);
        n.visit_children_with(self);
    }
    fn visit_for_of_stmt(&mut self, n: &ForOfStmt) {
        self.body(&n.body);
        n.visit_children_with(self);
    }
    fn visit_while_stmt(&mut self, n: &WhileStmt) {
        self.body(&n.body);
        n.visit_children_with(self);
    }
    fn visit_do_while_stmt(&mut self, n: &DoWhileStmt) {
        self.body(&n.body);
        n.visit_children_with(self);
    }
}

/// Puts [`QUIT_CHECK`] at the start of every loop's body, bracing a body
/// that is a single statement. JavaScript the parser cannot read is left as
/// it is, for QuickJS to report.
fn add_quit_checks(js: String, module: bool) -> String {
    if !js.contains("for") && !js.contains("while") {
        return js;
    }
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), js);
    let mut parser = Parser::new(Syntax::Es(Default::default()), StringInput::from(&*fm), None);
    let mut loops = Loops::default();
    let parsed = if module { parser.parse_module().map(|m| m.visit_with(&mut loops)) } else { parser.parse_script().map(|s| s.visit_with(&mut loops)) };
    let mut js = fm.src.to_string();
    if parsed.is_err() || loops.0.is_empty() {
        return js;
    }
    let base = fm.start_pos.0;
    // From the end, so earlier offsets stay right.
    let mut edits: Vec<(usize, String)> = Vec::new();
    for (lo, hi, block) in loops.0 {
        let (lo, hi) = ((lo - base) as usize, (hi - base) as usize);
        if block {
            edits.push((lo + 1, QUIT_CHECK.to_string()));
        } else {
            edits.push((lo, format!("{{{QUIT_CHECK}")));
            edits.push((hi, "}".to_string()));
        }
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    for (at, text) in edits {
        js.insert_str(at, &text);
    }
    js
}

