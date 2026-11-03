# Code review, 2026-11-03

A review of the whole codebase after step 4 of [the threading plan](multithreading.md), by five independent reviewers, one per area: the core's text model (buffers, undo, text properties, regexps, syntax, codings, files), the core's editor (command loop, windows, display, threading, processes), the script crate and both engines, the TypeScript packages, and the front ends with the agent and MCP. Each read its area cold and reported findings with their place in the code; the high ones were checked against the code before being listed here. Behaviour against Emacs was out of scope: the oracle and the fuzzers check that.

## The verdict

The architecture holds up everywhere. Every reviewer called its area sound and deliberately Emacs-shaped: one editor on its own thread behind an ordered channel, front ends that draw only from the frame description, a real gate for every edit (`insdel.rs`), undo that records property changes and marker moves as Emacs's does, a regexp engine that follows regex-emacs.c, the natives table as the right abstraction for two engines, small and justified unsafe code with true SAFETY notes, strict TypeScript packages split along Emacs's own files, and careful handling of the API key. Nothing found depends on one JavaScript engine's ways.

The weaknesses are at the seams, and fall in four groups, in the order to fix them.

## 1. Safety, hangs and crashes

Each of these takes the editor down, hangs it from a keystroke, or lets something act without the user's say.

| | Where | What |
| --- | --- | --- |
| 1.1 | `ember-gui/src/app.rs:259`, `ember-mcp/src/lib.rs:160`, `ember-core/src/driver.rs:271` | **An MCP client can answer Ember's own agent's approval question.** Socket requests run with the agent flag off, and the driver runs them inside any prompt that waits, so `press_keys "y"` answers "Let the agent write …?". Set the flag for socket requests and ask as the agent does, and refuse keys into a question the client did not open. |
| 1.2 | `ember-agent/src/lib.rs:266,476`, `ember-core/src/editor.rs:1252` | **The agent's tools run inside a prompt the user has open**, as the agent's pump is a timer and timers run in nested loops; its keys answer the user's question, and keys left over after an answer run as the user's, past the permission check. Run tools only when no prompt is open or the agent opened it; drain leftover keys before clearing the flag. |
| 1.3 | `ember-core/src/filefns.rs:306`, `fileops.rs:206` | **`make-temp-file` writes anywhere, and `vc_files` runs git, without `check_permission`.** |
| 1.4 | `ember-core/src/search.rs:191` | **Backward literal search is quadratic** in the distance to the match: `C-r` with the nearest match a megabyte back never finishes. Only the few starts after the last non-overlapping match need trying, each against a short slice. |
| 1.5 | `ember-core/src/regexp.rs:533` | **`\(?N:…\)` takes any N** and allocates slots for that many groups: `\(?4000000000:x\)` at `C-M-s` brings the editor down. Emacs refuses N over 255. |
| 1.6 | `ember-core/src/filelock.rs:161,96` | **A lock file Ember can neither read nor delete loops forever** on the first edit of the file. Tell "stale, deleted" from "cannot read or delete", and bound the retries. |
| 1.7 | `ember-core/src/process.rs:1155` | **`call-process` blocks the editor thread** with no quit and no timeout; a program that never exits freezes Ember, and it cannot even exit. Read on a thread, check for quit, kill the child on quit. |
| 1.8 | `ember-core/src/driver.rs:180,265`, `editor.rs:855` | **`C-g` is lost after a key queued just before it**: that key's command clears the quit flag `C-g` set, so `C-g` is dropped. Count quits taken rather than reading the flag. |
| 1.9 | `ember-core/src/driver.rs:364`, `editor.rs:549,1140,1302` | **After an internal error the command loop's counters stay wrong**: `running` and `in_change_hooks` have no unwind guard, so after one panic every command is treated as nested (no undo boundaries, the quit flag never cleared, change hooks off). Drop guards, and a reset in `guarded`. |
| 1.10 | `ember-script/src/natives.rs:64` (V8 arm) | **A panic in a native aborts the editor on V8**, as V8's callbacks are `extern "C"`; QuickJS catches it. Run each native under `catch_unwind` and throw an InternalError. |

## 2. Wrong results and leaks over time

Each of these is wrong only after a while, or in a case the tests do not make, and shows up after hours of use or in a user's init.ts.

