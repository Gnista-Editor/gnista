//! Finds where Ember's org-mode differs from Emacs's by trying random cases.
//!
//! It writes random Org documents and key sequences as oracle cases, records
//! what GNU Emacs does with them using record.el, runs them through Ember,
//! and shrinks each case that differs to fewer keys and lines, so it can be
//! read and added to `tests/emacs/cases/`. It needs Emacs, so it is ignored
//! unless asked for:
//!
//! ```text
//! cargo test --release -p ember-script --test org_fuzz -- --ignored --nocapture
//! ```
//!
//! `EMBER_FUZZ_SEED` picks the random cases, so a run can be repeated, and
//! `EMBER_FUZZ_CASES` says how many to try (300 by default). The shrunk
//! cases are written to `target/org-fuzz/differences.json`.

mod oracle;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use oracle::{Case, Golden, State, differences, oracle_dir, run};

/// A small random number generator, so the fuzzer needs no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

const WORDS: &[&str] = &["alpha", "beta", "gamma", "notes", "plan", "read", "call", "fix"];

fn heading(rng: &mut Rng, level: usize) -> String {
    let mut line = "*".repeat(level);
    line.push(' ');
    if rng.chance(40) {
        line.push_str(rng.pick(&["TODO ", "DONE "]));
    }
    if rng.chance(20) {
        line.push_str(rng.pick(&["[#A] ", "[#B] ", "[#C] "]));
    }
    line.push_str(rng.pick(WORDS));
    if rng.chance(50) {
        line.push(' ');
        line.push_str(rng.pick(WORDS));
    }
    if rng.chance(15) {
        line.push_str(rng.pick(&[" [/]", " [1/2]", " [%]"]));
    }
    if rng.chance(20) {
        line.push_str(rng.pick(&[" :work:", " :home:x:"]));
    }
    line
}

fn list(rng: &mut Rng, out: &mut Vec<String>) {
    let bullet = rng.pick(&["-", "+", "1.", "1)"]);
    let boxes = rng.chance(40);
    // Lists are often spaced out with a blank line between items.
    let spaced = rng.chance(25);
    let count = 2 + rng.below(3);
    for n in 0..count {
        if spaced && n > 0 {
            out.push(String::new());
        }
        let b = match bullet.strip_prefix('1') {
            Some(style) => format!("{}{style}", n + 1),
            None => bullet.to_string(),
        };
        let mut line = format!("{b} ");
        if boxes {
            line.push_str(rng.pick(&["[ ] ", "[X] "]));
        }
        line.push_str(rng.pick(WORDS));
        out.push(line);
        if rng.chance(25) {
            let indent = " ".repeat(b.len() + 1);
            let child = rng.pick(&["-", "+"]);
            out.push(format!("{indent}{child} {}", rng.pick(WORDS)));
        }
        if rng.chance(10) {
            out.push(format!("{}{}", " ".repeat(b.len() + 1), rng.pick(WORDS)));
        }
    }
}

/// Drawers, blocks, keywords, comments, links and closed planning lines.
fn other(rng: &mut Rng, out: &mut Vec<String>) {
    let lines: &[&str] = match rng.below(7) {
        0 => &[":LOGBOOK:", "- note", ":END:"],
        1 => &["#+BEGIN_SRC", "code here", "#+END_SRC"],
        2 => &["#+begin_quote", "quoted", "#+end_quote"],
        3 => &["#+TITLE: notes"],
        4 => &["# a comment"],
        5 => &["see [[*notes][the notes]] now"],
        _ => &["CLOSED: [2026-10-20 Tue 10:00]"],
    };
    out.extend(lines.iter().map(|l| l.to_string()));
}

