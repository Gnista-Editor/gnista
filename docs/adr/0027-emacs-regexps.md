# 0027. An engine for Emacs's regular expressions

Status: accepted · 2026-10-30

## Context

Regular expressions that are data, in variables, options and packages' code, are Emacs's, and the core matched them by translating each to the `regex` crate's syntax. The crate cannot match three things Emacs Lisp relies on: back-references (`\(...\)\1`); syntax classes, which depend on the buffer's syntax table and on `syntax-table` text properties (`\w`, `\sw`, `\s-`, `\s_`, `\_<`, `\b`, and `[:word:]`, `[:space:]` and `[:punct:]` in brackets); and point (`\=`). The translation approximated the classes with Unicode ones, which differ from Emacs's, `_` being a word character to the crate and a symbol constituent in Emacs's standard table, and refused back-references. Its matcher also finds what a leftmost-first automaton finds, which is the same as Emacs's backtracking matcher for most expressions but not all. Every port either worked around these or quietly behaved differently ([docs/plan.md](../plan.md) lists it first among the gaps in the core).

## Options considered

1. **Keep translating**, and refuse what the crate cannot match. Fast, but the differences stay.
2. **Oniguruma**, through the `onig` crate, which has an Emacs syntax mode and back-references. It is C, and it cannot know the buffer's syntax table or Emacs's syntax and category classes, so the classes stay approximate.
3. **An engine of Ember's own**, as Emacs's regex-emacs.c is: Emacs's syntax parsed exactly, compiled to a program for a backtracking machine that reads the buffer, with its syntax table and properties, through the same accessor scans use.

## Decision

Option 3. `regexp.rs` parses Emacs's syntax as regex-emacs.c does, with its rules for when `*`, `^` and `$` are special, collapsed repetition operators, non-greedy `*?`, `+?` and `??`, `\{N,M\}`, shy and explicitly numbered groups, back-references, syntax and category classes, word and symbol boundaries, `\=`, and bracket expressions with Emacs's character classes. It compiles to instructions for a backtracking machine with a failure stack, as Emacs's has: alternatives are tried in order, greedy operators try the longest first, a loop that matched empty ends, and groups keep what they matched last on the path that succeeded. The machine reads characters through a haystack: the buffer, narrowed and with point, or a string, and it asks the syntax table, and `syntax-table` properties where `parse-sexp-lookup-properties` is on, for a character's class. A search tries each start in turn, skipping those whose first character cannot start a match, as Emacs's fastmap does, and stops with "Stack overflow in regexp matcher" past a limit, as Emacs does. Case folding compares characters downcased, as Emacs's case table does by default.

`re-search-forward`, `re-search-backward`, `looking-at` and `string-match` use it, from Rust and from scripts; literal searches stay with the crate, which is fast at them. Categories (`\cC`) are a few of Emacs's standard ones worked out from Unicode, until Ember has category tables.

A fuzzer compares it with Emacs's `string-match` and match data on random expressions and strings, and the differences it finds become recorded cases.

## Consequences

Ports can use Emacs's regexps as their Lisp does, and font-lock keywords, imenu and outline patterns, `compilation-error-regexp-alist` and Org's regexps match what they match in Emacs. A backtracking matcher can take exponential time on some expressions, as Emacs's can; the step limit turns that into an error. Regexps in packages' own code may still be JavaScript's, and `ember.emacsRegexp`, which translates one for JavaScript to match strings, keeps its approximations until it calls the engine.

## Dependencies introduced

None.
