//! Keymaps as values, as Emacs has them: a prefix map is shared wherever
//! it is bound, a keymap's name is a variable holding it, text can carry
//! a keymap of its own, and a child's prefix maps merge with its parent's.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    s.eval_typescript(
        &mut ed,
        "test.ts",
        r#"
        globalThis.seen = [];
        for (const name of ["one", "two", "three"]) {
          ember.defineCommand({ name: `test-${name}`, run: () => { seen.push(name); } });
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
        r#"(globalThis.prefix = ember.defineKeymap("test-prefix-map"),
            ember.bindKey("C-c t", prefix),
            ember.bindKey("<f5>", prefix),
            ember.bindKey("1", "test-one", prefix), 0)"#,
    );
    ed.press("C-c t 1 <f5> 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "one one");
    // Bound later, a key shows under both prefixes, as one keymap.
    eval(&mut ed, &s, r#"(ember.defineKey("test-prefix-map", "2", "test-two"), 0)"#);
    ed.press("C-c t 2 <f5> 2").unwrap();
    assert_eq!(seen(&mut ed, &s), "two two");
    assert_eq!(eval(&mut ed, &s, r#"ember.lookupKey("global-map", "C-c t") === prefix"#), "true");
    assert_eq!(eval(&mut ed, &s, r#"ember.lookupKey("global-map", "<f5> 2")"#), "test-two");
    // The name is a variable holding the keymap, and defining it again keeps it.
    assert_eq!(eval(&mut ed, &s, r#"ember.variable("test-prefix-map") === prefix && ember.defineKeymap("test-prefix-map") === prefix"#), "true");
    assert_eq!(eval(&mut ed, &s, "ember.keymapp(prefix) && !ember.keymapp('test-prefix-map')"), "true");
}

#[test]
fn a_child_merges_its_parent_s_prefix_maps_and_unbinding_shows_the_parent_s() {
    let (mut ed, s) = setup();
    eval(
        &mut ed,
        &s,
        r#"(globalThis.parent = ember.makeSparseKeymap(),
            globalThis.child = ember.makeSparseKeymap(parent),
            ember.defineKey(child, "C-c 1", "test-one"),
            ember.defineKey(parent, "C-c 2", "test-two"),
            ember.defineKey(parent, "C-c 1", "test-three"),
            ember.useLocalMap(child), 0)"#,
    );
    ed.press("C-c 1 C-c 2").unwrap();
    assert_eq!(seen(&mut ed, &s), "one two");
    eval(&mut ed, &s, r#"(ember.defineKey(child, "C-c 1", null), 0)"#);
    ed.press("C-c 1").unwrap();
    assert_eq!(seen(&mut ed, &s), "three");
    assert_eq!(eval(&mut ed, &s, "ember.keymapParent(child) === parent"), "true");
    eval(&mut ed, &s, "(ember.setKeymapParent(child, null), 0)");
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
        r#"(globalThis.button = ember.makeSparseKeymap(),
            ember.defineKey(button, "RET", "test-one"),
            ember.insert("see [here] now"),
            ember.putTextProperty(4, 10, "keymap", button), 0)"#,
    );
    ed.window_buffer_mut().set_point(5);
    ed.press("RET").unwrap();
    assert_eq!(seen(&mut ed, &s), "one");
    assert_eq!(eval(&mut ed, &s, "ember.currentActiveMaps()[0] === button"), "true");
    // Elsewhere RET is a newline.
    ed.window_buffer_mut().set_point(0);
    ed.press("RET").unwrap();
    assert_eq!(seen(&mut ed, &s), "");
    assert!(ed.window_buffer().slice(0..1) == "\n");
}

#[test]
fn a_transient_map_can_be_a_keymap_or_bindings() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, r#"(globalThis.once = ember.makeSparseKeymap(), ember.defineKey(once, "x", "test-three"), ember.setTransientMap(once), 0)"#);
    ed.press("x x").unwrap();
    assert_eq!(seen(&mut ed, &s), "three");
    eval(&mut ed, &s, r#"(ember.setTransientMap({ y: "test-two" }), 0)"#);
    ed.press("y").unwrap();
    assert_eq!(seen(&mut ed, &s), "two");
    // An overriding map is a keymap too, by name or as itself.
    eval(&mut ed, &s, r#"(ember.setOverridingMap(once), 0)"#);
    assert_eq!(eval(&mut ed, &s, "ember.overridingMap() === once"), "true");
    ed.press("x").unwrap();
    eval(&mut ed, &s, r#"(ember.setOverridingMap(null), 0)"#);
    assert_eq!(seen(&mut ed, &s), "three");
}

#[test]
fn emacs_s_prefix_maps_have_their_names() {
    let (mut ed, s) = setup();
    for (name, keys) in [("ctl-x-map", "C-x"), ("ctl-x-4-map", "C-x 4"), ("ctl-x-5-map", "C-x 5"), ("narrow-map", "C-x n"), ("project-prefix-map", "C-x p")] {
        assert_eq!(eval(&mut ed, &s, &format!(r#"ember.lookupKey("global-map", "{keys}") === ember.variable("{name}")"#)), "true", "{name}");
    }
    // Binding in one binds under its prefix, as (define-key ctl-x-4-map ...) does.
    eval(&mut ed, &s, r#"(ember.defineKey("ctl-x-4-map", "t", "test-one"), 0)"#);
    ed.press("C-x 4 t").unwrap();
    assert_eq!(seen(&mut ed, &s), "one");
    assert_eq!(eval(&mut ed, &s, r#"ember.lookupKey("project-prefix-map", "f")"#), "project-find-file");
}
