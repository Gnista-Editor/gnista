# 0008. Tree-sitter highlighting

Status: accepted · 2026-10-27

## Context

The second slice of milestone 3 in [the plan](../plan.md) is syntax highlighting. Emacs has two ways to highlight: font-lock's regular expressions, written in Lisp, and, since Emacs 29, tree-sitter parsers through `treesit.el`, with major modes such as `rust-ts-mode`. Ember draws from display rows that the core computes ([ADR 0007](0007-text-properties-faces-and-display-rows.md)), so highlighting has to give faces to those rows.

## Options considered

1. **Font-lock with regular expressions, in TypeScript.** Closest to classic Emacs, but slow to run on every edit from a script, and every language would need its keywords written by hand.
2. **Tree-sitter in the core, with grammars compiled in.** One primitive, as `treesit.el` is a C primitive in Emacs. Grammars ship their own highlighting queries.
3. **Tree-sitter with grammars loaded at run time.** More languages without rebuilding, but needs dynamic libraries and a place to get them from.

## Decision

Tree-sitter in the core, with a few grammars compiled in: Rust, JavaScript, JSON and Python.

- A buffer gets a syntax tree when its major mode calls `ember.treesitParserCreate(language)`, as an Emacs mode calls `treesit-parser-create`. Changing the major mode removes it, since modes start by killing local state.
- Every insertion and deletion tells the tree what changed. The tree is reparsed lazily, from the rope's chunks and the old tree, when a window next draws the buffer, so a burst of edits costs one parse.
- Only the rows being drawn are queried. Each capture name maps to an Emacs 29 face: `keyword` to `font-lock-keyword-face`, `string` to `font-lock-string-face`, `number` to `font-lock-number-face`, and so on, trying `keyword.control` then `keyword` for longer names. Inner captures win over outer ones.
- Syntax faces come last, below overlays and text properties, so a property or overlay can always restyle code.
- `prog-mode.ts` and `treesit-modes.ts` define `prog-mode` and `rust-ts-mode`, `js-ts-mode`, `json-ts-mode` and `python-ts-mode` built on it, and add them to `auto-mode-alist`.
- Scripts can ask for the node at a position with `ember.treesitNodeAt`, a start towards structural commands and indentation.

## Consequences

Highlighting works the same in both front ends with no front end code. More languages mean more crates and a bigger binary; run-time grammars can come later behind the same API. Indentation, `treesit-font-lock-level` and per-mode queries written in TypeScript are not done yet.

## Dependencies introduced

- `tree-sitter` 0.27: incremental parsing and queries.
- `tree-sitter-rust`, `tree-sitter-javascript`, `tree-sitter-json`, `tree-sitter-python`: the grammars and their highlighting queries.
- `regex` 1 is also added to `ember-core` now, for searching in milestone 4.

None of these use the network.
