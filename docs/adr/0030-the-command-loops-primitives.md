# 0030. The command loop's primitives

Status: accepted · 2026-10-30

## Context

Lisp that reads keys itself, rather than through a command's interactive spec, uses the command loop's primitives in Emacs's keyboard.c: `read-key`, `read-event`, `read-char` and `read-key-sequence` read keys partway through a command; `this-command-keys` says which keys ran it; `recent-keys` lists the keys typed lately with the commands they ran, which `C-h l` shows; and `recursive-edit` lets the user go on editing until `C-M-c` returns to the command, or `C-]` quits it. Transient-style menus, `C-h l`, keyboard macro editing, modal packages and `query-replace`'s `C-r` need them. Gnista had `read-char-choice` and the other questions, `unread-command-events` and the last key and command, but none of these ([docs/plan.md](../plan.md), the fourth gap in the core).

Emacs's Lisp waits inside the primitive for the key. Gnista's commands do not wait: front ends hand the editor one key at a time, and code that needs an answer gives a function to run with it, which a script writes as `await`, as the minibuffer's readers and questions already work.

## Options considered

1. **Block**, running a nested command loop inside the primitive that takes keys from the front end until the answer comes, as Emacs does. The front ends would have to be driven from inside the editor, and the agent's and tests' key-at-a-time driving would no longer work.
2. **Read keys as questions are answered**: the primitive notes what it waits for and returns; the next key goes to it before any keymap, and its answer runs the waiting code in the context it read in, as questions do.

## Decision

Option 2, in `keyboard.rs`, as Emacs's keyboard.c:

- `read-key`, `read-event`, `read-char` and `read-key-sequence` show their prompt in the echo area and give the next key to the waiting code, as its description: `"x"`, `"C-x"`, `"<f1>"`. `read-key` takes `ESC` alone, as Emacs's does, rather than as Meta for the next key; `read-char` signals "Non-character input-event" for a key that is not a character; `read-key-sequence` reads until the active keymaps bind the keys or do not, `C-g` being a key like others in it, and the rest quit on `C-g`. Scripts `await gnista.readKey(prompt)` and the rest.
- `this-command-keys` is the keys of the command running, without its prefix argument's, which ran commands of their own, as Emacs 30.2 gives them; after `read-key-sequence`, the sequence read.
- `recent-keys` keeps the last 300 keys typed, as `lossage-size` says, each command after the keys that ran it, and not the keys a keyboard macro replays. `view-lossage` on `C-h l` shows them as help.el writes them.
- `recursive-edit` is entered and the editor goes on taking commands, the mode line showing `[` `]` around the modes for each level, as `%[` and `%]` in `mode-line-modes` do; `exit-recursive-edit` on `C-M-c` runs what waited, and `abort-recursive-edit` on `C-]` quits it, or the minibuffer if one was opened inside it. `top-level` leaves every level. `recursion-depth` counts recursive edits and minibuffers.
- `input-pending-p` and `discard-input` look at the keys given back with `unread-command-events`.

Events stay key descriptions, as Gnista's keys are everywhere; a mouse event's place is the last mouse event's, which `lastMouseEvent` and `posn-at-point` give.

## Consequences

Packages can read keys and edit recursively as Emacs's Lisp does, written with `await`. What Emacs does that this does not: events as Lisp values with their positions inside them, so a mouse event read by `read-event` carries no place of its own; keys a command reads with `read-event` added to `this-command-keys`; and `function-key-map`, which Gnista does not have yet.

Added since: `read-event` and `read-char` take Emacs's SECONDS (`{ seconds }`) and give undefined when no key comes in time, the deadline counted among the timers front ends wake for. On them, `sit-for` (`gnista.sitFor`) waits until the time passes or a key comes, putting the key back to run as a command, as subr.el's does, and `sleep-for` (`gnista.sleepFor`) goes on after its time in the command's buffer.

Also added since: **translation keymaps.** A key can be bound to keys, as an Emacs string or vector binding (`gnista.bindKey("C-c m", ["a", "b"])`): in an ordinary keymap they are typed as a keyboard macro. `input-decode-map` and then `key-translation-map` translate the keys the command loop reads, as read_key_sequence does: from where each map last stopped, keys it binds to keys become those keys, or what a function bound there returns, and keys it binds to nothing are passed over; a prefix in either waits for more. On them, `packages/iso-transl.ts` gives `C-x 8` as iso-transl.el does (`C-x 8 ' e` is é), its table generated from Emacs by `tests/emacs/iso-transl.el`. Six Emacs comparison cases match (`iso-transl.json`).

## Dependencies introduced

None.
