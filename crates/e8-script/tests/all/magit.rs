//! magit, a package that does not ship with E8
//! (examples/packages/magit.ts): the status buffer shows a repository as
//! Magit 4 shows it in Emacs 30, its sections open and close as there, and
//! staging, unstaging, discarding and committing change the repository.

use std::path::Path;
use std::process::Command;

use crate::driven::Driven;
use e8_core::Value;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The repository Emacs's Magit was shown: one commit, a change to a.txt
/// unstaged, one to b.txt staged, and c.txt untracked.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.email", "t@example.com"]);
    git(p, &["config", "user.name", "Tester"]);
    std::fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(p.join("b.txt"), "keep\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "First commit"]);
    std::fs::write(p.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    std::fs::write(p.join("c.txt"), "new\n").unwrap();
    std::fs::write(p.join("b.txt"), "keep\nmore\n").unwrap();
    git(p, &["add", "b.txt"]);
    dir
}

fn setup(dir: &Path) -> Driven {
    let d = Driven::new("");
    let root = format!("{}/", dir.canonicalize().unwrap().display());
    d.with(move |ed| {
        ed.set_frame_size(100, 40);
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
        ed.set_variable("default-directory", Value::Str(root));
    });
    d.eval(r#"e8.require("magit");"#);
    d
}

/// The status buffer's text as it shows, hidden sections left out, and point's line counting from 1.
fn visible(d: &Driven) -> (String, usize) {
    let text = d.eval_expression(
        r#"(() => {
          const hidden = e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "invisible") === true);
          let out = "";
          for (let p = e8.pointMin(); p < e8.pointMax(); p++) {
            if (!hidden.some((o) => e8.overlayStart(o) <= p && p < e8.overlayEnd(o))) out += e8.charAfter(p);
          }
          return out;
        })()"#,
    );
    let line = d.with(|ed| ed.buffer().line_of(ed.buffer().point()) + 1);
    (serde_json::from_str(&text).unwrap(), line)
}

const START: &str = "Head:     main First commit

Untracked files (1)
Unstaged changes (1)
modified   a.txt

Staged changes (1)
modified   b.txt

Recent commits
";

#[test]
fn the_status_buffer_shows_what_magit_shows() {
    let dir = repo();
    let d = setup(dir.path());
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    assert_eq!(d.with(|ed| ed.buffer().name.clone()), format!("magit: {}", dir.path().file_name().unwrap().to_string_lossy()));
    assert_eq!(visible(&d), (START.to_string(), 3));
    // As Emacs's Magit, key by key: TAB, n, TAB, n, n, TAB.
    d.press("TAB");
    let untracked = START.replace("Untracked files (1)\n", "Untracked files (1)\nc.txt\n\n");
    assert_eq!(visible(&d), (untracked.clone(), 3));
    d.press("n");
    assert_eq!(visible(&d), (untracked.clone(), 4));
    d.press("TAB");
    assert_eq!(visible(&d), (untracked.clone(), 4));
    d.press("n");
    assert_eq!(visible(&d).1, 6);
    d.press("n");
    assert_eq!(visible(&d).1, 7);
    d.press("TAB");
    let expanded = untracked.replace("modified   a.txt\n", "modified   a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n");
    assert_eq!(visible(&d), (expanded, 7));
}

