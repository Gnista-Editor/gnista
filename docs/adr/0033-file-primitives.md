# 0033. File primitives for Lisp

Status: accepted · 2026-10-30

## Context

Gnista could visit, save, copy, rename and delete files ([ADR 0018](0018-files-and-saving.md), [ADR 0021](0021-managing-files.md)), but the primitives Lisp uses to do such things itself were missing or under names of Gnista's own (`fileExists`, `readTextFile`). That covers `insert-file-contents`, `write-region`, the `file-*-p` predicates, modes and times, temporary files and true names. Without them, packages that read and write files of their own cannot be ported as their Lisp is written. And Emacs offers every one of these operations first to a handler in `file-name-handler-alist`, which TRAMP's remote files and the archive and compression modes are built on. Lock files, `.#name`, which warn two editors off one file, were left out of ADR 0018. [docs/plan.md](../plan.md) lists these sixth among the gaps in the core.

## Options considered

1. **Script functions over Rust's file system calls**, one for each primitive. Quick, but a handler could not stand in for any of them, nor for visiting and saving.
2. **The primitives in the core, each asking for a handler first**, as fileio.c's do, with visiting and saving going through `insert-file-contents` and `write-region` when a handler takes the file.

## Decision

Option 2.

**Primitives** (`filefns.rs`), under Emacs's names:
- `insert-file-contents`, with VISIT, BEG and END, and REPLACE, which keeps what is the same at either end with point in proportion, as reverting does;
- `write-region`, with the buffer, a region or a string, APPEND, VISIT (t, a name or quiet) and MUSTBENEW;
- `file-exists-p`, `file-readable-p`, `file-writable-p`, `file-executable-p`, `file-regular-p`, `file-symlink-p`, `file-accessible-directory-p` and `file-newer-than-file-p`;
- `file-modes`, `set-file-modes` and `set-file-times`;
- `file-truename`, `make-temp-file`, `substitute-in-file-name`, `file-name-concat` and `file-name-absolute-p`;
- `directory-files` with FULL, MATCH and COUNT.

Messages and errors are Emacs's: "Wrote" and "Added to", `file-missing` for "Opening input file" and "Opening output file", and `file-already-exists`. The commands built on them are files.el's `insert-file` on `C-x i` and `append-to-file`, and `write-region`'s own, which asks before overwriting.

**Handlers.** Each primitive asks `find-file-name-handler`. That picks, of the entries in `file-name-handler-alist` whose regexp matches the name, the one matching furthest along it. It passes over handlers `inhibit-file-name-handlers` names while the operation is `inhibit-file-name-operation`, and those whose `operations` property leaves the operation out. The handler is called with the operation's name and its arguments, and does the operation itself or binds those two variables and calls the primitive again. Visiting a file a handler takes reads it with `insert-file-contents`, and saving it writes it with `write-region`, so a package can serve whole files from elsewhere.

**Lock files** (`filelock.rs`), as filelock.c:
- **Taking the lock.** The first change to a buffer visiting a file makes `.#name` beside it, a symbolic link to `user@host.pid:boot-time`, while `create-lockfiles` is on, as it is by default.
- **Giving it up.** Saving, reverting, undoing back to the file, killing the buffer and quitting take the lock away.
- **When another process holds it,** the change is refused and Emacs's question is asked: `NAME locked by user@host (pid N): (s, q, p, ?)?`. s takes the lock and p goes on without it, each running the command again from where it started, as the question about a file changed on disk does; q leaves the file alone with `file-locked`.
- **Stale locks.** A lock left by a process no longer running on this machine, or from before the machine last started, is taken over without asking.
- **Asking.** `file-locked-p` says whose a lock is.

The Emacs comparison checks the commands and the lock files, which its runners now list as "lock" where a case turns `create-lockfiles` on; headless tests check a handler serving files of its own, the question about another's lock, and a stale lock.

## Consequences

Packages can read, write and test files as their Lisp does, and a TRAMP-like package can make remote or archived files look local. What is still missing:
- `expand-file-name`, `file-attributes` and the copying and renaming commands do not ask handlers yet;
- `after-insert-file-functions` and `write-region-annotate-functions` are not run;
- `lock-file-name-transforms` is not used;
- `insert-file-contents-literally` and `file-name-case-insensitive-p` are not there;
- `directory-files` sorts even with NOSORT;
- `set-file-modes` and `set-file-times` ask the agent's permission, which Emacs has no counterpart for.

## Dependencies introduced

None.
