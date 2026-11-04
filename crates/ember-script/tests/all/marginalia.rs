//! marginalia, a package that does not ship with Ember
//! (examples/packages/marginalia.ts): its annotators give what
//! marginalia.el gives in Emacs 30 for the same things, as
//! tests/emacs/completion/annotations.el recorded them, and vertico shows
//! them beside the candidates.

use std::path::Path;

use crate::driven::Driven;
use ember_core::Value;
use serde::Deserialize;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

#[derive(Deserialize)]
struct Recorded {
    category: String,
    candidate: String,
    annotation: Option<String>,
}

const SETUP: &str = r#"
  ember.require("marginalia"); ember.require("vertico");
  ember.defineCommand({ name: "an-test-command", doc: "Run the test thing.\n\nMore about it.", run: () => undefined });
  ember.bindKey("C-c t", "an-test-command");
  ember.defineCommand({ name: "an-unbound-command", doc: "Do nothing much, for a test that has a very long first line that goes on.", run: () => undefined });
  ember.defineVariable({ name: "an-test-variable", value: 42, doc: "The answer, for the test." });
  ember.defineVariable({ name: "an-test-string", value: "hello", doc: "A string, for the test." });
  ember.defineVariable({ name: "an-test-list", value: [1, 2, 3], doc: "A list." });
  ember.defineVariable({ name: "an-api-key", value: "secret", doc: "Not to be shown." });
  ember.defineFace({ name: "an-test-face", doc: "A face for the test.", attributes: { weight: "bold" } });
"#;

fn setup() -> Driven {
    let d = Driven::new("");
    d.with(|ed| {
        ed.set_frame_size(80, 30);
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    });
    d.eval(SETUP);
    std::fs::create_dir_all("/tmp/ember-marginalia").unwrap();
    std::fs::write("/tmp/ember-marginalia/notes.txt", "hello").unwrap();
    let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_577_930_640);
    let file = std::fs::File::options().write(true).open("/tmp/ember-marginalia/notes.txt").unwrap();
    file.set_modified(time).unwrap();
    d.with(|ed| ed.call("find-file", vec![ember_core::Arg::Str("/tmp/ember-marginalia/notes.txt".into())]).unwrap());
    d
}

#[test]
fn annotations_are_what_marginalia_gives_in_emacs() {
    let recorded: Vec<Recorded> =
        serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs/completion/annotations.json")).unwrap())
            .unwrap();
    let d = setup();
    let mut failures = Vec::new();
    for r in &recorded {
        let ember = d.eval_expression(&format!(
            r#"ember.letBind({{ "marginalia-field-width": 40 }}, () => {{ const a = ember.funcall("marginalia-annotate-{}", {:?}); return a === undefined ? null : String(a); }})"#,
            r.category, r.candidate
        ));
        let ember: Option<String> = serde_json::from_str(&ember).unwrap();
        // Emacs in batch formats no mode line, so its buffer status is empty: compare the file.
        let (ember, emacs) = if r.category == "buffer" {
            (ember.map(|a| a.chars().rev().take(20).collect::<String>()), r.annotation.clone().map(|a| a.chars().rev().take(20).collect::<String>()))
        } else {
            (ember, r.annotation.clone())
        };
        if ember != emacs {
            failures.push(format!("{} {}:\n  Emacs {emacs:?}\n  Ember {ember:?}", r.category, r.candidate));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn vertico_shows_annotations_aligned_beside_the_candidates() {
    let d = setup();
    d.eval(r#"ember.call("vertico-mode"); ember.call("marginalia-mode");"#);
    d.press("M-x");
    d.press("a n - t e s t - c");
    let (_, after) = d.with(|ed| ed.minibuffer_strings());
    // The annotation starts at column 30, the candidate and its key rounded up to ten, then the separator.
    assert!(after.contains("an-test-command (C-c t)         Run the test thing."), "{after:?}");
    d.press("C-g");
}

#[test]
fn documentation_is_cut_to_half_the_frame_width() {
    let d = setup();
    d.with(|ed| ed.set_frame_size(120, 30));
    d.eval(r#"ember.call("vertico-mode"); ember.call("marginalia-mode");"#);
    d.press("M-x");
    d.press("a n - u n b o u n d");
    let (_, after) = d.with(|ed| ed.minibuffer_strings());
    // marginalia-field-width is the smaller of 80 and half the minibuffer's window, 60 here, not 40.
    assert!(after.contains("Do nothing much, for a test that has a very long first line…"), "{after:?}");
    d.press("C-g");
}

#[test]
fn each_minibuffer_aligns_its_annotations_afresh() {
    let d = setup();
    d.eval(r#"ember.call("vertico-mode"); ember.call("marginalia-mode");
      ember.defineCommand({ name: "an-command-whose-name-is-longer-than-most", doc: "Long.", run: () => undefined });"#);
    d.press("M-x");
    d.press("a n - c o m m a n d");
    let (_, after) = d.with(|ed| ed.minibuffer_strings());
    assert!(after.contains("an-command-whose-name-is-longer-than-most           Long."), "{after:?}");
    d.press("C-g");
    // The wider candidate the last minibuffer showed no longer pushes the annotations right.
    d.press("C-h v");
    d.press("a n - t e s t - v");
    let (_, after) = d.with(|ed| ed.minibuffer_strings());
    assert!(after.contains("an-test-variable                 v       42"), "{after:?}");
    d.press("C-g");
}
