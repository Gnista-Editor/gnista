//! Emacs Lisp mode: its faces, as Emacs 30's font-lock gives them. Its
//! indentation is compared with Emacs by the oracle, in elisp-indent.json.

use e8_core::{Arg, Editor, Value};
use e8_script::Scripting;

const SAMPLE: &str = r#";;; sample.el --- A sample  -*- lexical-binding: t -*-
;; A comment
(defvar my-var 42 "A variable.")
(defcustom my-option nil "An option." :type 'boolean :group 'my)
(defface my-face '((t :weight bold)) "A face.")
(defun my-fun (a &optional b)
  "Do A, then `my-var' with B."
  (let ((x (+ a 1)) ; trailing
        (y "str"))
    (when (and x y)
      (message "%s %s" x ?\"))
    (if b (error "Bad %s" b) nil)))
(defmacro my-mac (&rest body) `(progn ,@body))
(use-package org :ensure t :config (setq org-x 1))
(cl-defstruct my-struct a b)
(defalias 'my-alias #'my-fun)
"#;

fn face_name(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::List(items) => format!("({})", items.iter().map(face_name).collect::<Vec<_>>().join(" ")),
        other => format!("{other:?}"),
    }
}

/// The runs of text with a face, and the face, as Emacs's next-single-property-change finds them.
fn face_runs(ed: &Editor) -> Vec<(String, String)> {
    let b = ed.window_buffer();
    let mut runs: Vec<(String, String)> = Vec::new();
    let mut last: Option<String> = None;
    for pos in 0..b.len() {
        let face = b.text_property(pos, "face").map(face_name);
        let c = b.slice(pos..pos + 1);
        match (&face, runs.last_mut()) {
            (Some(f), Some((text, g))) if last.as_ref() == Some(f) && g == f => text.push_str(&c),
            (Some(f), _) => runs.push((c, f.clone())),
            _ => {}
        }
        last = face;
    }
    runs
}

#[test]
fn emacs_lisp_is_fontified_as_emacs_fontifies_it() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text(SAMPLE);
    ed.call("emacs-lisp-mode", vec![]).unwrap();
    ed.set_frame_size(100, 40);
    ed.redisplay();
    let expected: Vec<(&str, &str)> = vec![
        (";;; ", "font-lock-comment-delimiter-face"),
        ("sample.el --- A sample  -*- lexical-binding: t -*-\n", "font-lock-comment-face"),
        (";; ", "font-lock-comment-delimiter-face"),
        ("A comment\n", "font-lock-comment-face"),
        ("defvar", "font-lock-keyword-face"),
        ("my-var", "font-lock-variable-name-face"),
        ("\"A variable.\"", "font-lock-doc-face"),
        ("defcustom", "font-lock-keyword-face"),
        ("my-option", "font-lock-variable-name-face"),
        ("\"An option.\"", "font-lock-doc-face"),
        (":type", "font-lock-builtin-face"),
        (":group", "font-lock-builtin-face"),
        ("defface", "font-lock-keyword-face"),
        ("my-face", "font-lock-variable-name-face"),
        (":weight", "font-lock-builtin-face"),
        ("\"A face.\"", "font-lock-doc-face"),
        ("defun", "font-lock-keyword-face"),
        ("my-fun", "font-lock-function-name-face"),
        ("&optional", "font-lock-type-face"),
        ("\"Do A, then `", "font-lock-doc-face"),
        ("my-var", "(font-lock-constant-face font-lock-doc-face)"),
        ("' with B.\"", "font-lock-doc-face"),
        ("let", "font-lock-keyword-face"),
        ("; ", "font-lock-comment-delimiter-face"),
        ("trailing\n", "font-lock-comment-face"),
        ("\"str\"", "font-lock-string-face"),
        ("when", "font-lock-keyword-face"),
        ("and", "font-lock-keyword-face"),
        ("\"%s %s\"", "font-lock-string-face"),
        ("if", "font-lock-keyword-face"),
        ("error", "font-lock-warning-face"),
        ("\"Bad %s\"", "font-lock-string-face"),
        ("defmacro", "font-lock-keyword-face"),
        ("my-mac", "font-lock-function-name-face"),
        ("&rest", "font-lock-type-face"),
        ("progn", "font-lock-keyword-face"),
        ("use-package", "font-lock-keyword-face"),
        (":ensure", "font-lock-builtin-face"),
        (":config", "font-lock-builtin-face"),
        ("setq", "font-lock-keyword-face"),
        ("cl-defstruct", "font-lock-keyword-face"),
        ("my-struct", "font-lock-type-face"),
        ("defalias", "font-lock-keyword-face"),
        ("my-alias", "font-lock-function-name-face"),
    ];
    let got = face_runs(&ed);
    let got: Vec<(&str, &str)> = got.iter().map(|(t, f)| (t.as_str(), f.as_str())).collect();
    assert_eq!(got, expected);
}

#[test]
fn el_files_and_org_s_elisp_blocks_use_emacs_lisp_mode() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* H\n#+begin_src emacs-lisp\n  (setq a\n  1)\n#+end_src\n");
    ed.call("rename-buffer", vec![Arg::Str("c.org".into())]).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    ed.window_buffer_mut().set_point(30);
    ed.press("C-c '").unwrap();
    assert_eq!(ed.variable("major-mode").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("emacs-lisp-mode"));
    ed.press("C-n TAB C-c '").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "* H\n#+begin_src emacs-lisp\n  (setq a\n        1)\n#+end_src\n");
}

