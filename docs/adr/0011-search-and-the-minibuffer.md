# 0011. Search, replace and the minibuffer

Status: accepted · 2026-10-27

## Context

Milestone 4 in [the plan](../plan.md) is searching and the minibuffer: incremental search, `query-replace`, regular expressions in Emacs's syntax, minibuffer history and better completion. In Emacs the search primitives and the regexp engine are C, while `isearch.el`, `replace.el` and the completion styles are Lisp. Isearch and query-replace are modal: while they run, keys mean something else, and a key they do not know ends them and then runs as usual.

## Options considered

For regular expressions:

1. **Write an Emacs regexp engine.** Exact, back-references included, but a large piece of work and slow to get right.
2. **Translate Emacs syntax to the `regex` crate.** Already a dependency ([ADR 0008](0008-tree-sitter-highlighting.md)). Fast and linear time, but it has no back-references or look-around.

For the modal commands:

1. **Write isearch and query-replace in Rust.** Simple to drive, but against [ADR 0005](0005-rust-core-typescript-commands.md), and scripts could not build their own modal commands.
2. **Give scripts the primitives Emacs's Lisp uses.** An overriding keymap, a keymap default binding, and unread keys, then write the commands in TypeScript.

## Decision

Translate regexps to the `regex` crate, and give scripts the primitives for modal commands.

**Regular expressions** (`search.rs`): `\(`, `\)`, `\|`, `\{m,n\}`, `\(?:`, `\<`, `\>`, `\b`, `\w`, `\W`, `\s-` and the other syntax classes, `` \` ``, `\'`, `[[:alpha:]]` and the other classes, and bare `(`, `)`, `|`, `{` and `}` as literals. `*` at the start of an expression is literal, and `^` and `$` are anchors only where Emacs treats them so. `\<` and `\>` become the crate's `\b{start}` and `\b{end}`. Back-references are an error, and symbol boundaries are word boundaries.

**Searching**: forward and backward search over the buffer, a backward match ending by where the search starts, as in Emacs. Match data with groups, `replace-match` with `\&` and `\N`, replacements following the case of what they replace, `case-fold-search` and `search-upper-case`. `search-forward`, `search-backward`, `re-search-forward` and `re-search-backward` are commands; scripts use `ember.search`, which does not move point.

**Modal commands**: `Editor::set_overriding_map` puts a named keymap ahead of all but a transient map, as Emacs's `overriding-terminal-local-map`. A keymap can have a default binding for keys it does not bind, as an Emacs keymap's `[t]`. `Editor::unread_keys` makes keys the next read, as `unread-command-events`. With these:

- `isearch.ts` follows `isearch.el` (and since [ADR 0042](0042-isearch-state-and-comint-history-search.md) keeps its state and hooks): `C-s`, `C-r`, `C-M-s`, `C-M-r`, wrapping after a failure, `DEL`, `C-g`, `C-w`, `C-y` and `M-r`, the current match in the `isearch` face and the others nearby in `lazy-highlight`, prompts worded as Emacs words them, and `search-ring`.
- `replace.ts` follows `replace.el`: `query-replace` (`M-%`), `query-replace-regexp` (`C-M-%`), `replace-string` and `replace-regexp`, on the region when it is active from a key or M-x. The keys while asking are `y`, `SPC`, `n`, `DEL`, `!`, `.`, `,`, `^`, `q`, `RET` and `C-g`.
- Neither blocks: each key is its own command, so the editor keeps drawing between them.

**History**: each prompt has a history variable, by Emacs's names: `extended-command-history`, `file-name-history`, `buffer-name-history`, `minibuffer-history`, and `query-replace-history` for the replace commands. A command parameter can name its own. `M-p`, `M-n`, `<up>` and `<down>` go through it, with Emacs's messages at either end, and `history-length` limits it.

**Completion**: `completion-styles` lists the styles, tried in order until one matches: `basic` and `emacs22` by prefix, `partial-completion` word by word, so `s-w-b` completes to `split-window-below`, `substring` and `flex`. The default is Emacs's, `basic`, `partial-completion` and `emacs22`. File names still complete by prefix only.

## Consequences

The oracle checks isearch and the replace commands against Emacs, with cases that call a command with its arguments before typing keys, since batch Emacs reads the minibuffer from standard input. `C-g` hangs batch Emacs, so quitting is covered by headless tests. Each replacement is a separate undo step, where Emacs can undo a whole `query-replace` at once. Searching copies the buffer into a string each time, which is fine for ordinary files and will want the rope searched directly for large ones. Isearch's own history keys (`M-p` and `M-n` while searching) and partial completion of file names are not done yet.

## Dependencies introduced

None: `regex` was added with [ADR 0008](0008-tree-sitter-highlighting.md).
