//! Tree-sitter highlighting and the modes that use it.

use gnista_core::{Editor, palette};
use gnista_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let scripting = Scripting::new(&mut ed).unwrap();
    (ed, scripting)
}

/// The colour of the first segment of the first row whose text is `text`.
fn color_of(ed: &Editor, text: &str) -> Option<gnista_core::Color> {
    ed.window_rows(20, true)
        .iter()
        .flat_map(|r| r.segments.iter())
        .find(|s| s.text == text)
        .unwrap_or_else(|| panic!("no segment {text:?} in {:?}", ed.window_rows(20, true)))
        .style
        .foreground
}

#[test]
fn visiting_a_rust_file_highlights_it() {
    let (mut ed, _scripting) = setup();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("main.rs");
    std::fs::write(&file, "fn main() {\n    let s = \"hi\"; // note\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Rust");
    assert_eq!(ed.buffer_language(), Some("rust"));
    assert_eq!(color_of(&ed, "fn"), palette("accent-ink", true), "keywords");
    assert_eq!(color_of(&ed, "\"hi\""), palette("good", true), "strings");
    let rows = ed.window_rows(20, true);
    let comment = rows[1].segments.iter().find(|s| s.text == "// note").unwrap();
    assert!(comment.style.italic, "comments");
}

#[test]
fn edits_update_the_highlighting() {
    let (mut ed, _scripting) = setup();
    ed.window_buffer_mut().set_text("let x = 1;\n");
    ed.call("rust-ts-mode", vec![]).unwrap();
    assert_eq!(color_of(&ed, "1"), palette("bad", true), "numbers");
    // Replacing the number with a string highlights the string.
    ed.press("M-< C-u 9 C-f DEL").unwrap();
    ed.type_text("\"one\"");
    assert_eq!(color_of(&ed, "\"one\""), palette("good", true));
    // Undo takes it back.
    ed.press("C-/").unwrap();
    assert_eq!(ed.window_buffer().slice(0..ed.window_buffer().len()), "let x = ;\n");
    assert!(ed.window_rows(1, true)[0].segments.iter().all(|s| !s.text.contains('"')));
}

#[test]
fn leaving_the_mode_stops_highlighting() {
    let (mut ed, _scripting) = setup();
    ed.window_buffer_mut().set_text("{\"a\": 1}");
    ed.call("json-ts-mode", vec![]).unwrap();
    assert_eq!(ed.mode_name(), "JSON");
    assert!(ed.window_rows(1, true)[0].segments.len() > 1);
    ed.call("fundamental-mode", vec![]).unwrap();
    assert_eq!(ed.buffer_language(), None);
    assert_eq!(ed.window_rows(1, true)[0].segments.len(), 1);
}

#[test]
fn scripts_can_ask_about_nodes() {
    let (mut ed, scripting) = setup();
    ed.window_buffer_mut().set_text("def f(x):\n    return x\n");
    ed.call("python-ts-mode", vec![]).unwrap();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"
            import("treesit").then(({ nodeAt }) => {
              const node = nodeAt(4)!;
              gnista.message(`${gnista.treesitNodeType(node)} ${gnista.treesitNodeStart(node)} ${gnista.treesitNodeEnd(node)} ${gnista.treesitLanguage()} ${gnista.treesitLanguageAvailable("rust")}`);
            });
            "#
            .to_string(),
        )
        .unwrap();
    assert_eq!(ed.echo(), Some("identifier 4 5 python true"));
}

#[test]
fn prog_mode_hook_runs_for_programming_modes() {
    let (mut ed, scripting) = setup();
    scripting
        .eval_typescript(
            &mut ed,
            "test.ts",
            r#"gnista.addHook("prog-mode-hook", () => gnista.message("programming"));"#.to_string(),
        )
        .unwrap();
    ed.call("python-ts-mode", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("programming"));
}

/// Runs TypeScript with treesit.ts's functions as `t`, and gives what it
/// leaves in `globalThis.result`, as JSON.
fn with_treesit(ed: &mut Editor, scripting: &Scripting, code: &str) -> String {
    scripting
        .eval_typescript(ed, "test.ts", format!("import(\"treesit\").then((t: any) => {{ globalThis.result = JSON.stringify((() => {{ {code} }})()); }});"))
        .unwrap();
    let got = scripting.eval_expression(ed, "globalThis.result").unwrap();
    serde_json::from_str::<String>(&got).unwrap_or(got)
}

const RUST: &str = "fn main() {\n    let x = 1;\n    foo(x, 2);\n}\n\nfn other() {}\n";

