//! Searching beyond what the oracle covers: the lines a regexp matches at
//! the start of, as Org finds its headings.

use ember_core::Editor;

#[test]
fn matching_lines_finds_the_lines_a_regexp_matches_at_the_start_of() {
    let mut ed = Editor::new();
    ed.type_text("* one\nnot * this\n** two\n\n*three\nlast ** ");
    let found = ed.matching_lines("^\\*+ ", false).unwrap();
    assert_eq!(found, vec![(0, 0, "* one".to_string()), (2, 17, "** two".to_string())]);
    // Empty lines, and the accessible portion only, as narrowing leaves it.
    assert_eq!(ed.matching_lines("^$", false).unwrap().iter().map(|l| l.0).collect::<Vec<_>>(), vec![3]);
    ed.buffer_mut().narrow(3, 30);
    assert_eq!(ed.matching_lines("^\\*+ ", false).unwrap(), vec![(2, 17, "** two".to_string())], "not at a narrowing's edge mid-line");
    // Matches as looking-at at each line's start says, multibyte text before.
    let mut ed = Editor::new();
    ed.type_text("ünïcödé\n✓ done\n✓ again");
    assert_eq!(ed.matching_lines("^✓ \\(a\\|d\\)", false).unwrap(), vec![(1, 8, "✓ done".to_string()), (2, 15, "✓ again".to_string())]);
}
