# 0026. The next foundations

Status: proposed · 2026-10-30

## Context

[ADR 0025](0025-foundations-for-emacs-parity.md) set ten foundations, and most landed in one round, with two reviews of the work and their fixes. A third review then asked the same question again: where does Ember's runtime model still differ from Emacs's in ways every future port will have to work around? It read the core, the script layer and a sample of packages, and ranked what remains by what leaving it would cost.

1. **The minibuffer is not a buffer in a window.** `Editor::buffer()` gives the minibuffer whenever a prompt is open; timers wait while one is; icomplete draws through a special minibuffer overlay; the agent has its own kind of timer to run during prompts. This blocks recursive minibuffers, `C-x o` out of the minibuffer, `read-from-minibuffer`'s keymap argument, `read-key` and recursive edits, and every package that runs in the background has to learn the rule. One live bug came from it: compilation output arriving during `M-x` went into the minibuffer. It is fixed, by making "the minibuffer is current" state that `set-buffer` changes, but the structure stays.
2. **Values have no symbols.** Strings stand for both text and names, so data cannot say which it means: `mode-line-format` needs it (a string to show, or a variable whose value to show), as do `:eval` forms, display specs and keymaps. Per-buffer state that would be a buffer-local variable lives in package side tables instead, which killing the buffer and `kill-all-local-variables` do not clear, and `C-h v` cannot show.
3. **Hooks are kept apart from their variables.** Functions are always added first, with no depth or append; a hook's variable shows names, and setting it does nothing; a local hook has no `t` for where the global functions run; `run-hook-with-args-until-success` skips functions added from Rust. The `-functions` dispatch hooks every backend uses need these: `completion-at-point-functions`, `xref-backend-functions`, `project-find-functions`, `kill-buffer-query-functions`.
4. **Keymaps are not values.** A binding is a command name or a copy of a prefix map, so a prefix map cannot be shared (`ctl-x-4-map`, `project-prefix-map`), and text cannot carry `keymap` or `local-map` properties, which links and buttons need.
5. **No symbol properties or advice.** delsel lists the commands that replace the region instead of reading their `delete-selection` property; Org advises by hand.
6. **A window's start is a line, and the selected window's point lives in the buffer.** No window configurations or parameters, so `save-window-excursion`, `quit-window`'s restore, winner and ediff wait, and a window cannot start partway through a wrapped line.
7. **Completion tables are lists of strings.** No completion function, metadata or `completion-at-point`.
8. **Scanners ignore `syntax-table` properties**, so modes whose syntax depends on context (Python's triple quotes, Rust's raw strings and char literals, JS regexps) cannot use `syntax-propertize`.
9. **Every package loads at startup**, with no autoloads or `with-eval-after-load`.

Smaller: undo has no `buffer-undo-list` to inspect or turn off, and file operations have no `file-name-handler-alist`.

## Options considered

1. **Take them in the review's order** (minibuffer, symbols, hooks).
2. **Cheapest first**: hooks, then symbols, then the minibuffer, as hooks touch little and unblock the most ports, and symbols are needed before the mode line and keymaps can be values.
3. **Leave them until a port needs each**, as ADR 0025 did for some items.

## Decision

Proposed: option 2.

1. Hooks are their variables' values: lists of functions, with `t` for the global ones in a local value, depth ordering as `add-hook`'s DEPTH, and run from that list in Rust.
2. `Value::Symbol`, keywords included, and one table per symbol in the core: its value, its function (a command being a function with an interactive spec) and its property list, with advice as a wrapper on the function. `mode-line-format`, formatted by the core for both front ends, and keymaps as values follow from it.
3. The minibuffer as buffers in a minibuffer window, one per depth, with recursive minibuffers, timers running during prompts, and icomplete drawing with ordinary overlays.
4. Then window objects with start markers and configurations, completion tables as functions, `syntax-table` properties, and autoloads, each when it starts, in an ADR of its own.

## Progress

Step 1 landed with this ADR: a hook's entries are function values with a depth, a buffer's local value holds `t` where the global functions run, `add-hook`'s ordering and its refusal to add a function twice are Emacs's, and the hook's variable shows its functions, with true for `t`. Hooks run in Rust, `run-hook-with-args-until-success` and `-until-failure` included, so functions added from Rust run there too, and scripts add and remove a function by itself rather than by an id kept under the buffer's name, which renaming the buffer broke. Setting a hook's variable to a list does not change the hook yet.

Step 2 began: `Value::Symbol` is a symbol, keywords included, which scripts see as JavaScript's registered symbol of its name, so `ember.intern("space") === ember.intern("space")`, as `eq` is. Symbols have property lists, `ember.put` and `ember.get`, and a command's name is its symbol, so delsel reads each command's `delete-selection` property, as Emacs's does, rather than keeping a list. Display specs take symbols. Still to come in step 2: the symbol's value and function in the same table, advice, and `mode-line-format` and keymaps as values built on them.

## Consequences

Ports can keep following their Lisp closely: dispatch hooks, symbol properties, keymaps in text and recursive minibuffers are what the next large ports (completion-at-point, eglot-style backends, Org's links and agenda keys, isearch's minibuffer) are written against. The cost is a second migration of the packages that use hooks, and of the mode line in both front ends; the mode line keeps each front end's look, which its snapshots check.

## Dependencies introduced

None.
