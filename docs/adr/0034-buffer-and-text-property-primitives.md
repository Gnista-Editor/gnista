# 0034. Buffer and text property primitives

Status: accepted · 2026-10-30

## Context

Packages ported from Emacs call a set of primitives from editfns.c, textprop.c and buffer.c directly, and Ember had few of them. Some had names of Ember's own; for others, packages worked around the gap, as lisp.ts and org.ts each put a narrowing back by hand. The missing ones:
- **Fields**, the stretches of text with one `field` property, which comint, eshell and the minibuffer's prompt are built on: `field-beginning`, `field-end`, `field-string`, `delete-field` and `constrain-to-field`, which C-a and the word commands obey.
- **Searches for where a property changes**: `next-single-property-change` and its kin, `text-property-any` and `text-property-not-all`, and `get-pos-property`, the property inserted text would take.
- **Buffer substrings**: `insert-buffer-substring`, `delete-and-extract-region` and `compare-buffer-substrings`.
- **`save-restriction`.**
- **`buffer-local-value`.**
- **`buffer-undo-list` as data.**
- **Indirect buffers**, which Org's `org-tree-to-indirect-buffer` and polymode need.

[docs/plan.md](../plan.md) lists these seventh among the gaps in the core.

## Options considered

1. **Each primitive as script code over what scripts could already ask**, such as `charProperty` in a loop. This is slow on long buffers, and inserted text's stickiness, which fields depend on, cannot be seen from scripts.
2. **The searches and fields in the core** (`textprop.rs`), as textprop.c and editfns.c have them, with what is plain composition (`delete-and-extract-region`, `save-restriction`, `compare-buffer-substrings`) in the prelude.

## Decision

Option 2.

**Searches** (`textprop.rs`), under Emacs's names and with its edge cases:
- `nextSinglePropertyChange` and `previousSinglePropertyChange` give `undefined` where nothing changes before the end, or LIMIT when there is one.
- The `-char-` forms look at overlays too and give the end of the accessible text.
- `next-overlay-change` and `previous-overlay-change` are there too, and `next-property-change` takes its LIMIT.
- `getPosProperty` follows `text_property_stickiness`:
  - Text is rear-sticky unless `rear-nonsticky` or `text-property-default-nonsticky` says otherwise, and front-sticky where `front-sticky` says so.
  - Where both apply, the side before wins unless its value is nil.
  - An overlay counts if text inserted at the position would go into it, by its front and rear advance.
  - `text-property-default-nonsticky` is now a variable, with Emacs's value.

**Fields** follow editfns.c's `find_field`. A position between two fields belongs to the one inserted text would join. With ESCAPE-FROM-EDGE, it belongs to both, and a `boundary` field between them is skipped. `constrain-to-field` keeps a new position in the old one's field, with ONLY-IN-LINE, INHIBIT-CAPTURE-PROPERTY and `inhibit-field-text-motion` as Emacs has them. `move-beginning-of-line` and the word commands now go through it, as Emacs's do, instead of a check for the minibuffer's prompt. So a prompt made as comint makes one stops C-a and M-b in any buffer. `move-end-of-line` does not, as Emacs's moves to the next line's start and back, which fields on one line never stop.

**Buffers**:
- `insertBufferSubstring` and its no-properties form, `deleteAndExtractRegion`, `compareBufferSubstrings` (folding case as `case-fold-search` says), `bufferNarrowedP`, and `saveRestriction`. The last puts a narrowing back with its edges moved by edits, as markers move, or widens if the buffer was not narrowed, even when the code throws.
- `bufferLocalValue`.
- `getBufferCreate` now returns the buffer, as Emacs's does.

**The undo list as data.** `bufferUndoList` gives the history as Emacs's `buffer-undo-list` holds it, newest first:
- null for a boundary;
- a number for point before a command;
- `[beg, end]` for an insertion;
- `[text, pos]` for a deletion, with pos negated when point was after it;
- `[true]` where the buffer was unmodified;
- `true` when undo is off.

Positions count from 0, as everywhere in scripts. `bufferDisableUndo` and `bufferEnableUndo` turn recording off and on. The list is read-only: undo keeps its own structure, so code cannot push entries or bind the list.

Making the list visible showed two places where Ember recorded point differently from Emacs 30's `record_point`. Neither showed in what undo did:
- Emacs records point before a backward deletion even when point was at its end.
- Emacs takes the position from where point was before the command, `point_before_last_command_or_undo`, even when the command joins its undo step to the one before.

Ember now does both.

The values were checked against Emacs 30.2 by a batch probe on the same text, and the tests (`crates/ember-script/tests/textprop.rs`) hold its answers. Batch Emacs cannot type into the minibuffer, so field motion there is tested headless rather than by the Emacs comparison.

## Consequences

Packages can port code that uses fields, property searches, restrictions and other buffers' text as its Lisp is written. lisp.ts and org.ts now use `saveRestriction` instead of putting narrowings back themselves. Indirect buffers come in a second step. What is still missing:
- `buffer-undo-list` cannot be written or let-bound, as Lisp binds it to t to make changes without undo.
- Text properties are still put without undo, the modified flag or change hooks (see [differences.md](../differences.md)).
- `field` values are compared with `equal`, where Emacs uses `eq`, which differs only for two distinct strings with the same text.

## Dependencies introduced

None.
