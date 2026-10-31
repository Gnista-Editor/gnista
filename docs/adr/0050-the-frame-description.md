# 0050. The frame description

Status: accepted · 2026-10-31

## Context

Step 2 of [docs/multithreading.md](../multithreading.md). Both front ends drew by asking the editor while they painted: the GUI's `draw`, `draw_buffer`, `draw_mode_line`, `draw_header_line` and `draw_echo_area` called about thirty `Editor` methods, among them `rows_to_draw`, `style_for`, `line_numbers`, `window_fringes`, `glyph_columns`, `row_offset_in`, `row_ascent`, `image_top`, `image_rgba`, `mode_line` and `minibuffer_rows`. The terminal's `ui.rs` did the same. With the editor on a thread of its own (step 3), a front end that asks the editor while it draws waits for whatever command is running, which is the freeze step 3 is meant to end.

## Options considered

1. **Lock the editor while drawing.** The UI waits on the editor whenever a command runs, which breaks the plan's invariant that the UI never waits on it.
2. **A description of each frame**, built by the core after redisplay as plain owned data, that front ends draw from without asking anything. This is what Gerd Möllmann described for a parallel Emacs redisplay: layout and jit-lock stay where Lisp runs, and drawing works from a snapshot.

## Decision

Option 2.

**`Editor::describe_frame(frame, dark, scale)`** (`frame_description.rs`) returns a `FrameDescription` with:
- the window tree and how many lines the echo area takes;
- each window as a `WindowDescription`:
  - rows, each a `RowDescription`: the `Row` with its styled segments, its glyphs, its height, each glyph's width in columns, whether it lies on the grid, its offset (for right-to-left rows), and its ascent and the tops of its segments for rows with images;
  - point and point's row, the region, line numbers and their styles;
  - its fringes, with the truncation bitmaps a front end puts in place of them when it scrolls a row sideways, and each bitmap's style;
  - whether the cursor shows, its margins, `word-wrap`, and the mode line and header line with their styles;
- the echo area: a message, or the minibuffer's rows and point;
- the `default` face, the fringe bitmaps `define-fringe-bitmap` defined, and each shown image's pixels, at the scale given.

**What front ends draw from.** The GUI's draw functions, `fringe.rs` and `image.rs`, and the terminal's `draw`, take only the description. A front end still computes its own horizontal scroll and which rows it cut off, from the text it laid out, and picks the truncation bitmap for them, as fringe.c ranks it below a display spec's bitmap and above everything else.

**Speed.** `key_to_frame` in the bench times a key and its description against a key and the calls the GUI made to draw, each in an editor of its own over the same part of the 50,000-line Org file:

| | `C-v` | `C-n` | typing |
| --- | ---: | ---: | ---: |
| Cells, drawing calls | 2.43 ms | 0.46 ms | 2.17 ms |
| Cells, description | 2.42 ms | 0.48 ms | 2.06 ms |
| GUI metrics, drawing calls | 2.96 ms | 0.82 ms | 2.49 ms |
| GUI metrics, description | 3.07 ms | 0.83 ms | 2.45 ms |

## Consequences

- **Pixels unchanged.** Every GUI snapshot and terminal test passes unchanged, which shows that drawing from the description draws the same pixels and cells.
- **Display work targets the description.** New display features add fields to it, not editor calls from front ends.
- **Not moved yet, and needed by step 3:**
  - Laying windows out and telling the editor their sizes (the GUI's `Layout::new`, the terminal's `layout_windows`).
  - Hit-testing mouse events (`hit`, `mouse_target`).
  - The GUI's smooth scrolling, the bell, the frame's title, and answering the agent.

  These are input, not drawing. In step 3 they become messages to the editor's thread: a resize with the front end's metrics, and mouse events carrying their position.
- **Descriptions copy the rows.** That is what drawing already cost, as the table shows. A description is owned data, so the editor's thread can hand one over and go on.
