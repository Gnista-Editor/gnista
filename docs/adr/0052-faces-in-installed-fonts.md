# 0052. Faces in installed fonts

Status: accepted · 2026-11-01

## Context

The GUI drew all text in two of egui's families: monospace (Geist Mono, else egui's own) and proportional (Inter). A face's `:family` only chose between them, by whether the name looked fixed-width. So `(set-face-attribute 'org-level-1 nil :family "Menlo")` drew in Geist Mono, and `face-font` named one of the two ([ADR 0048](0048-overlay-arrows-fringe-indicators-and-fonts.md)). Emacs draws a face in the family it names whenever that family is installed.

## Options considered

1. **Load every installed family at startup.** It costs startup time and memory for fonts nobody uses.
2. **Load a family when a face first names it**, between frames, and measure and draw in it from then on.

## Decision

Option 2.

**Asking for a family.** When the GUI's metrics (`metrics.rs`) are asked for a font whose family a face named, and the window has not loaded it, they mark it wanted and use the monospace or proportional family meanwhile. Names that stand for egui's own families, such as `Monospace` and `Sans Serif` (Emacs's `fixed-pitch` and `variable-pitch`), are not loaded.

**Loading it.** At the start of each frame, `theme::load_wanted_families` loads the wanted families from the system's fonts with fontique, which the GUI already uses. Each becomes an egui family of its own that falls back on the monospace fonts for what it lacks. A family that is not installed is remembered as missing and keeps the fallback.

**Measuring in it.** On the next frame, once egui has the fonts, the window gives the editor fresh metrics, so text is laid out again in the new family. The metrics' measures are kept by family as well as size and weight.

**Drawing in it.** A face with any family is drawn with that face's font.

## Consequences

- A face can name any installed family, and `face-font` and `font-at` name it. Rows in such a family are off the grid and measured glyph by glyph, as proportional text is, even when the family is fixed-width.
- The first frame after a family is named draws in the fallback; the next draws in the family.
- A loaded family has only its regular weight. Bold text in it is drawn as bold monospace is without a bold font: twice, slightly apart. Italic is not slanted.
- The `default` face's family does not change the window's main font yet, which remains Geist Mono.
- Tests check that a family that is not installed falls back. A test that Menlo loads depends on the fonts installed and is ignored by default.
