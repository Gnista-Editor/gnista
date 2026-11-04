//! Choosing by a key from a menu, as Org's capture and agenda do: the menu
//! shows while it waits for the key.

use crate::driven::Driven;

#[test]
fn capture_lists_its_templates_in_org_select() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let d = Driven::new(&format!(
        r#"gnista.setVariable("org-capture-templates", [["t", "Todo", "entry", ["file", {:?}], "* TODO %?"], ["w", "Work"], ["wm", "Meeting", "entry", ["file", {:?}], "* %?"]]);"#,
        dir.path().join("todo.org").display().to_string(),
        dir.path().join("work.org").display().to_string()
    ));
    d.with(|ed| ed.set_frame_size(80, 24));
    d.press("M-x o r g - c a p t u r e RET");
    let menu = d.with(|ed| ed.buffers().iter().find(|b| b.name == "*Org Select*").map(|b| b.slice(0..b.len())));
    assert_eq!(
        menu.as_deref(),
        Some(
            "Select a capture template\n=========================\n\n[t]     Todo\n[w]...  Work...\n-------------------------------------------------------------------------------\n[C]     Customize org-capture-templates\n[q]     Abort\n"
        )
    );
    // A prefix shows what is under it.
    d.press("w");
    let menu = d.with(|ed| ed.buffers().iter().find(|b| b.name == "*Org Select*").map(|b| b.slice(0..b.len())));
    assert!(menu.as_deref().is_some_and(|m| m.contains("w [m]     Meeting\n")), "{menu:?}");
    d.press("m");
    assert_eq!(d.text(), "* \n");
    assert!(d.with(|ed| !ed.buffers().iter().any(|b| b.name == "*Org Select*")));
    d.press("C-c C-k");
    // q aborts.
    d.press("M-x o r g - c a p t u r e RET q");
    assert_eq!(d.message().as_deref(), Some("Abort"));
}

#[test]
fn the_agenda_dispatcher_takes_a_key() {
    let d = Driven::new("");
    d.with(|ed| ed.set_frame_size(80, 24));
    d.press("M-x o r g - a g e n d a RET");
    let menu = d.with(|ed| ed.buffers().iter().find(|b| b.name == "*Agenda Commands*").map(|b| b.slice(0..b.len())));
    assert!(menu.as_deref().is_some_and(|m| m.starts_with("Press key for an agenda command:\n")), "{menu:?}");
    d.press("t");
    assert_eq!(d.buffer_name(), "*Org Agenda*");
}
