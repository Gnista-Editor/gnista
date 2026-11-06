# 0013. Following Org's Lisp closely

Status: accepted · 2026-10-28

## Context

[ADR 0012](0012-org-mode.md) brought org mode in as TypeScript packages that did what Org does, written fresh. A differential fuzzer (`crates/e8-script/tests/org_fuzz.rs`) then typed random Org keys into random documents in both E8 and GNU Emacs 30.2 with Org 9.7. At first more than a third of its cases differed. The differences were rarely in what a command is for. They were in where point and the mark end up, which folds survive an edit, what joins the kill ring, and what happens on odd input. Org's behaviour there comes from how its Lisp is written: the order of insertions and deletions, which markers move, when its after-change functions run, and what its regexps match.

## Options considered

1. **Keep writing Org's commands fresh, fixing each difference as it is found.** Each fix is small, but each command keeps drifting from Org in ways nobody has tried yet.
2. **Port Org's functions closely, edit by edit, and give the core what Emacs gives Lisp.** More code, and some of it reproduces quirks, but a ported function behaves like Org's in cases nobody has tested.

## Decision

Org's commands are ported from its Lisp, keeping the order of their edits and the markers they rely on. Where Org's behaviour comes from Emacs itself, the core does what Emacs does:

- **Change hooks.** `after-change-functions` run after each change with Emacs's arguments. An error removes the buffer's local functions, as Emacs does. Org's fold checks run from there, as in Org, and reveal a fold that an edit broke after the command, from `post-command-hook`, as `org-fold-core--region-delayed` does.
- **Markers and overlays.** Overlays have front and rear advance, `insert-before-markers` moves marks and overlay ends, and Org's folds are front-advance overlays as in Emacs 30. The packages keep their own markers (`edInsert`, `edDelete`, `edReplace`) for the positions Org holds in markers.
- **Inserting.** Typing and `newline` insert and inherit the text properties around them, as `self-insert-command` does (`e8.insertAndInherit`). Emacs's `insert` with several arguments is several changes, and the ports insert in the same pieces.
- **The region.** `e8.keepMarkActive` stands for binding `deactivate-mark` to nil. Org's region commands ignore an empty region, as `use-region-p` does. A failed command leaves the region active, and `kill-region` passes mark and point unsorted, as Emacs does.
- **Undo.** Undo returns point to where it was before the command when the command's first change was elsewhere, as `record_point` does, and puts marks back into the text it reinserts, as `record_marker_adjustments` does. Undoing in a region builds Emacs's selective list (`undo-make-selective-list`), keeping only the changes inside the region with their positions moved for those left out. Runs of typing and deleting share a step, as `undo-auto-amalgamate` gives them, but not with a count of 2 or more.
- **The command loop.** Point leaves hidden text after `post-command-hook` has run. An undefined key runs `undefined`, so it becomes the last command. `current-column` gives hidden text no width unless it shows an ellipsis.
- **Elements.** The element parser knows blocks, comments, fixed-width lines, rules, clock lines and diary sexps. It separates paragraphs as `org-element-paragraph-separate` does and ends lists as `org-element-plain-list-parser` does.

Where Org itself misbehaves, E8 follows it if that is cheap: stale match data in `org-delete-char`, a column count from `org-split-string`, a cookie found past the title. Otherwise the case is listed in `tests/emacs/known-gaps.txt`.

The fuzzer is part of the work. It now also types editing keys from outside Org, and its documents have drawers, blocks, comments, links and closed planning lines. Each round's shrunk differences become oracle cases in `tests/emacs/cases/org-fuzz-*.json`.

## Consequences

Seeds that once differed in more than a third of their cases now differ in well under one percent, and what is left is mostly Org's own corners. A new Org command should be ported from its Lisp, not written fresh. Keep its edits in the same order, and use the marker helpers where Org uses markers.

Following Org this closely costs code. `org.ts` reproduces some of Org's quirks, and a few of its fold and list functions are long. When Org changes, these ports have to follow it.

Known gaps:

- **Not reproduced:** lists Org garbles from stale positions in its own structures.
- **Org's parser errors:** timestamps that only Org's loose regexp matches fail in more of Org's commands than in E8's.
- **Org's infinite loops:** a region loop that starts partway along a heading never finishes in Org, and the fuzzer leaves such cases out.

## Dependencies introduced

None.
