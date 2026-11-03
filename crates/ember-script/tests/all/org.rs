//! Org mode: how it looks once fontified, and the commands the Emacs oracle
//! cannot check because they read the minibuffer, depend on today's date,
//! or are about display.

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

fn org(text: &str) -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(text);
    ed.call("org-mode", vec![]).unwrap();
    ed.set_window_size(ed.selected_window(), 80, 20);
    ed.redisplay();
    (ed, scripting)
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

/// The rows the window shows, as text.
fn rows(ed: &Editor) -> Vec<String> {
    ed.window_rows(20, true)
        .iter()
        .map(|r| r.segments.iter().map(|s| s.text.as_str()).collect())
        .collect()
}

/// The face names at a position, first first.
fn faces_at(ed: &Editor, pos: usize) -> Vec<String> {
    match ed.window_buffer().text_property(pos, "face") {
        Some(Value::Str(s)) => vec![s.clone()],
        Some(Value::List(items)) => items.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

fn find(ed: &Editor, needle: &str) -> usize {
    let t = text(ed);
    let i = t.find(needle).unwrap_or_else(|| panic!("no {needle:?} in {t:?}"));
    t[..i].chars().count()
}

fn call(ed: &mut Editor, name: &str, args: &[&str]) {
    ed.call(name, args.iter().map(|a| Arg::Str(a.to_string())).collect())
        .unwrap_or_else(|e| panic!("{name}: {e}"));
}

#[test]
fn org_files_get_org_mode() {
    let dir = std::env::temp_dir().join(format!("ember-org-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("notes.org");
    std::fs::write(&file, "* Notes\n").unwrap();
    let mut ed = Editor::new();
    let _scripting = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![Arg::Str(file.to_string_lossy().into_owned())]).unwrap();
    assert_eq!(ed.mode_name(), "Org");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn headings_states_tags_and_priorities_get_their_faces() {
    let (ed, _s) = org("* TODO [#A] Write the report :work:\n** DONE Old *bold* part\nbody\n");
    assert_eq!(faces_at(&ed, find(&ed, "Write")), ["org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, "TODO")), ["org-todo", "org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, "[#A]")), ["org-priority", "org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, ":work:")), ["org-tag", "org-level-1"]);
    assert_eq!(faces_at(&ed, find(&ed, "DONE")), ["org-done", "org-headline-done", "org-level-2"]);
    assert_eq!(faces_at(&ed, find(&ed, "bold")), ["bold", "org-headline-done", "org-level-2"]);
    assert!(faces_at(&ed, find(&ed, "body")).is_empty());
    // The faces draw: a TODO is bold.
    let row = &ed.window_rows(1, true)[0];
    assert!(row.segments.iter().any(|s| s.text == "TODO" && s.style.bold));
}

#[test]
fn links_show_their_description() {
    let (ed, _s) = org("See [[https://gnu.org][GNU]] and [[*Plans]].\n");
    assert_eq!(rows(&ed)[0], "See GNU and *Plans.");
    assert_eq!(faces_at(&ed, find(&ed, "GNU")), ["org-link"]);
}

#[test]
fn text_objects_get_their_faces() {
    let (ed, _s) = org(
        "#+TITLE: My notes\n\
         Some /italic/, _underlined_, =verbatim=, ~code~ and +struck+ text.\n\
         Meet <2026-10-28 Wed 10:00> at https://example.com\n\
         - [X] done item [1/2]\n\
         - term :: definition\n\
         # a comment\n\
         | a | b |\n\
         #+begin_src rust\n\
         fn main() {}\n\
         #+end_src\n\
         :PROPERTIES:\n\
         :ID: 1\n\
         :END:\n",
    );
    assert_eq!(faces_at(&ed, find(&ed, "#+TITLE:")), ["org-document-info-keyword"]);
    assert_eq!(faces_at(&ed, find(&ed, "My notes")), ["org-document-title"]);
    assert_eq!(faces_at(&ed, find(&ed, "/italic/")), ["italic"]);
    assert_eq!(faces_at(&ed, find(&ed, "_underlined_")), ["underline"]);
    assert_eq!(faces_at(&ed, find(&ed, "=verbatim=")), ["org-verbatim"]);
    assert_eq!(faces_at(&ed, find(&ed, "~code~")), ["org-code"]);
    assert_eq!(faces_at(&ed, find(&ed, "+struck+")), ["org-strike-through"]);
    assert_eq!(faces_at(&ed, find(&ed, "<2026")), ["org-date"]);
    assert_eq!(faces_at(&ed, find(&ed, "https://example")), ["org-link"]);
    assert_eq!(faces_at(&ed, find(&ed, "[X]")), ["org-checkbox"]);
    assert_eq!(faces_at(&ed, find(&ed, "[1/2]")), ["org-checkbox-statistics-todo"]);
    assert_eq!(faces_at(&ed, find(&ed, "term")), ["org-list-dt"]);
    assert_eq!(faces_at(&ed, find(&ed, "# a comment")), ["font-lock-comment-face"]);
    assert_eq!(faces_at(&ed, find(&ed, "| a")), ["org-table"]);
    assert_eq!(faces_at(&ed, find(&ed, "#+begin_src")), ["org-block-begin-line"]);
    assert_eq!(faces_at(&ed, find(&ed, "fn main")), ["org-block"]);
    assert_eq!(faces_at(&ed, find(&ed, "#+end_src")), ["org-block-end-line"]);
    assert_eq!(faces_at(&ed, find(&ed, ":PROPERTIES:")), ["org-drawer"]);
    assert_eq!(faces_at(&ed, find(&ed, ":ID:")), ["org-special-keyword"]);
}

#[test]
fn editing_refontifies_what_follows() {
    let (mut ed, _s) = org("one\ntwo\nthree\n");
    ed.window_buffer_mut().set_point(0);
    ed.press("* SPC").unwrap();
    ed.redisplay();
    assert_eq!(faces_at(&ed, 2), ["org-level-1"]);
    // Opening a block restyles the lines after it.
    ed.press("C-n C-a").unwrap();
    ed.type_text("#+begin_quote\n");
    ed.redisplay();
    assert_eq!(faces_at(&ed, find(&ed, "two")), ["org-quote"]);
    assert_eq!(faces_at(&ed, find(&ed, "three")), ["org-quote"]);
}

#[test]
fn folded_headings_show_an_ellipsis() {
    let (mut ed, _s) = org("* One\nbody\n** Sub\ntext\n* Two\n");
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("FOLDED"));
    ed.redisplay();
    assert_eq!(rows(&ed), ["* One...", "* Two", ""]);
    ed.press("TAB").unwrap();
    assert_eq!(ed.echo(), Some("CHILDREN"));
    assert_eq!(rows(&ed), ["* One", "body", "** Sub...", "* Two", ""]);
}

#[test]
fn tags_are_set_and_aligned() {
    let (mut ed, _s) = org("* TODO Write\n");
    call(&mut ed, "org-set-tags-command", &["work home"]);
    let line = text(&ed).lines().next().unwrap().to_string();
    assert!(line.starts_with("* TODO Write "), "{line:?}");
    assert!(line.ends_with(" :work:home:"), "{line:?}");
    assert_eq!(line.chars().count(), 77, "tags end at column 77: {line:?}");
    call(&mut ed, "org-set-tags-command", &[""]);
    assert_eq!(text(&ed), "* TODO Write\n");
}

#[test]
fn scheduling_and_deadlines_go_on_the_planning_line() {
    let (mut ed, _s) = org("* Task\nbody\n");
    call(&mut ed, "org-schedule", &["2026-11-03"]);
    assert_eq!(text(&ed), "* Task\nSCHEDULED: <2026-11-03 Tue>\nbody\n");
    call(&mut ed, "org-deadline", &["2026-11-05 15:00"]);
    assert_eq!(text(&ed), "* Task\nSCHEDULED: <2026-11-03 Tue> DEADLINE: <2026-11-05 Thu 15:00>\nbody\n");
    ed.call_with_prefix("org-schedule", vec![Arg::Str(String::new())], Some(ember_core::PrefixArg::Universal(4))).unwrap();
    assert_eq!(text(&ed), "* Task\nDEADLINE: <2026-11-05 Thu 15:00>\nbody\n");
}

#[test]
fn timestamps_are_inserted_from_a_date() {
    let (mut ed, _s) = org("Meet ");
    ed.window_buffer_mut().set_point(5);
    call(&mut ed, "org-timestamp", &["2026-12-24 18:30"]);
    assert_eq!(text(&ed), "Meet <2026-12-24 Thu 18:30>");
    // On a timestamp, it is changed rather than added to.
    ed.window_buffer_mut().set_point(8);
    call(&mut ed, "org-timestamp-inactive", &["2026-12-25"]);
    assert_eq!(text(&ed), "Meet [2026-12-25 Fri]");
}

#[test]
fn a_repeating_task_moves_on_when_done() {
    let (mut ed, _s) = org("* TODO Water plants\nSCHEDULED: <2026-10-28 Wed +1w>\n");
    ed.set_variable("org-log-repeat", Value::Bool(false));
    ed.press("C-c C-t").unwrap();
    assert_eq!(text(&ed), "* TODO Water plants\nSCHEDULED: <2026-11-04 Wed +1w>\n");
}

#[test]
fn a_repeat_is_logged_with_the_time() {
    // org-log-repeat is "time" by default, as in Org. The oracle cannot
    // check this, as the note records the time now.
    let (mut ed, _s) = org("* TODO Water plants\nSCHEDULED: <2026-10-28 Wed +1w>\n");
    ed.press("C-c C-t").unwrap();
    let t = text(&ed);
    let lines: Vec<&str> = t.lines().collect();
    assert_eq!(lines[..3], ["* TODO Water plants", "SCHEDULED: <2026-11-04 Wed +1w>", ":PROPERTIES:"], "{t:?}");
    // An inactive timestamp with the time, such as [2026-10-28 Wed 11:13].
    let stamp = |s: &str| {
        let c: Vec<char> = s.chars().collect();
        c.len() == 22
            && c[0] == '['
            && c[21] == ']'
            && c[1..5].iter().chain(&c[6..8]).chain(&c[9..11]).chain(&c[16..18]).chain(&c[19..21]).all(|d| d.is_ascii_digit())
            && c[18] == ':'
    };
    assert!(lines[3].strip_prefix(":LAST_REPEAT: ").is_some_and(stamp), "{t:?}");
    assert_eq!(lines[4], ":END:");
    assert!(lines[5].strip_prefix("- State \"DONE\"       from \"TODO\"       ").is_some_and(stamp), "{t:?}");
    // The drawer is folded, as org-entry-put leaves a new one.
    assert!(ed.invisible_in(ed.window_buffer(), find(&ed, ":LAST_REPEAT:")).is_some());
}

#[test]
fn org_log_done_records_when() {
    let (mut ed, _s) = org("* TODO Ship it\n");
    ed.set_variable("org-log-done", Value::Str("time".into()));
    ed.press("C-c C-t").unwrap();
    let t = text(&ed);
    assert!(t.starts_with("* DONE Ship it\nCLOSED: ["), "{t:?}");
    ed.press("C-c C-t").unwrap();
    assert_eq!(text(&ed), "* Ship it\n");
}

#[test]
fn links_are_inserted_and_followed() {
    let (mut ed, _s) = org("* One\n\n* Two\n");
    ed.window_buffer_mut().set_point(6);
    call(&mut ed, "org-insert-link", &["*Two", "the second"]);
    assert_eq!(text(&ed), "* One\n[[*Two][the second]]\n* Two\n");
    ed.window_buffer_mut().set_point(9);
    ed.press("C-c C-o").unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "* Two"));
    // On the heading, as anywhere in the entry, the entry's only link is followed.
    ed.window_buffer_mut().set_point(0);
    ed.call("org-open-at-point", vec![]).unwrap();
    assert_eq!(ed.window_buffer().point(), find(&ed, "* Two"));
    let (mut ed, _s) = org("text
* One
");
    assert_eq!(ed.call("org-open-at-point", vec![]).unwrap_err().to_string(), "No link found");
}

#[test]
fn a_table_is_made_from_a_size() {
    let (mut ed, _s) = org("");
    call(&mut ed, "org-table-create-or-convert-from-region", &["3x2"]);
    assert_eq!(text(&ed), "|   |   |   |\n|---+---+---|\n|   |   |   |\n");
    assert_eq!(ed.window_buffer().point(), 2);
    ed.press("a TAB b TAB c TAB").unwrap();
    assert_eq!(text(&ed), "| a | b | c |\n|---+---+---|\n|   |   |   |\n");
}

#[test]
fn typing_after_tab_replaces_a_field() {
    let (mut ed, _s) = org("| one | two |\n");
    ed.window_buffer_mut().set_point(2);
    ed.press("TAB x").unwrap();
    assert_eq!(text(&ed), "| one | x   |\n");
}

#[test]
fn a_subtree_is_cut_and_pasted_at_a_new_level() {
    let (mut ed, _s) = org("* One\n** Sub\ntext\n* Two\n");
    ed.window_buffer_mut().set_point(6);
    ed.press("C-c C-x C-w").unwrap();
    assert_eq!(text(&ed), "* One\n* Two\n");
    ed.press("C-c C-n").unwrap();
    ed.press("C-c C-x C-y").unwrap();
    assert_eq!(text(&ed), "* One\n* Two\n* Sub\ntext\n");
}

#[test]
fn checkboxes_update_their_parent() {
    let (mut ed, _s) = org("- [ ] all [/]\n  - [ ] a\n  - [X] b\n");
    let a = find(&ed, "  - [ ] a") + 2;
    ed.window_buffer_mut().set_point(a);
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "- [X] all [2/2]\n  - [X] a\n  - [X] b\n");
    ed.press("C-c C-c").unwrap();
    assert_eq!(text(&ed), "- [-] all [1/2]\n  - [ ] a\n  - [X] b\n");
}

#[test]
fn undo_takes_back_a_whole_org_command() {
    let (mut ed, _s) = org("| a | bb |\n| ccc | d |\n");
    ed.window_buffer_mut().set_point(1);
    ed.press("TAB").unwrap();
    assert_eq!(text(&ed), "| a   | bb |\n| ccc | d  |\n");
    ed.press("C-/").unwrap();
    assert_eq!(text(&ed), "| a | bb |\n| ccc | d |\n");
}

#[test]
fn fontifying_a_large_file_is_quick() {
    let mut big = String::new();
    for i in 0..3000 {
        big.push_str(&format!("* TODO Heading {i} :tag:\nSome *bold* text with a [[https://x.org][link]] <2026-10-28 Wed>.\n"));
    }
    let (mut ed, _s) = org(&big);
    let start = std::time::Instant::now();
    ed.press("M-> M-<").unwrap();
    ed.redisplay();
    ed.type_text("x");
    ed.redisplay();
    assert!(start.elapsed().as_secs_f64() < 2.0, "took {:?}", start.elapsed());
}


/// The heading index follows edits as finding every heading again would:
/// random insertions, deletions and Org commands, checked after each, a
/// heading at a time or all of them.
#[test]
fn the_heading_index_follows_random_edits() {
    let mut text = String::new();
    for i in 0..60 {
        text.push_str(&format!("{} TODO Heading {i} :tag{}:\nBody of {i}.\n", "*".repeat(1 + i % 3), i % 4));
    }
    let (mut ed, s) = org(&text);
    let mut seed = 42u64;
    let mut rand = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize % n.max(1)
    };
    let pieces = ["\n* New ", "x", "\n", "** ", "*", " :a:b:", "TODO ", "\n\n", "é", ""];
    for step in 0..400 {
        let len = ed.buffer().len();
        match rand(6) {
            0 | 1 => {
                let at = rand(len + 1);
                ed.buffer_mut().set_point(at);
                ed.type_text(pieces[rand(pieces.len())]);
            }
            2 => {
                let at = rand(len + 1);
                let n = rand(12).min(len - at.min(len));
                ed.buffer_mut().set_point(at);
                for _ in 0..n {
                    ed.press("C-d").ok();
                }
            }
            3 => {
                let line = rand(ed.buffer().line_count());
                let at = ed.buffer().line_start(line);
                ed.buffer_mut().set_point(at);
                ed.press(["C-c C-t", "M-<down>", "M-<up>", "RET", "C-k", "M-RET"][rand(6)]).ok();
            }
            4 => {
                ed.press("C-/").ok();
            }
            _ => {
                // Narrowed, then widened again.
                let line = rand(ed.buffer().line_count());
                let at = ed.buffer().line_start(line);
                ed.buffer_mut().set_point(at);
                ed.call("org-narrow-to-subtree", vec![]).ok();
                let verdict = s.eval_expression(&mut ed, "ember.funcall('org--headings-verify')").unwrap();
                assert_eq!(verdict, "null", "narrowed, step {step}");
                ed.press("C-x n w").ok();
            }
        }
        ed.take_error();
        // Mostly one heading, read as the element parser reads it, so the
        // shifts for the rest stay pending across steps; now and then all.
        let check = if step % 5 == 4 { String::new() } else { rand(1000).to_string() };
        let verdict = s.eval_expression(&mut ed, &format!("ember.funcall('org--headings-verify', {check})")).unwrap();
        assert_eq!(verdict, "null", "step {step}");
    }
    let verdict = s.eval_expression(&mut ed, "ember.funcall('org--headings-verify')").unwrap();
    assert_eq!(verdict, "null", "at the end");
}

/// Org's markers live only while the command that made them runs: one an
/// error left behind is dropped once the command is over, not moved on
/// every later edit for the rest of the session.
#[test]
fn markers_a_failed_command_leaves_are_dropped_after_it() {
    let (mut ed, s) = org("* One\n");
    s.eval_typescript(
        &mut ed,
        "leak.ts",
        r#"import("org-macs").then((m) => {
             (globalThis as any).orgMacs = m;
             ember.defineCommand({ name: "leak-a-marker", run: () => { m.marker(0); throw new Error("partway"); } });
           });"#
            .to_string(),
    )
    .unwrap();
    // Org keeps a few markers across commands, as its last-indent ones.
    let count = |ed: &mut ember_core::Editor| s.eval_expression(ed, "(globalThis as any).orgMacs.markers.length").unwrap();
    let before = count(&mut ed);
    ed.press("M-x").unwrap();
    ed.type_text("leak-a-marker\n");
    assert_eq!(count(&mut ed), before);
}

