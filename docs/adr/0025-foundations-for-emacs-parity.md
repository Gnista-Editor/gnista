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
- Still to come: the `modification-hooks`, `insert-in-front-hooks` and `insert-behind-hooks` properties of text and overlays, which hold functions and so wait for functions as values (item 7); and before-change-functions for undo, reverting and process output, which still go straight to the buffer.

## Consequences

Ports can follow their Lisp closely: reading input where the Lisp does, catching the conditions it catches, binding what it binds, requiring what it requires. The cost is migrating existing packages, done as each is next touched, and a larger core.

## Dependencies introduced

None yet.