#[test]
fn nodes_as_emacs_gives_them() {
    // Emacs 30.2 on the same text, its positions counting from 1.
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const p = gnista.treesitParserCreate("rust");
        const root = gnista.treesitParserRootNode(p);
        const fn = gnista.treesitNodeChild(root, 0)!;
        const body = gnista.treesitNodeChildByFieldName(fn, "body")!;
        const type = gnista.treesitNodeType;
        return [type(root), gnista.treesitNodeStart(root), gnista.treesitNodeEnd(root), gnista.treesitNodeChildCount(root),
          gnista.treesitNodeChildCount(fn), gnista.treesitNodeChildCount(fn, true), type(fn), type(gnista.treesitNodeChild(fn, -1)),
          type(gnista.treesitNodeChild(fn, 0)), type(gnista.treesitNodeChild(fn, 0, true)), gnista.treesitNodeFieldNameForChild(fn, 1),
          gnista.treesitNodeFieldNameForChild(fn, 0) ?? null, type(gnista.treesitNodeNextSibling(fn)), type(gnista.treesitNodeNextSibling(fn, true)),
          type(gnista.treesitNodePrevSibling(gnista.treesitNodeChild(root, 1))), type(gnista.treesitNodeParent(body)),
          type(gnista.treesitNodeFirstChildForPos(body, 19)), type(gnista.treesitNodeFirstChildForPos(body, 19, true)),
          type(gnista.treesitNodeDescendantForRange(root, 19, 20)), type(gnista.treesitNodeDescendantForRange(root, 19, 20, true)),
          gnista.treesitNodeString(gnista.treesitNodeChild(root, 1)), gnista.treesitNodeEq(gnista.treesitNodeParent(body), fn),
          type(t.nodeAt(20)), type(t.nodeAt(11)), type(t.nodeAt(11, undefined, true)), gnista.treesitNodeStart(t.nodeAt(44)),
          type(t.nodeOn(16, 26)), t.nodeText(gnista.treesitNodeChildByFieldName(fn, "name"), true),
          gnista.treesitNodeCheck(fn, "named"), gnista.treesitNodeCheck(gnista.treesitNodeChild(fn, 0)!, "named"), gnista.treesitNodeCheck(fn, "has-error")];
        "#,
    );
    // Emacs: ("source_file" 1 60 2 4 3 "function_item" "block" "fn" "identifier" "name" nil "function_item" ...)
    assert_eq!(
        got,
        r#"["source_file",0,59,2,4,3,"function_item","block","fn","identifier","name",null,"function_item","function_item","function_item","function_item","let_declaration","let_declaration","let_declaration","let_declaration","(function_item name: (identifier) parameters: (parameters) body: (block))",true,"identifier","{","identifier",45,"let_declaration","main",true,false,false]"#
    );
}

#[test]
fn queries_and_searches_as_emacs_gives_them() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    s.eval_typescript(&mut ed, "pred.ts", r#"gnista.defun("long-name-p", (n: gnista.TreesitNode) => gnista.treesitNodeEnd(n)! - gnista.treesitNodeStart(n)! > 3);"#.into()).unwrap();
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const root = gnista.treesitParserRootNode(gnista.treesitParserCreate("rust"));
        const fn = gnista.treesitNodeChild(root, 0)!;
        const text = (n: any) => (n === undefined ? null : t.nodeText(n, true));
        const pairs = (cs: [string, gnista.TreesitNode][]) => cs.map(([name, n]) => [name, text(n)]);
        return [
          pairs(gnista.treesitQueryCapture(root, "(function_item name: (identifier) @name) (call_expression function: (identifier) @call)")),
          pairs(gnista.treesitQueryCapture(root, "(call_expression function: (identifier) @f arguments: (arguments (integer_literal) @n))", 14, 39)),
          gnista.treesitQueryCapture("rust", "(integer_literal) @n", null, null, true).map(text),
          gnista.treesitNodeType(t.searchForward(t.nodeAt(20), "identifier")), text(t.searchForward(t.nodeAt(20), "identifier")),
          text(t.searchForward(t.nodeAt(20), "identifier", true)), gnista.treesitNodeType(t.searchForward(t.nodeAt(20), "block")),
          text(t.searchSubtree(fn, "integer_literal")), text(t.searchSubtree(fn, "integer_literal", true)),
          gnista.treesitNodeType(t.searchSubtree(fn, "integer_literal", false, false, 2)) ?? null,
          // Emacs's predicates, which its string queries write as tree-sitter's.
          gnista.treesitQueryCapture(root, '((identifier) @id (#match "^o" @id))', null, null, true).map(text),
          gnista.treesitQueryCapture(root, '((identifier) @id (#equal @id "x"))', null, null, true).map(text),
          gnista.treesitQueryCapture(root, '((identifier) @id (#pred long-name-p @id))', null, null, true).map(text),
          gnista.treesitQueryCapture(root, "(let_declaration pattern: (_) @p value: (_) @v)", null, null, false, true).map(pairs),
        ];
        "#,
    );
    // Emacs: ((name . "main") (call . "foo") (name . "other")) ((f . "foo") (n . "2")) ("1" "2")
    //        ("identifier" "foo" "main" "block" "1" "2" nil)
    assert_eq!(
        got,
        r#"[[["name","main"],["call","foo"],["name","other"]],[["f","foo"],["n","2"]],["1","2"],"identifier","foo","main","block","1","2",null,["other"],["x","x"],["main","other"],[[["p","x"],["v","1"]]]]"#
    );
}