#[test]
fn org_s_elisp_blocks_get_emacs_lisp_s_faces() {
    // As Emacs 30 fontifies it, with org-src-fontify-natively on as by default;
    // Emacs writes org-block alone as (org-block).
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* H\n#+begin_src emacs-lisp\n(setq a \"s\") ; c\n#+end_src\ntext\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_frame_size(100, 20);
    ed.redisplay();
    let got = face_runs(&ed);
    let got: Vec<(&str, &str)> = got.iter().map(|(t, f)| (t.as_str(), f.as_str())).collect();
    assert_eq!(
        got,
        vec![
            ("* H", "org-level-1"),
            ("#+begin_src emacs-lisp\n", "org-block-begin-line"),
            ("(", "org-block"),
            ("setq", "(font-lock-keyword-face org-block)"),
            (" a ", "org-block"),
            ("\"s\"", "(font-lock-string-face org-block)"),
            (") ", "org-block"),
            ("; ", "(font-lock-comment-delimiter-face org-block)"),
            ("c\n", "(font-lock-comment-face org-block)"),
            // The delimiter lines' newlines too, as org-fontify-whole-block-delimiter-line has it.
            ("#+end_src\n", "org-block-end-line"),
        ]
    );
}

#[test]
fn tree_sitter_blocks_get_their_mode_s_faces_too() {
    // E8's python-mode is python-ts-mode, whose rules differ in detail
    // from the python.el Emacs fontifies with; its keywords and strings agree.
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* H\n#+begin_src python\nx = \"s\"\ndef f(): return 1\n#+end_src\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.set_frame_size(100, 20);
    ed.redisplay();
    let got = face_runs(&ed);
    let has = |text: &str, face: &str| got.iter().any(|(t, f)| t == text && f == face);
    assert!(has("\"s\"", "(font-lock-string-face org-block)"), "{got:?}");
    assert!(has("def", "(font-lock-keyword-face org-block)"), "{got:?}");
    assert!(has("return", "(font-lock-keyword-face org-block)"), "{got:?}");
}

#[test]
fn bash_blocks_get_bash_ts_mode_s_faces_where_its_grammar_is() {
    let Some(dir) = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".emacs.d/tree-sitter")).filter(|d| d.join("libtree-sitter-bash.dylib").exists()) else {
        eprintln!("No libtree-sitter-bash in ~/.emacs.d/tree-sitter: skipped");
        return;
    };
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.set_variable("treesit-extra-load-path", Value::List(vec![Value::Str(dir.display().to_string())]));
    ed.window_buffer_mut().set_text("* H\n#+begin_src bash\nif true; then echo hi; fi\n#+end_src\n");
    ed.call("rename-buffer", vec![Arg::Str("b.org".into())]).unwrap();
    ed.call("org-mode", vec![]).unwrap();
    ed.set_frame_size(100, 20);
    ed.redisplay();
    let got = face_runs(&ed);
    assert!(got.iter().any(|(t, f)| t == "if" && f == "(font-lock-keyword-face org-block)"), "{got:?}");
    assert!(got.iter().any(|(t, f)| t == "echo" && f == "(font-lock-function-name-face org-block)"), "{got:?}");
    ed.window_buffer_mut().set_point(24);
    ed.press("C-c '").unwrap();
    assert_eq!(ed.variable("major-mode").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("bash-ts-mode"));
}

#[test]
fn javascript_blocks_edit_in_js_ts_mode() {
    let mut ed = Editor::new();
    let _s = Scripting::new(&mut ed).unwrap();
    ed.window_buffer_mut().set_text("* H\n#+begin_src javascript\nlet a = 1;\n#+end_src\n");
    ed.call("org-mode", vec![]).unwrap();
    ed.window_buffer_mut().set_point(30);
    ed.press("C-c '").unwrap();
    assert_eq!(ed.variable("major-mode").and_then(|v| v.as_str().map(String::from)).as_deref(), Some("js-ts-mode"));
}
