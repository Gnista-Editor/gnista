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
