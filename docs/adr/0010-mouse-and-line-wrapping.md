# 0010. The mouse and line wrapping

Status: accepted · 2026-10-27

## Context

The last slice of milestone 3 in [the plan](../plan.md) is the mouse and long lines. In Emacs a click is an event like a key: `<down-mouse-1>`, `<mouse-1>`, `<drag-mouse-1>`, `<double-mouse-1>`, each carrying where it happened, bound in keymaps to commands in `mouse.el`. Long lines are continued on the next screen line by default, with `\` in a terminal's last column; `truncate-lines` cuts them off instead, and `visual-line-mode` breaks them between words. `C-n` and `C-p` move by screen lines (`line-move-visual`).

## Options considered

For the mouse:

1. **Front ends move point and set the region themselves.** Quick, but clicks could not be rebound, recorded or described, and the two front ends would differ.
2. **Mouse events are keys, as in Emacs.** Front ends turn presses and moves into keys and say where they happened; the commands are in a package.

For wrapping:

1. **Front ends wrap when drawing.** Line motion and scrolling in the core would not know about screen lines.
2. **The core wraps display rows.** The rows the front ends draw are already the core's ([ADR 0007](0007-text-properties-faces-and-display-rows.md)), so wrapping is one more step there, and motion can count the same rows.

## Decision

Mouse events are keys, and the core wraps display rows.

**The mouse:**

- `KeyCode::Mouse(kind, button)` covers `<down-mouse-N>`, `<mouse-N>`, `<drag-mouse-N>`, `<double-mouse-N>` and `<triple-mouse-N>`, with modifiers as for keys.
- `Editor::mouse(key, event)` runs the key's binding. The `MouseEvent` says which window, the buffer position under the pointer, and where a drag started. Scripts read it with `e8.lastMouseEvent()`, as Emacs commands read their event.
- As in Emacs, an unbound press is dropped, and an unbound drag or repeated click runs the plain click's binding.
- Front ends hit-test through `display::position_at_column`. Below the text is the end of the buffer, and the mode line has no position. A drag sends `<drag-mouse-1>` as the pointer moves, so the region follows it; Emacs tracks the drag inside `mouse-drag-region`, which needs a nested event loop E8 does not have.
- `packages/mouse.ts` follows `mouse.el`: `mouse-drag-region`, `mouse-set-point` and `mouse-set-region`. Emacs selects words and lines inside `mouse-drag-region` by counting clicks; E8 binds `<double-mouse-1>` and `<triple-mouse-1>` to `mouse-select-word` and `mouse-select-line`.
- Emacs binds `S-<down-mouse-1>` to a font menu. E8 binds `S-<mouse-1>` to `mouse-extend-region`, which extends the region as most editors do. This is a deliberate difference.
- The wheel scrolls the window under the pointer without selecting it, as Emacs's `mouse-wheel-follow-mouse` does.

**Wrapping:**

- `truncate-lines` (off by default), `word-wrap` and `truncate-partial-width-windows` (50) are variables, as in Emacs.
- Rows wrap one column short of the window's width, keeping the last column for the continuation mark: `\` in the terminal, a faint `\` in the GUI where Emacs draws a fringe arrow. A row that continues is marked `continued`, and point at its end shows at the start of the next row.
- With `word-wrap`, rows break after the last space or tab that fits. An ellipsis for hidden text is never split.
- `C-n` and `C-p` move by screen lines, keeping the column on screen, unless `line-move-visual` is off. Keeping point visible and scrolling count screen rows. The window's top is still the start of a line of text, so a single line taller than the window cannot be scrolled through.
- `visual-line-mode` and `toggle-truncate-lines` are in `simple.ts`, with `beginning-of-visual-line`, `end-of-visual-line` and `kill-visual-line` on `C-a`, `C-e` and `C-k` in the mode. They use `e8.screenLine`, standing in for Emacs's `vertical-motion`.

## Consequences

Clicks can be rebound, described with `C-h k` and recorded, and both front ends behave alike. Batch Emacs does not lay out text, so it moves by lines of text and ignores `word-wrap`; the oracle cannot check screen lines, and headless tests stand in for it. Keyboard macros record mouse keys but not where they happened, so replaying them reuses the last event's position. Scrolling within one very long line, and C-v scrolling by exactly a screen of continued lines, are left for later.

## Dependencies introduced

None.