| | Where | What |
| --- | --- | --- |
| 2.1 | `packages/org-agenda.ts:76,377` | **Agenda lines hold positions as numbers**: after `t` changes an entry's text, later entries in the same file point at the wrong place. Markers, as compile.ts keeps. |
| 2.2 | `packages/org-macs.ts:12`, `org.ts:2635` and most of 55 `marker(` sites | **Org's markers leak on quit or error**, dropped only on the normal path, and every later Org edit walks them. A `withMarker` that drops in `finally`. |
| 2.3 | `packages/org.ts:1339` | **Delayed fold reveals run in whatever buffer is current** at the end of the command: from the agenda or capture, the agenda is unfolded and the Org file's fold stays broken. |
| 2.4 | `comint.ts:47`, `shell.ts:17`, `hi-lock.ts:45`, `view.ts:6`, `diff.ts:70`, `bookmark.ts:23`, `ansi-color.ts:102`, `tabulated-list.ts:465` | **Per-buffer state in module maps keyed by buffer name**: renaming a shell loses its history and directory stack, hi-lock highlights in a renamed buffer cannot be removed, killed buffers leave entries. Buffer-local variables, as Emacs keeps them. |
| 2.5 | `packages/org.ts:425,7700` | **Org's heading index is never dropped** when its buffer is killed (indirect buffers, capture, agenda visits). |
| 2.6 | `packages/recentf.ts:58` | **`recentf-exclude` is compiled as a JavaScript regexp**, not an Emacs one; a user's Emacs pattern mismatches or throws inside the find-file hook. |
| 2.7 | `packages/org-capture.ts:79` | Capture's origin point is a number while the origin buffer stays editable beside it. |
| 2.8 | `ember-script/src/v8engine/mod.rs:77,946` | **V8 keeps every editor function given to a script**, for the isolate's life, and some close over the engine itself, a cycle that never frees the isolate (around-advice would leak one per call). |
| 2.9 | `ember-script/src/prelude.js:227` | **A marker that has once been an editor value is never freed**: `markersKept` only grows, on both engines. |
| 2.10 | `ember-script/src/v8engine/bindings.rs:79`, `quickjs/bindings.rs:60` | **Out-of-range numbers convert differently**: V8 saturates (`gotoChar(-1)` is 0), QuickJS throws. Pick one for both. Smaller drifts: thrown non-Error objects, `[x]` prefixes, frozen functions, over-long strings. |
| 2.11 | `ember-script/src/natives/text.rs` (`deleteMarker`), `lib.rs:304` | FinalizationRegistry cleanups go through safe points, so a `C-g` pending then makes them throw and the marker is never deleted: `#[safe_point = false]`. |
| 2.12 | `ember-core/src/buffer.rs:2079,719` | **Undoing entries that no longer fit the buffer panics**: a `buffer-undo-list` set by a script is not checked as `undo_in_region` checks. |
| 2.13 | `ember-core/src/buffer.rs:1104,2223` | **Changing the case of ß right after an insertion corrupts the insertion's undo entry**, through typing amalgamation the trial edits do not take back. |
| 2.14 | `ember-core/src/editor.rs:1174` | `call_interactively` reports a quit as success once keys were typed into its prompt. |
| 2.15 | `ember-core/src/driver.rs:167` | `Driver::settle` can return before the keys it waits for ran, when a process woke the loop: driven tests with a process can flake. |
| 2.16 | `ember-core/src/driver.rs:247` | A panic or re-entry in `describe` publishes empty frames: the window goes blank until the next input. |
| 2.17 | `ember-core/src/keyboard.rs:281`, `editor.rs:1205` | Nested prompts and recursive edits have no depth limit, and overflow the stack rather than signalling `excessive-lisp-nesting`. |
| 2.18 | `ember-mcp/src/socket.rs:36` | The socket's directory is chmodded whatever it is (`EMBER_SOCKET=~/x.sock` makes home 0700) and the default one is not checked for its owner, which matters on Linux's shared `/tmp`. |
| 2.19 | `ember-agent/src/api.rs:103,138`, `lib.rs:344` | The API connection has no timeouts, a mid-stream error is reported as "ended early", and a block index from the stream is used unbounded. |
| 2.20 | `ember-agent/src/lib.rs:163,207` | A killed `*agent*` buffer's history is reused by the next `M-x agent`; buffers the agent opens in a turn are not folded into one undo step. |
| 2.21 | `ember-core/src/timers.rs:145` | A timer cancelled by an earlier timer in the same round still runs. |

