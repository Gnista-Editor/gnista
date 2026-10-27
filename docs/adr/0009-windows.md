# 0009. Windows

Status: accepted · 2026-10-27

## Context

The third slice of milestone 3 in [the plan](../plan.md) is windows: `C-x 2`, `C-x 3`, `C-x o`, `C-x 0` and `C-x 1`. Until now the editor had one window, whose point and top line lived in the buffer. In Emacs each window has its own point and start, the selected window's point is the buffer's point, and other windows' points are markers that move with edits. Ember also has two front ends that measure in different units, cells and points.

## Options considered

1. **The core lays windows out in character cells.** Simple for the terminal, but the GUI's mode lines are taller than a text line and its text has padding, so cells do not map onto it.
2. **The core keeps a tree of splits and each front end lays it out.** The core decides which windows exist and how they divide the frame; a front end turns that into rectangles in its own units and tells the core how many lines and columns each window has.

## Decision

The core keeps a tree of splits; front ends lay it out.

- `WindowTree` is a binary tree: each split halves a window, side by side or one above the other, the first part keeping the extra unit of an odd size, as Emacs's `split-window` does. `WindowTree::rects` divides any rectangle among the windows, so both front ends share one rule. Deleting a window gives its space to its sibling.
- The selected window's point and top line stay in its buffer, so commands are unchanged. The other windows keep their top lines, and their points are kept in their buffers, moving with insertions and deletions as Emacs's window-point markers do. Selecting a window swaps these.
- Each window refers to its buffer by an id, so killing or renaming buffers does not confuse windows. Killing a buffer shows another one in every window that showed it.
- Front ends call `set_window_size` for each window; scrolling uses the selected window's height. A window too small to halve, by Emacs's `window-min-height` of 4 and `window-min-width` of 10, does not split, with Emacs's message.
- Deleting the selected window selects the most recently used one left, as Emacs's `delete-window-choose-selected` does by default.
- The primitives (split, delete, select, list) are Rust, as in Emacs's C. The commands are in `packages/window.ts`, after `window.el`, and `other-window` takes a prefix count.
- Only the selected window shows the region and a filled cursor; other windows show a hollow cursor and a plainer mode line, as in Emacs.

## Consequences

Scripts and, later, the agent can split and select windows through the same commands. The oracle checks window points, cycling and deletion against Emacs. Resizing windows (`C-x ^`, `C-x }`), `C-x 4` commands, and scrolling the window under the mouse are not done yet; the last comes with the mouse in the next slice.

## Dependencies introduced

None.