#[test]
fn staging_and_unstaging_files_and_hunks() {
    let dir = repo();
    let d = setup(dir.path());
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    // s on the untracked file stages it.
    d.press("TAB n s");
    assert!(git(dir.path(), &["diff", "--cached", "--name-only"]).contains("c.txt"));
    // s on a hunk stages just it.
    let (text, _) = visible(&d);
    assert!(text.contains("Staged changes (2)"), "{text}");
    d.eval(r#"e8.gotoChar(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()).indexOf("modified   a.txt"));"#);
    d.press("TAB n s");
    assert_eq!(git(dir.path(), &["diff", "--name-only"]), "");
    assert!(git(dir.path(), &["diff", "--cached"]).contains("+TWO"));
    // u on the staged changes heading unstages them all.
    d.eval(r#"e8.gotoChar(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()).indexOf("Staged changes"));"#);
    d.press("u");
    assert_eq!(git(dir.path(), &["diff", "--cached", "--name-only"]), "");
}

#[test]
fn committing_writes_the_message_in_a_buffer() {
    let dir = repo();
    let d = setup(dir.path());
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    d.press("c c");
    // git writes the template and waits for its editor, E8.
    settle(&d, || d.with(|ed| ed.buffer().name == "COMMIT_EDITMSG"));
    assert_eq!(d.with(|ed| ed.buffer().name.clone()), "COMMIT_EDITMSG");
    let template = d.with(|ed| { let b = ed.buffer(); b.slice(0..b.len()) });
    assert!(template.starts_with("\n# Please enter the commit message for your changes."), "{template}");
    assert!(template.contains("#\tmodified:   b.txt"), "{template}");
    d.press("M o r e SPC b");
    d.press("C-c C-c");
    settle(&d, || git(dir.path(), &["log", "-1", "--format=%s"]) == "More b\n");
    assert_eq!(git(dir.path(), &["log", "-1", "--format=%s"]), "More b\n");
    settle(&d, || !visible(&d).0.contains("Staged changes"));
    assert!(d.with(|ed| ed.buffer().name.starts_with("magit: ")));
    assert!(!visible(&d).0.contains("Staged changes"));
}

#[test]
fn discarding_asks_and_puts_the_file_back() {
    let dir = repo();
    let d = setup(dir.path());
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    d.eval(r#"e8.gotoChar(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()).indexOf("modified   a.txt"));"#);
    d.press("k");
    d.press("y");
    assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\ntwo\nthree\n");
}

#[test]
fn the_log_lists_the_commits() {
    let dir = repo();
    let d = setup(dir.path());
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    d.press("l l");
    let (text, _) = visible(&d);
    assert!(text.contains(" main First commit  Tester "), "{text}");
    d.press("RET");
    let (rev, _) = visible(&d);
    assert!(rev.contains("Author:     Tester <t@example.com>") && rev.contains("new file   a.txt"), "{rev}");
}

#[test]
fn the_upstream_stashes_and_unpushed_commits_show_as_in_magit() {
    let origin = tempfile::tempdir().unwrap();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git(p, &["clone", "-q", &origin.path().display().to_string(), "."]);
    git(p, &["config", "user.email", "t@example.com"]);
    git(p, &["config", "user.name", "Tester"]);
    std::fs::write(p.join("a.txt"), "one\n").unwrap();
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "Initial"]);
    git(p, &["push", "-q", "origin", "main"]);
    git(p, &["branch", "-q", "--set-upstream-to=origin/main"]);
    std::fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
    git(p, &["commit", "-qam", "Second"]);
    std::fs::write(p.join("a.txt"), "one\ntwo\nstashed\n").unwrap();
    git(p, &["stash", "-q"]);
    std::fs::write(p.join("a.txt"), "x\n").unwrap();
    let hash = git(p, &["rev-parse", "--short", "HEAD"]).trim().to_string();
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    let want = format!(
        "Head:     main Second\nMerge:    origin/main Initial\n\nUnstaged changes (1)\nmodified   a.txt\n\nStashes (1)\nUnmerged into origin/main (1)\n{hash} main Second\n\n"
    );
    assert_eq!(visible(&d), (want, 4));
}

#[test]
fn the_menus_show_as_magits_do() {
    let recorded: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/emacs/magit/menus.json")).unwrap()).unwrap();
    let dir = repo();
    let d = setup(dir.path());
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    let mut failures = Vec::new();
    for (key, want) in &recorded {
        d.press(key);
        let shown = d.with(|ed| {
            let i = ed.find_buffer(" *transient*")?;
            let b = &ed.buffers()[i];
            Some(b.slice(0..b.len()))
        });
        d.press("C-g");
        if shown.as_deref() != want.as_str() {
            failures.push(format!("{key}:\n--- Emacs\n{}\n--- E8\n{}", want.as_str().unwrap(), shown.unwrap_or_default()));
        }
    }
    assert!(failures.is_empty(), "{} menus differ:\n{}", failures.len(), failures.join("\n"));
}

/// Waits for a push, pull or fetch Magit runs without waiting, as its process ends.
fn settle(d: &Driven, done: impl Fn() -> bool) {
    let start = std::time::Instant::now();
    while !done() && start.elapsed() < std::time::Duration::from_secs(20) {
        d.with(|ed| ed.accept_process_output(std::time::Duration::from_millis(50)));
    }
}

#[test]
fn pushing_sets_the_upstream_and_pulling_fetches() {
    let origin = tempfile::tempdir().unwrap();
    git(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
    let dir = repo();
    let p = dir.path();
    git(p, &["remote", "add", "origin", &origin.path().display().to_string()]);
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    // P u asks for the upstream to set, as there is none.
    d.press("P u");
    d.press("o r i g i n / m a i n RET");
    settle(&d, || !git(origin.path(), &["log", "--oneline", "main"]).is_empty());
    assert_eq!(git(origin.path(), &["log", "-1", "--format=%s", "main"]), "First commit\n");
    settle(&d, || git(p, &["rev-parse", "--abbrev-ref", "main@{upstream}"]) == "origin/main\n");
    assert_eq!(git(p, &["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main\n");
    // The status shows the upstream once the push is done.
    settle(&d, || visible(&d).0.contains("Merge:    origin/main"));
    assert!(visible(&d).0.contains("Merge:    origin/main First commit"), "{}", visible(&d).0);
}

#[test]
fn branching_and_stashing() {
    let dir = repo();
    let p = dir.path();
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    d.press("b c");
    d.press("RET");
    d.press("t o p i c RET");
    assert_eq!(git(p, &["branch", "--show-current"]), "topic\n");
    assert!(visible(&d).0.starts_with("Head:     topic First commit"));
    d.press("z z");
    d.press("RET");
    assert_eq!(git(p, &["stash", "list"]).lines().count(), 1);
    assert_eq!(git(p, &["status", "--porcelain", "--untracked-files=no"]), "");
    assert!(visible(&d).0.contains("Stashes (1)"));
    d.press("z p");
    d.press("RET");
    assert_eq!(git(p, &["stash", "list"]), "");
    assert!(git(p, &["status", "--porcelain"]).contains(" M a.txt"));
}

#[test]
fn an_instant_fixup_goes_into_the_commit() {
    let dir = repo();
    let p = dir.path();
    git(p, &["commit", "-q", "-m", "Second"]);
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    let first = git(p, &["rev-parse", "--short", "HEAD~"]).trim().to_string();
    d.press("s");
    d.press("c F");
    d.press(&format!("{} RET", first.chars().map(|c| c.to_string()).collect::<Vec<_>>().join(" ")));
    // s staged the untracked c.txt, point's section; the fixup is folded
    // into the first commit: two commits still, c.txt in the first.
    assert_eq!(git(p, &["log", "--format=%s"]), "Second\nFirst commit\n");
    assert_eq!(git(p, &["show", "HEAD~:c.txt"]), "new\n");
}

#[test]
fn loading_magit_runs_no_git() {
    // Outside a repository and with no git to run, as at startup anywhere.
    let d = Driven::new("");
    d.with(|ed| {
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
        ed.set_variable("magit-git-executable", Value::Str("no-such-git".into()));
    });
    d.eval(r#"e8.require("magit");"#);
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)), None);
}

#[test]
fn staging_the_lines_of_a_region() {
    let dir = repo();
    let p = dir.path();
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    // Into a.txt's hunk: "-two" and "+TWO" are its 2nd and 3rd lines, "+four" its 5th.
    d.eval(r#"e8.gotoChar(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()).indexOf("modified   a.txt"));"#);
    d.press("TAB n");
    d.eval(r#"(() => { const t = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()); e8.gotoChar(t.indexOf("-two")); e8.setMark(e8.point()); e8.gotoChar(t.indexOf("+TWO") + 4); e8.activateMark(); })()"#);
    d.press("s");
    // Only TWO staged, four left unstaged.
    assert_eq!(git(p, &["diff", "--cached", "--", "a.txt"]).lines().filter(|l| l.starts_with('+') || l.starts_with('-')).collect::<Vec<_>>(), ["--- a/a.txt", "+++ b/a.txt", "-two", "+TWO"]);
    assert_eq!(git(p, &["diff", "--", "a.txt"]).lines().filter(|l| l.starts_with('+') || l.starts_with('-')).collect::<Vec<_>>(), ["--- a/a.txt", "+++ b/a.txt", "+four"]);
}

/// A repository of three commits, each changing a file of its own.
fn history() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.email", "t@example.com"]);
    git(p, &["config", "user.name", "Tester"]);
    for (file, msg) in [("one.txt", "One"), ("two.txt", "Two"), ("three.txt", "Three")] {
        std::fs::write(p.join(file), msg).unwrap();
        git(p, &["add", file]);
        git(p, &["commit", "-q", "-m", msg]);
    }
    dir
}

#[test]
fn an_interactive_rebase_edits_the_todo_list_in_e8() {
    let dir = history();
    let p = dir.path();
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    let first = git(p, &["rev-parse", "--short", "HEAD~2"]).trim().to_string();
    d.press("r i");
    d.press(&format!("{} RET", first.chars().map(|c| c.to_string()).collect::<Vec<_>>().join(" ")));
    settle(&d, || d.with(|ed| ed.buffer().name == "git-rebase-todo"));
    let todo = d.with(|ed| { let b = ed.buffer(); b.slice(0..b.len()) });
    // Newer git writes the subjects as comments: pick 1234567 # One.
    assert!(todo.starts_with(&format!("pick {first} ")) && todo.lines().next().unwrap().ends_with("One") && todo.contains(" Three\n"), "{todo}");
    // Fold Two into One, and leave Three out.
    d.press("n f d");
    d.press("C-c C-c");
    // Done once git has finished the rebase, not when the log first shows
    // One alone, as it does after the pick and before the fixup.
    settle(&d, || !p.join(".git/rebase-merge").exists() && git(p, &["log", "--format=%s"]) == "One\n");
    assert_eq!(git(p, &["log", "--format=%s"]), "One\n");
    assert_eq!(git(p, &["show", "--name-only", "--format=", "HEAD"]), "one.txt\ntwo.txt\n");
}

#[test]
fn rewording_a_commit_writes_its_message_again() {
    let dir = history();
    let p = dir.path();
    let d = setup(p);
    d.start(|ed| ed.call("magit-status", vec![]).unwrap());
    let second = git(p, &["rev-parse", "--short", "HEAD~"]).trim().to_string();
    d.press("r w");
    d.press(&format!("{} RET", second.chars().map(|c| c.to_string()).collect::<Vec<_>>().join(" ")));
    settle(&d, || d.with(|ed| ed.buffer().name == "COMMIT_EDITMSG"));
    d.press("C-k S e c o n d");
    d.press("C-c C-c");
    settle(&d, || git(p, &["log", "--format=%s"]) == "Three\nSecond\nOne\n");
    assert_eq!(git(p, &["log", "--format=%s"]), "Three\nSecond\nOne\n");
}
