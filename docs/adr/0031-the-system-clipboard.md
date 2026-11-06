# 0031. The system clipboard

Status: accepted · 2026-10-30

## Context

The kill ring kept to itself. Text killed or copied in E8 never reached other programs, and `C-y` never saw what they copied; on the Mac, ⌘V inserted the clipboard's text but ⌘C and ⌘X did nothing. Emacs links the two with `select-enable-clipboard`, on by default: `kill-new` hands the text to `interprogram-cut-function`, and `current-kill` first takes in, through `interprogram-paste-function`, text another program put on the clipboard since Emacs last put text there. On the Mac, Emacs binds ⌘C, ⌘X and ⌘V (`s-c`, `s-x`, `s-v`) to `kill-ring-save`, `kill-region` and `yank`.

## Options considered

1. **Leave the clipboard to the front end**: the GUI copies the newest kill to the clipboard after each command and inserts what ⌘V gives. `C-y` would still not see other programs' text, and the kill ring would not know what came in.
2. **Link the kill ring to a clipboard the front end supplies**, as select.el does, in the core where the kill ring is.

## Decision

Option 2. `select.rs` holds a `Clipboard` trait that a front end implements; `kill-new` and kills put the newest kill on it, and `current-kill` with 0 takes in clipboard text that differs from what the editor last put there or took in, as `gui-selection-value` does, so `C-y` pastes it and `M-y` goes on to the kills before. `select-enable-clipboard` turns it off. The GUI implements the trait with `arboard`, and sends ⌘C, ⌘X and ⌘V to `kill-ring-save`, `kill-region` and `yank` through the command loop (`Editor::command_execute`), so they act on the region and `M-y` follows a paste. Tests and headless editors have no clipboard, and the GUI's tests leave the user's alone, as only `main.rs` installs it. The terminal pastes as typing does; copying out of it, which needs OSC 52, is left for later.

## Consequences

Copying and pasting between E8 and other programs work as in Emacs, by Emacs's keys and the Mac's. Not yet: the primary selection on X11 (`select-enable-primary`), `save-interprogram-paste-before-kill`, and the terminal writing the clipboard.

## Dependencies introduced

`arboard` in e8-gui, for reading and writing the system clipboard. egui already depends on it for its own copy and paste; e8-gui names it to reach the clipboard outside egui's frame.
