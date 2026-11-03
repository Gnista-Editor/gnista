//! transient, which ships with Ember as with Emacs, and Casual's Dired
//! menu, a package that does not (examples/packages/casual-dired.ts): the
//! menus show as transient 0.10 shows Casual 2's in Emacs 30.

use ember_core::{Arg, Editor, Value};
use ember_script::Scripting;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    ed.set_frame_size(100, 40);
    let s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
    s.eval_expression(&mut ed, r#"ember.require("casual")"#).unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "").unwrap();
    std::fs::write(dir.path().join("b.txt"), "").unwrap();
    ed.call("dired", vec![Arg::Str(dir.path().display().to_string())]).unwrap();
    // As on a Mac with GNU ls, where Emacs shows the Sort By menu.
    ed.set_variable("dired-use-ls-dired", Value::Bool(true));
    (ed, s, dir)
}

fn menu(ed: &Editor) -> Option<String> {
    let b = &ed.buffers()[ed.find_buffer(" *transient*")?];
    Some(b.slice(0..b.len()))
}

const MAIN: &str = "\
File           Directory               Mark                  Navigation
 o Open Other   s Sort By›              m Mark                ^   .. Dir
 v View         h [ ] Hide Details      u Unmark              p   Up File
 C Copy to…     O [ ] Omit Mode         U Unmark All          n   Down File
 R Rename…      i Insert Subdir         t Toggle Marks        M-p Up Dir
 D Delete…      $ Hide/Unhide Subdir    ~ Flag Backups        M-n Down Dir
 l Link›        k Kill (Hide) Line(s)   x Delete Flagged      [   Up Subdir
 c Change›      g Revert                r Regexp›             ]   Down Subdir
 y Type         f Filter by name…       # Utils›              j   Goto File…
 w Copy Name    E Edit (wdired)         / Search & Replace›   M-j Goto Subdir…
 ! Shell…       d Dired…
 & Shell &… 
 W Browse

Quick                 Search                       New
 J Jump to Bookmark…   C-s I-Search…                + Directory
 B Add Bookmark…       M-s I-Search Regexp…         F File
 b List Buffers        M-f Find in files (rgrep)…

 C-g Dismiss    RET Open    , Settings›    q Quit Dired   
";

const LINK: &str = "\
Link
Symbolic             Relative             Hard
 s Absolute…          r Relative…          h Hard…
 S Absolute regexp…   R Relative regexp…   H Hard regexp…

 C-g ‹Back    C-q Dismiss   
";

#[test]
fn the_dired_menu_shows_as_in_emacs() {
    let (mut ed, _s, _dir) = setup();
    ed.call("casual-dired-tmenu", vec![]).unwrap();
    assert_eq!(menu(&ed).as_deref(), Some(MAIN));
    // The menu's window is below, as tall as the menu; the Dired window stays selected.
    assert!(ed.buffer().name.contains("tmp") || ed.buffer().name.ends_with('/'), "{}", ed.buffer().name);
}

#[test]
fn a_sub_menu_goes_back_with_c_g_and_c_q_leaves_them_all() {
    let (mut ed, _s, _dir) = setup();
    ed.call("casual-dired-tmenu", vec![]).unwrap();
    ed.press("l").unwrap();
    assert_eq!(menu(&ed).as_deref(), Some(LINK));
    ed.press("C-g").unwrap();
    assert_eq!(menu(&ed).as_deref(), Some(MAIN));
    ed.press("l C-q").unwrap();
    assert_eq!(menu(&ed), None);
    // The keys are Dired's again.
    ed.press("n").unwrap();
    assert_eq!(ed.echo(), None);
}

#[test]
fn a_suffix_that_stays_runs_and_the_menu_shows_its_effect() {
    let (mut ed, s, _dir) = setup();
    ed.call("casual-dired-tmenu", vec![]).unwrap();
    // m marks the file and stays; RET... the description of h follows the mode.
    ed.press("n m").unwrap();
    let marked = s.eval_expression(&mut ed, "ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax())").unwrap();
    assert!(marked.contains("\\n* "), "{marked}");
    ed.press("h").unwrap();
    assert!(menu(&ed).unwrap().contains(" h [x] Hide Details"));
    ed.press("C-g").unwrap();
    assert_eq!(menu(&ed), None);
}

#[test]
fn a_key_no_suffix_has_is_refused() {
    let (mut ed, _s, _dir) = setup();
    ed.call("casual-dired-tmenu", vec![]).unwrap();
    ed.press("z").unwrap();
    assert_eq!(ed.echo(), Some("Unbound suffix: `z' (Use `C-g' to abort, `?' for help)"));
    assert_eq!(menu(&ed).as_deref(), Some(MAIN));
}

#[test]
fn switches_and_options_are_the_arguments_a_suffix_reads() {
    let (mut ed, s, _dir) = setup();
    let pkgs = tempfile::tempdir().unwrap();
    std::fs::write(
        pkgs.path().join("args-menu.ts"),
        r#"
        import { transientArgs, transientDefinePrefix } from "transient";
        const show = ember.defineCommand({ name: "show-args", run: () => ember.message(JSON.stringify(transientArgs("args-menu"))) });
        transientDefinePrefix("args-menu", {
          value: ["--all"],
          groups: [{ description: "Arguments", items: [["-a", "All", "--all"], ["-v", "Verbose", "--verbose"], ["=a", "Author", "--author="]] },
                   { description: "Actions", items: [["s", "Show", show]] }],
        });
        "#,
    )
    .unwrap();
    ed.set_variable("load-path", Value::List(vec![Value::Str(pkgs.path().display().to_string())]));
    s.eval_expression(&mut ed, r#"ember.require("args-menu")"#).unwrap();
    ed.call("args-menu", vec![]).unwrap();
    assert_eq!(
        menu(&ed).as_deref(),
        Some("Arguments\n -a All (--all)\n -v Verbose (--verbose)\n =a Author (--author=)\n\nActions\n s Show\n")
    );
    ed.press("- v - a = a M i n a RET s").unwrap();
    assert_eq!(ed.echo(), Some(r#"["--verbose","--author=Mina"]"#));
    assert_eq!(menu(&ed), None);
}
