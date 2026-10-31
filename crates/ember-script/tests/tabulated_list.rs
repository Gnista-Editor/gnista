//! Tabulated lists, as Emacs's tabulated-list.el prints, tags, sorts and
//! widens them: the text and header lines here are Emacs 30.2's on the same
//! list, its header line's `:align-to` spaces worked out.

use ember_core::Editor;
use ember_script::Scripting;

fn setup() -> (Editor, Scripting) {
    let mut ed = Editor::new();
    let s = Scripting::new(&mut ed).unwrap();
    (ed, s)
}

/// Runs TypeScript with tabulated-list.ts's functions as `t`, in a list
/// buffer, and gives the snapshots `show` took: each the header line and
/// the text.
fn run(ed: &mut Editor, scripting: &Scripting, code: &str) -> Vec<String> {
    let source = format!(
        r#"import("tabulated-list").then((t: any) => {{
            const shots: string[] = [];
            const show = () => shots.push(String(ember.formatModeLine(ember.variable("header-line-format"))) + "\n" + ember.bufferText(ember.pointMin(), ember.pointMax()));
            ember.withCurrentBuffer(ember.getBufferCreate("tl"), () => {{
                ember.call("tabulated-list-mode");
                {code}
            }});
            globalThis.result = JSON.stringify(shots);
        }});"#
    );
    scripting.eval_typescript(ed, "test.ts", source).unwrap();
    let got = scripting.eval_expression(ed, "globalThis.result").unwrap();
    serde_json::from_str::<Vec<String>>(&serde_json::from_str::<String>(&got).unwrap()).unwrap()
}

const SETUP: &str = r#"
    const sym = (s: string) => Symbol.for(s) as any;
    const size = (e: any) => Number(e[1][1]);
    ember.setVariable("tabulated-list-format", [["Name", 10, true], ["Size", 6, (a: any, b: any) => size(a) < size(b), sym(":right-align"), true], ["Note", 8, false], ["Last", 1, true]] as any);
    ember.setVariable("tabulated-list-padding", 2);
    ember.setVariable("tabulated-list-entries", [[sym("a"), ["banana", "12", "yellow fruit", "x"]], [sym("b"), ["apple", "7", "red", "y"]], [sym("c"), ["a-very-long-name", "1234567", "n", "z"]]] as any);
    ember.setVariable("tabulated-list-sort-key", ["Name", false] as any);
    t.tabulatedListInitHeader();
    t.tabulatedListPrint();
"#;

#[test]
fn entries_print_in_columns_sorted_with_the_titles_in_the_header_line() {
    let (mut ed, s) = setup();
    let shots = run(
        &mut ed,
        &s,
        &format!(
            r#"{SETUP}
            show();
            ember.gotoChar(ember.lineStart(1));
            t.tabulatedListPutTag("*", true);
            show();
            ember.callWithPrefix(1, "tabulated-list-sort");
            show();
            shots.push(`line ${{ember.lineOf(ember.point())}} col ${{ember.currentColumn()}}`);
            ember.callWithPrefix(1, "tabulated-list-sort");
            show();
            ember.gotoChar(ember.pointMin());
            t.tabulatedListSetCol(2, "changed", true);
            show();
            ember.callWithPrefix(-1, "tabulated-list-sort");
            show();
            ember.conditionCase(() => ember.callWithPrefix(2, "tabulated-list-sort"), {{ "user-error": (e: any) => shots.push(`error ${{e.message}}`) }});
            ember.gotoChar(ember.pointMin());
            ember.moveToColumn(3);
            ember.callWithPrefix(4, "tabulated-list-widen-current-column");
            show();"#
        ),
    );
    let expected = [
        "  Name ▼       Size Note     Last\n  a-very-long-name 1234567 n        z\n  apple           7 red      y\n  banana         12 yellow fruit x\n",
        "  Name ▼       Size Note     Last\n  a-very-long-name 1234567 n        z\n* apple           7 red      y\n  banana         12 yellow fruit x\n",
        "  Name       Size ▼ Note     Last\n  apple           7 red      y\n  banana         12 yellow fruit x\n  a-very-long-name 1234567 n        z\n",
        // Emacs counts lines from 1, Ember from 0: the second line, banana's, kept.
        "line 1 col 0",
        "  Name       Size ▲ Note     Last\n  a-very-long-name 1234567 n        z\n  banana         12 yellow fruit x\n  apple           7 red      y\n",
        "  Name       Size ▲ Note     Last\n  a-very-long-name 1234567 changed  z\n  banana         12 yellow fruit x\n  apple           7 red      y\n",
        "  Name         Size Note     Last\n  a-very-long-name 1234567 changed  z\n  apple           7 red      y\n  banana         12 yellow fruit x\n",
        "error Cannot sort by Note",
        "  Name             Size Note     Last\n  a-very-long-name 1234567 changed  z\n  apple               7 red      y\n  banana             12 yellow fruit x\n",
    ];
    assert_eq!(shots, expected);
}

#[test]
fn a_list_without_the_header_line_has_its_titles_as_its_first_line() {
    let (mut ed, s) = setup();
    let shots = run(
        &mut ed,
        &s,
        &format!(
            r#"ember.setVariable("tabulated-list-use-header-line", false);
            {SETUP}
            shots.push(ember.bufferText(ember.pointMin(), ember.pointMax()));
            shots.push(String(t.tabulatedListHeaderOverlayP()));
            shots.push(String(t.tabulatedListGetId(ember.pointMin()) === undefined));"#
        ),
    );
    // The header string's text, its spaces lined up by `display` properties, as Emacs 30.2 inserts it.
    assert!(shots[0].starts_with(" Name ▼   Size Note Last \n  a-very-long-name"), "{:?}", shots[0]);
    assert_eq!(&shots[1..], ["true", "true"]);
}

#[test]
fn the_header_line_shows_above_the_list_in_its_window() {
    let (mut ed, s) = setup();
    run(&mut ed, &s, SETUP);
    ed.call("switch-to-buffer", vec![ember_core::Arg::Str("tl".into())]).unwrap();
    ed.set_frame_size(40, 10);
    ed.redisplay();
    let id = ed.selected_window();
    assert!(ed.window_wants_header_line(id, 10));
    let header: String = ed.header_line(id).unwrap().iter().map(|s| s.text.as_str()).collect();
    assert_eq!(header, "  Name ▼       Size Note     Last");
    // The sorted column's title is bold.
    assert!(ed.header_line(id).unwrap().iter().any(|s| s.text.contains('▼') && s.faces.iter().any(|f| f == "bold")));
}
