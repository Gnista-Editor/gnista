# 0012. Org mode as TypeScript packages

Status: accepted · 2026-10-28

## Context

Milestone 5 in [the plan](../plan.md) is org mode as a TypeScript package, as [ADR 0002](0002-start-simple.md) set out: headings that fold with `TAB` and `S-TAB`, structure editing with the `M-<arrow>` keys, TODO states, tags, links and timestamps, good enough for daily notes. Org is Lisp in Emacs, so by [ADR 0005](0005-rust-core-typescript-commands.md) it is TypeScript here. Org needs things from the core that earlier milestones did not provide:

- **Fontifying.** Text should be styled as it comes into view. Outline mode re-fontified the whole buffer after every command.
- **Hidden text and point.** Point should step over hidden text as Emacs does. Hidden link brackets made the difference visible.
- **Remapping.** Commands should be remappable, so typing in a table keeps it aligned.

## Options considered

For styling org text:

1. **Tree-sitter.** There is an org grammar, but it is not maintained with the others and Emacs's org does not use one. Its parse would also disagree with Org's own idea of headings, lists and emphasis.
2. **A fontifying function in TypeScript, called for the lines about to be shown.** This is how Emacs's font-lock and jit-lock work. Org's rules can then be written as Org writes them.

For where org lives:

1. **One package.** Simple, but long.
2. **Split as Emacs splits it.** Emacs has `org.el`, `org-list.el`, `org-table.el`, `ol.el` and more. Packages run in separate scopes and can only reach each other through commands, so splitting finely means duplicating the parsing helpers.

## Decision

Org is fontified by a TypeScript function on `jit-lock-functions`, and it comes as two packages: `org.ts` (headings, folding, lists, TODO states, tags, timestamps and links) and `org-table.ts` (tables).

**Fontifying** (`fontify.rs`):

- Hooks can take arguments (`run_hook_with_args`). `jit-lock-functions` is called with the start and end of whole lines that are about to be shown and are not yet fontified.
- `Editor::redisplay`, which both front ends now call before drawing, fontifies what each window shows and keeps point visible.
- An edit marks everything from the edited line to the end of the buffer for fontifying again. Emacs's `jit-lock-contextually` does the same after a delay, so a new `#+begin_src` restyles the lines below it. Only what is shown is fontified, so this is cheap.
- `font-lock-ensure` and `font-lock-flush` are commands.
- `add-face-text-property` lets faces stack, as font-lock's do.
- Outline mode moved from re-fontifying after every command to the same hook.

**Other core changes:**

