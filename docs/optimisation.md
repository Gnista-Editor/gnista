# Optimisation

The aim is for Ember to be faster than Emacs in every situation, not only in most. [performance.md](performance.md) records what has been measured and changed; this document lists where Ember is known to be slower than it could be, or than Emacs, and what would make it faster. Each entry says how it was measured, so it can be measured again before and after.

Two rules carry over from the work so far. Measure first: a change goes in with the numbers it moved. And a faster path must give the same results as the path it stands in for, checked the way the slower one is checked (by the Emacs oracle, a fuzzer or the recorded cases), so speed never costs behaving like Emacs.

## Regular expressions: an automaton beside the backtracking matcher

**Now.** Emacs regexps are matched by Ember's own engine, a backtracking machine as Emacs's regex-emacs.c is ([ADR 0027](adr/0027-emacs-regexps.md)), which tries each start position in turn, skipping those whose first character cannot start a match. Failing searches over 10 MB of text, measured with `regexp_searches_over_a_large_buffer_are_fast` in `crates/ember-script/tests/regexp.rs` against Emacs 30.2 on the same text:

| Regexp | Ember | Emacs |
| --- | ---: | ---: |
| `\<zzz\>` | 70 ms | 39 ms |
| `^\* q` | 78 ms | 30 ms |
| `[0-9]+x` | 161 ms | 90 ms |
| `\w+qq` | 879 ms | 611 ms |

Like Emacs's, the matcher takes exponential time on some expressions: `\(x+x+\)+y` on a line of x's takes seconds in both, so a mistyped `C-M-s` can stop the editor until it gives up.

**Idea.** A lazy DFA or a one-pass automaton, from the `regex-automata` crate that `regex` already brings in, checks each character once: failing searches would take a few milliseconds, and no expression would take exponential time. An automaton that keeps the priority of alternatives, as the crate's leftmost-first mode does, finds the same match and the same groups as a backtracking matcher for any regexp it can express, so it can stand in for the engine where:

- the regexp has no back-references and no `\=`;
- the buffer has no `syntax-table` text properties in effect (`parse-sexp-lookup-properties` off), so each syntax class (`\w`, `\sC`, `[:space:]`, `[:word:]`, `[:punct:]`) is a fixed set of characters, worked out from the buffer's syntax table when the regexp is compiled, and the compiled automaton is kept per regexp and syntax table;
- word and symbol boundaries (`\b`, `\<`, `\>`, `\_<`, `\_>`) are look-arounds the automaton supports over those sets, which includes Emacs's boundaries between scripts only if they are expressed as character sets too, or else such regexps stay with the engine;
- Emacs's own departures are kept: a loop that matches nothing ends, `\{N,M\}` is a loop that a matching-nothing iteration ends, and a `*` or `+` loop of non-words or non-symbols before `\_<` never gives characters back. Where these change what matches, the automaton finds where a match can start and the engine finds the match there.

Everything else stays with the engine. The regexp fuzzer compares the two on every case, and the speed test above gains Ember-only rows for the automaton.

## Electric Pair mode in a large buffer

Typing `(` then `)` with Electric Pair and Show Paren mode on takes about 1.9 s a key in a 100 MB text file (`( and ) with electric-pair and show-paren` in the bench, [performance.md](performance.md)), where it is 21 ms in a 50,000-line Org file. Electric Pair mode checks whether the buffer's parens balance by scanning to its end, as elec-pair.el does. Emacs pays the same; being faster than it means keeping the balance from `syntax-ppss`'s cached states, so a check scans from the nearest kept state rather than the whole buffer.

## Org's headings after each change

Org keeps an index of its headings from its after-change hook since 2026-11-01, moving the headings after an edit and looking again only at the lines it touched, so `C-c C-t` and `M-<down>` take 8 to 9 ms in the 50,000-line file ([performance.md](performance.md)). What is left: each heading after an edit still gets a new object, which is most of what a single edit costs; RET takes 20 ms, much of it elsewhere in org-return; and S-TAB, 26 ms, is interpreting Org's folding, half of it QuickJS's regexp matcher.

## Character tables

Classes, categories, scripts and case past ASCII are binary searches in sorted runs (`chartab_data.rs`). Two-level tables indexed by code point, as Emacs's char-tables are, would make each lookup a pair of array reads. Worth doing when a profile shows the searches; none has yet.

## Moving through rows in the GUI

With the GUI's metrics, rows built for moving point (`C-n` over continued lines, keeping point in sight) work out their faces, as their wrapping depends on the fonts, where with cells they need none. That is most of what `C-n` costs over the terminal: 0.75 ms a key against 0.42 in a 50,000-line Org file, and 0.98 ms in `variable-pitch-mode` (`gui_layout` in the bench, [performance.md](performance.md)). A buffer whose rows have all been on the grid could skip the faces until a face with another height or a proportional family is in effect, or rows' measured widths could be kept per line between keys until the text or faces there change, as Emacs's glyph matrices are.

Later on 2026-10-31, rows off the grid cost 0.1 to 0.2 ms a key more than in the table above: `C-n` 0.93 ms with `text-scale-adjust` twice against 0.79, and in `variable-pitch-mode` `C-v` 3.38 ms against 3.17 and `C-n` 1.12 against 0.99. Running `gui_layout` on each commit of that day put the rise before images, bidirectional text and the fringe indicators: at `6f8f6e7`, faces with Emacs's attributes and the GUI's fringes, `variable-pitch-mode` already took 3.44 and 1.16 ms, and the merges after it moved nothing beyond noise. So the cost is in resolving faces' extra attributes or in the fringes' extra column for rows off the grid, and a profile of `C-n` in `variable-pitch-mode` should say which.
