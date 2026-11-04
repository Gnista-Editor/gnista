# 0016. The Org agenda and capture

Status: accepted · 2026-10-28

## Context

Org's agenda (org-agenda.el) and capture (org-capture.el) are large: the agenda has many views, sorting strategies, filters and a time grid, and capture fills templates in an indirect buffer narrowed to the new entry. Gnista needs the everyday core of both, close enough to Emacs that its oracle can check them.

## Options considered

1. **Port everything.** Thousands of lines, most of them for views and options few people use.
2. **Port the default views and the default behaviour, closely.** The week agenda and the global TODO list as Emacs -Q shows them, and capture of entries into files and under headings.

## Decision

Option 2, ported from Org 9.7, in `packages/org.ts`:

- **The week agenda (`org-agenda-list`)** shows the week from Monday with scheduled items, deadlines and active timestamps from `org-agenda-files`. Overdue scheduled items, coming deadlines (within `org-deadline-warning-days`) and missed ones show on today, with Org's leaders, and repeaters count as `org-agenda-get-scheduled` counts them. Items are ordered by Org's urgency, with the category padded to 12 columns and tags against the window's edge.
- **The TODO list (`org-todo-list`)** lists the entries that are not done, most urgent first.
- **The agenda buffer** is read-only, in `org-agenda-mode`. `n`, `p`, `RET`, `TAB`, `t` (which rewrites the entry's lines where they are, as `org-agenda-change-all-lines` does), `g`, `f`, `b`, `.`, `q` and `x` work. Its window takes half to three quarters of the frame, as `org-agenda-window-frame-fractions` has it. `org-agenda` asks for a view's key: `a` or `t`.
- **Capture (`org-capture`)** asks for a template's key from `org-capture-templates`, fills in `%?`, the date escapes and `%%`, and files an entry at the end of a file or as the last child of a heading, which it adds if it is missing. `C-c C-c` finishes and saves; `C-c C-k` kills the entry again.
- **No indirect buffers.** Emacs captures in an indirect buffer narrowed to the entry. Gnista narrows the target buffer itself while the capture is under way, which gives the same text, keys and result.
- **A fixed day for tests.** The internal variable `gnista--today` stands for today, as `record.el` overrides `org-today`. Oracle cases can also answer prompts and key reads (`answers`), visit a file (`visit`), make it the agenda's (`agenda_files`), and set capture templates.

## Consequences

The agenda and capture match Emacs on the cases in `tests/emacs/cases/org-agenda.json` and `org-capture.json`. Left out for now: the day and month spans, the time grid and timed entries, tag and search views, agenda filters, bulk actions, clocking from the agenda, capture to items, tables or plain text, and the capture `%a` link. Neither `C-c a` nor `C-c c` is bound, as in Emacs -Q; bind them in `init.ts`.

## Dependencies introduced

None.