#[test]
fn parsers_and_nodes_out_of_date() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text(RUST);
    let got = with_treesit(
        &mut ed,
        &s,
        r#"
        const p = gnista.treesitParserCreate("rust");
        const root = gnista.treesitParserRootNode(p);
        const counts = [gnista.treesitParserList().length, gnista.treesitParserCreate("rust") === p, gnista.treesitParserCreate("rust", null, true) === p,
          gnista.treesitParserList().length, (gnista.treesitParserCreate("rust", null, false, "mine"), gnista.treesitParserList().length),
          gnista.treesitParserList(null, null, true).length, gnista.treesitParserList(null, "rust", "mine").length,
          gnista.treesitParserLanguage(p), gnista.treesitParserTag(p) ?? null];
        const old = gnista.treesitNodeChild(root, 0)!;
        gnista.gotoChar(0);
        gnista.insert("// c\n");
        // Out of date only once the tree is parsed again, as Emacs's.
        const before = [gnista.treesitNodeCheck(old, "outdated"), gnista.treesitNodeCheck(old, "live"), gnista.treesitNodeType(old)];
        const now = gnista.treesitNodeType(gnista.treesitNodeChild(gnista.treesitParserRootNode(p), 0));
        const after = [gnista.treesitNodeCheck(old, "outdated"), gnista.conditionCase(() => gnista.treesitNodeType(old), { "treesit-node-outdated": () => "outdated" })];
        gnista.treesitParserDelete(p);
        return [...counts, ...before, now, ...after, gnista.treesitNodeCheck(old, "live"), gnista.treesitParserList(null, null, true).length];
        "#,
    );
    // Emacs: (1 t nil 2 2 3 1 rust nil) (nil t "function_item" "line_comment")
    assert_eq!(got, r#"[1,true,false,2,2,3,1,"rust",null,false,true,"function_item","line_comment",true,"outdated",false,2]"#);
}

/// Each run of the same style in the first rows, with its text.
fn face_runs(ed: &mut Editor) -> Vec<(String, gnista_core::Style)> {
    ed.redisplay();
    ed.window_rows(20, true).iter().flat_map(|r| r.segments.iter()).map(|s| (s.text.clone(), s.style.clone())).collect()
}

/// The style a face draws in.
fn style(ed: &Editor, face: &str) -> gnista_core::Style {
    ed.style_for(&[face.to_string()], true)
}

#[test]
fn font_lock_rules_highlight_in_place_of_the_grammars_query() {
    let (mut ed, s) = setup();
    ed.window_buffer_mut().set_text("{\"a\": 1, \"b\": true}");
    ed.call("json-ts-mode", vec![]).unwrap();
    // The rules' order and overrides decide, as treesit-font-lock-fontify-region's do:
    // the first rule's face stays where nil overrides, the third's goes over it with t.
    s.eval_expression(
        &mut ed,
        r#"gnista.treesitSetFontLockRules("json", [
            ["(pair key: (_) @font-lock-keyword-face)", null],
            ["(pair) @font-lock-warning-face", null],
            ["(true) @font-lock-builtin-face", "t"],
            ["(number) @font-lock-type-face", null]])"#,
    )
    .unwrap();
    let runs = face_runs(&mut ed);
    let style_of = |text: &str| runs.iter().find(|(t, _)| t == text).map(|(_, f)| f.clone()).unwrap_or_else(|| panic!("no {text:?} in {runs:?}"));
    assert_eq!(style_of("\"a\""), style(&ed, "font-lock-keyword-face"));
    // A pair whose key has a face already keeps it, rather than taking the second rule's.
    assert!(!runs.iter().any(|(_, f)| *f == style(&ed, "font-lock-warning-face")), "{runs:?}");
    assert_eq!(style_of("true"), style(&ed, "font-lock-builtin-face"));
    assert_eq!(style_of("1"), style(&ed, "font-lock-type-face"));
}

#[test]
fn a_mode_without_its_grammar_warns_and_stays_plain() {
    let (mut ed, _s) = setup();
    let dir = tempfile::tempdir().unwrap();
    ed.set_variable("user-emacs-directory", gnista_core::Value::Str(format!("{}/", dir.path().display())));
    ed.call("go-ts-mode", vec![]).unwrap();
    assert_eq!(ed.echo(), Some("Cannot activate tree-sitter, because language grammar for go is unavailable"));
    assert_eq!(ed.buffer_language(), None);
}

