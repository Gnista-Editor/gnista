//! The undo history as Emacs's `buffer-undo-list`: text property changes
//! recorded and undone, the list read and set, t to stop recording and back
//! again, and `(apply ...)` entries called by undo.

use ember_core::{Editor, Function, Value};

fn list(ed: &Editor) -> Value {
    ed.variable("buffer-undo-list").unwrap()
}

fn num(n: usize) -> Value {
    Value::Number(n as f64)
}

#[test]
fn a_property_change_is_undone_and_redone() {
    let mut ed = Editor::new();
    ed.type_text("hello world");
    ed.buffer_mut().undo_boundary();
    ed.buffer_mut().set_modified(false);
    ed.buffer_mut().change_text_property(0..5, "face", Some(Value::Str("bold".into())));
    assert!(ed.buffer().is_modified(), "a property change modifies the buffer, as in Emacs");
    // Recorded as (nil PROP OLDVAL BEG . END).
    let Value::List(entries) = list(&ed) else { panic!() };
    assert_eq!(entries[0], Value::List(vec![Value::Null, Value::Str("face".into()), Value::Null, num(0), num(5)]));
    ed.press("C-/").unwrap();
    assert_eq!(ed.buffer().text_property(2, "face"), None);
    assert!(!ed.buffer().is_modified(), "undone back to the saved state");
    // Undoing the undo puts the face back.
    ed.press("C-f C-/").unwrap();
    assert_eq!(ed.buffer().text_property(2, "face"), Some(&Value::Str("bold".into())));
    // Setting the value it has already changes nothing and records nothing.
    ed.buffer_mut().undo_boundary();
    let before = list(&ed);
    ed.buffer_mut().change_text_property(0..5, "face", Some(Value::Str("bold".into())));
    assert_eq!(list(&ed), before);
}

#[test]
fn undo_in_the_region_takes_back_property_changes_inside_it() {
    let mut ed = Editor::new();
    ed.type_text("one two three");
    ed.buffer_mut().undo_boundary();
    ed.buffer_mut().change_text_property(0..3, "face", Some(Value::Str("bold".into())));
    ed.buffer_mut().undo_boundary();
    ed.buffer_mut().change_text_property(8..13, "face", Some(Value::Str("italic".into())));
    ed.buffer_mut().undo_boundary();
    // The region over "one": only its change is undone.
    ed.press("M-< C-SPC C-f C-f C-f C-/").unwrap();
    assert_eq!(ed.buffer().text_property(1, "face"), None);
    assert_eq!(ed.buffer().text_property(9, "face"), Some(&Value::Str("italic".into())));
}

#[test]
fn binding_the_list_to_t_stops_recording_and_keeps_the_history() {
    let mut ed = Editor::new();
    ed.type_text("abc");
    ed.buffer_mut().undo_boundary();
    let before = list(&ed);
    ed.set_variable("buffer-undo-list", Value::Bool(true));
    assert_eq!(list(&ed), Value::Bool(true));
    ed.type_text("XYZ");
    // Set back, as a let does, the history is as it was: undo takes "abc" out.
    ed.set_variable("buffer-undo-list", before.clone());
    assert_eq!(list(&ed), before);
    ed.press("C-/").unwrap();
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "XYZ");
}

#[test]
fn a_list_set_becomes_the_history() {
    let mut ed = Editor::new();
    ed.type_text("hello");
    // As if "llo" was typed after "he", and before that nothing.
    ed.set_variable("buffer-undo-list", Value::List(vec![Value::List(vec![num(2), num(5)]), Value::Null]));
    ed.press("C-/").unwrap();
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "he");
    // A deletion: undoing puts "XY" back at 1, point after it for a negative position.
    ed.set_variable(
        "buffer-undo-list",
        Value::List(vec![Value::List(vec![Value::Str("XY".into()), Value::Number(-1.0)]), Value::Null]),
    );
    ed.press("C-g C-/").unwrap();
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "hXYe");
    assert_eq!(ed.buffer().point(), 3);
    // nil empties it.
    ed.set_variable("buffer-undo-list", Value::Null);
    assert_eq!(list(&ed), Value::List(vec![]));
}

