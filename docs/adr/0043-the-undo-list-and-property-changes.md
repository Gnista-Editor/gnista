# 0043. The undo list as Lisp sees it, and text property changes undone

Status: accepted · 2026-10-31

## Context

[ADR 0034](0034-buffer-and-text-property-primitives.md) let scripts read `buffer-undo-list`, but not set or bind it, and text property changes were neither recorded for undo nor a change to the buffer. Emacs's Lisp relies on all three:

- `with-silent-modifications` binds `buffer-undo-list` to t around property changes that only style text, as font-lock, syntax-propertize and comint's output marking do.
- Code clears the list, or binds it to t to make changes that are not to be undone.
- Packages push `(apply FUN . ARGS)` entries so undo calls them.
- `put-text-property` and its kin record `(nil PROP OLDVAL BEG . END)` and modify the buffer (undo.c's `record_property_change`), so `C-/` takes back a property a command changed.

[docs/plan.md](../plan.md) lists these as what remained of the buffer primitives.

## Options considered

1. **Keep Ember's undo history, groups of edits in the buffer, and let it hold the other kinds of entry: property changes and `apply` entries.** Make `buffer-undo-list` a variable the buffer answers, as Emacs's BVAR, whose value is the history in Emacs's form and whose setting replaces it. Binding it to t keeps the history aside, so a `let` gives it back unchanged, redo and marker adjustments included.
2. **Store the list itself as Emacs does and write `undo` and `primitive-undo` in TypeScript, as simple.el does.** Closest to Emacs and to ADR 0005, but `undo-equiv-table` and `pending-undo-list` rest on the sharing of cons cells, which Ember's values do not have, and undo, undo in a region, change groups and indirect buffers would all be rewritten at once.

## Decision

Option 1:

- **Property changes.** An edit records a text property change: the property's old value on each stretch it changes, and none where the value is already the new one, so setting what is there records nothing and modifies nothing, as in Emacs. `Buffer::change_text_property` records and changes. The script primitives `putTextProperty`, `removeTextProperty` and `addFaceTextProperty` use it. The editor's own marks still use the silent `put_text_property`. Undo puts the old values back, recording that in turn, so it can be redone. Undo in a region keeps a property change inside the region, as `undo-make-selective-list` does. The history shows a change as `[null, prop, oldval, beg, end]`.
- **`apply` entries.** An `(apply FUN . ARGS)` or `(apply DELTA BEG END FUN . ARGS)` entry is kept in the history, and undo calls its function once the step is undone (`Editor::run_undo_applies`), as do `undo-redo` and `cancelChangeGroup`.
- **Setting `buffer-undo-list`.** It is a buffer-local variable the buffer answers, t while recording is off.
  - t stops recording and keeps the history aside, and setting back the list it was restores it exactly.
  - nil empties it.
  - Any other list, in the form reading gives, becomes the history, one step for each stretch between nils.
  - `letBind` binds it, as `let` does.
- **Silent modifications.** `ember.withSilentModifications(fn)` is Emacs's macro: property changes inside it are not recorded, leave the buffer as modified as it was, and do not deactivate the region, with `inhibit-read-only` and `inhibit-modification-hooks` bound. jit-lock runs `jit-lock-functions` silently, as `jit-lock-fontify-now` does. Comint's output and prompt marking, compile's faces and rust-ts-mode's syntax properties use it, as their Emacs code or its font-lock does. Tabulated lists set the list to t, as tabulated-list-mode does.

`tests/undo_list.rs` in ember-core and ember-script check property changes undone and redone, undo in a region, binding to t, setting a list, and `apply` entries. All 1924 Emacs cases still match.

## Consequences

- Org's, comint's and other packages' Lisp that binds or pushes onto `buffer-undo-list` can be ported as written.
- A list set from code loses what reading it does not show: which steps were undos (so redo through them), the markers a deletion moved, and which save an unmodified mark belongs to, taken as the latest. Binding to t and back loses nothing.
- Still not as in Emacs:
  - Property changes do not run `before-change-functions` and `after-change-functions`, and do not check for read-only text.
  - `(MARKER . ADJUSTMENT)` entries are not shown.
  - `(t . TIME)` is `[true]`.
  - `undo` and `primitive-undo` remain Rust, not ports of simple.el.

  [docs/differences.md](../differences.md) lists them.

## Dependencies introduced

None.
