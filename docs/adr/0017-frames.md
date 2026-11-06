# 0017. Frames

Status: accepted · 2026-10-28

## Context

[ADR 0009](0009-windows.md) gave E8 one frame of windows. In Emacs a frame is a top-level window of the operating system, each with its own tree of windows, all sharing the buffers, the kill ring and the minibuffer's history. The `C-x 5` commands mirror `C-x 4` for frames. A terminal Emacs has frames too, but shows only the selected one. E8's GUI is egui, which can open more native windows as viewports, but tests embed every viewport in one window.

## Options considered

1. **Frames in the GUI only.** Each native window owns an `Editor` view. But commands such as `make-frame-command` and `other-frame` would then live outside the core, where scripts, the oracle and the agent cannot reach them.
2. **Frames in the core, shown by each front end as it can.** The core keeps a list of frames, each a window tree, and a selected frame whose windows the commands act on. The GUI shows each frame in a native window. The terminal, and the GUI where viewports are embedded, show the selected frame, as a terminal Emacs does.

## Decision

Frames are in the core (option 2).

- `Editor` keeps the selected frame's window tree where it was, so window code is unchanged, and the other frames' trees beside it. `make_frame`, `select_frame`, `delete_frame`, `frame_list` and `selected_frame` are primitives, as in Emacs's C. `frame_list` lists the newest frame first, as Emacs's does, and a new frame is selected and shows the selected window's buffer and point.
- All frames have the same size in the core for now, the one front ends give with `set_frame_size`. A front end sizes each window it lays out with `set_window_size`, so a GUI frame of another size still scrolls and wraps correctly.
- Deleting the sole frame fails with Emacs's message, "Attempt to delete the sole visible or iconified frame". `delete-window` only considers the selected frame's windows.
- jit-lock fontifies the windows of every frame before they draw.
- The commands are in `packages/window.ts`, after `frame.el` and `window.el`: `make-frame-command`, `other-frame`, `delete-frame`, `delete-other-frames`, and `switch-to-buffer-other-frame`, `find-file-other-frame` and `display-buffer-other-frame` on `C-x 5 2`, `o`, `0`, `1`, `b`, `f` and `C-o`.
- In the GUI each frame other than the first is an immediate viewport. Typing or clicking in a frame's window selects that frame first. A frame newly selected by a command gets the focus, and closing a frame's window deletes the frame. There is one minibuffer, which shows in the selected frame's echo area, unlike Emacs, where each frame has its own.

## Consequences

Scripts and the agent can make and switch frames with the same commands. Batch Emacs cannot make frames, so the oracle does not cover them. What `C-x 5` does was checked by hand in a GUI Emacs and is tested headlessly, and the GUI's frame windows have a test that runs with embedded viewports. Next would be frames of their own sizes and a minibuffer per frame.

## Dependencies introduced

None.