#[test]
fn undo_calls_the_function_of_an_apply_entry() {
    let mut ed = Editor::new();
    ed.type_text("x");
    let f = Function::new(Some("note-undo"), |ed, args| {
        let n = args.first().and_then(|v| v.as_number()).unwrap_or(0.0);
        ed.set_variable("undone-with", Value::Number(n));
        Ok(Value::Null)
    });
    ed.set_variable(
        "buffer-undo-list",
        Value::List(vec![Value::List(vec![Value::Symbol("apply".into()), Value::Function(f), Value::Number(7.0)]), Value::Null]),
    );
    ed.press("C-/").unwrap();
    assert_eq!(ed.variable("undone-with"), Some(Value::Number(7.0)));
}

/// Changing case where it changes length, as ß to SS, right after an
/// insertion in the same command leaves that insertion's undo as it was:
/// undoing the command gives back the text before it.
#[test]
fn changing_case_after_an_insertion_undoes_cleanly() {
    let mut ed = ember_core::Editor::new();
    ed.type_text("aßb");
    ed.press("C-a").unwrap();
    ed.press("C-f").unwrap();
    ed.define_command(ember_core::Command::new("insert-then-upcase", "Inserts x and upcases the character after it.", |ed, _| {
        ed.insert("x")?;
        let p = ed.buffer().point();
        ed.casify_region(ember_core::casefiddle::Case::Up, p, p + 1).map(drop)
    }));
    ed.call("insert-then-upcase", vec![]).unwrap();
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "axSSb");
    ed.press("C-/").unwrap();
    assert_eq!(ed.buffer().slice(0..ed.buffer().len()), "aßb");
}

/// Undoing a kill of a whole fontified buffer puts every run of faces back
/// in one pass over the runs there, rather than one rebuild of all the
/// buffer's runs for each run saved: 100,000 runs come back at once.
#[test]
fn undoing_a_kill_of_many_property_runs_is_quick() {
    let mut ed = Editor::new();
    let line = "* heading :tag:\n";
    ed.buffer_mut().set_text(&line.repeat(50_000));
    for i in 0..50_000 {
        let start = i * line.len();
        ed.buffer_mut().put_text_property(start..start + 9, "face", Value::Str("bold".into()));
        ed.buffer_mut().put_text_property(start + 10..start + 15, "face", Value::Str("italic".into()));
    }
    let len = ed.buffer().len();
    let started = std::time::Instant::now();
    ed.delete_region(0, len).unwrap();
    ed.buffer_mut().undo_boundary();
    ed.call("undo", vec![]).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    assert_eq!(ed.buffer().len(), len);
    assert_eq!(ed.buffer().text_property(line.len() * 49_999 + 11, "face"), Some(&Value::Str("italic".into())));
}

/// Output inserted a piece at a time joins one insertion for undo, and
/// counts each piece as it joins rather than the whole run again, as
/// `cat` of a large file in a shell buffer inserts it.
#[test]
fn insertions_joining_one_run_are_counted_once() {
    let mut ed = Editor::new();
    let started = std::time::Instant::now();
    for _ in 0..300_000 {
        ed.insert("line é\n").unwrap();
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    ed.buffer_mut().undo_boundary();
    ed.call("undo", vec![]).unwrap();
    assert_eq!(ed.buffer().len(), 0, "one undo takes the run back");
}

/// Binding `buffer-undo-list`, as `(let ((buffer-undo-list t)) ...)` does,
/// keeps the history aside rather than copying it out and comparing it back:
/// with 20,000 steps, 2,000 bindings are quick, and the history comes back
/// as it was, edits made while it was t forgotten.
#[test]
fn binding_the_undo_list_keeps_the_history_as_it_is() {
    let mut ed = Editor::new();
    for i in 0..20_000 {
        ed.insert(&format!("{i} ")).unwrap();
        ed.buffer_mut().undo_boundary();
    }
    let before = ed.variable("buffer-undo-list");
    let started = std::time::Instant::now();
    for _ in 0..2_000 {
        let id = ed.specbind("buffer-undo-list", Value::Bool(true));
        ed.insert("x").unwrap();
        ed.unbind(id);
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    assert_eq!(ed.variable("buffer-undo-list"), before);
    // Bound to nil, recording starts afresh, and the history comes back after.
    let id = ed.specbind("buffer-undo-list", Value::Null);
    ed.insert("y").unwrap();
    assert_ne!(ed.variable("buffer-undo-list"), before);
    ed.unbind(id);
    assert_eq!(ed.variable("buffer-undo-list"), before);
}
