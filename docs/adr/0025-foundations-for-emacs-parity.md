# 0025. Foundations for Emacs parity

Status: accepted · 2026-10-29

## Context

Ember is meant to grow into a mostly complete Emacs: Rust doing what Emacs does in C, TypeScript packages doing what its Lisp does, file by file. After twenty-four ADRs of features, two independent architecture reviews asked whether the base is shaped for that road. They agreed: the features are sound and well tested, but the runtime model under the packages differs from Emacs's in ways that every port has to work around, and each package written in today's patterns adds to a later migration. Cheap now, expensive later.

What Emacs's Lisp takes for granted and Ember lacked:

- **Reading input mid-function.** `read-string`, `y-or-n-p`, `read-key` return values; Ember's prompts take callbacks, so every port that asks a question is rewritten in continuation-passing style, and loses the command's context (current buffer, prefix argument, `this-command`, undo group) across it.
- **A module system.** `require`, `provide`, autoloads, shared helpers. Packages here are isolated scripts that share only through the `ember` API, so helpers get copied and big packages (org.ts, 7,800 lines) cannot be split.
- **Errors with conditions.** `condition-case` on `search-failed`, `file-error`, `user-error`, `quit`, `scan-error` with its data. Ember's errors are strings, and packages parse them.
- **Dynamic binding.** `(let ((inhibit-read-only t) (case-fold-search nil)) ...)`, buffer-local bindings unwound in the right buffer.
- **Values.** Functions, buffer and marker objects, propertized strings, symbols. Ember's values are null, booleans, numbers, strings and lists; buffers are named by string, markers are integer handles freed by hand.
- **Commands as functions.** Called with numbers, positions and optional arguments, returning values; here commands take strings and return nothing.
- **One edit path.** Every change through insdel.c's sequence: read-only checks (`inhibit-read-only`, `read-only` text properties), `before-change-functions`, the change, undo, markers, `after-change-functions`.
- **One regexp dialect.** Variables users copy from Emacs (`auto-mode-alist`, `outline-regexp`, `compilation-error-regexp-alist-alist`) hold Emacs regexps; some of Ember's hold JavaScript ones.
- **A general display.** Overlay strings, `display` properties, `line-prefix`, margins and `mode-line-format`; Ember's rows are buffer text, with line numbers, the mode line and the completion list each a special case.

The current buffer being tied to the selected window was a further mismatch, fixed in this round.

## Decision

These become the foundations, in this order, each landing whole with its tests before ports build on it:

1. **Errors carry a condition and data**, as Emacs's signals: an error symbol in a hierarchy (`error`, `user-error`, `quit`, `scan-error`, `search-failed`, `file-error` and its family, `buffer-read-only`, `args-out-of-range`), its data, and its message. Scripts get `ember.signal`, errors with `.symbol` and `.data`, and `ember.conditionCase`.
2. **Dynamic binding**: `ember.letBind({ var: value }, fn)`, unwinding each binding in the buffer it was made in, as `let` of a buffer-local variable does.
3. **Packages load independently**: one package failing to load leaves the others working, as an error in one Lisp file does.
4. **Emacs regexps wherever a regexp is data**: in variables, options and anything a user or Lisp code supplies, with Emacs's match data API (`lookingAt`, `reSearchForward`, `matchString`). JavaScript regexps stay fine inside a package's own code.
5. **Packages are ES modules named after Emacs features**, importing each other as Lisp files `require` each other, with a `subr` module for what subr.el and subr-x.el hold. QuickJS runs modules natively; this changes neither the language nor the runtime ([ADR 0003](0003-typescript-on-quickjs.md)). Big packages split as Emacs splits them (org-element, org-list, org-agenda, org-capture).
6. **Prompts are awaitable**: a command's `run` may be async, `await ember.readString(...)` returns the answer, and the core keeps the command's context across the wait, with prompts nesting as recursive minibuffers. Tests, the oracle and the MCP server keep a synchronous "run until idle". New ports use it once it exists; old ones move over as they are touched.
7. **Values grow handles and functions**: buffers, markers, overlays, windows and processes as objects with stable ids, markers freed when nothing refers to them, functions as values in variables and hooks, and propertized strings for the kill ring and `buffer-substring`.
8. **Commands are functions with an interactive spec**: typed parameters (number, position, region, optional), the prefix argument a declared parameter, values passed natively inside scripts and turned into strings only at the MCP and agent edge.
9. **Edits go through the editor**: Editor-level insert and delete run the full insdel.c sequence, with `inhibit-read-only`, `read-only` and `modification-hooks` text properties; `Buffer`'s raw edits become internal.
10. **Display assembles rows from text, overlay strings and display properties**, and the core formats the mode line for both front ends, retiring the special cases.

