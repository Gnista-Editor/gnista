# 0026. The next foundations

Status: accepted · 2026-10-30

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

Option 2.

1. Hooks are their variables' values: lists of functions, with `t` for the global ones in a local value, depth ordering as `add-hook`'s DEPTH, and run from that list in Rust.
2. `Value::Symbol`, keywords included, and one table per symbol in the core: its value, its function (a command being a function with an interactive spec) and its property list, with advice as a wrapper on the function. `mode-line-format`, formatted by the core for both front ends, and keymaps as values follow from it.
3. The minibuffer as buffers in a minibuffer window, one per depth, with recursive minibuffers, timers running during prompts, and icomplete drawing with ordinary overlays.
4. Then window objects with start markers and configurations, completion tables as functions, `syntax-table` properties, and autoloads, each when it starts, in an ADR of its own.

## Progress

Step 1 landed with this ADR: a hook's entries are function values with a depth, a buffer's local value holds `t` where the global functions run, `add-hook`'s ordering and its refusal to add a function twice are Emacs's, and the hook's variable shows its functions, with true for `t`. Hooks run in Rust, `run-hook-with-args-until-success` and `-until-failure` included, so functions added from Rust run there too, and scripts add and remove a function by itself rather than by an id kept under the buffer's name, which renaming the buffer broke. Setting a hook's variable replaces its functions, names of functions included, and `letBind` binds a hook as its list, as `let` does.

Step 2 began: `Value::Symbol` is a symbol, keywords included, which scripts see as JavaScript's registered symbol of its name, so `ember.intern("space") === ember.intern("space")`, as `eq` is. Symbols have property lists, `ember.put` and `ember.get`, and a command's name is its symbol, so delsel reads each command's `delete-selection` property, as Emacs's does, rather than keeping a list. Display specs take symbols. Of step 3, timers now run while a prompt is open, as Emacs's do, with the minibuffer current, and the agent's special timer for prompts is gone; it rests on code being able to make another buffer current during a prompt, fixed with the compilation bug above. Still to come in step 2: the symbol's value and function in the same table, advice, and `mode-line-format` and keymaps as values built on them.

Of step 4, scanners read `syntax-table` properties where `parse-sexp-lookup-properties` is set, a property being a descriptor string such as `"."`, where Emacs's is a syntax cons; a mode's `syntax-propertize-function` runs over text before scans from scripts reach it, in stretches of whole lines, and edits and property changes drop the parse states and properties after them. rust-ts-mode uses it for char literals, as its Emacs counterpart does, which closes [ADR 0024](0024-processes-compiling-comments-and-indentation.md)'s open item about `'"'`. The core's own scans, such as the electric commands in Rust, do not call it yet.

Keymaps are values: `Value::Keymap`, a prelude `Keymap` object in scripts, kept in the editor's store and bound by id, so a prefix map is shared wherever it is bound. A keymap's name is a variable holding it, as `global-map`, `ctl-x-map`, `ctl-x-4-map`, `ctl-x-5-map`, `ctl-x-x-map`, `narrow-map`, `help-map` and `project-prefix-map` are, and every function that took a keymap's name takes a keymap too: `define-key` (`defineKey`, and `bindKey` with a keymap as the binding for a prefix or null to unbind), `make-sparse-keymap`, `keymap-parent`, `set-keymap-parent`, `lookup-key`, `current-active-maps`, transient and overriding maps, and keymap and local-map text properties. Where a keymap and its parent both bind a prefix key to keymaps, the keys after it are looked up in both, the keymap's first, as Emacs composes them, so a mode's `C-c` bindings do not hide its parent's. A minor mode still names its keymap.

Before keymaps were values, text and overlays could already carry keys: a `keymap` property at point comes before the minor modes' maps and a `local-map` property stands in for the buffer's own, read where Emacs's get_local_map reads them, so links and buttons can bind RET and the mouse. The property holds a keymap or a keymap's name.

A completion table can be a function of the input that gives the names, as Emacs's `completion-table-dynamic` makes one: the editor calls it as the prompt opens and after each command, and the completion styles apply to what it gives. Tables with Emacs's whole protocol (the action argument, boundaries and metadata) and `completion-at-point` remain.

Step 2 went on with one table: `symbols.rs` holds each name's variable, a hook's global functions, its function cell and its property list, where five tables kept them before. A function cell holds a function, a command (a function with an interactive spec, its parameters), or another name, as `defalias` makes; defining a function of a command's name replaces the command, as `defun` without `interactive` does, and the variable and properties of the name stay. `funcall` on a command makes its parameters from the values, numbers for counts and positions and Emacs's forms for a raw prefix argument. Advice is nadvice.el's: `advice-add` with each HOW, depths, and replacing by function or name, kept beside the function cell so it stays when the function is defined again, and applied wherever a call goes by name: keys, M-x, `ember.call`, `funcall` and hooks that hold names. An alias's own advice applies to calls through it. The built-in commands that counted with the prefix argument (`forward-char`, `delete-char`, `kill-word` and the rest, and the search commands) take the count as a parameter instead, as Emacs's `(forward-char N)`, so code passes it and advice sees it. Calling a function held as a value, as `symbolFunction` gives it, does not go through the name's advice, unlike Emacs, where the advice is in the function cell; and a script function advised is called with editor values only.

## Review

A review of the work under this ADR found, and the same round fixed:
- `syntax-propertize` started where the last edit was rather than at its line's start, so a char literal typed a key at a time, with show-paren scanning between keys, was never marked.
- Visiting a file, killing a buffer, selecting a window or fontifying during a prompt left the minibuffer wrongly current or not: a file visited from the minibuffer got no major mode, and text inserted after a kill went to the wrong buffer.
- A dynamic completion table threw away icomplete's rotation after every command; it now keeps it while the names are the same.
- A hook with a local value was not local to `letBind` or `isLocalVariable`; a local value whose functions were all removed stayed as `[t]`.
- A hook function returning an object did not count as success in `run-hook-with-args-until-success`; what is not an editor value now counts as t.
- A keymap property on the last character applied at the end of the buffer even where it was rear-nonsticky.

A fuzzer also found `DEL` deleting electric pairs twice undoing in two steps; `delete-char` now calls `undo-auto-amalgamate` whoever calls it, as Emacs's does.

Still open: setting a hook's variable drops its depths, and its named entries cannot be removed with `removeHook`; a propertize function that throws leaves its stretch undone, as in Emacs.

## Consequences

Ports can keep following their Lisp closely: dispatch hooks, symbol properties, keymaps in text and recursive minibuffers are what the next large ports (completion-at-point, eglot-style backends, Org's links and agenda keys, isearch's minibuffer) are written against. The cost is a second migration of the packages that use hooks, and of the mode line in both front ends; the mode line keeps each front end's look, which its snapshots check.

## Dependencies introduced

None.