- **Point and hidden text.** Point adjustment after a command follows Emacs's `adjust_point_for_property`. Point is inside hidden text when hidden characters lie on both sides of it, and it goes to the far end in the direction it moved, or to the near end if it came from outside. Where no ellipsis shows and the command did not edit, a move from one edge of the hidden text to the other goes a character further. So `C-f` onto a link's hidden `[[target][` lands after the first character of its description, as in Emacs.
- **`kill-line`.** It kills to the end of the visible line, so `C-k` on a folded heading kills its subtree.
- **Remapping.** Keymaps can remap commands (`ember.remapCommand`, Emacs's `[remap ...]`). A remapped typing command still amalgamates undo as `self-insert-command` does.
- **Undo.** `ember.call` from inside a running command no longer starts a new undo step, so an org command undoes as one.
- **Script functions.** `ember.callWithPrefix` passes a prefix argument on, and `ember.callInteractively` runs a command with minibuffer prompts. `ember.stringWidth` aligns tags and tables by display width, and `<return>`, `<tab>` and `<backtab>` parse as keys.

**Org** (`packages/org.ts`, `org-mode`, derived from `outline-mode` as in Emacs):

- **Folding.** `TAB` cycles a heading between folded, children and subtree, with `EMPTY ENTRY` when there is nothing under it. `S-TAB` cycles between overview, contents and show all. `org-cycle-separator-lines` keeps one blank line visible between folded subtrees. `#+STARTUP:` and `org-startup-folded` set the visibility at startup, with drawers folded. `TAB` also folds drawers, blocks and list items with children, moves between table fields, and otherwise indents as `org-indent-line` does.
- **Fontifying.** Heading levels, TODO and done states, done headings, priorities, tags, emphasis markers, links, timestamps, statistics cookies, checkboxes, description terms, footnotes, targets, `#+TITLE:` and other keywords, comments, tables, drawers, properties, planning keywords and blocks all get their faces. Links show only their description, behind an `org-link` invisible property.
- **Structure.** `M-RET`, `C-RET`, `M-S-RET` and `C-S-RET` insert headings and items. `M-<left>` and `M-<right>` promote, demote, indent and outdent; `M-S-<left>` and `M-S-<right>` do the same for whole subtrees. `M-<up>` and `M-<down>` move subtrees, items and table rows. `C-c C-n`, `C-c C-p`, `C-c C-f`, `C-c C-b` and `C-c C-u` move between headings. `C-c *` and `C-c -` toggle headings and items, `C-c @` marks a subtree, and `C-c C-x C-w`, `C-c C-x M-w` and `C-c C-x C-y` cut, copy and paste subtrees.
- **TODO states and priorities.** `C-c C-t`, `S-<left>` and `S-<right>` cycle through `org-todo-keywords` or a `#+TODO:` line. Repeating `SCHEDULED` and `DEADLINE` dates move on when an entry is marked done, and `org-log-done` set to `"time"` adds `CLOSED:`. `S-<up>` and `S-<down>` change priorities.
- **Tags, checkboxes and cookies.** `C-c C-q` sets tags, aligned to `org-tags-column`. `C-c C-c` ticks checkboxes and updates parent boxes and `[1/3]` and `[33%]` cookies.
- **Timestamps.** `C-c .` and `C-c !` insert them from dates such as `+3`, `fri`, `11-03` or `2026-11-03 10:30`. `S-<up>` and `S-<down>` change whichever part point is on, and `S-<left>` and `S-<right>` move by a day. `C-c C-s` and `C-c C-d` schedule and set deadlines.
- **Links.** `C-c C-l` inserts a link, and `C-c C-o` or a click follows one: within the buffer to a `*Heading`, a `#custom-id`, a `<<target>>` or a heading's title, or to a file, with an optional `::search`.

**Tables** (`packages/org-table.ts`):

- **Aligning and moving.** Tables align as you move with `TAB`, `S-TAB` and `RET`, and numbers align right. A rule line `|-` expands to a full rule.
- **Editing.** Rows and columns can be inserted, deleted and moved, and `C-c |` makes a table, either a new one or from the region.
- **Typing.** `org-self-insert-command`, `org-delete-char` and `org-delete-backward-char`, remapped in `org-mode-map`, keep fields their width as you type. Typing straight after a move blanks the field.

The Emacs oracle now records the text left visible after fontifying, which checks folding and link hiding. Oracle cases can turn on major modes such as `org-mode`. 168 org cases from Emacs 30.2's Org 9.7 cover folding, structure editing, TODO states, priorities, lists, checkboxes, timestamps, tables and links. Prompts, dates relative to today, faces and repeaters, which the oracle cannot check, have headless tests in `crates/ember-script/tests/org.rs`, and a GUI snapshot shows daily notes in both themes.

## Consequences

Daily notes work without Emacs, and the same jit-lock hook is there for any mode that styles text with properties.

The deliberate gaps:

- **Not implemented:** the agenda, capture, refile, archiving, clocking, export and Babel.
- **External links:** `http`, `mailto` and other external links are not opened. That needs a way to start a browser, which was left for a decision of its own.
- **Repeating tasks:** marking one done does not log the change or set `LAST_REPEAT`, as Emacs's `org-log-repeat` does.
- **Shift selection:** `org-support-shift-select` exists, but setting it does not turn Shift selection on in Org.
- **Dragging elements:** `M-<up>` and `M-<down>` on a paragraph are an error rather than dragging it.
- **Fontifying:** source blocks are not highlighted in their language, and emphasis does not span lines.
- **Prompts:** the minibuffer has no initial input, so `C-c C-q` does not start from the current tags, and `C-c ,` needs `RET` after the letter.

Fontifying looks back for an open block from the first line it styles, which is a scan to the start of the buffer at worst. Most commands also scan the buffer's headings, which is fine for notes but will want an index for very large files. A test keeps a 6,000-line file's redisplay and editing under two seconds in a debug build.

## Dependencies introduced

None.
