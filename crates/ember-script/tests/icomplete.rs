//! Compares what icomplete shows with what GNU Emacs's shows, on the cases in
//! `tests/emacs/icomplete/cases.json`, recorded by its `record.el` into
//! `golden.json`. After changing the cases, record them again:
//!
//! ```text
//! cd tests/emacs/icomplete && script -q /dev/null emacs -Q -nw -l $PWD/record.el
//! ```
//!
//! An ignored test makes random cases, records them with Emacs, and prints
//! where Ember differs:
//!
//! ```text
//! EMBER_FUZZ_SEED=1 cargo test --release -p ember-script --test icomplete -- --ignored --nocapture
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ember_core::{Editor, Value};
use ember_script::Scripting;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Case {
    name: String,
    mode: String,
    reader: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    collection: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    require_match: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    files: Vec<String>,
    keys: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
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

#[derive(Deserialize)]
struct Golden {
    cases: Vec<Recorded>,
}

fn icomplete_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs/icomplete")
}

/// Runs a case through Ember: what the minibuffer shows after <f5> and after
/// each key, until the prompt closes.
fn run(case: &Case) -> Vec<Step> {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    // As Emacs's terminal frame: 80 columns, 24 lines with the echo area.
    ed.set_frame_size(80, 23);
    ed.set_variable("max-mini-window-height", Value::from(6.0));
    // Where record.el makes them, so paths are as long as Emacs's, which
    // decides how many completions fit in a line.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/icomplete-files").join(&case.name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let root = format!("{}/", dir.canonicalize().unwrap().display());
    for file in &case.files {
        let path = Path::new(&root).join(file);
        if file.ends_with('/') {
            fs::create_dir_all(&path).unwrap();
        } else {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "").unwrap();
        }
    }
    let read = if case.reader == "file" {
        format!("ember.readFileName(\"File: \", done, {{ dir: {root:?} }})")
    } else {
        format!(
            "ember.completingRead(\"Pick: \", {}, done, {{ requireMatch: {} }})",
            serde_json::to_string(&case.collection).unwrap(),
            case.require_match
        )
    };
    let modes = ["fido-vertical-mode", "icomplete-vertical-mode", "fido-mode", "icomplete-mode"];
    let source = format!(
        r#"ember.defineVariable({{ name: "ic-answer", value: null }});
        const done = (a) => ember.setVariable("ic-answer", a);
        ember.defineCommand({{ name: "ic-read", run: () => {read} }});
        ember.bindKey("<f5>", "ic-read");
        ember.makeLocalVariable("default-directory");
        ember.setVariable("default-directory", {root:?});
        for (const mode of {modes:?}) ember.callWithPrefix(0, mode);
        ember.callWithPrefix(1, "{}-mode");"#,
        case.mode
    );
    scripting.eval_typescript(&mut ed, "case.ts", source).unwrap();
    let short = ember_core::abbreviate_dir(Path::new(&root));
    let without_dir = |text: &str| text.replace(&root, "DIR/").replace(&short, "DIR/");
    let mut states = Vec::new();
    for keys in std::iter::once("<f5>").chain(case.keys.iter().map(String::as_str)) {
        ed.press(keys).unwrap();
        let Some(_) = ed.prompt() else {
            let answer = ed.variable("ic-answer").and_then(|v| v.as_str().map(without_dir));
            states.push(Step::Exited { exited: true, answer });
            break;
        };
        let overlay = ed.minibuffer_overlay();
        let after: String = overlay.map_or(String::new(), |o| o.after.iter().map(|(text, _)| text.as_str()).collect());
        states.push(Step::Open {
            input: without_dir(&ed.minibuffer_input()),
            before: overlay.map_or(String::new(), |o| o.before.clone()),
            after: without_dir(&after),
        });
    }
    states
}

/// Where Ember's steps differ from Emacs's, or `None` if they do not.
fn compare(case: &Case, emacs: &[Step]) -> Option<String> {
    let mut ember = run(case);
    // Once the input leaves the case's directory, the directories differ.
    let outside = |s: &Step| {
        matches!(s, Step::Open { input, .. }
            if case.reader == "file" && (!input.starts_with("DIR/") || input.contains("//") || input.contains("/../")))
    };
    let emacs = &emacs[..emacs.iter().position(outside).unwrap_or(emacs.len())];
    ember.truncate(emacs.len().max(ember.iter().position(outside).unwrap_or(ember.len()).min(emacs.len())));
    if ember == emacs {
        return None;
    }
    let keys: Vec<&str> = std::iter::once("<f5>").chain(case.keys.iter().map(String::as_str)).collect();
    let mut out = format!("{} ({}, {}):\n", case.name, case.mode, case.reader);
    for (k, key) in keys.iter().enumerate() {
        let (a, b) = (emacs.get(k), ember.get(k));
        if a.is_none() && b.is_none() {
            break;
        }
        let mark = if a == b { " " } else { "*" };
        out.push_str(&format!("{mark} {key:>8}  Emacs {a:?}\n{mark} {:>8}  Ember {b:?}\n", ""));
    }
    Some(out)
}