fn table(rng: &mut Rng, out: &mut Vec<String>) {
    let rows = 2 + rng.below(2);
    for r in 0..rows {
        if r == 1 && rng.chance(50) {
            out.push(rng.pick(&["|---+---|", "|-"]).to_string());
        }
        let a = rng.pick(&["a", "bb", "12", "ccc", ""]);
        let b = rng.pick(&["x", "yy", "3", ""]);
        out.push(if rng.chance(30) { format!("|{a}|{b}|") } else { format!("| {a} | {b} |") });
    }
}

fn document(rng: &mut Rng) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut level = 1;
    for _ in 0..3 + rng.below(5) {
        match rng.below(10) {
            0..=3 => {
                level = (level + rng.below(3)).saturating_sub(1).clamp(1, 3);
                out.push(heading(rng, level));
                if rng.chance(15) {
                    out.push(rng.pick(&["SCHEDULED: <2026-10-28 Wed>", "DEADLINE: <2026-11-01 Sun +1w>"]).to_string());
                }
                if rng.chance(10) {
                    out.extend([":PROPERTIES:", ":ID: 1", ":END:"].map(String::from));
                }
            }
            4 | 5 => list(rng, &mut out),
            6 => table(rng, &mut out),
            7 => out.push(format!("{} <2026-10-{} Wed>", rng.pick(WORDS), 10 + rng.below(19))),
            8 => out.push(String::new()),
            9 if rng.chance(50) => other(rng, &mut out),
            _ => out.push(format!("{}{} {}", rng.pick(&["", "  "]), rng.pick(WORDS), rng.pick(WORDS))),
        }
    }
    let mut text = out.join("\n");
    // Org loops forever skipping comments in org-toggle-heading when the
    // last line is one, so a comment always ends with a newline.
    if rng.chance(85) || out.last().is_some_and(|l| l.starts_with("# ")) {
        text.push('\n');
    }
    text
}

/// Keys that run Org's commands without prompting, and plain motion and typing.
const ORG_KEYS: &[&str] = &[
    "TAB", "<backtab>", "M-RET", "C-<return>", "M-S-<return>", "M-<left>", "M-<right>", "M-<up>", "M-<down>",
    "M-S-<left>", "M-S-<right>", "M-S-<up>", "M-S-<down>", "S-<left>", "S-<right>", "S-<up>", "S-<down>",
    "C-c C-t", "C-c C-c", "C-c -", "C-c *", "C-c C-x C-b", "C-c C-n", "C-c C-p", "C-c C-f", "C-c C-b", "C-c C-u",
    "C-c @", "RET", "DEL", "C-d", "C-k", "C-c C-x C-w", "C-c C-x M-w", "C-c C-x C-y", "C-u TAB",
    "C-c SPC",
];
/// Editing keys from outside Org, which Org leaves alone or remaps.
const EDIT_KEYS: &[&str] = &["C-y", "M-y", "C-w", "M-w", "C-SPC", "C-/", "C-o", "M-d", "M-DEL", "C-t", "C-j", "M-<", "M->"];
const MOTION_KEYS: &[&str] = &["C-n", "C-p", "C-f", "C-b", "C-a", "C-e", "M-f", "M-b"];
const TYPING_KEYS: &[&str] = &["x", "SPC", "-", "|", "1"];

