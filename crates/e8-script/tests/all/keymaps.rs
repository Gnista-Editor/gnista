//! Keymaps as values, as Emacs has them: a prefix map is shared wherever
//! it is bound, a keymap's name is a variable holding it, text can carry
//! a keymap of its own, and a child's prefix maps merge with its parent's.

use e8_core::Editor;
use e8_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        for (const name of ["one", "two", "three"]) {
          e8.defineCommand({ name: `test-${name}`, run: () => { seen.push(name); } });
        }
        "#
        .to_string(),
    )
    .unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    let json = s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"));
    serde_json::from_str::<String>(&json).unwrap_or(json)
}

fn seen(ed: &mut Editor, s: &Scripting) -> String {
    eval(ed, s, "seen.splice(0).join(' ')")
}

#[test]
fn a_prefix_map_is_shared_wherever_it_is_bound() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.prefix = e8.defineKeymap("test-prefix-map"),
            e8.bindKey("C-c t", prefix),
            e8.bindKey("<f5>", prefix),
            e8.bindKey("1", "test-one", prefix), 0)"#,
    );
    ed.press("C-c t 1 <f5> 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "one one");
    // Bound later, a key shows under both prefixes, as one keymap.
    eval(&mut ed, &s, r#"(e8.defineKey("test-prefix-map", "2", "test-two"), 0)"#);
    ed.press("C-c t 2 <f5> 2").unwrap();
    assert_eq!(seen(&mut ed, &s), "two two");
    assert_eq!(eval(&mut ed, &s, r#"e8.lookupKey("global-map", "C-c t") === prefix"#), "true");
    assert_eq!(eval(&mut ed, &s, r#"e8.lookupKey("global-map", "<f5> 2")"#), "test-two");
    // The name is a variable holding the keymap, and defining it again keeps it.
    assert_eq!(eval(&mut ed, &s, r#"e8.variable("test-prefix-map") === prefix && e8.defineKeymap("test-prefix-map") === prefix"#), "true");
    assert_eq!(eval(&mut ed, &s, "e8.keymapp(prefix) && !e8.keymapp('test-prefix-map')"), "true");
}

#[test]
fn a_child_merges_its_parent_s_prefix_maps_and_nil_hides_the_parent_s() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.parent = e8.makeSparseKeymap(),
            globalThis.child = e8.makeSparseKeymap(parent),
            e8.defineKey(child, "C-c 1", "test-one"),
            e8.defineKey(parent, "C-c 2", "test-two"),
            e8.defineKey(parent, "C-c 1", "test-three"),
            e8.useLocalMap(child), 0)"#,
    );
    ed.press("C-c 1 C-c 2").unwrap();
    assert_eq!(seen(&mut ed, &s), "one two");
    // Nil hides the parent's binding, as (define-key map key nil); taken
    // out, the parent's shows.
    eval(&mut ed, &s, r#"(e8.defineKey(child, "C-c 1", null), 0)"#);
    ed.press("C-c 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "");
    eval(&mut ed, &s, r#"(e8.keymapUnset(child, "C-c 1", true), 0)"#);
    ed.press("C-c 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "three");
    assert_eq!(eval(&mut ed, &s, "e8.keymapParent(child) === parent"), "true");
    eval(&mut ed, &s, "(e8.setKeymapParent(child, null), 0)");
    ed.press("C-c 2").unwrap();
    assert_eq!(ed.echo(), Some("C-c 2 is undefined"));
}

#[test]
fn text_carries_a_keymap_of_its_own() {
    let (mut ed, s) = setup();
    // A button's map, as Emacs's buttons make one with make-sparse-keymap.
    eval(
        &mut ed,
        &s,
        r#"(globalThis.button = e8.makeSparseKeymap(),
            e8.defineKey(button, "RET", "test-one"),
            e8.insert("see [here] now"),
            e8.putTextProperty(4, 10, "keymap", button), 0)"#,
    );
    ed.window_buffer_mut().set_point(5);
    ed.press("RET").unwrap();
    assert_eq!(seen(&mut ed, &s), "one");
    assert_eq!(eval(&mut ed, &s, "e8.currentActiveMaps()[0] === button"), "true");
    // Elsewhere RET is a newline.
    ed.window_buffer_mut().set_point(0);
    ed.press("RET").unwrap();
    assert_eq!(seen(&mut ed, &s), "");
    assert!(ed.window_buffer().slice(0..1) == "\n");
}

#[test]
fn a_transient_map_can_be_a_keymap_or_bindings() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.once = e8.makeSparseKeymap(), e8.defineKey(once, "x", "test-three"), e8.setTransientMap(once), 0)"#);
    ed.press("x x").unwrap();
    assert_eq!(seen(&mut ed, &s), "three");
    eval(&mut ed, &s, r#"(e8.setTransientMap({ y: "test-two" }), 0)"#);
    ed.press("y").unwrap();
    assert_eq!(seen(&mut ed, &s), "two");
    // An overriding map is a keymap too, by name or as itself.
    eval(&mut ed, &s, r#"(e8.setOverridingMap(once), 0)"#);
    assert_eq!(eval(&mut ed, &s, "e8.overridingMap() === once"), "true");
    ed.press("x").unwrap();
    eval(&mut ed, &s, r#"(e8.setOverridingMap(null), 0)"#);
    assert_eq!(seen(&mut ed, &s), "three");
}

#[test]
fn emacs_s_prefix_maps_have_their_names() {
    let (mut ed, s) = setup();
    for (name, keys) in [("ctl-x-map", "C-x"), ("ctl-x-4-map", "C-x 4"), ("ctl-x-5-map", "C-x 5"), ("narrow-map", "C-x n"), ("project-prefix-map", "C-x p")] {
        assert_eq!(eval(&mut ed, &s, &format!(r#"e8.lookupKey("global-map", "{keys}") === e8.variable("{name}")"#)), "true", "{name}");
    }
    // Binding in one binds under its prefix, as (define-key ctl-x-4-map ...) does.
    eval(&mut ed, &s, r#"(e8.defineKey("ctl-x-4-map", "t", "test-one"), 0)"#);
    ed.press("C-x 4 t").unwrap();
    assert_eq!(seen(&mut ed, &s), "one");
    assert_eq!(eval(&mut ed, &s, r#"e8.lookupKey("project-prefix-map", "f")"#), "project-find-file");
}
