# 0064. The help system

Status: accepted · 2026-11-06

## Context

Help is how Emacs is learnt: `C-h k` says what a key does, `C-h f` what a command does, `C-h b` lists the keys, `C-h a` finds a command by a word, and the `*Help*` buffer links each name to its description. E8 had the mechanism in pieces: `describe-command`, `describe-key` and `describe-bindings` in Rust, with no links, and `describe-variable`, `describe-mode` and `describe-face` in help.ts, each a plain text buffer with no history.

What help shows is text, and text has a licence. Emacs's doc strings are in its GPL source, so copying them is the same as porting org.el ([ADR 0013](0013-following-org-closely.md), [ADR 0014](0014-gpl.md)): allowed while E8 is GPL, but it grows what a permissive core would have to rewrite ([licensing.md](../licensing.md)). The Emacs and Emacs Lisp manuals and the tutorial's prose are a different case: the manuals are under the GNU Free Documentation License with invariant sections, which does not combine with GPL code, so they cannot be copied into E8 at all, rewritten or not. A paraphrase that keeps a document's order, structure and examples is a derivative work; a sentence stating what a command does is a fact, which copyright does not protect.

## Options considered

1. **Copy Emacs's doc strings, link or embed its manuals.** The fastest way to complete help, and the doc strings are licence-compatible today. The manuals are not, and every copied doc string is more derived text.
2. **Write the content from behaviour, port the mechanism.** Every command, variable and face is documented where it is defined, from what it does, its declared parameters and its tests, never from Emacs's string. The machinery of help.el, help-fns.el and help-mode.el is ported like any other package. Help texts Emacs writes by hand, such as `help-for-help` and `describe-bindings`, are generated from the keymaps and the doc strings instead.
3. **No help beyond doc strings.** Leaves out what Emacs users reach for first.

## Decision

Option 2. The mechanism is TypeScript in help.ts, after help.el, help-fns.el and help-mode.el, on a few natives that expose what the core knows: a command's parameters and source (`commandInfo`), a keymap's bindings (`keymapBindings`), every key that runs a command (`whereIsInternal`) and the variables' names (`variableNames`). The content rules are:

- A doc string is written from the command's behaviour, parameters and tests, in E8's own words, when the command is defined. It is never copied or paraphrased from Emacs's. One that turns out to match Emacs's is rewritten.
- Help texts are generated, not written: `help-for-help` lists `help-map`'s bindings with their commands' first lines, `describe-bindings` the active keymaps, `describe-prefix-bindings` the keys under a prefix.
- The tutorial (`C-h t`) will be E8's own document, with its own order and examples. The manuals are never shipped: `C-h i` will read the Info files installed on the user's machine, and `C-h r` open the online manual, neither of which copies anything. An E8 manual grows from docs/features.md and docs/differences.md, which are ours.

The `*Help*` buffer is in `help-mode`, on `special-mode`: `RET` follows the name at point to its description, `TAB` and `S-TAB` move between the names, `l` and `r` go back and forward through what was shown, as help-mode's `help-go-back` and `help-go-forward`. `C-h` or `<f1>` after a prefix key lists the keys under it, as Emacs's `prefix-help-command` does; the command loop runs `describe-prefix-bindings` when the key after a prefix is unbound and is `C-h` or `<f1>`.

## Consequences

Help has no text to audit: every string it shows comes from a definition in E8 or from a keymap. The cost is that each command, variable and face must be documented as it lands, which [CLAUDE.md](../../CLAUDE.md) already asks. The doc strings written before this ADR have not been compared with Emacs's; licensing.md lists that check.

`C-h t`, `C-h i` and `C-h r` are not done, and docs/differences.md lists what else help lacks against Emacs. The Rust `describe-command`, `describe-key` and `describe-bindings` are gone, so an editor without the packages has no help commands, as it has none of the other commands Emacs writes in Lisp ([ADR 0005](0005-rust-core-typescript-commands.md)).

## Dependencies introduced

None.
