# 0028. Windows as objects

Status: accepted · 2026-10-30

## Context

[ADR 0026](0026-the-next-foundations.md)'s last step began with windows: a window was an id, a buffer, a size and a top line, with the selected window's point and top line kept in its buffer and the others' points as markers there. Emacs's windows are objects with more to them, and Lisp that ports leans on it: `save-window-excursion` and `quit-window`'s restore need a frame's windows saved and put back; `display-buffer` records how to undo itself in a `quit-restore` parameter; dedicated windows keep their buffer; `C-x <left>` and `C-x <right>` go through the buffers a window showed; and a window that is not selected keeps the text at its top when lines are added above it, as its start is a marker. Here a window's top was a line number, so typing above it in another window scrolled it, and window.ts kept `quit-restore` in a map of its own.

## Options considered

1. **Window objects as values** (`Value::Window`), as Emacs's are, with their state behind them.
2. **Window ids as now**, with the state Emacs keeps in a window object kept in the core's `Window`, and the functions on it under Emacs's names.

## Decision

Option 2: window ids stay what scripts hold, since they are never reused and compare as Emacs's window objects do; making them values can come with frames as values. What a window holds grows to Emacs's:

- **Start.** A window that is not selected keeps where it starts in its buffer beside its point, a position that moves with edits as Emacs's window-start marker does. `window-start` and `set-window-start` read and set it for any window; a window still starts at a line's start.
- **Parameters**: `window-parameter`, `set-window-parameter` and `window-parameters`. window.ts keeps `quit-restore` there, as `(METHOD PREVIOUS SELECTED BUFFER)`.
- **Dedication**: `window-dedicated-p` and `set-window-dedicated-p`. `switch-to-buffer` in a strongly dedicated window shows the buffer in another, as Emacs's pops to it; `display-buffer` may split a dedicated window but does not reuse one; killing the buffer of a dedicated window that is not selected deletes the window.
- **The buffers it showed**: `window-prev-buffers`, with where each started and its point, recorded whenever a window shows another buffer, as record-window-buffer does, and `window-next-buffers`. `previous-buffer` on `C-x <left>` goes back through them, further with each repeat, and `next-buffer` on `C-x <right>` comes forward again. A window made by splitting starts with none, as in Emacs.
- **Configurations**: `current-window-configuration` saves the selected frame's tree, each window's buffer, start and point (as markers, so they follow edits), size, parameters, dedication and buffer history, which window is selected and which buffer current; `set-window-configuration` puts them back, windows deleted meanwhile coming back under their ids and others going, and a buffer killed meanwhile replaced by another. Scripts hold a configuration as an object the editor frees when nothing refers to it, and `saveWindowExcursion` runs code and puts the windows back however it ends.

## Consequences

`save-window-excursion`, `quit-window` and the prev-buffer commands work as their Lisp does, and ports of winner, ediff and transient have what they save and restore. Still to come: a window starting partway through a line, which needs the rows to begin mid-line; `window-hscroll`, which the front ends work out for themselves; the minibuffer's window in the window tree; window objects as values; and `window-state-get` and `window-state-put`, which write a configuration as data.

## Dependencies introduced

None.
