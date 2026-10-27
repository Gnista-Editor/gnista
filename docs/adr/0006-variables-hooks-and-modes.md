# 0006. Variables, hooks and modes

Status: accepted · 2026-10-27

## Context

Milestone 2 of [the plan](../plan.md) is the substrate packages are built on, org mode included: documented variables with buffer-local values, hooks, and major and minor modes with their own keymaps. In Emacs all of these are values of Lisp symbols. Ember has no Lisp, so it needs its own model, and [ADR 0005](0005-rust-core-typescript-commands.md) says how to split it: what Emacs does in C goes in Rust, and what it does in Lisp goes in TypeScript.

## Options considered

1. **Everything in TypeScript.** Variables, hooks and modes as JavaScript objects. But Rust commands need variables too (`tab-width`, `overwrite-mode`), and key lookup, which is in Rust, needs to know the active keymaps.
2. **Everything in Rust.** Modes defined by Rust structs. But that would put Emacs's `define-derived-mode` and `define-minor-mode`, which are Lisp in Emacs, in Rust.
3. **Follow Emacs's split.** The state in Rust, and the functions that define modes in TypeScript.

## Decision

Follow Emacs's split.

**In the Rust core:**

- **Variables** have documentation, a global value and optional per-buffer values. Some are automatically buffer-local, as with Emacs's `defvar-local`. Setting follows Emacs's `setq`, and defining follows `defvar` by keeping an existing value. A value is `null`, a boolean, a number, a string, or a list of these. Those are the values JavaScript and JSON share, so scripts read and write them directly.
- **Hooks** are documented variables whose value is their functions, which can be Rust closures or script functions. A buffer's own functions run before the global ones. The command loop runs `pre-command-hook` and `post-command-hook` around each command that keys run. A pre-command function can change `this-command` to replace the command, as `delete-selection-mode` needs. Visiting and saving run their hooks.
- **Modes** are state. A buffer's major mode is the buffer-local variables `major-mode` and `mode-name` plus its local keymap. A minor mode is on when the variable of its name is true, and it is registered with a lighter and a keymap. Keys are looked up in Emacs's order: a transient map, the minibuffer's map, minor modes (most recently defined first), the major mode's map and its parents, then the global map.
- **Calls from code** do not change `this-command` or `last-command`, as calling a function from Lisp does not. Only commands that keys or M-x run do. The core calls `normal-mode` after visiting a file and `help-mode` for `*Help*` by name, if they are defined, as Emacs's C calls those Lisp functions.

**In TypeScript:**

- `defineMajorMode` and `defineMinorMode`, in the prelude, do what `define-derived-mode` and `define-minor-mode` do. A major mode clears the buffer's own variables, sets up its parents and then itself, and runs the mode hooks with the parent's first. A minor mode toggles when run from a key, turns on when called from code without an argument, and follows the sign of a prefix argument.
- The modes and the commands about them are packages:

  | Package | Contents | After Emacs's |
  | --- | --- | --- |
  | `simple.ts` | `fundamental-mode` and `overwrite-mode` | `simple.el` |
  | `files.ts` | `normal-mode` and `auto-mode-alist` | `files.el` |
  | `text-mode.ts` | `text-mode` | `text-mode.el` |
  | `delsel.ts` | `delete-selection-mode` | `delsel.el` |
  | `help.ts` | `help-mode`, `describe-variable` and `describe-mode` | `help-mode.el` and `help-fns.el` |

## Consequences

Packages can define modes and variables, and Rust commands can read the same variables. `auto-mode-alist` patterns are JavaScript regular expressions rather than Emacs's. The generated `ember.d.ts` lists every variable and hook with its documentation, as it does commands. Variables cannot hold functions or objects yet; hooks are the only place functions are stored.

## Dependencies introduced

None.
