//! A benchmark of large files, run by hand:
//!
//! ```text
//! cargo test --release -p ember-script --test bench -- --ignored --nocapture
//! ```
//!
//! It writes a large Org file and a large text file, opens them as a user
//! would, and times keys as the front ends see them: each key, then the
//! redisplay and the rows a window draws. `EMBER_BENCH_ORG_LINES` and
//! `EMBER_BENCH_TEXT_MB` set the sizes (50,000 lines and 100 MB by default).

use std::path::Path;
use std::time::{Duration, Instant};

use ember_core::Editor;
use ember_script::Scripting;

const ROWS: usize = 50;
const COLS: usize = 120;

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// One screenful drawn as a front end draws it.
fn frame(ed: &mut Editor) {
    ed.redisplay();
    let w = ed.selected_window();
    std::hint::black_box(ed.rows_of_window(w, ROWS + 1, true));
}

struct Bench {
    ed: Editor,
    _scripting: Scripting,
    results: Vec<(String, Duration, usize)>,
}

impl Bench {
    fn new() -> Bench {
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        let w = ed.selected_window();
        ed.set_window_size(w, COLS, ROWS);
        Bench { ed, _scripting: scripting, results: Vec::new() }
    }

    /// Times `f` run `n` times, each followed by a frame.
    fn time(&mut self, name: &str, n: usize, mut f: impl FnMut(&mut Editor)) {
        let start = Instant::now();
        for _ in 0..n {
            f(&mut self.ed);
            frame(&mut self.ed);
        }
        let elapsed = start.elapsed();
        if let Some(e) = self.ed.take_error() {
            println!("  ({name}: {e})");
        }
        self.results.push((name.to_string(), elapsed, n));
    }

    fn keys(&mut self, name: &str, n: usize, keys: &str) {
        let keys = keys.to_string();
        self.time(name, n, |ed| {
            ed.press(&keys).ok();
        });
    }

    fn goto_line(&mut self, line: usize) {
        let b = self.ed.window_buffer_mut();
        let pos = b.line_start(line.min(b.line_count() - 1));
        b.set_point(pos);
        frame(&mut self.ed);
    }

    fn report(&self, title: &str) {
        println!("\n{title}");
        for (name, elapsed, n) in &self.results {
            let each = elapsed.as_secs_f64() * 1000.0 / *n as f64;
            println!("  {name:<44} {each:>10.2} ms each  ({n}x, {:.0} ms)", elapsed.as_secs_f64() * 1000.0);
        }
    }
}

/// Org text with the things Org's commands look at: headings at three
/// levels with states, tags, planning and property drawers, lists with
/// checkboxes, a table, a source block, links and emphasis.
fn org_text(lines: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    while out.lines().count() < lines {
        n += 1;
        out.push_str(&format!(
            "* TODO Project {n} [1/2] :work:\n\
             SCHEDULED: <2026-10-28 Wed>\n\
             :PROPERTIES:\n\
             :ID: project-{n}\n\
             :END:\n\
             Some paragraph text about project {n}, with *bold*, /italics/ and a [[https://example.com][link]].\n\
             ** Notes {n}\n\
             - [ ] item one\n\
             - [X] item two\n\
             \x20 - nested item\n\
             | name | hours |\n\
             |------+-------|\n\
             | mon  |     3 |\n\
             *** DONE Step {n}\n\
             #+begin_src rust\n\
             fn main() {{}}\n\
             #+end_src\n\
             \n"
        ));
    }
    out
}

fn text(mb: usize) -> String {
    let line = "The quick brown fox jumps over the lazy dog, and then it does it all again for a while.\n";
    let mut out = String::with_capacity(mb * 1024 * 1024 + 100);
    while out.len() < mb * 1024 * 1024 {
        out.push_str(line);
    }
    out.push_str("needle at the very end\n");
    out
}

fn open(b: &mut Bench, path: &Path) {
    let path = path.to_string_lossy().to_string();
    b.time("find-file and its major mode", 1, |ed| {
        ed.call("find-file", vec![ember_core::Arg::Str(path.clone())]).unwrap();
    });
}

#[test]
#[ignore]
fn large_org_file() {
    let lines = env_usize("EMBER_BENCH_ORG_LINES", 50_000);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.org");
    std::fs::write(&path, org_text(lines)).unwrap();
    let mut b = Bench::new();
    open(&mut b, &path);
    b.keys("C-v (scroll a screen down)", 20, "C-v");
    b.keys("M-> (end of buffer)", 1, "M->");
    b.keys("M-< (start of buffer)", 1, "M-<");
    let middle = b.ed.window_buffer().line_count() / 2;
    // A heading near the middle.
    let heading = (middle..middle + 40)
        .find(|&l| b.ed.window_buffer().line_text(l).starts_with("* TODO"))
        .unwrap();
    b.goto_line(heading + 5);
    b.ed.press("C-e").unwrap();
    b.keys("typing in a paragraph", 20, "x");
    b.keys("DEL", 20, "DEL");
    b.keys("RET in a paragraph", 5, "RET");
    b.keys("C-n (next line)", 20, "C-n");
    b.goto_line(heading);
    b.keys("TAB on a heading (cycle)", 3, "TAB");
    b.keys("C-c C-t on a heading (TODO state)", 2, "C-c C-t");
    b.goto_line(heading + 7);
    b.ed.press("C-e").unwrap();
    b.keys("C-c C-c on a checkbox", 2, "C-c C-c");
    b.keys("M-RET on an item", 1, "M-RET");
    b.keys("C-/ (undo)", 1, "C-/");
    b.goto_line(heading + 6);
    b.keys("M-<down> on a heading (move subtree)", 2, "M-<down>");
    b.goto_line(heading + 11);
    b.keys("TAB in a table (next field)", 3, "TAB");
    b.goto_line(0);
    b.keys("S-TAB (cycle the whole buffer)", 3, "S-<tab>");
    b.goto_line(0);
    b.time("C-s for a word near the end", 1, |ed| {
        ed.press("C-s").ok();
        ed.type_text(&format!("Project {}", lines / 18));
        ed.press("RET").ok();
    });
    b.report(&format!("Org file of {} lines", b.ed.window_buffer().line_count()));
}

#[test]
#[ignore]
fn large_text_file() {
    let mb = env_usize("EMBER_BENCH_TEXT_MB", 100);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.txt");
    std::fs::write(&path, text(mb)).unwrap();
    let mut b = Bench::new();
    open(&mut b, &path);
    b.keys("C-v (scroll a screen down)", 20, "C-v");
    b.keys("M-> (end of buffer)", 1, "M->");
    b.keys("M-< (start of buffer)", 1, "M-<");
    let middle = b.ed.window_buffer().line_count() / 2;
    b.goto_line(middle);
    b.keys("typing in the middle", 20, "x");
    b.keys("RET in the middle", 5, "RET");
    b.keys("C-k (kill line)", 5, "C-k");
    b.keys("C-/ (undo)", 5, "C-/");
    b.goto_line(0);
    b.time("C-s for a word at the end", 1, |ed| {
        ed.press("C-s").ok();
        ed.type_text("needle");
        ed.press("RET").ok();
    });
    b.report(&format!("Text file of {mb} MB, {} lines", b.ed.window_buffer().line_count()));
}
