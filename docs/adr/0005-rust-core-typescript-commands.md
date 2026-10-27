# 0005. Rust for Emacs's C core, TypeScript for its Lisp, and Emacs as the oracle

Status: accepted · 2026-10-27

## Context

Ember now has a core, two front ends and TypeScript scripting, and the next step is to grow it towards Emacs systematically ([docs/plan.md](../plan.md)). Two questions decide how that work is done: where new commands are written, and how to tell whether Ember behaves like Emacs.

## Options considered

1. **All commands in Rust.** Fast and simple to test, but the TypeScript API only grows when someone needs it, and Ember's own commands would be in a different language from its extensions.
2. **Follow Emacs's split.** Emacs is a C core with most of the editor in Lisp. Ember writes what Emacs does in C (buffers, markers, text properties, search, keymaps, the command loop, display) in Rust, and what Emacs does in Lisp in TypeScript.

For checking behaviour:

1. **Read the manuals and compare by hand.** Slow, and gaps are found by chance.
2. **Use real Emacs as an oracle.** Run the same key sequence on the same text in `emacs -Q --batch` and in Ember, and compare text, point, mark and kill ring.

## Decision

Follow Emacs's split: new commands that Emacs writes in Lisp are written in TypeScript and ship with Ember. The existing Rust commands stay until there is a reason to move them.

Check behaviour against real Emacs. Cases live in `tests/emacs/cases/`, `tests/emacs/record.el` records Emacs's results into `tests/emacs/golden/`, and a Rust test compares Ember against the golden files. `tests/emacs/known-gaps.txt` lists the cases Ember does not match yet; the test fails if a listed case starts passing, so the list stays accurate.

## Consequences

The TypeScript API has to grow quickly, and QuickJS's speed matters sooner. Parity becomes measurable: the number of cases and known gaps is the progress report. Regenerating golden files needs Emacs installed; running the tests does not. The oracle sees behaviour, not display, so display and mouse handling still need snapshots and people trying it.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| serde, serde_json (dev) | 1 | Reading oracle cases and golden files in tests |
