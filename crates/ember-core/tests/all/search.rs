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

/// Scanning balanced expressions to the buffer's end, as electric-pair
/// checks a balance, gives the same answers when it passes plain text a
/// run at a time as when it passes it a character at a time.
#[test]
fn scanning_far_passes_plain_text_in_runs_with_the_same_answers() {
    let pieces = ["word ", "(", ")", "\"str (\" ", "x\\(", "é ", ".,", "\n", "  ", "[", "]", "sym-bol "];
    let mut seed = 9u64;
    let mut rand = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize % n
    };
    for _ in 0..1000 {
        let text: String = (0..rand(40)).map(|_| pieces[rand(pieces.len())]).collect();
        let mut ed = Editor::new();
        ed.type_text(&text);
        let len = ed.buffer().len();
        let from = rand(len + 1);
        for (count, depth, sexp) in [(1_000_000_000i64, 0, true), (-1_000_000_000, 0, true), (1, 0, true), (-1, 0, true), (1, 0, false), (-1, 0, false), (1, 1, false), (-1, 1, false), (2, 0, false), (1, -1, true)] {
            let mut slow = ed.scanner();
            slow.lookup_properties = true;
            let fast = ed.scanner().scan_lists(from, count, depth, sexp).map_err(|e| (e.to_string(), e.data().to_vec()));
            let slow = slow.scan_lists(from, count, depth, sexp).map_err(|e| (e.to_string(), e.data().to_vec()));
            assert_eq!(fast, slow, "{text:?} from {from}, count {count}, depth {depth}, sexp {sexp}");
        }
    }
}

/// A backward literal search far from its match tries only the starts
/// that can overlap the last match, rather than every start against the
/// rest of the text: with a megabyte between, the search is immediate.
#[test]
fn a_backward_literal_search_far_from_its_match_is_quick() {
    let mut ed = Editor::new();
    let text = format!("foo foofoo{}", "x".repeat(1 << 20));
    ed.buffer_mut().set_text(&text);
    let backward = ember_core::SearchOptions { regexp: false, backward: true, case_fold: false, bound: None };
    let start = std::time::Instant::now();
    let found = ed.search("foo", text.len(), &backward).unwrap().unwrap();
    assert_eq!((found.start, found.end), (7, 10), "the match that starts last");
    // Overlapping matches: the later of "aa" in "aaa" starts at 1.
    ed.buffer_mut().set_text("aaa");
    let found = ed.search("aa", 3, &backward).unwrap().unwrap();
    assert_eq!((found.start, found.end), (1, 3));
    assert!(start.elapsed() < std::time::Duration::from_secs(5), "took {:?}", start.elapsed());
}