## 3. Large buffers

Each of these is work that grows with the buffer, the number of overlays or text property runs, where the aim is to be faster than Emacs everywhere.

| | Where | What |
| --- | --- | --- |
| 3.1 | `ember-core/src/properties.rs:75-178` | **Text properties are a flat list rebuilt on every edit**, and restoring saved properties (undo, yank) is runs × saved runs: undoing `C-x h C-w` in a fully fontified 50,000-line Org file hangs. Find the affected window by halving and splice. |
| 3.2 | `ember-core/src/search.rs:178` | Forward literal search copies the rest of the buffer for each search. |
| 3.3 | `ember-core/src/buffer.rs:2221` | Typing amalgamation counts the whole run's characters on every insertion: quadratic for process output (`cat` of a large file in `*shell*`). |
| 3.4 | `ember-core/src/insdel.rs:104` | `subst-char-in-region` runs `after-change-functions` once per character. |
| 3.5 | `ember-core/src/rows.rs:356` | With lines truncated, every row on the way to point scans every overlay. |
| 3.6 | `ember-core/src/faces.rs:831` | The style cache is bypassed whenever `face-remapping-alist` is set (text scaling, `variable-pitch-mode`). |
| 3.7 | `ember-core/src/fontify.rs:156`, `frame_description.rs:171` | Each window's rows are built three or four times per frame. |
| 3.8 | `ember-core/src/textprop.rs:79-220`, `insdel.rs:240` | Overlay searches backward and the modification-hook scan pass over every overlay. |
| 3.9 | `ember-core/src/coding.rs:723-812` | Encoding non-ASCII text takes a lock per character, a new encoder per character, and a second pass. |
| 3.10 | `ember-core/src/fileio.rs:272`, `filefns.rs:398` | Reverting a buffer keeps four copies of the text, in two copies of the same code. |
| 3.11 | `packages/org-agenda.ts:88,149` | The agenda reads every line of every file once a day of the week, with `matchAll`. |
| 3.12 | `packages/org.ts:3744` | `org-indent-region` parses the section again after every line it indents. |
| 3.13 | `ember-core/src/buffer.rs:565` | Reading `buffer-undo-list` copies the whole history. |

## 4. Architecture and upkeep

None of these is a bug today; each makes the next ones likelier.

- **Undo out of `buffer.rs`**: 900 of its 2,400 lines are undo, with invariants spread over seven fields, where 2.12, 2.13 and 3.3 are. An `undo.rs`, as `textprop.rs` and `indirect.rs` already extend `Buffer`.
- **One value layer for both engines**: the natives table is shared, but the conversions, `ScriptFunction`, `defineCommand` and `enter` are written twice (about 450 lines each) and have begun to drift (2.10). A small per-engine trait of the operations they need would make it one module.
- **`Editor`'s key reading and kill ring into structs of their own** (`keyboard::Keyboard`, a kill ring), from an `Editor` of 110 fields.
- **org.ts along Org's own files**: org-list, org-fold, org-element, ol, org-refile, with the seams already marked; and org's self-insert commands back in org.ts from org-table.ts.
- **Packages that copy instead of import**: three `forwardLine`s with different narrowing, `regexpQuote` inlined ten times, org-table's copies of org's helpers; `allMatches` moved to subr for every package; `matchAll` left in imenu, treesit-modes, simple, fill and org-table.
- **Conditions**: about 60 places throw a plain `Error` where Emacs signals `user-error`; two packages match scan errors by message.
- **The front ends' shared code**: click counting and window layout are written once for the GUI and once for the terminal; the terminal polls 60 times a second and does not listen on the agent socket.
- **Comments that no longer match**: timers.rs and process.rs say the editor has no thread of its own, minibuffer.rs that prompts do not wait, app.rs that it draws from editor state, natives.rs that defineCommand is in lib.rs, docs/layout.md that the script crate is QuickJS's; and orphaned doc comments in editor.rs, org.ts and prelude.js.
