# 0004. A graphical front end on egui, with ArtCraft's look

Status: accepted · 2026-10-27

## Context

Gnista had only a terminal front end. Mark wanted a graphical one now, looking like the ArtCraft Launcher (github.com/storytold/craft-launcher). That launcher is built on egui 0.37, with ArtCraft's shared widgets in `craft-ui` (github.com/storytold/craft-libs).

## Options considered

1. **egui and eframe.** Immediate mode, so the window is drawn from editor state each frame, exactly as the terminal front end works. Text shaping with harfrust (kerning and ligatures) since 0.35, and system fonts, colour emoji and non-Latin scripts since 0.37. `egui_kittest` renders headless snapshot tests, and `egui_mcp` lets an agent operate a running app. It is what ArtCraft uses.
2. **egui plus `craft-ui`.** ArtCraft's widgets, but only as a git dependency, and craft-libs patches the whole egui family and winit to ArtCraft's forks. Gnista would follow their forks and release pace. The look does not come from `craft-ui` anyway: its README leaves complete themes to each app.
3. **GPUI (Zed).** The best text rendering and speed, but its API follows Zed's needs and its documentation is thin.
4. **Iced, or a custom wgpu renderer.** More code for the same result, and the look built from scratch.

## Decision

egui and eframe from crates.io, without `craft-ui`. ArtCraft's design language is recreated in `gnista-gui/src/theme.rs`: their colour tokens (MIT OR Apache-2.0), hard edges and hairline rules, and Geist Mono and Inter when installed. `craft-ui` pieces can be borrowed later with attribution if Gnista needs them.

How it works:

- **Drawing.** Only visible lines are laid out, with egui shaping each line. The buffer, mode line and echo area are painted directly. egui's `TextEdit` is not used; it is not built for large files or Emacs editing.
- **Keys.** Plain characters come from text events, so layouts and dead keys work. Alt, which is Option on macOS, is Meta, and the character Option would type is dropped. Off macOS, egui turns Ctrl-X, Ctrl-C and Ctrl-V into cut, copy and paste, which are turned back into C-x, C-c and C-v. Cmd on macOS is left to the system, and Cmd-V pastes.
- **Fonts.** Geist Mono and Inter are found by family name through fontique when installed. Otherwise egui's built-in fonts are used. Snapshot tests always use the built-in fonts, so they render the same on any machine.
- **Separate binary.** `gnista-gui` is its own crate and binary, so the terminal build does not depend on a GPU stack.

## Consequences

Both front ends share the core, the scripting setup (`gnista_script::config::setup`) and the display helpers (`gnista_core::display`). Snapshot tests need a GPU or a software wgpu adapter, which matters for CI later. There is one window for now; splitting the frame comes next.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| eframe | 0.37 | Native window, event loop and wgpu rendering for egui |
| egui | 0.37 | Immediate mode drawing and text layout |
| fontique | 0.11 | Finding installed fonts by family name (already used by eframe's system font support) |
| egui_kittest (dev) | 0.37 | Headless rendering and snapshot tests |
| unicode-width | 0.2 | Moved from the terminal crate to `gnista-core::display` |
