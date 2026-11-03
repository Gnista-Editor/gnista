//! vertico and orderless, packages that do not ship with Ember
//! (examples/packages/): each case of tests/emacs/completion/cases.json,
//! replayed key by key, shows what vertico 2.5 and orderless show in Emacs
//! 30, as tests/emacs/completion/record.el recorded them in golden.json.

use std::path::{Path, PathBuf};

use crate::driven::Driven;
use ember_core::Value;
use serde::Deserialize;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

#[derive(Deserialize)]
struct Case {
    name: String,
    #[serde(default)]
    vars: serde_json::Map<String, serde_json::Value>,
    collection: Vec<String>,
    #[serde(default)]
    require_match: bool,
    #[serde(default)]
    history: Vec<String>,
    default: Option<String>,
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
        .map(|(k, v)| format!("ember.setVariable({k:?}, {v});"))
        .collect();
    let source = format!(
        r#"ember.require("vertico"); ember.require("orderless");
        ember.defineVariable({{ name: "cr-answer", value: null }});
        ember.defineVariable({{ name: "cr-history", value: {history} }});
        {vars}
        ember.call("vertico-mode");
        ember.defineCommand({{ name: "cr-read", run: () => ember.setVariable("cr-answer",
          ember.completingRead("Pick: ", {collection}, {{ requireMatch: {require_match}, history: "cr-history"{default} }})) }});
        ember.bindKey("<f5>", "cr-read");"#,
        history = serde_json::to_string(&case.history).unwrap(),
        vars = vars.join("\n"),
        collection = serde_json::to_string(&case.collection).unwrap(),
        require_match = case.require_match,
        default = case.default.as_ref().map_or(String::new(), |d| format!(", default: {d:?}")),
    );
    d.eval(&source);
    let mut states = Vec::new();
    for keys in std::iter::once("<f5>").chain(case.keys.iter().map(String::as_str)) {
        d.press(keys);
        let (open, answer, input, (before, after)) = d.with(|ed| {
            let answer = ed.variable("cr-answer").and_then(|v| v.as_str().map(str::to_string));
            (ed.prompt().is_some(), answer, ed.minibuffer_input(), ed.minibuffer_strings())
        });
        if !open {
            states.push(Step::Exited { exited: true, answer });
            break;
        }
        states.push(Step::Open { input, before, after });
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
        let ember = run(case);
        if ember != *emacs {
            let mut out = format!("{}:\n", case.name);
            let keys: Vec<&str> = std::iter::once("<f5>").chain(case.keys.iter().map(String::as_str)).collect();
            for (k, key) in keys.iter().enumerate() {
                let (a, b) = (emacs.get(k), ember.get(k));
                if a.is_none() && b.is_none() {
                    break;
                }
                let mark = if a == b { " " } else { "*" };
                out.push_str(&format!("{mark} {key:>6}  Emacs {a:?}\n{mark} {:>6}  Ember {b:?}\n", ""));
            }
            failures.push(out);
        }
    }
    assert!(failures.is_empty(), "{} cases differ from Emacs:\n{}", failures.len(), failures.join("\n"));
}
