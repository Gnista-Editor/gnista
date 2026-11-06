//! Listing abbrevs as Emacs lists them, and editing them in *Abbrevs*.
//! Emacs's listing has every mode's table, so the Emacs comparison cannot
//! check it; the global table's text here is what Emacs 30.2 writes.

use e8_core::{Arg, Editor};
use e8_script::Scripting;

fn text_of(ed: &mut Editor, s: &Scripting, buffer: &str) -> String {
    let got = s.eval_expression(ed, &format!("e8.withCurrentBuffer({buffer:?}, () => e8.bufferText(0, e8.bufferSize()))")).unwrap();
    serde_json::from_str(&got).unwrap()
}

#[test]
fn list_abbrevs_writes_them_as_emacs_does_and_edits_come_back() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    for (name, expansion) in [("fb", "foobar"), ("longname", "x y z")] {
        ed.call("define-global-abbrev", vec![Arg::Str(name.into()), Arg::Str(expansion.into())]).unwrap();
    }
    ed.type_text("fb");
    ed.press("C-x '").unwrap();
    ed.call("list-abbrevs", vec![]).unwrap();
    let listed = text_of(&mut ed, &s, "*Abbrevs*");
    assert_eq!(listed, "(global-abbrev-table)\n\n\"fb\"\t       1    \"foobar\"\n\"longname\"     0    \"x y z\"\n\n\n");
    // Edited there, C-c C-c makes them the abbrevs.
    ed.call("switch-to-buffer", vec![Arg::Str("*Abbrevs*".into())]).unwrap();
    s.eval_expression(&mut ed, r#"e8.gotoChar(e8.search('"x y z"').start + 1)"#).unwrap();
    ed.press("C-d").unwrap();
    ed.type_text("w");
    ed.press("C-c C-c").unwrap();
    ed.call("switch-to-buffer", vec![Arg::Str("*scratch*".into())]).unwrap();
    ed.press("M->").unwrap();
    ed.type_text(" longname");
    ed.press("C-x '").unwrap();
    assert!(text_of(&mut ed, &s, "*scratch*").ends_with("w y z"));
}