fn keys(rng: &mut Rng) -> String {
    let n = 1 + rng.below(5);
    (0..n)
        .map(|_| match rng.below(22) {
            0..=10 => rng.pick(ORG_KEYS),
            11..=16 => rng.pick(MOTION_KEYS),
            17 | 18 => rng.pick(EDIT_KEYS),
            _ => rng.pick(TYPING_KEYS),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn random_case(rng: &mut Rng, name: String) -> Case {
    let text = document(rng);
    let lines: Vec<&str> = text.split('\n').collect();
    let line = rng.below(lines.len());
    let start: usize = lines[..line].iter().map(|l| l.chars().count() + 1).sum();
    let column = rng.below(lines[line].chars().count() + 1);
    Case {
        name,
        point: start + column,
        text,
        keys: keys(rng),
        modes: vec!["org-mode".into()],
        call: Vec::new(),
        platform: None,
    }
}

/// Records what Emacs does with the cases, in a directory of their own.
/// Org can loop forever on some cases, so a run that takes too long is
/// stopped and the cases are recorded in halves, leaving out any case that
/// hangs by itself.
fn record(dir: &Path, cases: &[Case]) -> BTreeMap<String, State> {
    match record_within(dir, cases, Duration::from_secs(10 + cases.len() as u64 / 100)) {
        Some(states) => states,
        None if cases.len() == 1 => {
            eprintln!("Emacs hangs on {}; leaving it out", cases[0].name);
            BTreeMap::new()
        }
        None => {
            let (a, b) = cases.split_at(cases.len() / 2);
            let mut states = record(dir, a);
            states.extend(record(dir, b));
            states
        }
    }
}

/// Records the cases with one run of Emacs, or `None` if it takes longer than `limit`.
fn record_within(dir: &Path, cases: &[Case], limit: Duration) -> Option<BTreeMap<String, State>> {
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir.join("cases")).unwrap();
    fs::write(dir.join("cases/fuzz.json"), serde_json::to_string_pretty(cases).unwrap()).unwrap();
    let mut child = Command::new("emacs")
        .args(["-Q", "--batch", "-l"])
        .arg(oracle_dir().join("record.el"))
        .env("EMBER_ORACLE_DIR", dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("emacs runs");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    assert!(status.success(), "Emacs failed: {stderr}");
    let golden: Golden = serde_json::from_str(&fs::read_to_string(dir.join("golden/fuzz.json")).unwrap()).unwrap();
    Some(golden.cases.into_iter().map(|r| (r.name, r.state)).collect())
}

/// Which of a case's fields differ between Emacs and Ember, or `None` if
/// the case cannot be compared because it made Emacs prompt.
fn compare(case: &Case, emacs: &State) -> Option<String> {
    if emacs.error.as_deref().is_some_and(|e| e.contains("Minibuffer read")) {
        return None;
    }
    let ember = std::panic::catch_unwind(|| run(case));
    match ember {
        Ok(ember) => Some(differences(&without_clock_times(emacs), &without_clock_times(&ember))),
        Err(_) => Some("    Ember panicked".into()),
    }
}

/// A state with the times of inactive timestamps blanked out. Org logs the
/// time of a change, and Emacs ran a while before Ember, so the minute can
/// differ.
fn without_clock_times(state: &State) -> State {
    let blank = |s: &str| -> String {
        let mut chars: Vec<char> = s.chars().collect();
        for i in 0..chars.len() {
            // "[2026-10-28 Wed 11:46]": the time is the five characters before the bracket.
            if chars[i] == ']' && i >= 21 && chars[i - 21] == '[' && chars[i - 3] == ':' {
                for c in &mut chars[i - 5..i] {
                    if *c != ':' {
                        *c = '0';
                    }
                }
            }
        }
        chars.into_iter().collect()
    };
    // Emacs reports deleting past the buffer's ends with an internal "Args out
    // of range" error; Ember says which end, on purpose (see known-gaps.txt).
    let error = match state.error.as_deref() {
        Some(e) if e.starts_with("Args out of range: #<buffer") || e == "End of buffer" || e == "Beginning of buffer" => {
            Some("out of range".to_string())
        }
        _ => state.error.clone(),
    };
    State {
        text: blank(&state.text),
        visible: blank(&state.visible),
        kill_ring: state.kill_ring.iter().map(|k| blank(k)).collect(),
        error,
        ..state.clone()
    }
}

/// The names of the fields that differ, so shrinking keeps to the same difference.
fn fields(diff: &str) -> BTreeSet<String> {
    diff.lines().filter_map(|l| l.trim().split(':').next()).map(String::from).collect()
}

/// Smaller versions of a case: one key fewer, or one line fewer.
fn shrinks(case: &Case) -> Vec<Case> {
    let mut out = Vec::new();
    let keys: Vec<&str> = case.keys.split(' ').collect();
    // Keys of a sequence such as "C-c C-t" go together.
    let mut groups: Vec<Vec<&str>> = Vec::new();
    for k in keys {
        match groups.last_mut() {
            Some(g) if matches!(*g.last().unwrap(), "C-c" | "C-x" | "C-u") => g.push(k),
            Some(g) if g.len() >= 2 && g[g.len() - 2] == "C-c" && *g.last().unwrap() == "C-x" => g.push(k),
            _ => groups.push(vec![k]),
        }
    }
    for i in 0..groups.len() {
        if groups.len() > 1 {
            let rest: Vec<&str> = groups.iter().enumerate().filter(|(j, _)| *j != i).flat_map(|(_, g)| g.clone()).collect();
            out.push(Case { keys: rest.join(" "), ..case.clone() });
        }
    }
    let lines: Vec<&str> = case.text.split('\n').collect();
    let mut start = 0;
    for (i, line) in lines.iter().enumerate() {
        let len = line.chars().count() + 1;
        if lines.len() > 1 {
            let text = lines.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
            let point = if case.point >= start + len { case.point - len } else { case.point.min(start) };
            if point <= text.chars().count() {
                out.push(Case { text, point, ..case.clone() });
            }
        }
        start += len;
    }
    out
}

#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn org_mode_behaves_like_emacs_on_random_cases() {
    fuzz(random_case);
}

/// Words, punctuation, indentation and blank lines for plain text.
fn text_document(rng: &mut Rng) -> String {
    let mut lines: Vec<String> = Vec::new();
    for _ in 0..1 + rng.below(5) {
        if rng.chance(15) {
            lines.push(String::new());
            continue;
        }
        let mut line = rng.pick(&["", "", "  ", "\t"]).to_string();
        for w in 0..1 + rng.below(5) {
            if w > 0 {
                line.push_str(rng.pick(&[" ", " ", "  ", ", ", ". ", "-"]));
            }
            line.push_str(rng.pick(&["one", "two", "three", "foo_bar", "x", "Hello", "it's", "42", "a.b"]));
        }
        if rng.chance(20) {
            line.push_str(rng.pick(&[".", "!", " ", "?"]));
        }
        lines.push(line);
    }
    let mut text = lines.join("\n");
    if rng.chance(70) {
        text.push('\n');
    }
    text
}

/// Keys for plain editing, outside any mode: motion, killing, yanking, the
/// mark, undo, transposing and prefix arguments.
const EDIT_ONLY_KEYS: &[&str] = &[
    "C-f", "C-b", "C-n", "C-p", "C-a", "C-e", "M-f", "M-b", "M-<", "M->", "C-d", "DEL", "M-d", "M-DEL", "C-k",
    "C-y", "M-y", "C-w", "M-w", "C-SPC", "C-x C-x", "C-x h", "C-/", "C-?", "C-t", "M-t", "C-x C-t", "C-o", "C-j",
    "RET", "C-u", "M-2", "C--", "S-<right>", "S-<left>", "S-<down>", "C-g",
];

fn random_text_case(rng: &mut Rng, name: String) -> Case {
    let text = text_document(rng);
    let point = rng.below(text.chars().count() + 1);
    let n = 1 + rng.below(6);
    let keys = (0..n)
        .map(|_| if rng.chance(80) { rng.pick(EDIT_ONLY_KEYS) } else { rng.pick(&["x", "SPC", "1"]) })
        .collect::<Vec<_>>()
        .join(" ");
    Case { name, point, text, keys, modes: Vec::new(), call: Vec::new(), platform: None }
}

/// Fuzzes editing outside any mode, as the org fuzzer does org-mode.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn plain_editing_behaves_like_emacs_on_random_cases() {
    fuzz(random_text_case);
}

/// Generates cases with `generate`, compares Emacs and Ember on them, and
/// shrinks those that differ.
fn fuzz(generate: fn(&mut Rng, String) -> Case) {
    let seed: u64 = std::env::var("EMBER_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    let count: usize = std::env::var("EMBER_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    // Mixed first, so seeds differing in their lowest bit give different cases.
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(0x9e37_79b9_7f4a_7c15) | 1);
    let work = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/org-fuzz");
    let cases: Vec<Case> = (0..count).map(|i| generate(&mut rng, format!("f{i:04}"))).collect();
    let recorded = record(&work.join("run"), &cases);

    let mut failing: Vec<(Case, String)> = Vec::new();
    let mut compared = 0;
    for case in &cases {
        if let Some(diff) = recorded.get(&case.name).and_then(|emacs| compare(case, emacs)) {
            compared += 1;
            if !diff.is_empty() {
                failing.push((case.clone(), diff));
            }
        }
    }
    eprintln!("seed {seed}: {compared} cases compared, {} differ", failing.len());

    // Shrink every failing case a step at a time, recording each round's
    // candidates with one run of Emacs.
    for round in 0..20 {
        let mut candidates = Vec::new();
        for (k, (case, _)) in failing.iter().enumerate() {
            for (j, mut smaller) in shrinks(case).into_iter().enumerate() {
                smaller.name = format!("s{k:03}-{j:03}");
                candidates.push((k, smaller));
            }
        }
        if candidates.is_empty() {
            break;
        }
        let all: Vec<Case> = candidates.iter().map(|(_, c)| c.clone()).collect();
        let recorded = record(&work.join("shrink"), &all);
        let mut progress = false;
        let mut taken = BTreeSet::new();
        for (k, smaller) in candidates {
            if taken.contains(&k) {
                continue;
            }
            let Some(diff) = recorded.get(&smaller.name).and_then(|emacs| compare(&smaller, emacs)) else { continue };
            if !diff.is_empty() && fields(&diff) == fields(&failing[k].1) {
                let name = failing[k].0.name.clone();
                failing[k] = (Case { name, ..smaller }, diff);
                taken.insert(k);
                progress = true;
            }
        }
        eprintln!("shrinking, round {round}: {} cases shrunk", taken.len());
        if !progress {
            break;
        }
    }

    // Cases that shrank to the same thing are one difference.
    let mut seen = BTreeSet::new();
    failing.retain(|(c, _)| seen.insert((c.text.clone(), c.keys.clone(), c.point)));
    failing.sort_by_key(|(c, _)| (c.keys.split(' ').count(), c.text.len()));
    for (case, diff) in &failing {
        eprintln!("\n{}: text {:?}, point {}, keys {:?}\n{diff}", case.name, case.text, case.point, case.keys);
    }
    let out: Vec<&Case> = failing.iter().map(|(c, _)| c).collect();
    fs::write(work.join("differences.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
    assert!(failing.is_empty(), "{} differences from Emacs; see above", failing.len());
}

/// Runs the cases in `EMBER_FUZZ_REPLAY` (by default the last run's
/// `differences.json`) again, to check fixes without a new search.
#[test]
#[ignore = "needs GNU Emacs; run with --ignored"]
fn org_mode_replays_differences() {
    let work = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/org-fuzz");
    let file = std::env::var("EMBER_FUZZ_REPLAY").map(Into::into).unwrap_or_else(|_| work.join("differences.json"));
    let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
    let recorded = record(&work.join("replay"), &cases);
    let mut failing = 0;
    for case in &cases {
        let Some(diff) = recorded.get(&case.name).and_then(|emacs| compare(case, emacs)) else { continue };
        if !diff.is_empty() {
            failing += 1;
            eprintln!("\n{}: text {:?}, point {}, keys {:?}\n{diff}", case.name, case.text, case.point, case.keys);
        }
    }
    eprintln!("\n{failing} of {} cases differ", cases.len());
    assert_eq!(failing, 0);
}