/// A fold an edit breaks is shown once the command is over in the buffer
/// it is in, though another is current by then, as when the edit is made
/// from the agenda or capture.
#[test]
fn a_fold_broken_from_another_buffer_is_shown_in_its_own() {
    let (mut ed, s) = org("* A\nbody\n* B\n");
    ed.press("TAB").unwrap();
    ed.redisplay();
    assert!(!rows(&ed).iter().any(|r| r.contains("body")), "folded: {:?}", rows(&ed));
    s.eval_typescript(
        &mut ed,
        "break.ts",
        r#"ember.defineCommand({ name: "break-fold-elsewhere", run: () => {
             ember.call("switch-to-buffer", "other");
             ember.withCurrentBuffer("*scratch*", () => ember.deleteRegion(0, 2));
           } });"#
            .to_string(),
    )
    .unwrap();
    ed.press("M-x").unwrap();
    ed.type_text("break-fold-elsewhere\n");
    ed.call("switch-to-buffer", vec![Arg::Str("*scratch*".into())]).unwrap();
    ed.redisplay();
    assert!(rows(&ed).iter().any(|r| r.contains("body")), "shown: {:?}", rows(&ed));
}

/// The week's agenda reads each file once, not once a day: 10,000 entries
/// with timestamps make their week quickly, each on its day.
#[test]
fn the_week_agenda_reads_each_file_once() {
    let (mut ed, s) = org("");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.org");
    let entries: String = (0..10_000)
        .map(|i| format!("* TODO Task {i}\nSCHEDULED: <2026-11-{:02} Tue>\nBody with <2026-11-{:02} Wed> in it.\n", 2 + i % 7, 2 + (i + 3) % 7))
        .collect();
    std::fs::write(&path, entries).unwrap();
    s.eval_typescript(&mut ed, "files.ts", format!("ember.setVariable(\"org-agenda-files\", [{:?}]);", path.to_str().unwrap())).unwrap();
    let started = std::time::Instant::now();
    s.eval_typescript(&mut ed, "week.ts", "ember.call(\"org-agenda-list\");".to_string()).unwrap();
    let took = started.elapsed();
    let agenda = text(&ed);
    assert!(agenda.contains("Task 9999"), "{}", &agenda[..agenda.len().min(400)]);
    assert!(took < std::time::Duration::from_secs(10), "took {took:?}");
}

