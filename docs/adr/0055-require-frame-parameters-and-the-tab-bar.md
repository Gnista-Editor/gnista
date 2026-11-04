# 0055. Require, frame parameters and the tab bar

Status: accepted · 2026-11-03

## Context

Making Gnista a daily driver means running a real Emacs configuration's worth of packages. Some built-ins only turn on when a configuration requires them (`org-tempo`), some live in frames rather than buffers (`tab-bar-mode` keeps its tabs in the `tabs` frame parameter and shows them in a line across the frame), and the next step is loading packages that do not ship with Gnista at all. Gnista had none of `require`, frame parameters or a frame-wide line above the windows.

## Options considered

1. **Preload everything and gate behaviour behind variables.** Simple, but `org-tempo` changes what TAB does once loaded, so `-q` would no longer behave as `emacs -Q`, and it gives no way in for a user's own packages.
2. **`gnista.require`, as Emacs's `require`.** Shipped packages that loading turns on go in `LIBRARY` beside `PACKAGES`; anything else is `NAME.ts` along `load-path`. Each engine imports the module from a native while the calling script runs, so a configuration's `gnista.require("org-tempo")` is in force on the next line, as in Lisp.
3. **The tab bar drawn by the front ends from tab state they read.** That would need the front ends to know about tabs, which are a package's business.
4. **The tab bar as a mode-line construct.** The core formats a frame's `tab-bar-line` parameter at redisplay, as it formats mode lines, and front ends draw the segments in a line taken from the top of the frame when `tab-bar-lines` is 1. A click on it is `<tab-bar> <mouse-1>` with the column, which tab-bar.ts maps to the item it put there.

## Decision

Options 2 and 4. Frames get parameters (`frame-parameter`, `set-frame-parameter`); `tab-bar-lines` and `tab-bar-line` are the two the core reads. tab-bar.ts keeps each frame's tabs, each a window configuration, and builds its line with `tab-bar-format`, auto-width and all, from an `:eval` so it is current at each redisplay.

## Consequences

- External packages are one `gnista.require` away, loaded from `~/.config/gnista/packages` by default, with the same import-by-feature rule as shipped ones.
- Any package can put something on the tab bar by changing `tab-bar-format`, as in Emacs.
- The GUI draws the tab bar in its own inks, as it does the mode line, so the tab-bar faces' colours are not shown there; a theme that styles the tab bar would need the GUI to honour faces on these lines.
- Frame parameters other than these two are only stored, not acted on.

## Dependencies introduced

None.
