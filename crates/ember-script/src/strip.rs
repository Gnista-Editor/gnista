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

use ember_core::{Error, Result};
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

pub fn strip_types(filename: &str, source: String) -> Result<String> {
    strip(filename, source, false)
}

/// As [`strip_types`], for an ES module: `import` and `export` are kept.
pub fn strip_module_types(filename: &str, source: String) -> Result<String> {
    strip(filename, source, true)
}

fn strip(filename: &str, source: String, module: bool) -> Result<String> {
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
            Err(Error::new(format!("{filename}:{}:{}: {message}", loc.line, loc.col.0 + 1)))
        }
        (_, Some((message, None))) => Err(Error::new(format!("{filename}: {message}"))),
        (Err(e), None) => Err(Error::new(format!("{filename}: {}", e.message))),
    }
}

/// What goes at the start of each loop's body.
const QUIT_CHECK: &str = "if (--globalThis.__emberQuit < 0) ember.maybeQuit();";

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erases_types_and_keeps_positions() {
        let ts = "const n: number = 1;\ninterface P { x: number }\nfunction f(a: string): void { throw a }\n";
        let js = strip_types("t.ts", ts.to_string()).unwrap();
        assert_eq!(js.lines().count(), ts.lines().count());
        assert_eq!(js.find("throw"), ts.find("throw"));
        assert!(!js.contains("number"));
    }

    #[test]
    fn reports_syntax_errors_with_location() {
        let err = strip_types("t.ts", "let a = 1;\nlet b = ;\n".to_string()).unwrap_err();
        assert!(err.to_string().starts_with("t.ts:2:"), "{err}");
    }

    #[test]
    fn loops_check_for_quitting_on_their_first_line() {
        let ts = "let n: number = 0;\nwhile (n < 3) n++;\nfor (const x of [1]) {\n  n += x;\n}\ndo { n-- } while (n > 0);\n";
        let js = strip_types("t.ts", ts.to_string()).unwrap();
        assert_eq!(js.matches(QUIT_CHECK).count(), 3, "{js}");
        assert_eq!(js.lines().count(), ts.lines().count());
        assert!(js.contains(&format!("while (n < 3) {{{QUIT_CHECK}n++;}}")), "{js}");
        assert!(js.contains(&format!("for (const x of [1]) {{{QUIT_CHECK}")), "{js}");
        // Nothing to do without loops.
        assert_eq!(strip_types("t.ts", "const a: number = 1;".to_string()).unwrap().trim_end(), "const a         = 1;");
    }

    #[test]
    fn rejects_non_erasable_syntax() {
        assert!(strip_types("t.ts", "enum E { A }".to_string()).is_err());
    }
}
