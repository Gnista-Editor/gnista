//! org-roam, a package that does not ship with Ember
//! (examples/packages/org-roam.ts), and org-id, which does: notes found by
//! their titles, linked by ID, captured, and their backlinks shown.

use std::path::Path;

use crate::driven::Driven;
use ember_core::Value;

const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/packages");

const ALPHA: &str = ":PROPERTIES:\n:ID:       alpha-id\n:END:\n#+title: Alpha\n#+filetags: :one:\n\nAlpha mentions [[id:beta-id][Beta]] here.\n";
const BETA: &str = "#+title: Notes\n\n* Beta\n:PROPERTIES:\n:ID:       beta-id\n:ROAM_ALIASES: \"Second letter\"\n:END:\nBeta's text.\n* Not a node\n";

fn setup(dir: &Path) -> Driven {
    std::fs::write(dir.join("alpha.org"), ALPHA).unwrap();
    std::fs::write(dir.join("beta.org"), BETA).unwrap();
    let d = Driven::new("");
    let roam = format!("{}/", dir.canonicalize().unwrap().display());
    let db = format!("{}/.cache.json", dir.canonicalize().unwrap().display());
    d.with(move |ed| {
        ed.set_frame_size(120, 40);
        ed.set_variable("load-path", Value::List(vec![Value::Str(EXAMPLES.into())]));
        ed.set_variable("org-roam-directory", Value::Str(roam));
        ed.set_variable("org-roam-db-location", Value::Str(db));
    });
    d.eval(r#"ember.require("vertico"); ember.call("vertico-mode"); ember.require("org-roam"); ember.call("org-roam-db-autosync-mode");"#);
    d
}

fn text(d: &Driven) -> String {
    d.with(|ed| {
        let b = ed.buffer();
        b.slice(0..b.len())
    })
}

#[test]
fn node_find_visits_a_node_by_title_or_alias() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    d.start(|ed| ed.call("org-roam-node-find", vec![]).unwrap());
    let shown = d.with(|ed| ed.minibuffer_strings().1);
    assert!(shown.contains("Alpha") && shown.contains("Beta") && shown.contains("Second letter") && !shown.contains("Not a node"), "{shown:?}");
    d.press("S e c o n d RET");
    let (name, line) = d.with(|ed| (ed.buffer().name.clone(), ed.buffer().line_of(ed.buffer().point())));
    assert_eq!((name.as_str(), line), ("beta.org", 2));
}

#[test]
fn node_find_of_a_new_title_captures_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    d.start(|ed| ed.call("org-roam-node-find", vec![]).unwrap());
    d.press("G a m m a SPC r a y M-RET");
    assert!(d.with(|ed| ed.variable("org-roam-capture-mode").is_some_and(|v| v.is_true())));
    let note = text(&d);
    assert!(note.starts_with(":PROPERTIES:\n:ID:       ") && note.ends_with(":END:\n#+title: Gamma ray\n"), "{note:?}");
    d.press("H i C-c C-c");
    let file = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).find(|f| f.ends_with("-gamma_ray.org")).expect("the note's file");
    let saved = std::fs::read_to_string(dir.path().join(&file)).unwrap();
    assert!(saved.ends_with("#+title: Gamma ray\nHi\n"), "{saved:?}");
    // The new node can be found at once.
    d.start(|ed| ed.call("org-roam-node-find", vec![]).unwrap());
    assert!(d.with(|ed| ed.minibuffer_strings().1).contains("Gamma ray"));
    d.press("C-g");
}

#[test]
fn node_insert_links_to_a_node() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    let alpha = format!("{}/alpha.org", dir.path().canonicalize().unwrap().display());
    d.with(move |ed| ed.call("find-file", vec![ember_core::Arg::Str(alpha)]).unwrap());
    d.eval("ember.gotoChar(ember.pointMax());");
    d.start(|ed| ed.call("org-roam-node-insert", vec![]).unwrap());
    d.press("B e t a RET");
    assert!(text(&d).ends_with("here.\n[[id:beta-id][Beta]]"), "{:?}", text(&d));
}

#[test]
fn the_buffer_shows_the_backlinks_and_id_links_are_followed() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    let beta = format!("{}/beta.org", dir.path().canonicalize().unwrap().display());
    d.with(move |ed| ed.call("find-file", vec![ember_core::Arg::Str(beta)]).unwrap());
    d.eval("ember.gotoChar(ember.lineStart(7));");
    d.with(|ed| ed.call("org-roam-buffer-toggle", vec![]).unwrap());
    let roam = d.with(|ed| {
        let b = &ed.buffers()[ed.find_buffer("*org-roam*").unwrap()];
        b.slice(0..b.len())
    });
    assert_eq!(roam, "Backlinks:\nAlpha (Top)\nAlpha mentions [[id:beta-id][Beta]] here.\n\n\n");
    // Following the link in Alpha comes back to Beta's heading.
    let alpha = format!("{}/alpha.org", dir.path().canonicalize().unwrap().display());
    d.with(move |ed| ed.call("find-file", vec![ember_core::Arg::Str(alpha)]).unwrap());
    d.eval(r#"ember.gotoChar(ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax()).indexOf("[[id:") + 3);"#);
    d.with(|ed| ed.call("org-open-at-point", vec![]).unwrap());
    let (name, line) = d.with(|ed| (ed.buffer().name.clone(), ed.buffer().line_of(ed.buffer().point())));
    assert_eq!((name.as_str(), line), ("beta.org", 2));
}

