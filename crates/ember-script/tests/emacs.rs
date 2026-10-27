//! Compares Ember with GNU Emacs on the recorded cases in `tests/emacs/`.
//!
//! It lives here rather than in ember-core because Ember includes the
//! packages that ship with it, such as the prefix argument commands in
//! packages/simple.ts, just as Emacs includes its preloaded Lisp.
//!
//! Each case's keys are typed into a fresh editor, as record.el types them
//! into Emacs: an error shows its message and the next key still runs. The
//! result, including the first error, is compared with what Emacs did. Cases listed in `known-gaps.txt` are expected to differ; the
//! test fails if one of them starts matching, so the list stays accurate.
//!
//! To add cases, edit `tests/emacs/cases/*.json`, then record what Emacs
//! does with `emacs -Q --batch -l tests/emacs/record.el`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use ember_core::{Editor, Key, PrefixArg};
use ember_script::Scripting;
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    text: String,
    keys: String,
    #[serde(default)]
    point: usize,
    /// Modes to turn on before typing the keys.
    #[serde(default)]
    modes: Vec<String>,
    /// The Emacs `system-type` the case holds on, if only one.
    platform: Option<String>,
}

#[derive(Deserialize)]
struct Golden {
    emacs_version: String,
    /// The Emacs `system-type` the golden file was recorded on.
    system_type: String,
    cases: Vec<Recorded>,
}

#[derive(Deserialize)]
struct Recorded {
    name: String,
    input: Input,
    #[serde(flatten)]
    state: State,
}

#[derive(Deserialize, PartialEq)]
struct Input {
    text: String,
    point: usize,
    keys: String,
    #[serde(default)]
    modes: Vec<String>,
    platform: Option<String>,
}

/// What a case leaves behind, as both editors report it.
#[derive(Debug, Deserialize, PartialEq)]
struct State {
    text: String,
    point: usize,
    mark: Option<usize>,
    mark_active: bool,
    /// Newest first, as Emacs lists it.
    kill_ring: Vec<String>,
    modified: bool,
    error: Option<String>,
}

/// This platform as Emacs's `system-type` names it.
fn system_type() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows-nt"
    } else {
        "gnu/linux"
    }
}

fn oracle_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs")
}

/// Runs a case through Ember the way record.el runs it through Emacs.
fn run(case: &Case) -> State {
    let mut ed = Editor::new();
    let _scripting = Scripting::new(&mut ed).expect("scripting starts");
    let b = ed.window_buffer_mut();
    b.set_text(&case.text);
    b.set_point(case.point);
    for mode in &case.modes {
        ed.call_with_prefix(mode, Vec::new(), Some(PrefixArg::Number(1)))
            .unwrap_or_else(|e| panic!("{}: turning on {mode}: {e}", case.name));
    }
    let keys = Key::parse_seq(&case.keys)
        .unwrap_or_else(|| panic!("{}: keys {:?} are not valid Emacs notation", case.name, case.keys));
    let mut error = None;
    for key in keys {
        ed.handle_key(key);
        if let Some(e) = ed.take_error() {
            error.get_or_insert(e.to_string());
        }
    }
    let b = ed.window_buffer();
    State {
        text: b.slice(0..b.len()),
        point: b.point(),
        mark: b.mark(),
        mark_active: b.is_mark_active(),
        kill_ring: ed.kill_ring().iter().rev().cloned().collect(),
        modified: b.is_modified(),
        error,
    }
}

/// The fields where Ember differs from Emacs, one per line.
fn differences(emacs: &State, ember: &State) -> String {
    let mut out = Vec::new();
    macro_rules! compare {
        ($($field:ident),*) => {$(
            if emacs.$field != ember.$field {
                out.push(format!(
                    "    {}: Emacs {:?}, Ember {:?}",
                    stringify!($field), emacs.$field, ember.$field
                ));
            }
        )*};
    }
    compare!(text, point, mark, mark_active, kill_ring, modified, error);
    out.join("\n")
}

/// `known-gaps.txt`: one `file/case` per line, with an optional `# reason`.
fn known_gaps() -> BTreeMap<String, String> {
    let text = fs::read_to_string(oracle_dir().join("known-gaps.txt")).unwrap_or_default();
    text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| match line.split_once('#') {
            Some((id, reason)) => (id.trim().to_string(), reason.trim().to_string()),
            None => (line.to_string(), String::new()),
        })
        .collect()
}

#[test]
fn ember_behaves_like_emacs() {
    let dir = oracle_dir();
    let gaps = known_gaps();
    let mut problems = Vec::new();
    let (mut total, mut matching) = (0, 0);
    let mut seen = Vec::new();

    let mut files: Vec<PathBuf> = fs::read_dir(dir.join("cases"))
        .expect("tests/emacs/cases exists")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();

    for file in files {
        let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
        let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(&file).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        let golden_path = dir.join("golden").join(file.file_name().unwrap());
        let Ok(golden) = fs::read_to_string(&golden_path) else {
            problems.push(format!("{stem}: no golden file; record it with record.el"));
            continue;
        };
        let golden: Golden = serde_json::from_str(&golden)
            .unwrap_or_else(|e| panic!("{}: {e}", golden_path.display()));
        let recorded: BTreeMap<&str, &Recorded> =
            golden.cases.iter().map(|r| (r.name.as_str(), r)).collect();

        for case in &cases {
            let id = format!("{stem}/{}", case.name);
            seen.push(id.clone());
            if let Some(platform) = &case.platform {
                if platform != system_type() {
                    continue;
                }
                if *platform != golden.system_type {
                    problems.push(format!("{id}: holds on {platform}; record it there"));
                    continue;
                }
            }
            total += 1;
            let input = Input {
                text: case.text.clone(),
                point: case.point,
                keys: case.keys.clone(),
                modes: case.modes.clone(),
                platform: case.platform.clone(),
            };
            let Some(emacs) = recorded.get(case.name.as_str()) else {
                problems.push(format!("{id}: not recorded; record it with record.el"));
                continue;
            };
            if emacs.input != input {
                problems.push(format!("{id}: the case changed since Emacs {} recorded it; record it again", golden.emacs_version));
                continue;
            }
            let ember = run(case);
            let diff = differences(&emacs.state, &ember);
            match (diff.is_empty(), gaps.contains_key(&id)) {
                (true, false) => matching += 1,
                (false, true) => {}
                (true, true) => problems.push(format!("{id}: now matches Emacs; remove it from known-gaps.txt")),
                (false, false) => problems.push(format!("{id}: keys {:?}\n{diff}", case.keys)),
            }
        }
    }
    for id in gaps.keys() {
        if !seen.contains(id) {
            problems.push(format!("{id}: listed in known-gaps.txt but there is no such case"));
        }
    }

    eprintln!("Emacs oracle: {total} cases, {matching} match, {} known gaps", gaps.len());
    assert!(problems.is_empty(), "\n{}\n", problems.join("\n"));
}
