//! transient, which ships with E8 as with Emacs: a prefix shows its
//! suffixes in columns in a window below, a suffix runs and leaves or runs
//! and stays, a sub-menu goes back with C-g, C-q leaves them all, and
//! switches and options are the arguments a suffix reads. Casual's and
//! Magit's menus, which are built on it, are tested in their own
//! repositories, e8-casual and e8-magit, against what Emacs shows.

use e8_core::{Editor, Value};
use e8_script::Scripting;

/// A menu of two columns, a sub-menu, a suffix that stays and one that
/// leaves, and a menu of arguments, as a package in a directory of its own.
const MENUS: &str = r#"
import { transientArgs, transientDefinePrefix } from "transient";
e8.defineVariable({ name: "tm-count", value: 0 });
const bump = e8.defineCommand({ name: "tm-bump", run: () => e8.setVariable("tm-count", (e8.variable("tm-count") as number) + 1) });
const hello = e8.defineCommand({ name: "tm-hello", run: () => e8.message("Hello") });
transientDefinePrefix("tm-sub", {
  groups: [{ description: "Sub", items: [["x", "Hello", hello]] }],
});
transientDefinePrefix("tm-main", {
  groups: [
    {
      items: [
        { description: "Left", items: [["b", "Bump", bump, { transient: true }], ["h", "Hello", hello]] },
        { description: "Right", items: [["s", "Sub", "tm-sub"]] },
      ],
    },
  ],
});
const show = e8.defineCommand({ name: "show-args", run: () => e8.message(JSON.stringify(transientArgs("args-menu"))) });
transientDefinePrefix("args-menu", {
  value: ["--all"],
  groups: [{ description: "Arguments", items: [["-a", "All", "--all"], ["-v", "Verbose", "--verbose"], ["=a", "Author", "--author="]] },
           { description: "Actions", items: [["s", "Show", show]] }],
});
"#;

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    ed.set_frame_size(100, 40);
    let s = Scripting::new(&mut ed).unwrap();
    let pkgs = tempfile::tempdir().unwrap();
    std::fs::write(pkgs.path().join("tm-menus.ts"), MENUS).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(pkgs.path().display().to_string())]));
    s.eval_expression(&mut ed, r#"e8.require("tm-menus")"#).unwrap();
    (ed, s, pkgs)
}

fn menu(ed: &Editor) -> Option<String> {
    let b = &ed.buffers()[ed.find_buffer(" *transient*")?];
    Some(b.slice(0..b.len()))
}

fn count(ed: &Editor) -> f64 {
    ed.variable("tm-count").and_then(|v| v.as_number()).unwrap_or(f64::NAN)
}

#[test]
fn a_prefix_shows_its_groups_side_by_side() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    assert_eq!(menu(&ed).as_deref(), Some("Left      Right\n b Bump    s Sub\n h Hello\n"));
}

#[test]
fn a_suffix_that_stays_runs_and_one_that_leaves_closes_the_menu() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("b b").unwrap();
    assert_eq!(count(&ed), 2.0);
    assert!(menu(&ed).is_some());
    ed.press("h").unwrap();
    assert_eq!(ed.echo(), Some("Hello"));
    assert_eq!(menu(&ed), None);
}

#[test]
fn a_sub_menu_goes_back_with_c_g_and_c_q_leaves_them_all() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("s").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Sub\n x Hello"), "{:?}", menu(&ed));
    ed.press("C-g").unwrap();
    assert!(menu(&ed).unwrap().starts_with("Left"), "{:?}", menu(&ed));
    ed.press("s C-q").unwrap();
    assert_eq!(menu(&ed), None);
    // The keys are the buffer's own again.
    ed.press("b").unwrap();
    assert_eq!(count(&ed), 0.0);
}

#[test]
fn a_key_no_suffix_has_is_refused() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("tm-main", vec![]).unwrap();
    ed.press("z").unwrap();
    assert_eq!(ed.echo(), Some("Unbound suffix: `z' (Use `C-g' to abort, `?' for help)"));
    assert!(menu(&ed).unwrap().starts_with("Left"));
}

#[test]
fn switches_and_options_are_the_arguments_a_suffix_reads() {
    let (mut ed, _s, _pkgs) = setup();
    ed.call("args-menu", vec![]).unwrap();
    assert_eq!(
        menu(&ed).as_deref(),
        Some("Arguments\n -a All (--all)\n -v Verbose (--verbose)\n =a Author (--author=)\n\nActions\n s Show\n")
    );
    ed.press("- v - a = a M i n a RET s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--verbose","--author=Mina"]"#));
    assert_eq!(menu(&ed), None);
}