fn load_cases(dir: &Path) -> Vec<Case> {
    serde_json::from_str(&fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap()
}

fn load_golden(dir: &Path) -> Vec<Recorded> {
    let golden: Golden = serde_json::from_str(&fs::read_to_string(dir.join("golden.json")).unwrap()).unwrap();
    golden.cases
}

#[test]
fn icomplete_shows_what_emacs_shows() {
    let dir = icomplete_dir();
    let golden = load_golden(&dir);
    let mut failures = Vec::new();
    for case in load_cases(&dir) {
        let recorded = golden.iter().find(|r| r.name == case.name).unwrap_or_else(|| panic!("{} is not recorded", case.name));
        if let Some(diff) = compare(&case, &recorded.states) {
            failures.push(diff);
        }
    }
    assert!(failures.is_empty(), "{} cases differ from Emacs:\n{}", failures.len(), failures.join("\n"));
}

/// A small random number generator, so the fuzzer needs no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

fn random_case(rng: &mut Rng, k: usize) -> Case {
    const WORDS: &[&str] = &[
        "apple", "apricot", "avocado", "banana", "band", "bandana", "cherry", "chervil", "Cherry", "date", "dates",
        "fig", "figment", "grape", "grapefruit", "find-file", "find-file-other-window", "file", "a-b", "ab",
    ];
    const FILES: &[&str] = &[
        "alpha.txt", "alps.org", "Alpha.md", "beta/", "beta/inner.txt", "notes.org", "notes.org~", ".hidden", "a.o",
        "readme.md", "README", "src/", "src/main.rs", "x",
    ];
    let mode = rng.pick(&["icomplete", "fido", "icomplete-vertical", "fido-vertical"]).to_string();
    let reader = rng.pick(&["collection", "collection", "file"]).to_string();
    let mut collection = Vec::new();
    let mut files = Vec::new();
    let letters: Vec<String> = if reader == "file" {
        for _ in 0..2 + rng.below(6) {
            let f = rng.pick(FILES).to_string();
            if !files.contains(&f) {
                files.push(f);
            }
        }
        ["a", "l", "p", "b", "e", "t", "n", "o", "r", "s", "x", ".", "/", "A", "N"].map(String::from).to_vec()
    } else {
        for _ in 0..2 + rng.below(7) {
            let w = rng.pick(WORDS).to_string();
            if !collection.contains(&w) {
                collection.push(w);
            }
        }
        ["a", "p", "b", "n", "c", "e", "r", "f", "i", "l", "-", "C", "x"].map(String::from).to_vec()
    };
    let mut commands = vec!["DEL", "C-.", "C-,", "TAB", "C-j", "C-M-i", "RET", "C-a", "C-e"];
    if mode.starts_with("fido") {
        commands.extend(["M-j", "C-s", "C-r", "<right>", "<left>"]);
    }
    if mode.ends_with("vertical") {
        commands.extend(["C-n", "C-p", "<down>", "<up>", "M-<", "M->"]);
    }
    let mut keys = Vec::new();
    for _ in 0..1 + rng.below(9) {
        if rng.below(3) == 0 {
            keys.push(rng.pick(&commands).to_string());
        } else {
            keys.push(letters[rng.below(letters.len())].clone());
        }
    }
    Case { name: format!("fuzz-{k:04}"), mode, reader, collection, require_match: rng.below(2) == 0, files, keys }
}

/// Records cases with Emacs in a terminal, as record.el does them.
fn record(dir: &Path, cases: &[Case]) -> Vec<Recorded> {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("cases.json"), serde_json::to_string_pretty(cases).unwrap()).unwrap();
    let _ = fs::remove_file(dir.join("golden.json"));
    let status = Command::new("script")
        .args(["-q", "/dev/null", "emacs", "-Q", "-nw", "-l"])
        .arg(icomplete_dir().join("record.el").canonicalize().unwrap())
        .env("EMBER_ORACLE_DIR", dir)
        .env("TERM", "xterm-256color")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("emacs runs");
    assert!(status.success(), "Emacs failed");
    load_golden(dir)
}

#[test]
#[ignore = "needs GNU Emacs in a terminal"]
fn icomplete_behaves_like_emacs_on_random_cases() {
    let seed: u64 = std::env::var("EMBER_FUZZ_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let count: usize = std::env::var("EMBER_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let cases: Vec<Case> = (0..count).map(|k| random_case(&mut rng, k)).collect();
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("icomplete-fuzz");
    let recorded = record(&dir, &cases);
    let mut differ = Vec::new();
    for case in &cases {
        let Some(emacs) = recorded.iter().find(|r| r.name == case.name) else { continue };
        if let Some(diff) = compare(case, &emacs.states) {
            println!("{diff}");
            differ.push(case.clone());
        }
    }
    fs::write(dir.join("differences.json"), serde_json::to_string_pretty(&differ).unwrap()).unwrap();
    println!("seed {seed}: {} cases compared, {} differ", cases.len(), differ.len());
}
