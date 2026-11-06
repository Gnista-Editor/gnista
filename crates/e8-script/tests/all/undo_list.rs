//! Undo from scripts, as Emacs Lisp sees it: text property changes recorded
//! and undone, with-silent-modifications, `buffer-undo-list` bound to t and
//! read and set, and an `(apply ...)` entry pushed onto it.

use e8_core::Editor;
use e8_script::Scripting;

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
    eval(&mut ed, &s, "e8.setBufferModified(false)");
    eval(&mut ed, &s, "e8.putTextProperty(0, 5, 'face', 'bold')");
    assert_eq!(eval(&mut ed, &s, "e8.bufferModified()"), "true", "as put-text-property modifies the buffer");
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.getTextProperty(2, 'face') === undefined"), "true");
    assert_eq!(eval(&mut ed, &s, "e8.bufferModified()"), "false");
}

#[test]
fn silent_modifications_leave_no_undo_and_no_change() {
    let (mut ed, s) = setup();
    eval(&mut ed, &s, "e8.setBufferModified(false)");
    let before = eval(&mut ed, &s, "JSON.stringify(e8.variable('buffer-undo-list'))");
    eval(&mut ed, &s, "e8.withSilentModifications(() => e8.putTextProperty(0, 5, 'face', 'bold'))");
    assert_eq!(eval(&mut ed, &s, "e8.bufferModified()"), "false");
    assert_eq!(eval(&mut ed, &s, "JSON.stringify(e8.variable('buffer-undo-list'))"), before);
    assert_eq!(eval(&mut ed, &s, "e8.getTextProperty(2, 'face')"), "\"bold\"");
}

#[test]
fn binding_buffer_undo_list_to_t_keeps_changes_out_of_the_history() {
    let (mut ed, s) = setup();
    ed.press("C-e").unwrap();
    ed.type_text("!");
    // After the change recorded, so its position still holds.
    eval(&mut ed, &s, "e8.letBind({ 'buffer-undo-list': true }, () => e8.insert(' <<'))");
    // The insertion is not in the history: undo takes back the "!" typed before.
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferText(0, e8.bufferSize())"), "\"hello world <<\"");
}

#[test]
fn an_apply_entry_pushed_onto_the_list_runs_when_undone() {
    let (mut ed, s) = setup();

    eval(
        &mut ed,
        &s,
        r#"(() => {
            const old = e8.variable('buffer-undo-list');
            e8.setVariable('buffer-undo-list', [[Symbol.for('apply'), (n) => e8.setDefault('undone', n), 3], ...old]);
        })()"#,
    );
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.variable('undone')"), "3");
}

#[test]
fn fontifying_between_keys_leaves_typing_one_undo_step() {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    // A jit-lock function that styles text, as a mode's font-lock does.
    eval(&mut ed, &s, "e8.addHook('jit-lock-functions', (start, end) => e8.putTextProperty(start, end, 'face', 'bold'), { local: true })");
    for c in ["a", "b", "c"] {
        ed.type_text(c);
        ed.redisplay();
    }
    ed.press("C-/").unwrap();
    assert_eq!(eval(&mut ed, &s, "e8.bufferText(0, e8.bufferSize())"), "\"\"", "typing amalgamates, as Emacs's does");
}

/// An undo list set from code whose positions no longer fit the buffer is
/// refused, as undo in a region refuses changes outside it, rather than
/// taking out text that is not there.
#[test]
fn an_undo_list_that_no_longer_fits_is_refused() {
    let (mut ed, s) = setup();
    // Text "x" deleted at a position far past the buffer's end.
    eval(&mut ed, &s, r#"e8.setVariable("buffer-undo-list", [["x", 1000000], null])"#);
    ed.press("C-/").unwrap();
    let error = ed.take_error().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("outside visible portion"), "{error}");
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "hello world");
}
