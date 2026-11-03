# 0056. Grammars from shared libraries

Status: accepted · 2026-11-03

## Context

Ember compiled in four tree-sitter grammars, each a crate with its own highlighting query. A daily-driver configuration wants many more languages (Go, Nix, YAML, TOML, Bash and the rest), and Emacs users already have them built as shared libraries in `~/.emacs.d/tree-sitter`, which `treesit-install-language-grammar` makes. Emacs's modes highlight with their own `treesit-font-lock-rules`, not the grammar's query, which the libraries do not carry anyway.

## Options considered

1. **A crate for each grammar.** Each needs a release, adds compile time and size to every build, and Ember would choose the languages rather than the user.
2. **Load the libraries Emacs builds.** `libtree-sitter-LANG.dylib` (or `.so`) along `treesit-extra-load-path`, then `tree-sitter` in `user-emacs-directory`, by its `tree_sitter_LANG` function, as `treesit-load-name-override-list` can rename; the mode gives its font-lock rules, which the core applies with Emacs's override semantics.

## Decision

Option 2. Grammars that ship stay as they are; any other language is looked for when a parser, query or `treesit-language-available-p` asks for it. A mode sets `treesit-font-lock-settings` and `treesit-font-lock-feature-list`, and `treesit-major-mode-setup` passes the rules enabled at `treesit-font-lock-level` to the core, which then highlights with them in place of the grammar's query. go-ts-mode is the first such mode, ported from Emacs's.

## Consequences

- A user's Emacs grammars work in Ember by adding `~/.emacs.d/tree-sitter` to `treesit-extra-load-path`, or copying them to `~/.config/ember/tree-sitter`.
- Loading a library runs its code, as Emacs's loading does: the libraries are trusted as the user's own.
- A library built for a tree-sitter ABI this one does not read is refused with the reason, which `treesit-language-available-p` gives with DETAIL.
- Rules use tree-sitter's own predicates (`#match?`) for highlighting; Emacs's Lisp predicates in a highlighting rule are not checked yet.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| libloading | 0.8 | Opening grammar libraries and finding their language function. Already in the build through other crates. |
| tree-sitter-language | 0.1 | Turning that function into a tree-sitter language. Already in the build through the grammar crates. |
