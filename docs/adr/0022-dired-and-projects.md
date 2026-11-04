# 0022. Dired and projects

Status: accepted · 2026-10-29

## Context

With completion ([ADR 0020](0020-completion-and-icomplete.md)) and the file primitives ([ADR 0021](0021-managing-files.md)) in place, the two Emacs tools people manage files with were missing: Dired, a directory as a buffer whose lines are files to visit, mark and act on, and project.el, which knows the tree a file belongs to and finds files in it.

Dired is Lisp in Emacs, in dired.el and dired-aux.el, and so is the listing when Emacs draws it itself, in ls-lisp.el; otherwise it runs `ls`. project.el asks version control for a project's files, as `git ls-files`.

## Decision

- **dired.ts** follows dired.el and dired-aux.el. `C-x d` (`dired`), `C-x 4 d`, `C-x 5 d` and `C-x C-j` (`dired-jump`) list a directory, and `find-file` of a directory lists it too, as `find-file-run-dired`. The buffer is named after the directory, read-only, in `dired-mode` ("Dired by name"), with `default-directory` and `dired-directory` set, and is reused when the directory is listed again. Point starts on the first file that is not `.`, `..` or an auto-save file, as `dired-trivial-filenames` says.
- **The listing** is drawn as ls-lisp draws it for `dired-listing-switches` (`-al`; `A`, `t`, `S`, `r`, `h` and `G` work too), with times as `ls` writes them, and Emacs's `first` style of free space, which leaves out the total line. The free space itself is not shown yet.
- **The keys** are Emacs's: moving (`n`, `p`, `SPC`, `<`, `>`, `M-{`, `M-}` with its wraparound, `j`), visiting (`RET`, `f`, `o`, `C-o`, `v`, `a`, `^`, `q`), marking (`m`, `u`, `d`, `DEL`, `t`, `U`, `% m`, `% d`, `* /`, `* @`, `* *`, `~`, `#`, `* c`, `* N`, `M-DEL`), acting (`x`, `D`, `C`, `R`, `+`, `k`, `w`), and showing (`g`, `l`, `s`, `(`, `?`). Copying and renaming ask as dired-aux does, "Copy foo.txt to: " or "Copy * [3 files] to: ", ask before overwriting with `y`, `n`, `!` and `q`, mark copies `C`, keep renamed files' marks, and add each new file's line where Emacs adds it. Renaming takes buffers visiting the files along, auto-save files and all. Deleting asks first, again for a directory with files in it, and goes to the trash as `delete-by-moving-to-trash` says. `g` keeps marks and point, through a new `revert-buffer-function`.
- **Faces** come from a jit-lock function, as dired.el's font-lock keywords: the header, directories, links, marks, flagged files and backups. `dired-hide-details-mode` hides the details with invisibility, as Emacs's does.
- **Points of detail** come from comparing with Emacs: marking modifies the buffer, and `g` leaves it as modified as it was; point after deleting stays with its line, as `save-excursion` keeps it; messages count as Emacs's do ("0 matching files marked", "Killed 0 lines."); `D` on `.` or `..` is refused while `C` tries and fails; `k` without a prefix kills only marked lines.
- **project.ts** follows project.el. A project is the tree under a version control root (`.git`, `.hg`, `.bzr`, `.svn`, `_darcs`, `.jj`, or `project-vc-extra-root-markers`). `C-x p f` reads one of its files relative to the directory they share, "Find file in ~/proj/editor/: ", completing by substring as Emacs's `project-file` category does; `C-x p d` and `C-x p D` list a directory or the root in Dired; `C-x p b` and `C-x p k` switch among and kill its buffers; `C-x p p` chooses a known project, then what to do there, from `project-switch-commands`. Outside a project they ask for one. Projects used are remembered in `project-list-file`, as JSON. The files come from a new primitive, `projectFiles`, which runs `git ls-files -c -o --exclude-standard`, as project.el's Git backend does, or walks the tree outside Git.
- **Completion categories** gain their own styles first, as Emacs's `completion-category-defaults` and `-overrides` give them: buffer names add substring, project files use substring, and fido puts flex in front of each.
- **The oracle compares Dired buffers.** Batch Emacs lists with ls-lisp, sorting by characters, as Gnista does. Since sizes and dates differ between runs, both sides report a Dired buffer as each line's mark and file name, with point and mark as positions in that. 43 cases cover the keys, and a Dired fuzzer types random keys over random directories. Comparing showed three faults in the recorder, now fixed: a long message log dropped lines, so a later case's messages could seem lost; Emacs folds a message repeated from the case before into it as "[2 times]"; and yes-or-no questions took any other answer as no, where Emacs asks again.

- **Found on the way.** Gnista gains a message log, as Emacs's `*Messages*`: messages are logged, a message shown again straight after itself is counted ("Mark set [2 times]"), and `C-h e` shows the log. The oracle reads it rather than the echo area, leaving out errors, which batch Emacs does not log, and the prefix argument being typed is shown without being logged, as Emacs echoes it. `M-<` and `M->` say "Mark set", as Emacs's `push-mark` does. `M-{` and `M-}` move by paragraphs, after paragraphs.el with its defaults, with 70 oracle cases.

## Consequences

Files are found, opened and managed as in Emacs, from Dired or a project, and every change to the disk asks the agent's permission. Dired's behaviour is checked against Emacs line by line, down to point, marks and messages.

`M-DEL` and `* c` read their marks as text and RET, where Emacs reads a key. Left out: subdirectories inserted into a listing (`i`) and recursive listings, wdired (`C-x C-q` to rename by editing), `dired-do-shell-command`, chmod, chown, touch, symbolic and hard links, compressing, `dired-do-find-regexp` and the other search commands, `dired-omit-mode`, the free-space display, the `*Deletions*` and `*Marked Files*` windows, wildcards in `dired`'s argument, `dired-undo` beyond plain undo, `list-directory`, and project.el's regexp search, shells, compiling and `project-any-command`.

## Dependencies introduced

None. Projects run `git`, if it is installed.
