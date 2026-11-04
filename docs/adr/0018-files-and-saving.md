# 0018. Files and saving

Status: accepted · 2026-10-29

## Context

To keep real notes in Gnista, saving has to be as safe as in Emacs. Until now a save truncated the file and wrote it: no backup, no check that the file changed on disk since it was read, no auto-saving, and no way to read a file back. Files had to be UTF-8, and a DOS file's carriage returns showed up as text. Quitting with unsaved files meant typing C-x C-c twice, not being asked about each file.

Emacs does most of this in Lisp, in files.el, and some in C: writing and reading in a coding system, the visited file's modification time, auto-saving from the keyboard loop, and the check before the first change to a file that changed on disk. Its Lisp also asks questions partway through a command, with `yes-or-no-p` and `y-or-n-p`, and runs code later with timers. Gnista had neither.

## Options considered

1. **Questions as blocking reads.** Commands would wait for the answer as Emacs's Lisp does. Gnista's commands run to completion on the editor's only thread, so a blocking read would need the command loop to become re-entrant.
2. **Questions that call on with the answer.** A command asks and returns; the answer runs a function given with the question. The question opens the minibuffer as a prompt does, so front ends, C-g, the oracle and the agent need nothing new.
3. **Asking by failing.** A command fails with a message to repeat it, as C-x C-c did. Simple, but unlike Emacs, and nothing can be offered but "again".

## Decision

Questions call on with the answer (option 2), and files work as in Emacs, split as Emacs splits them.

- **Questions** (`questions.rs`): `yes_or_no_p`, `read_answer` (one of several typed answers, as kill-buffer's "yes, no, save and then kill"), `y_or_n_p` and `read_char_choice` (a single key, as Emacs 30's `y-or-n-p` takes it in the minibuffer). Anything else asks again, with Emacs's "Please answer yes or no." Scripts have `yesOrNoP`, `yOrNP`, `readAnswer` and `readCharChoice`.
- **Timers** (`timers.rs`): `run_with_timer` and `run_with_idle_timer`, as in Emacs, run by `Editor::run_timers`. Front ends call it when `next_timer_in` says one is due; tests move the clock with `advance_clock`. Timers waited while a prompt was open; since [ADR 0026](0026-the-next-foundations.md) they run then too, as in Emacs.
- **Codings** (`coding.rs`): a file is read as UTF-8, UTF-8 with a signature, or Latin-1 if it is not valid UTF-8, and its line ends as Unix, DOS or Mac, as Emacs detects them. `buffer-file-coding-system` says how it is written back, named as Emacs names it (`undecided-dos`, `iso-latin-1-unix`), and is permanent-local, so changing the major mode keeps it; Gnista's variables can now be permanent-local. The mode line starts with Emacs's mnemonic, such as `U:` or `-\`. Text a coding cannot hold is saved as UTF-8.
- **Writing and reading** (`fileio.rs`), as Emacs's C does: `write_visited_file` makes the backup on the first save of a session, `name~` beside the file, by renaming unless `backup-by-copying` or a hard link says to copy, and not for files in the temporary directory, as Emacs's `normal-backup-enable-predicate`. It writes in the buffer's coding and syncs to the disk, through a new file renamed over the old with `file-precious-flag`, and deletes the auto-save file. `replace_with_file` rereads a file replacing only what differs, keeping point in proportion within what changed, as Emacs's `insert-file-contents` with REPLACE was measured to do.
- **Changed on disk**: the first change to an unmodified buffer whose file changed on disk, and has different text, is refused, and the editor asks "changed on disk; really edit the buffer? (y, n, r or C-h)", as Emacs's lock_file does. y runs the command again and lets it edit, r reverts. A call from code fails instead of asking.
- **Auto-saving**, as Emacs's keyboard loop does it: to `#name#`, after more than `auto-save-interval` keys (never more often than every 20) and after `auto-save-timeout` seconds idle. Visiting a file with a newer auto-save file says so.
- **The commands**, in `files.ts` after files.el: `save-buffer` (asking before overwriting a file changed on disk, and adding the final newline `require-final-newline` asks for, which Text and programming modes turn on), `write-file`, `revert-buffer`, `revert-buffer-quick` (`C-x x g`), `recover-this-file`, `recover-file`, `save-some-buffers` (`C-x s`), `save-buffers-kill-terminal`, `not-modified` (`M-~`), `auto-save-mode`, `auto-revert-mode`, `global-auto-revert-mode` and `set-buffer-file-coding-system` (`C-x RET f`). `kill-buffer` stays in Rust, as it is C in Emacs, and asks before killing a modified file buffer when typed; from code it still refuses.
- **The oracle visits real files.** A case can have `files`, written into a fresh directory outside the temporary one so Emacs makes backups, `find` to visit one, `disk` for the text <f33> gives the file behind the editor's back, and `message` to compare the last message. Such cases compare what the directory holds afterwards: files, backups and auto-save files. A fuzzer edits, saves and reverts files that change on disk.

## Consequences

Saving is as safe as in Emacs, and the oracle checks it byte for byte: backups, codings, the questions and their answers, reverting, auto-saving and recovering. Commands can now ask questions and scripts can use timers, which later work needs (an agent asking before it acts, for one). The questions read differently from Emacs's Lisp: what follows the answer is a function.

Left out: lock files (`.#name`, for two editors on one file), numbered backups and `backup-directory-alist`, coding systems beyond UTF-8 and Latin-1, `revert-buffer`'s per-mode functions (the agenda has `g`), file notifications for auto-revert (it polls every `auto-revert-interval` seconds), the `*Directory*` listing and diff that `recover-file` offers, `kill-emacs-query-functions`, and the question Emacs also asks when `set-buffer-modified-p` (as `C-u M-~`) marks a buffer modified whose file changed on disk.

## Dependencies introduced

None.
