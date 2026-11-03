//! The file primitives scripts call: handlers in file-name-handler-alist,
//! lock files, and the predicates and names Emacs gives Lisp.

use crate::driven::Driven;
use ember_core::{Arg, Editor};
use ember_script::Scripting;

fn setup() -> (Editor, Scripting, tempfile::TempDir) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let cd = format!("(ember.makeLocalVariable(\"default-directory\"), ember.setVariable(\"default-directory\", {:?}))", format!("{}/", dir.path().display()));
    scripting.eval_expression(&mut ed, &cd).unwrap();
    (ed, scripting, dir)
}

fn eval(ed: &mut Editor, s: &Scripting, code: &str) -> String {
    s.eval_expression(ed, code).unwrap_or_else(|e| panic!("{code}: {e}"))
}

fn text(ed: &Editor) -> String {
    let b = ed.window_buffer();
    b.slice(0..b.len())
}

#[test]
fn a_handler_serves_names_of_its_own() {
    // A handler for /fake: names keeping files in memory, as TRAMP keeps
    // them on another machine; anything else it hands back to the real
    // operation, which it reaches by inhibiting itself.
    let (mut ed, s, _dir) = setup();
    s.eval_typescript(
        &mut ed,
        "handler.ts",
        r#"
        globalThis.store = new Map([["/fake:notes.txt", "remote text\n"]]);
        globalThis.seen = [];
        const handler = ember.defun("fake-file-handler", (op, ...args) => {
          const name = typeof op === "symbol" ? op.description : op;
          seen.push(name);
          switch (name) {
            case "file-exists-p": return store.has(args[0]);
            case "insert-file-contents": {
              const text = store.get(args[0]) ?? "";
              ember.insert(text);
              ember.gotoChar(ember.point() - text.length);
              return [args[0], text.length];
            }
            case "write-region": {
              store.set(args[2], ember.bufferSubstring(0, ember.bufferSize()).string);
              if (args[4] === true) ember.setBufferModified(false);
              return null;
            }
            default:
              return ember.letBind({ "inhibit-file-name-handlers": [handler], "inhibit-file-name-operation": name },
                () => ember.funcall(name, ...args));
          }
        });
        ember.setVariable("file-name-handler-alist", [["\\`/fake:", handler]]);
        "#
        .into(),
    )
    .unwrap();
    assert_eq!(eval(&mut ed, &s, r#"ember.fileExistsP("/fake:notes.txt")"#), "true");
    assert_eq!(eval(&mut ed, &s, r#"ember.fileExistsP("/fake:other.txt")"#), "false");
    ed.call("find-file", vec![Arg::Str("/fake:notes.txt".into())]).unwrap();
    assert_eq!(text(&ed), "remote text\n");
    assert!(!ed.window_buffer().is_modified());
    ed.type_text("more ");
    ed.call("save-buffer", vec![]).unwrap();
    assert_eq!(eval(&mut ed, &s, r#"store.get("/fake:notes.txt")"#), r#""more remote text\n""#);
    assert!(!ed.window_buffer().is_modified());
    assert_eq!(eval(&mut ed, &s, r#"ember.findFileNameHandler("/fake:x", "file-exists-p")"#), r#""fake-file-handler""#);
    assert_eq!(eval(&mut ed, &s, r#"ember.findFileNameHandler("/real/x", "file-exists-p") ?? "none""#), r#""none""#);
}

#[test]
fn a_lock_another_holds_is_asked_about() {
    // The question waits for its answer, so on the editor's own thread.
    let d = Driven::new("");
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    let lock = dir.path().join(".#a.txt");
    // Held by a process on another machine, which Ember cannot tell is gone.
    std::os::unix::fs::symlink("someone@elsewhere.1:0", &lock).unwrap();
    let visit = file.display().to_string();
    d.with(move |ed| ed.call("find-file", vec![Arg::Str(visit)]).unwrap());
    d.type_text("x");
    let prompt = d.prompt().unwrap_or_default();
    assert!(prompt.ends_with("a.txt locked by someone@elsewhere (pid 1): (s, q, p, ?)? "), "{prompt}");
    assert_eq!(d.text(), "one\n", "nothing typed yet");
    // q leaves the file alone.
    d.type_text("q");
    let echo = d.message().unwrap_or_default();
    assert!(echo.starts_with("File is locked: "), "{echo:?}");
    assert_eq!(d.text(), "one\n");
    // p edits without the lock, s takes it.
    d.type_text("x");
    d.type_text("p");
    assert_eq!(d.text(), "xone\n");
    assert_eq!(std::fs::read_link(&lock).unwrap().display().to_string(), "someone@elsewhere.1:0");
    d.press("C-/");
    d.type_text("x");
    d.type_text("s");
    assert_eq!(d.text(), "xone\n");
    let mine = std::fs::read_link(&lock).unwrap().display().to_string();
    assert!(mine.contains(&format!(".{}", std::process::id())), "{mine}");
    assert_eq!(d.eval_expression(&format!("ember.fileLockedP({:?})", file.display().to_string())), "true");
    // Saving gives it up.
    d.with(|ed| ed.call("save-buffer", vec![]).unwrap());
    assert!(std::fs::symlink_metadata(&lock).is_err());
}

#[test]
fn a_stale_lock_is_taken_over() {
    let (mut ed, _s, dir) = setup();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    let lock = dir.path().join(".#a.txt");
    // A process on this machine that is no longer running.
    std::os::unix::fs::symlink(format!("{}@{}.999999999", ember_core::filelock::user_login_name(), ember_core::filelock::system_name()), &lock).unwrap();
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.type_text("x");
    assert!(ed.prompt().is_none());
    assert_eq!(text(&ed), "xone\n");
    assert!(std::fs::read_link(&lock).unwrap().display().to_string().contains(&format!(".{}", std::process::id())));
    // Killing the buffer gives the lock up.
    ed.kill_buffer_unsaved("a.txt").unwrap();
    assert!(std::fs::symlink_metadata(&lock).is_err());
}

#[test]
fn a_lock_that_cannot_be_read_or_deleted_does_not_hang_editing() {
    let (mut ed, _s, dir) = setup();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "one\n").unwrap();
    // Neither a link nor a file to read, and not deleted as a stale lock is.
    std::fs::create_dir(dir.path().join(".#a.txt")).unwrap();
    ed.call("find-file", vec![Arg::Str(file.display().to_string())]).unwrap();
    ed.type_text("x");
    assert_eq!(text(&ed), "xone\n");
}

#[test]
fn names_and_predicates_as_emacs_gives_them() {
    // What Emacs 30.2 gives for the same names.
    let (mut ed, s, dir) = setup();
    std::fs::write(dir.path().join("a.txt"), "hello\nworld\n").unwrap();
    std::os::unix::fs::symlink("a.txt", dir.path().join("link")).unwrap();
    let got = eval(
        &mut ed,
        &s,
        r#"JSON.stringify([
          ember.fileExistsP("link"), ember.fileSymlinkP("link"), ember.fileRegularP("link"), ember.fileReadableP("a.txt"),
          ember.fileWritableP("new.txt"), ember.fileExecutableP("."), ember.fileModes("a.txt") === 0o644 || ember.fileModes("a.txt") === 0o664,
          ember.fileNewerThanFileP("a.txt", "nope"),
          ember.substituteInFileName("/a/b//c/d"), ember.substituteInFileName("/a/~/b$$c"),
          ember.fileNameConcat("a", "b/", "c"), ember.fileNameConcat("/x/", "", "y"),
          ember.fileNameAbsoluteP("/a"), ember.fileNameAbsoluteP("~/a"), ember.fileNameAbsoluteP("a"),
          ember.directoryFiles(".", { match: "\\.txt\\'" }),
          ember.fileTruename("link") === ember.fileTruename("a.txt"),
        ])"#,
    );
    assert_eq!(got, r#""[true,\"a.txt\",true,true,true,true,true,true,\"/c/d\",\"~/b$c\",\"a/b/c\",\"/x/y\",true,true,false,[\"a.txt\"],true]""#);
    let temp = eval(&mut ed, &s, r#"ember.makeTempFile("ember-", { suffix: ".txt", text: "made" })"#);
    let temp: String = serde_json::from_str(&temp).unwrap();
    assert!(temp.ends_with(".txt") && std::path::Path::new(&temp).file_name().unwrap().to_string_lossy().starts_with("ember-"));
    assert_eq!(std::fs::read_to_string(&temp).unwrap(), "made");
    std::fs::remove_file(temp).unwrap();
    // insert-file-contents leaves point before the text, and returns what it read.
    ed.window_buffer_mut().set_text("XY");
    ed.window_buffer_mut().set_point(1);
    let read = eval(&mut ed, &s, r#"JSON.stringify(ember.insertFileContents("a.txt").map((x) => typeof x === "string" ? x.replace(/.*\//, "") : x))"#);
    assert_eq!(read, r#""[\"a.txt\",12]""#);
    assert_eq!((text(&ed), ed.window_buffer().point()), ("Xhello\nworld\nY".to_string(), 1));
    let err = s.eval_expression(&mut ed, r#"ember.writeRegion("x", null, "a.txt", { mustbenew: true })"#).unwrap_err();
    assert!(err.to_string().contains("File exists"), "{err}");
}
