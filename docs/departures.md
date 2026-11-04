# Departures from Emacs and Org

Ember behaves like Emacs and Org, and the oracle checks it. This document collects places where it could, later, do better than they do: ideas held back until the base editor is stable, so that each departure is a choice made against a known baseline rather than a drift. Each entry says what Emacs or Org does, what Ember might do instead, and whether it would be the default or something a user turns on.

Two rules for when one is taken up. A departure leaves files as Emacs and Org would write them, unless that is the point of it, so a file edited in Ember still reads the same in Emacs. And it is off by default unless the Emacs behaviour is plainly a limitation nobody relies on; otherwise it is a mode or an option, as a package would add it in Emacs.

## Org's tags against the window's right edge

**Org.** Tags are lined up by spaces written into the heading, so they end at `org-tags-column` (-77: right-aligned to column 77). The column is fixed while windows are not: in a wide window tags sit in the middle, in a narrow one they push the line past the edge, and they move only when a command re-aligns them (`C-c C-q`, `org-align-tags`), not when the window is resized. With a proportional font they do not line up at all.

**Idea.** Align tags on screen only: a display property on the spaces before a heading's tags, `(space :align-to (- right WIDTH))`, stretches them so the tags end at the window's right edge, whatever its width and whatever the font, as long as the heading leaves room; the file keeps Org's spacing. Emacs's display engine supports such specs, and packages do this for Emacs, so it is a mode in Org's spirit rather than a change to it, off by default.

**Needs.** `:align-to` with `right`, `center` and arithmetic on them, as Emacs's pixel specifications have them ([ADR 0029](adr/0029-redisplay-beyond-rows.md) supports a plain column so far), and a jit-lock function in a small mode, about fifteen lines of TypeScript.
