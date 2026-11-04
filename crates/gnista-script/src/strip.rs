//! TypeScript to JavaScript, as the editor runs it: [`strip_js`] erases
//! types and puts in the checks for quitting, reporting errors as the
//! editor's.

use gnista_core::{Error, Result};

use crate::strip_js::strip_js;

pub fn strip_types(filename: &str, source: String) -> Result<String> {
    strip_js(filename, source, false).map_err(Error::new)
}

/// As [`strip_types`], for an ES module: `import` and `export` are kept.
pub fn strip_module_types(filename: &str, source: String) -> Result<String> {
    strip_js(filename, source, true).map_err(Error::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strip_js::QUIT_CHECK;

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
