# 0020. Completion and icomplete

Status: accepted · 2026-10-29

## Context

Opening files and finding things starts in the minibuffer, so completing there has to be as good as Emacs's. Ember drew a list of completions after the input, `{one | two}`, in each front end, from a prefix match. Its completion styles matched names in their own way, ignored where point was, and TAB completed to the longest common prefix. Nothing but commands' parameters could prompt: a command could not ask partway through for one of a list, or for a file name with a prompt of its own, which recent files, Dired and projects all need.

Emacs splits this between minibuffer.el, where styles become patterns and completing merges what the matches share, and icomplete.el, which shows the completions in an overlay after the input, with fido-mode for keys like ido's and vertical modes that list them down a minibuffer that grows.

## Options considered

1. **Keep drawing the list in each front end**, adding a vertical layout and selection there. Little to port, but icomplete's formats, its keys and fido's directory walking would be the front ends' own, unlike Emacs's and untested against it.
2. **Port icomplete.el as a package**, drawing through a minibuffer overlay the core keeps, and port the parts of minibuffer.el it rests on to the core, where Ember's completion already is.

## Decision

Option 2.

- **Reading partway through a command** (`minibuffer.rs`): `read_from_minibuffer` with a `Reading` gives Emacs's `completing-read` (a collection, `require-match`, a default, a history), `read-file-name` (a directory, and the default when the input is left as it started) and `read-string`; scripts have `ember.completingRead`, `readFileName` and `readString`. As with questions ([ADR 0018](0018-files-and-saving.md)), the command returns and the answer runs a function given with it. Opening a prompt resets the minibuffer's local variables, hooks and keymaps and runs `minibuffer-setup-hook`; closing it runs `minibuffer-exit-hook`. Local keymaps can be composed over each other (`ember.composeLocalMap`), as Emacs's `make-composed-keymap`, and prompts that must be answered by a match get `minibuffer-local-must-match-map`, where RET is `minibuffer-complete-and-exit`.
- **Styles as patterns** (`completion.rs`): basic, emacs22, substring, flex and partial-completion each turn the input, split at point, into a pattern of text and wildcards, matched from the start of a name, as minibuffer.el does. Completing merges what the matches share around each wildcard, as `completion-pcm--merge-completions`: TAB and RET complete `f-f` to `find-file`, and flex completes `l` to `il` when every match has it. File names complete within their directory part, their completion boundaries; ignore case where the file system does (`read-file-name-completion-ignore-case`, on for macOS); list every entry with `./` and `../`, in Emacs's order; and pass over `completion-ignored-extensions` when completing.
- **The order** (`completion_all_sorted_completions`), as `completion-all-sorted-completions`: shortest first, then alphabetical, then the history's, with the default first; flex matches best first, equals in the table's order. The core keeps the sorted list until the input changes, and commands rotate it with `ember.cacheAllSortedCompletions`, as icomplete's do.
- **icomplete.ts** follows icomplete.el: `icomplete-mode`, on by default where Emacs leaves it off, as Ember always listed completions; `fido-mode`; `icomplete-vertical-mode`; `fido-vertical-mode`; their keymaps and commands; the `[…]` and `{…}` formats, `[Matched]` and `[No matches]`; command keys after M-x's completions in a vertical list; and the `3/14` count of a list that scrolls. It shows the list with `ember.setMinibufferOverlay`, an overlay's before-string and after-string, which both front ends draw, a newline starting another line. The echo area grows to fit, up to `max-mini-window-height`, and only grows while a prompt is open, as `resize-mini-windows`' grow-only. The MCP server's screen tool shows the list too.
- **An oracle for icomplete.** Batch Emacs reads the minibuffer from standard input, so the usual oracle cannot see icomplete. `tests/emacs/icomplete/record.el` runs Emacs on a pseudo-terminal instead (`script -q /dev/null emacs -Q -nw`), feeding keys from timers, and records what the minibuffer shows after each key. Hand-written cases are compared on every test run; an ignored fuzzer makes random ones. After the fixes it led to, 690 random cases over five seeds match.

## Consequences

Completion in Ember now behaves as in Emacs, down to where point is, and other code can prompt for anything with completion, as recent files, Dired and projects next will. `fido-vertical-mode` in `init.ts` gives the list most people like. The completion code moved from front ends and simple matching to the core's patterns, which Emacs keeps in Lisp; it stays in Rust because the core already completed, and every prompt needs it.

Left out: the `*Completions*` buffer, so TAB shows a message where it cannot complete further; `completion-category-overrides` and the categories' own styles, other than fido's flex; annotations and grouping beyond command keys; killing the selected completion with fido's C-k, which needs a minibuffer inside the minibuffer; `icomplete-in-buffer`; and icomplete's delay before computing completions while typing fast.

## Dependencies introduced

None. The oracle needs `script`, which macOS and Linux have.