Alongside: an API naming rule (kebab-case to camelCase, `-p` to `P`; `undefined` for "nil"), a declarative table generating each native function's binding, wrapper and declaration, and an oracle that shares one scripting instance across cases.

Items 1 to 5 landed in this round, with packages loaded as ES modules through a resolver that finds a package by its feature name, a shared `subr` module, and Org's marker layer moved into `org-macs`; the oracle now runs its cases in parallel, 264 s to 34 s. Items 7 to 10 follow, each in its own ADR when it starts.

Org's agenda and capture then moved out of org.ts into `org-agenda.ts` and `org-capture.ts`, importing what they share from `org`, as org-agenda.el and org-capture.el require org; org.ts is 7,100 lines, and its lists and links are next to split, as org-list.el and ol.el.

Item 6 landed next:
- Every prompt and question returns a promise when given no `then`: `await ember.readString(...)`, `yOrNP`, `completingRead`, `readFileName` and the rest. The callback form stays for code not yet moved.
- QuickJS's job queue runs as each call from the editor into scripts finishes, so an awaiting command carries on inside the key that answered its prompt. That keeps the editor single-threaded and gives tests, the oracle and the MCP server the synchronous "run until idle" they need without an API of their own.
- Each prompt keeps the asking command's current buffer, prefix argument and name, and gives them back when the answer comes, as an Emacs command's `current-prefix-arg` and `this-command` stay bound through `read-from-minibuffer`; the command, not `exit-minibuffer`, becomes the last command.
- `C-g` rejects the promise with `quit`, so `try`/`finally`, `conditionCase` and `unwindProtect` run, as quitting unwinds a Lisp command.
- `withCurrentBuffer`, `saveExcursion`, `letBind` and `conditionCase` wait for an async body before unwinding: bindings stay in effect while the prompt waits, as a `let` does in a recursive edit.
- A rejected promise nothing handles is reported as the failing command's error, at the end of the call that rejected it.
- Prompts do not nest: one opened while the minibuffer is active is refused, as Emacs refuses it with `enable-recursive-minibuffers` off, its default. Recursive minibuffers come when something needs them.
- A command that runs another with `callInteractively` cannot yet await it; that waits for commands returning values (item 8).
- project.ts and compile's prompts moved to `await`; files.ts, dired.ts and fill.ts move as they are next touched.

Item 9 came next, as every new command added to the raw edits it would replace:
- `insdel.rs` is Emacs's insdel.c: `Editor::insert`, `insert_at`, `insert_before_markers`, `insert_and_inherit`, `delete_region`, `replace_range` and `subst_char_in_region` check, announce and make each change. `Buffer`'s own edits are crate-internal, for undo, reverting, the minibuffer and process output, as Emacs's internals bypass the checks too.
- A read-only buffer refuses unless `inhibit-read-only` is set. Text with a `read-only` property refuses deletion, and insertion where it would inherit the property, by `front-sticky` and `rear-nonsticky`, as verify_interval_modification decides; `inhibit-read-only` lifts it as t, or for the values its list holds. A string property is the error's message and data.
- `before-change-functions` run before each change and `after-change-functions` straight after it, with Emacs's arguments, unless `inhibit-modification-hooks` is set; `replace-match` is one change, as replace_range makes it.
- `kill-region` on read-only text copies it to the kill ring and then signals, or only says so with `kill-read-only-ok`, as simple.el does.
- Packages bind `inhibit-read-only` with `letBind` rather than turning `buffer-read-only` off and on.
- Still to come: before-change-functions for undo, reverting and process output, which still go straight to the buffer; and the modification hooks that changing text properties runs in Emacs.