/// Go's grammar as Emacs's treesit-install-language-grammar builds it, if
/// this machine has one: Gnista does not ship it.
fn go_grammar() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var_os("HOME")?).join(".emacs.d/tree-sitter");
    dir.join("libtree-sitter-go.dylib").exists().then_some(dir)
}

#[test]
fn go_ts_mode_loads_its_grammar_and_highlights_with_its_rules() {
    let Some(grammars) = go_grammar() else {
        eprintln!("No libtree-sitter-go in ~/.emacs.d/tree-sitter: skipped");
        return;
    };
    let (mut ed, _s) = setup();
    ed.set_variable("treesit-extra-load-path", gnista_core::Value::List(vec![gnista_core::Value::Str(grammars.display().to_string())]));
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("main.go");
    std::fs::write(&file, "package main\n\nfunc main() {\n\tx := len(\"hi\")\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Go");
    assert_eq!(ed.buffer_language(), Some("go"));
    assert_eq!(ed.variable("indent-tabs-mode"), Some(gnista_core::Value::Bool(true)));
    let runs = face_runs(&mut ed);
    let style_of = |text: &str| runs.iter().find(|(t, _)| t == text).map(|(_, f)| f.clone()).unwrap_or_else(|| panic!("no {text:?} in {runs:?}"));
    assert_eq!(style_of("package"), style(&ed, "font-lock-keyword-face"));
    assert_eq!(style_of("\"hi\""), style(&ed, "font-lock-string-face"));
    assert_eq!(style_of("len"), style(&ed, "font-lock-builtin-face"));
    assert_eq!(style_of("func"), style(&ed, "font-lock-keyword-face"));
    // Indenting by Emacs's rules: a block's statements one tab in.
    ed.press("M-< C-n C-n C-n TAB").unwrap();
    assert_eq!(ed.window_buffer().line_text(3), "\tx := len(\"hi\")");
    // Imenu from treesit-simple-imenu-settings, and C-M-a by defuns.
    ed.press("C-M-a").unwrap();
    assert_eq!(ed.window_buffer().point(), 14);
}

#[test]
fn bash_ts_mode_highlights_and_indents_as_emacs_does() {
    let Some(grammars) = go_grammar().filter(|d| d.join("libtree-sitter-bash.dylib").exists()) else {
        eprintln!("No libtree-sitter-bash in ~/.emacs.d/tree-sitter: skipped");
        return;
    };
    let (mut ed, _s) = setup();
    ed.set_variable("treesit-extra-load-path", gnista_core::Value::List(vec![gnista_core::Value::Str(grammars.display().to_string())]));
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("x.sh");
    std::fs::write(&file, "#!/bin/bash\n# Note\nf() {\n  local x=1\n  if [ \"$x\" = 2 ]; then\n    echo \"hi $HOME\" $(date) | grep h\n  fi\n  return 0\n}\n").unwrap();
    ed.visit_file(&file).unwrap();
    assert_eq!(ed.mode_name(), "Bash");
    let runs = face_runs(&mut ed);
    let style_of = |text: &str| runs.iter().find(|(t, _)| t == text).map(|(_, f)| f.clone()).unwrap_or_else(|| panic!("no {text:?} in {runs:?}"));
    // As Emacs 30's bash-ts-mode fontifies it at the default level.
    for (text, face) in [
        ("#!/bin/bash", "font-lock-comment-face"),
        ("f", "font-lock-function-name-face"),
        ("local", "font-lock-keyword-face"),
        ("x", "font-lock-variable-name-face"),
        ("if", "font-lock-keyword-face"),
        ("\"$x\"", "font-lock-string-face"),
        ("echo", "font-lock-function-name-face"),
        ("$(date)", "sh-quoted-exec"),
        ("grep", "font-lock-function-name-face"),
        ("fi", "font-lock-keyword-face"),
        ("return", "font-lock-keyword-face"),
    ] {
        assert_eq!(style_of(text), style(&ed, face), "{text}");
    }
    // Emacs's indentation, with tabs for each eight columns.
    ed.window_buffer_mut().set_text("f() {\nlocal x=1\nif [ 1 ]; then\necho a\nfi\nfor i in 1 2; do\necho $i\ndone\n}\n");
    ed.press("C-x h C-M-\\").unwrap();
    let b = ed.window_buffer();
    assert_eq!(b.slice(0..b.len()), "f() {\n    local x=1\n    if [ 1 ]; then\n\techo a\n    fi\n    for i in 1 2; do\n\techo $i\n    done\n}\n");
}
