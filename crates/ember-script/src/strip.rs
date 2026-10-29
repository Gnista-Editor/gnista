//! TypeScript to JavaScript by erasing types.
//!
//! Types are replaced with whitespace rather than compiled away, so every line
//! and column in the JavaScript matches the TypeScript source and error
//! locations need no source map. As in Node, only erasable syntax is allowed:
//! `enum`, `namespace` with values and parameter properties are rejected.

use std::sync::{Arc, Mutex};

use ember_core::{Error, Result};
use swc_common::errors::{DiagnosticBuilder, Emitter, Handler};
use swc_common::sync::Lrc;
use swc_common::{SourceMap, Span};
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
        (Ok(output), None) => Ok(output.code),
        (_, Some((message, Some(span)))) => {
            let loc = cm.lookup_char_pos(span.lo);
            Err(Error::new(format!("{filename}:{}:{}: {message}", loc.line, loc.col.0 + 1)))
        }
        (_, Some((message, None))) => Err(Error::new(format!("{filename}: {message}"))),
        (Err(e), None) => Err(Error::new(format!("{filename}: {}", e.message))),
    }
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
    fn rejects_non_erasable_syntax() {
        assert!(strip_types("t.ts", "enum E { A }".to_string()).is_err());
    }
}
