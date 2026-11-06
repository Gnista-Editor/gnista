# 0027. An engine for Emacs's regular expressions

Status: accepted · 2026-10-30

## Context

Regular expressions that are data, in variables, options and packages' code, are Emacs's, and the core matched them by translating each to the `regex` crate's syntax. The crate cannot match three things Emacs Lisp relies on: back-references (`\(...\)\1`); syntax classes, which depend on the buffer's syntax table and on `syntax-table` text properties (`\w`, `\sw`, `\s-`, `\s_`, `\_<`, `\b`, and `[:word:]`, `[:space:]` and `[:punct:]` in brackets); and point (`\=`). The translation approximated the classes with Unicode ones, which differ from Emacs's, `_` being a word character to the crate and a symbol constituent in Emacs's standard table, and refused back-references. Its matcher also finds what a leftmost-first automaton finds, which is the same as Emacs's backtracking matcher for most expressions but not all. Every port either worked around these or quietly behaved differently ([docs/plan.md](../plan.md) lists it first among the gaps in the core).

## Options considered

1. **Keep translating**, and refuse what the crate cannot match. Fast, but the differences stay.
2. **Oniguruma**, through the `onig` crate, which has an Emacs syntax mode and back-references. It is C, and it cannot know the buffer's syntax table or Emacs's syntax and category classes, so the classes stay approximate.
3. **An engine of E8's own**, as Emacs's regex-emacs.c is: Emacs's syntax parsed exactly, compiled to a program for a backtracking machine that reads the buffer, with its syntax table and properties, through the same accessor scans use.

## Decision

Option 3. `regexp.rs` parses Emacs's syntax as regex-emacs.c does, with its rules for when `*`, `^` and `$` are special, collapsed repetition operators, non-greedy `*?`, `+?` and `??`, `\{N,M\}`, shy and explicitly numbered groups, back-references, syntax and category classes, word and symbol boundaries, `\=`, and bracket expressions with Emacs's character classes. It compiles to instructions for a backtracking machine with a failure stack, as Emacs's has: alternatives are tried in order, greedy operators try the longest first, a loop that matched empty ends, and groups keep what they matched last on the path that succeeded. The machine reads characters through a haystack: the buffer, narrowed and with point, or a string, and it asks the syntax table, and `syntax-table` properties where `parse-sexp-lookup-properties` is on, for a character's class. A search tries each start in turn, skipping those whose first character cannot start a match, as Emacs's fastmap does, and stops with "Stack overflow in regexp matcher" past a limit, as Emacs does. Case folding compares characters by their canonical case, the lower case of their upper case, as Emacs's case canon table does.

`re-search-forward`, `re-search-backward`, `looking-at` and `string-match` use it, from Rust and from scripts; literal searches stay with the crate, which is fast at them.

What the classes, categories and case of characters past ASCII are comes from Emacs's own tables, which `tests/emacs/unicode.el` writes into `chartab_data.rs` from a running Emacs: each character's general category, which `[:alpha:]`, `[:graph:]` and the rest follow as Emacs's character.c does; its script, for the word boundaries Emacs sees between letters of two scripts; its entry in the standard syntax table, which is now E8's standard table for every character; its lower and upper case in the standard case table; and the standard category table's 43 categories. Regenerating them for a newer Emacs is running the script again.

A fuzzer compares it with Emacs's `string-match` and match data on random expressions and strings, and the differences it finds become recorded cases.

## Review

A review measured regexp searches over a 10 MB buffer at 300 times slower than before and 10 to 25 times slower than Emacs, as every character was read through the rope, every syntax lookup went through the table by name, and each start allocated afresh. The haystack now reads the buffer in chunks and finds where a match can start by scanning one, ASCII's syntax is looked up once a search, the matcher's memory is kept from one start to the next, a regexp starting with `^` is tried only at line starts, and a loop of one character test takes its characters without a failure point each, which also lets `^.*$` match a line of millions of characters. A failing search for `\<zzz\>` over 10 MB takes 70 ms, against Emacs's 40.

The same review found, and the same round fixed: σ, ς and µ did not fold with their other forms, and the Kelvin sign folded with `k`; the possessive loop was recognised by syntax rather than as Emacs's compiled code shows it, so a shy group or an interval changed it; categories were guesses, and `\cL`, `\cR` and the digits were refused; `*` after `` \` `` was a repetition; bracket classes past ASCII were Rust's, not Emacs's; and some messages differed. Fuzzing with characters past ASCII then found the standard syntax table and word boundaries between scripts differing from Emacs's, which the tables above settled. 220,000 random cases now match, 3,003 are recorded, and `re-search-forward` and `re-search-backward` signal Emacs's error for a bound on the wrong side of point.

## Consequences

Ports can use Emacs's regexps as their Lisp does, and font-lock keywords, imenu and outline patterns, `compilation-error-regexp-alist` and Org's regexps match what they match in Emacs. A backtracking matcher can take exponential time on some expressions, as Emacs's can: `\(x+x+\)+y` on a line of x's takes seconds in both, and a limit on the failure stack turns only the deepest into an error. Regexps in packages' own code may still be JavaScript's. The packages that matched Emacs regexps from variables with `e8.emacsRegexp`, a translation to JavaScript, use the engine instead: `auto-mode-alist` and `revert-without-query` with `string-match`, Dired's trivial file names, and outline's headings with `looking-at` on the buffer, as outline.el does. The translation stays, documented as approximate, for code that wants a JavaScript regexp.

## Dependencies introduced

None. The character tables are generated data, about 350 KB of Rust source.
