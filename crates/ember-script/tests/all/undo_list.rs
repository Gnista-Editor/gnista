//! Undo from scripts, as Emacs Lisp sees it: text property changes recorded
//! and undone, with-silent-modifications, `buffer-undo-list` bound to t and
//! read and set, and an `(apply ...)` entry pushed onto it.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    ed.type_text("hello world");
    ed.press("C-a").unwrap();
    (ed, s)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap()
}

#[test]
fn a_property_put_by_a_script_is_undone() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, "ember.setBufferModified(false)");
    eval(&mut ed, &s, "ember.putTextProperty(0, 5, 'face', 'bold')");
    assert_eq!(eval(&mut ed, &s, "ember.bufferModified()"), "true", "as put-text-property modifies the buffer");
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "ember.getTextProperty(2, 'face') === undefined"), "true");
    assert_eq!(eval(&mut ed, &s, "ember.bufferModified()"), "false");
}

#[test]
fn silent_modifications_leave_no_undo_and_no_change() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, "ember.setBufferModified(false)");
    let before = eval(&mut ed, &s, "JSON.stringify(ember.variable('buffer-undo-list'))");
    eval(&mut ed, &s, "ember.withSilentModifications(() => ember.putTextProperty(0, 5, 'face', 'bold'))");
    assert_eq!(eval(&mut ed, &s, "ember.bufferModified()"), "false");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(ember.variable('buffer-undo-list'))"), before);
    assert_eq!(eval(&mut ed, &s, "ember.getTextProperty(2, 'face')"), "\"bold\"");
}

#[test]
fn binding_buffer_undo_list_to_t_keeps_changes_out_of_the_history() {
    let (mut ed, s) = setup();
    ed.press("C-e").unwrap();
    ed.type_text("!");
    // After the change recorded, so its position still holds.
    eval(&mut ed, &s, "ember.letBind({ 'buffer-undo-list': true }, () => ember.insert(' <<'))");
    // The insertion is not in the history: undo takes back the "!" typed before.
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "ember.bufferText(0, ember.bufferSize())"), "\"hello world <<\"");
}

#[test]
fn an_apply_entry_pushed_onto_the_list_runs_when_undone() {
    let (mut ed, s) = setup();

    eval(
        &mut ed,
        &s,
        r#"(() => {
            const old = ember.variable('buffer-undo-list');
            ember.setVariable('buffer-undo-list', [[Symbol.for('apply'), (n) => ember.setDefault('undone', n), 3], ...old]);
        })()"#,
    );
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "ember.variable('undone')"), "3");
}

#[test]
fn fontifying_between_keys_leaves_typing_one_undo_step() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    // A jit-lock function that styles text, as a mode's font-lock does.
    eval(&mut ed, &s, "ember.addHook('jit-lock-functions', (start, end) => ember.putTextProperty(start, end, 'face', 'bold'), { local: true })");
    for c in ["a", "b", "c"] {
        ed.type_text(c);
        ed.redisplay();
    }
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "ember.bufferText(0, ember.bufferSize())"), "\"\"", "typing amalgamates, as Emacs's does");
}

/// An undo list set from code whose positions no longer fit the buffer is
/// refused, as undo in a region refuses changes outside it, rather than
/// taking out text that is not there.
#[test]
fn an_undo_list_that_no_longer_fits_is_refused() {
    let (mut ed, s) = setup();
    // Text "x" deleted at a position far past the buffer's end.
    eval(&mut ed, &s, r#"ember.setVariable("buffer-undo-list", [["x", 1000000], null])"#);
    ed.press("C-/").unwrap();
    let error = ed.take_error().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("outside visible portion"), "{error}");
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "hello world");
}
