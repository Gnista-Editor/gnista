# 0021. Managing files

Status: accepted · 2026-10-29

## Context

E8 could visit and save files but not copy, rename or delete them, make directories, list them, or remember which files were open recently. Emacs does the work in C (fileio.c and dired.c: `copy-file`, `rename-file`, `delete-file`, `make-directory`, `file-attributes`, `directory-files`) and the commands around it in Lisp (files.el, recentf.el, ffap.el). Dired, next, needs all of it, and so does an agent that tidies files.

Deleting is the one change here that cannot be undone. Emacs deletes for good unless `delete-by-moving-to-trash` is set.

## Decision

- **Primitives in the core** (`fileops.rs`), as Emacs's C: attributes as `ls -l` shows them, directory listings, copying files and directories, renaming, deleting files and directories, and making directories, with Emacs's errors ("File already exists: …", "Removing directory: Directory not empty, …"). A target ending in a slash is a directory to copy or move into, as Emacs's `expand_cp_target`. Each change asks `check_permission` first, so an agent needs the user's approval for it ([ADR 0019](0019-agent-buffer.md)).
- **Deleting goes to the trash by default.** `delete-by-moving-to-trash` is on in E8, where Emacs leaves it off: the file goes to the system's trash, from where Finder or the desktop can put it back, and `C-u` deletes for good, as Emacs's commands take the prefix. This makes a default safer, not less safe. Tests and the oracle turn it off, as Emacs has it.
- **Relative file names are in the default directory**, as Emacs's `expand-file-name` takes them, rather than in the directory E8 started in. `default-directory` is now a variable a buffer can set, as Dired's will.
- **The commands** follow files.el, in `files.ts`: `copy-file`, `rename-file`, `delete-file`, `make-directory`, `delete-directory`, `copy-directory`, `read-only-mode` (`C-x C-q`), `find-alternate-file` (`C-x C-v`) and `rename-visited-file`. Typed, they ask before replacing a file, and refuse when told no, as Emacs does; from code, a file already there is an error. A file that cannot be written is visited read-only.
- **Parameters can be worked out as they are asked**: a prompt, the starting input and a collection to complete against may be functions of the arguments read before, as Emacs's interactive specs are code. `rename-file` asks "Rename foo.txt to file: ", and `recentf-open` completes against the recent files, while code and tools still pass arguments directly.
- **recentf.ts** follows recentf.el: `recentf-mode` keeps `recentf-list` from `find-file-hook`, `after-save-hook` and the new `kill-buffer-hook`, saves it in `user-emacs-directory` from the new `kill-emacs-hook`, reads it back and cleans it up when turned on, and starts an empty `file-name-history` with it. `recentf-open` asks for one. It is off by default, as in Emacs; the sample `init.ts` turns it on. The list is saved as JSON, not Lisp.
- **ffap.ts** gives `find-file-at-point` (and `ffap`): the file named around point, if it is there, starts the prompt, with a line number after a colon left off.
- **The oracle lists directories.** A case's `files` can name directories (`sub/`) and files in them, and the listing compared afterwards goes into directories, so cases can check what copying, renaming and deleting did. A fix to record.el in passing: keys a case types answer `read-event` while there are any, as query-replace reads its answers.

## Consequences

Files can be managed from E8, and the agent can do it with the user's approval. Twenty oracle cases check the commands against Emacs, down to the questions and errors. Deleting by mistake loses nothing.

Left out: `ok-if-already-exists` as a number elsewhere than the questions, preserving owners and permissions on copy, symbolic and hard links (`make-symbolic-link`, `add-name-to-file`), `file-truename` in recentf, `recentf-open-files` and `recentf-edit-list`, and ffap's URLs, mail addresses and library names.

## Dependencies introduced

- `trash`: moves files to the system's trash on macOS, Windows and Linux desktops, in `e8-core`.
- `libc`, on Unix: owner and group names for file attributes, in `e8-core`.