#[test]
fn org_id_get_create_gives_a_heading_or_a_file_an_id() {
    let d = Driven::new("");
    d.with(|ed| {
        ed.call("switch-to-buffer", vec![ember_core::Arg::Str("ids.org".into())]).unwrap();
        ed.insert("#+title: Ids\n* Heading\ntext\n").unwrap();
    });
    d.eval(r#"ember.call("org-mode"); ember.gotoChar(ember.lineStart(2));"#);
    d.with(|ed| ed.call("org-id-get-create", vec![]).unwrap());
    let t = text(&d);
    let re = regex_lite(&t);
    assert!(re, "{t:?}");
    d.eval("ember.gotoChar(0);");
    d.with(|ed| ed.call("org-id-get-create", vec![]).unwrap());
    let t = text(&d);
    assert!(t.starts_with(":PROPERTIES:\n:ID:       ") && t.contains(":END:\n#+title: Ids\n"), "{t:?}");
}

/// Whether the heading got a drawer with an ID of a UUID's shape, aligned as Org aligns it.
fn regex_lite(t: &str) -> bool {
    let Some(at) = t.find("* Heading\n:PROPERTIES:\n:ID:       ") else { return false };
    let id: String = t[at + "* Heading\n:PROPERTIES:\n:ID:       ".len()..].chars().take(36).collect();
    id.len() == 36 && id.chars().filter(|&c| c == '-').count() == 4 && t.contains(&format!("{id}\n:END:\ntext"))
}

#[test]
fn consult_org_roam_previews_nodes_and_lists_backlinks_and_notes() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    d.eval(r#"ember.require("consult-org-roam"); ember.call("consult-org-roam-mode");"#);
    let beta = format!("{}/beta.org", dir.path().canonicalize().unwrap().display());
    d.with(move |ed| ed.call("find-file", vec![ember_core::Arg::Str(beta)]).unwrap());
    d.eval("ember.gotoChar(ember.lineStart(7));");
    // The backlinks of Beta: Alpha.
    d.start(|ed| ed.call("consult-org-roam-backlinks", vec![]).unwrap());
    assert_eq!(d.with(|ed| ed.minibuffer_strings().1), " \nAlpha\n");
    d.press("RET");
    assert_eq!(d.with(|ed| ed.buffer().name.clone()), "alpha.org");
    // The forward links of Alpha: Beta.
    d.start(|ed| ed.call("consult-org-roam-forward-links", vec![]).unwrap());
    assert_eq!(d.with(|ed| ed.minibuffer_strings().1), " \nBeta\nSecond letter\n");
    d.press("C-g");
    // consult-buffer lists the notes open by title, in their own group.
    d.start(|ed| ed.call("consult-buffer", vec![]).unwrap());
    let shown = d.with(|ed| ed.minibuffer_strings().1);
    assert!(shown.contains("Org-roam") && shown.contains("\nAlpha\n") && shown.contains("\nNotes\n"), "{shown:?}");
    d.press("C-g");
}

#[test]
fn org_capture_still_finishes_and_aborts_its_own_captures() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    let inbox = dir.path().join("inbox.org");
    std::fs::write(&inbox, "* Inbox\n").unwrap();
    d.eval(&format!(r#"ember.setVariable("org-capture-templates", [["t", "Todo", "entry", ["file", {:?}], "* TODO %?"]]);"#, inbox.display().to_string()));
    d.press("M-x");
    d.type_text("org-capture");
    d.press("RET t");
    d.type_text("Kept");
    d.press("C-c C-c");
    assert_eq!(std::fs::read_to_string(&inbox).unwrap(), "* Inbox\n* TODO Kept\n");
    d.press("M-x");
    d.type_text("org-capture");
    d.press("RET t");
    d.type_text("Dropped");
    d.press("C-c C-k");
    let left = d.eval_expression(r#"ember.withCurrentBuffer(ember.getBuffer("inbox.org")!, () => ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax()))"#);
    assert_eq!(left, r#""* Inbox\n* TODO Kept\n""#);
}

#[test]
fn node_find_with_consult_org_roam_visits_a_heading_node() {
    let dir = tempfile::tempdir().unwrap();
    let d = setup(dir.path());
    d.eval(r#"ember.require("consult"); ember.require("consult-org-roam"); ember.call("consult-org-roam-mode");"#);
    let path = dir.path().canonicalize().unwrap().display().to_string();
    d.eval(&format!("ember.call(\"dired\", {path:?});"));
    d.start(|ed| ed.call("org-roam-node-find", vec![]).unwrap());
    d.type_text("Beta");
    d.press("RET");
    let (name, line, echo) = d.with(|ed| (ed.buffer().name.clone(), ed.buffer().line_of(ed.buffer().point()), ed.echo().map(str::to_string)));
    assert_eq!((name.as_str(), line, echo), ("beta.org", 2, None));
}