Item 7 began with functions:
- `Value::Function` is a function as a value, as a lambda is in Lisp: variables, text properties and overlays hold them, and two are equal only if they are one function. A script's function keeps its identity across the boundary, so `ember.variable(name) === fn`.
- The editor keeps named functions, as symbols' function cells: `Editor::defun`, `fboundp`, `symbol_function` and `funcall`, which calls a function, a named one or a command. Scripts' `ember.defun` lands there, so Rust code calls script functions by name; a script still calls its own directly, so they can take objects.
- With them, changes call the `modification-hooks`, `insert-in-front-hooks` and `insert-behind-hooks` of text and overlays, in Emacs's order and with its arguments.
- Processes write their output and errors to one pipe, as Emacs's do, so they arrive in order; two pipes interleaved them by chance.
- Buffers are objects too: `Value::Buffer` holds a buffer by the id it keeps when renamed, and scripts get one object per buffer (`ember.currentBuffer()`, `getBuffer`), whose `name` follows renames and which every function taking a buffer accepts as its current name. Functions still return names, so code moves over as it is touched; compile.ts keeps `next-error-last-buffer` and its parse state by buffer, so renaming `*compilation*` keeps `M-g n` working. `rename-buffer` (`C-x x r`) came with it.
- Strings can carry text properties: `Value::Text`, as Emacs's propertized strings. `ember.propertize` makes one and `ember.bufferSubstring` gives one, `insert` puts its properties in with it, and overlay and display strings show in its faces. Kills keep their properties, and yanking leaves out those `yank-excluded-properties` names, as insert-for-yank does.
- Markers, windows and processes as objects, and markers freed when nothing refers to them, are the rest of item 7.

Item 8 then gave commands Emacs's interactive codes:
- Parameter kinds the editor fills without asking: `count` ("p", the prefix argument as a number), `prefix` ("P", as it is), `point` ("d"), `mark` ("m"), and `region-beginning` and `region-end` ("r"); and `number` ("n"), read until it is one.
- Arguments are typed: `Arg::Int` and `Arg::Prefix` beside text and keys, and a script's command gets numbers and Emacs's prefix forms (null, 3, "-", [4]).
- Code passes values, `ember.call("forward-paragraph", 2)`, and may leave a count or prefix out, which the call's prefix argument fills, as an `&optional` argument is nil. Text becomes an argument of any kind in one place, `Arg::from_text`, which the MCP server and the agent share: values turn into text only at that edge.
- The generated declarations type each command's arguments: numbers for counts and positions, optional counts.
- Commands still return nothing: functions (`defun`) are the way to return values, as most Emacs commands are called for their effect. Moving packages that read `prefixNumericValue()` themselves to `count` parameters happens as they are touched; paragraphs.ts and Org's heading motions moved.

Item 10 began with what rows show besides the text:
- An overlay's `before-string` and `after-string` show at its ends, after-strings of overlays ending at a position before before-strings of those starting there, none for an overlay its own `invisible` hides.
- A string `display` property shows in place of the text it is on, in that text's face, and an empty one hides it; `(space :width N)` and `(space :align-to COLUMN)` give space.
- Segments and glyphs say they are strings. The cursor goes on the text after an overlay string and on a display string when point is at the text it stands for, and wrapping moves a string to the next row whole.
- Still to come: strings with newlines, which end at the first; `line-prefix` and `wrap-prefix`; margins and images; and the mode line formatted by the core from `mode-line-format`.

## Review

A review of items 6 to 10 found, and the same round fixed:
- An overlay hook that changed the text ran every change hook again, its own included, without end; overlay hooks now run with change hooks off, as Emacs binds `inhibit-modification-hooks` around them.
- Overlay hooks after a change were told where it ended after `after-change-functions` had changed the text again.
- A change whose `before-change-functions` edited before it went to its old positions; it now goes where its start moved, as prepare_to_modify_buffer preserves it.
- A command awaiting a prompt answered from code already running, as a keyboard macro replays keys, carried on only once all the code had finished, out of order and without its prefix argument; promise continuations now run as each call into scripts ends.
- `C-x z` reused the count, point and region the editor had supplied the first time; repeating takes them afresh.
- A question answered by a key left the asking command's prefix argument and name in place after it.
- An empty overlay showed its after-string before its before-string; a count passed as nil failed instead of counting 1.

Still open from the review: a `display` property over a newline shows its string on each line, where Emacs hides the whole stretch.

## Consequences

Ports can follow their Lisp closely: reading input where the Lisp does, catching the conditions it catches, binding what it binds, requiring what it requires. The cost is migrating existing packages, done as each is next touched, and a larger core.

## Dependencies introduced

None yet.