/// Indenting a region keeps its parse through the indentation it changes,
/// rather than parsing the section again after each line: a section of
/// 2,000 paragraphs indents quickly, each line to the column it belongs.
#[test]
fn indenting_a_long_section_keeps_its_parse() {
    let body: String = (0..2_000).map(|i| format!("   paragraph {i}\n\n")).collect();
    let (mut ed, _s) = org(&format!("* Heading\n{body}"));
    let started = std::time::Instant::now();
    ed.press("M-< C-SPC M-> TAB").unwrap();
    let took = started.elapsed();
    let indented = text(&ed);
    assert!(indented.contains("\nparagraph 1999\n") && !indented.contains("   paragraph"), "{}", &indented[..200]);
    assert!(took < std::time::Duration::from_secs(10), "took {took:?}");
}

/// Org's errors in what the user did are `user-error`, as Emacs signals
/// them, so code catches them by condition.
#[test]
fn orgs_mistakes_are_user_errors() {
    // Before the first heading, where no entry has links to choose from.
    let (mut ed, s) = org("plain text\n* Heading\n");
    let caught = |ed: &mut Editor, command: &str| {
        let code = format!(r#"ember.conditionCase(() => {{ ember.call("{command}"); return "ran"; }}, {{ "user-error": (e) => "user-error: " + e.message, error: (e) => "error: " + e.message }})"#);
        s.eval_expression(ed, &code).unwrap()
    };
    assert_eq!(caught(&mut ed, "org-open-at-point"), "\"user-error: No link found\"");
    assert_eq!(caught(&mut ed, "org-table-align"), "\"user-error: Not at a table\"");
}

/// The buffer after typing `line` on the second of three lines and pressing `keys`, `|` at point.
fn typed(setup: &str, line: &str, keys: &str) -> String {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    if !setup.is_empty() {
        s.eval_expression(&mut ed, setup).unwrap();
    }
    ed.window_buffer_mut().set_text(&format!("a\n{line}\nb\n"));
    ed.call("org-mode", vec![]).unwrap();
    let end = 2 + line.chars().count();
    ed.window_buffer_mut().set_point(end);
    ed.press(keys).unwrap();
    let mut t = text(&ed);
    let at = t.char_indices().nth(ed.window_buffer().point()).map_or(t.len(), |(i, _)| i);
    t.insert(at, '|');
    t
}

#[test]
fn org_tempo_expands_templates_once_required() {
    let tempo = r#"(ember.require("org-tempo"), ember.setVariable("org-structure-template-alist", [...ember.variable("org-structure-template-alist"), ["el", "src emacs-lisp"]]))"#;
    // As Emacs 30's org-tempo leaves them.
    assert_eq!(typed(tempo, "<s", "TAB"), "a\n#+begin_src |\n\n#+end_src\nb\n");
    assert_eq!(typed(tempo, "<q", "TAB"), "a\n#+begin_quote\n|\n#+end_quote\nb\n");
    assert_eq!(typed(tempo, "  <q", "TAB"), "a\n#+begin_quote\n|\n#+end_quote\nb\n");
    assert_eq!(typed(tempo, "<el", "TAB"), "a\n#+begin_src emacs-lisp\n|\n#+end_src\nb\n");
    assert_eq!(typed(tempo, "<L", "TAB"), "a\n#+latex: |\nb\n");
    assert_eq!(typed(tempo, "x <s", "TAB"), "a\nx <s|\nb\n");
    // Without it, TAB only indents, as in Emacs -Q.
    assert_eq!(typed("", "<s", "TAB"), "a\n<s|\nb\n");
}

#[test]
fn org_insert_structure_template_asks_by_key() {
    // As Emacs 30's C-c C-, leaves them.
    assert_eq!(typed("", "", "C-c C-, q"), "a\n#+begin_quote\n|#+end_quote\nb\n");
    assert_eq!(typed("", "", "C-c C-, s"), "a\n#+begin_src |\n#+end_src\nb\n");
    assert_eq!(typed("", "foo", "C-c C-, q"), "a\nfoo\n#+begin_quote\n|#+end_quote\nb\n");
    assert_eq!(typed("", "  x", "C-c C-, TAB Q U O T E RET"), "a\n  x\n  #+BEGIN_QUOTE\n  |#+END_QUOTE\nb\n");
    assert_eq!(typed("", "", "C-c C-, TAB s r c SPC e m a c s - l i s p RET"), "a\n#+begin_src emacs-lisp\n|#+end_src\nb\n");
    // Around the region, escaping what Org would read as its own.
    let (mut ed, _s) = org("x\n* h\n#+k\ny\n");
    ed.window_buffer_mut().set_point(2);
    ed.press("C-SPC M-> C-c C-, e").unwrap();
    assert_eq!(text(&ed), "x\n#+begin_example\n,* h\n,#+k\ny\n#+end_example\n");
}

#[test]
fn require_loads_a_package_once_from_load_path() {
    let dir = std::env::temp_dir().join(format!("ember-require-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("my-thing.ts"), "import { charCount } from \"subr\";\nember.setVariable(\"my-thing-loads\", Number(ember.variable(\"my-thing-loads\") ?? 0) + charCount(\"x\"));\n").unwrap();
    let (mut ed, s) = org("");
    ed.set_variable("load-path", Value::List(vec![Value::Str(dir.display().to_string())]));
    s.eval_expression(&mut ed, r#"(ember.require("my-thing"), ember.require("my-thing"))"#).unwrap();
    assert_eq!(ed.variable("my-thing-loads"), Some(Value::Number(1.0)));
    let missing = s
        .eval_expression(&mut ed, r#"ember.conditionCase(() => ember.require("no-such-thing"), { "file-missing": (e) => e.message })"#)
        .unwrap();
    assert_eq!(missing, "\"Cannot open load file: No such file or directory, no-such-thing\"");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn tangling_writes_blocks_as_emacs_does() {
    // As Emacs 30's org-babel-tangle writes this file's blocks: header
    // arguments from #+PROPERTY, a drawer and the blocks themselves, a
    // COMMENT heading's left out, indentation and escaping commas taken
    // off, a blank line between blocks but with :padline no, a shebang
    // that makes the file executable, and directories :mkdirp makes.
    let dir = tempfile::tempdir().unwrap();
    let org = dir.path().join("conf.org");
    std::fs::write(&org, include_str!("../data/tangle.org")).unwrap();
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.call("find-file", vec![Arg::Str(org.display().to_string())]).unwrap();
    ed.press("C-c C-v t").unwrap();
    assert_eq!(ed.echo(), Some("Tangled 5 code blocks from conf.org"));
    let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
    assert_eq!(read("conf.el"), "(setq a 1)\n\n(when t\n  * not a heading\n  (setq b 2))\n");
    assert_eq!(read("out/other.py"), "print(\"one\")\nprint(\"two\")\n");
    assert_eq!(read("run.sh"), "#!/bin/sh\necho hi\n");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir.path().join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    // C-u tangles only the block at point.
    std::fs::remove_file(dir.path().join("conf.el")).unwrap();
    ed.press("M-< C-s r u n . s h RET C-u C-c C-v t").unwrap();
    assert_eq!(ed.echo(), Some("Tangled 1 code block from conf.org"));
    assert!(!dir.path().join("conf.el").exists());
}
