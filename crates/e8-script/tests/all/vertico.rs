//! vertico and orderless, packages that do not ship with E8
//! (examples/packages/): each case of tests/emacs/completion/cases.json,
//! replayed key by key, shows what vertico 2.5 and orderless show in Emacs
//! 30, as tests/emacs/completion/record.el recorded them in golden.json.

use std::path::{Path, PathBuf};

use crate::driven::Driven;
use e8_core::Value;
use serde::Deserialize;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

#[derive(Deserialize)]
struct Case {
    name: String,
    #[serde(default)]
    vars: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    collection: Vec<String>,
    #[serde(default)]
    require_match: bool,
    #[serde(default)]
    history: Vec<String>,
    default: Option<String>,
    #[serde(default)]
    reader: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    keys: Vec<String>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(untagged)]
enum Step {
    Exited { exited: bool, answer: Option<String> },
    Open { input: String, before: String, after: String },
}

#[derive(Deserialize)]
struct Recorded {
    name: String,
    states: Vec<Step>,
}

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs/completion")
}

fn run(case: &Case) -> Vec<Step> {
    let d = Driven::new("");
    d.with(|ed| {
        ed.set_frame_size(80, 30);
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    });
    let vars: Vec<String> = case
        .vars
        .iter()
        .map(|(k, v)| format!("e8.setVariable({k:?}, {v});"))
        .collect();
    // A file prompt reads in a directory of its own, holding the case's files.
    let files_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/completion-files");
    let _ = std::fs::create_dir_all(&files_root);
    let files_root = format!("{}/", files_root.canonicalize().unwrap().display());
    let dir = format!("{files_root}{}/", case.name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for f in &case.files {
        let path = Path::new(&dir).join(f);
        if f.ends_with('/') {
            std::fs::create_dir_all(&path).unwrap();
        } else {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "").unwrap();
        }
    }
    let read = if case.reader.as_deref() == Some("file") {
        format!("e8.readFileName(\"File: \", {{ dir: {dir:?} }})")
    } else {
        format!(
            "e8.completingRead(\"Pick: \", {}, {{ requireMatch: {}, history: \"cr-history\"{} }})",
            serde_json::to_string(&case.collection).unwrap(),
            case.require_match,
            case.default.as_ref().map_or(String::new(), |d| format!(", default: {d:?}"))
        )
    };
    let source = format!(
        r#"e8.require("vertico"); e8.require("orderless");
        e8.defineVariable({{ name: "cr-answer", value: null }});
        e8.defineVariable({{ name: "cr-history", value: {history} }});
        {vars}
        e8.call("vertico-mode");
        e8.defineCommand({{ name: "cr-read", run: () => e8.setVariable("cr-answer", {read}) }});
        e8.bindKey("<f5>", "cr-read");"#,
        history = serde_json::to_string(&case.history).unwrap(),
        vars = vars.join("\n"),
    );
    d.eval(&source);
    let mut states = Vec::new();
    for keys in std::iter::once("<f5>").chain(case.keys.iter().map(String::as_str)) {
        d.press(keys);
        let (open, answer, input, (before, after)) = d.with(|ed| {
            let answer = ed.variable("cr-answer").and_then(|v| v.as_str().map(str::to_string));
            (ed.prompt().is_some(), answer, ed.minibuffer_input(), ed.minibuffer_strings())
        });
        let short = e8_core::abbreviate_dir(Path::new(&files_root));
        let without_dir = |t: &str| t.replace(&files_root, "DIR/").replace(&short, "DIR/");
        if !open {
            states.push(Step::Exited { exited: true, answer: answer.as_deref().map(without_dir) });
            break;
        }
        states.push(Step::Open { input: without_dir(&input), before, after: without_dir(&after) });
    }
    states
}

#[test]
fn vertico_and_orderless_show_what_emacs_shows() {
    let cases: Vec<Case> = serde_json::from_str(&std::fs::read_to_string(dir().join("cases.json")).unwrap()).unwrap();
    #[derive(Deserialize)]
    struct Golden {
        cases: Vec<Recorded>,
    }
    let golden: Golden = serde_json::from_str(&std::fs::read_to_string(dir().join("golden.json")).unwrap()).unwrap();
    let mut failures = Vec::new();
    for case in &cases {
        let emacs = &golden.cases.iter().find(|r| r.name == case.name).unwrap_or_else(|| panic!("{} is not recorded", case.name)).states;
        let e8 = run(case);
        if e8 != *emacs {
            let mut out = format!("{}:\n", case.name);
            let keys: Vec<&str> = std::iter::once("<f5>").chain(case.keys.iter().map(String::as_str)).collect();
            for (k, key) in keys.iter().enumerate() {
                let (a, b) = (emacs.get(k), e8.get(k));
                if a.is_none() && b.is_none() {
                    break;
                }
                let mark = if a == b { " " } else { "*" };
                out.push_str(&format!("{mark} {key:>6}  Emacs {a:?}\n{mark} {:>6}  E8 {b:?}\n", ""));
            }
            failures.push(out);
        }
    }
    assert!(failures.is_empty(), "{} cases differ from Emacs:\n{}", failures.len(), failures.join("\n"));
}

/// The minibuffer grows past a quarter of the frame for vertico-count
/// lines, as vertico sets max-mini-window-height there, so the selected
/// candidate stays in sight as the arrow keys move down the list.
#[test]
fn the_minibuffer_grows_to_show_vertico_count_lines() {
    let d = Driven::new("");
    d.with(|ed| {
        ed.set_frame_size(80, 28);
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    });
    d.eval(
        r#"e8.require("vertico"); e8.setVariable("vertico-count", 12); e8.call("vertico-mode");
        e8.defineCommand({ name: "cr-read", run: () => e8.completingRead("Pick: ", Array.from({ length: 20 }, (_, i) => `c${i + 1}`)) });
        e8.bindKey("<f5>", "cr-read");"#,
    );
    d.press("<f5>");
    d.press("<down> <down> <down> <down> <down> <down> <down> <down>");
    // A quarter of the 30 lines would be 7: the prompt and six candidates.
    let (lines, after) = d.with(|ed| (ed.mini_window_height(30), ed.minibuffer_strings().1));
    assert_eq!(lines, 13, "{after:?}");
    assert!(after.contains("c8"), "{after:?}");
    // The window's own buffer keeps the quarter once the prompt is gone.
    d.press("C-g");
    assert_eq!(d.with(|ed| ed.max_mini_window_lines(30)), 7);
}
