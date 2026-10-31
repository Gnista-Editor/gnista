# 0042. Isearch's state and hooks, and searching comint's history

Status: accepted · 2026-10-31

## Context

[ADR 0011](0011-search-and-the-minibuffer.md) wrote isearch.ts after isearch.el's keys and prompts, but on a state of its own: a list of steps, each a string, a point and a match. Emacs's modes reach into isearch through its variables and hooks. Comint's `M-r` (`comint-history-isearch-backward-regexp`) sets `isearch-search-fun-function`, `isearch-message-function`, `isearch-wrap-function` and `isearch-push-state-function` buffer-locally from `isearch-mode-hook`, reads `isearch-forward`, `isearch-success` and `isearch-error`, moves `isearch-barrier` and `isearch-opoint`, and puts it all back from `isearch-mode-end-hook`. Info, Dired's file-name search, Org's and outline's invisible text, and `multi-isearch` do the same. ADR 0038 left `M-r` out for want of them.

## Options considered

1. **Port isearch.el's core: its variables and its stack of states.** `isearch-mode`, `isearch-done`, `isearch-update`, `isearch-search`, `isearch-search-string`, `isearch-repeat`, `isearch-search-and-update`, `isearch-push-state` and `-pop-state`, `isearch-cancel` and `isearch-abort`, `isearch-message` and `-message-prefix`, each as Emacs writes it, with the state in the variables Emacs names. Larger, but other packages can then be ported as they are.
2. **Give the existing isearch.ts a hook or two for comint.** Smaller now, but each later package would need another special case, and the behaviour would drift further from Emacs's.

## Decision

Option 1. isearch.ts keeps isearch.el's state in its variables (`isearch-string`, `isearch-message`, `isearch-forward`, `isearch-regexp`, `isearch-success`, `isearch-error`, `isearch-wrapped`, `isearch-barrier`, `isearch-opoint`, `isearch-other-end`, `isearch-case-fold-search`, `isearch-adjusted`, `isearch-yank-flag`) and its states on a stack, as `isearch-cmds`, each with the function `isearch-push-state-function` gave to restore it. It searches through `isearch-search-fun-function` (by default `isearch-search-fun-default`, which gives a function that searches as `re-search-forward` or `-backward` with the string quoted unless it is a regexp), with `case-fold-search` bound to `isearch-case-fold-search` as `isearch-search` binds it, filtered by `isearch-filter-predicate`; says where it is through `isearch-message-function`; wraps through `isearch-wrap-function`; and runs `isearch-mode-hook`, `isearch-update-post-hook` and `isearch-mode-end-hook` (with `isearch-mode-end-hook-quit`). Lazy highlighting searches forward with a bound through the same function, as Emacs's does. `isearch-toggle-regexp` (`M-r`, `M-s r`) only changes the mode, as Emacs's does: what is typed next searches the new way. `isearch-del-char` and `isearch-yank-char` are new. The functions comint needs (`isearchSearchFunDefault`, `isearchMessage`, `isearchMessagePrefix`, `isearchNoUpperCaseP`) are exported for packages to import.

comint.ts ports comint.el's history search: `M-r` and `comint-history-isearch-backward` set `comint-history-isearch` and start isearch, whose `isearch-mode-hook` entry `comint-history-isearch-setup` makes it search the input after the prompt and then each input before it in turn, put after the prompt, shows the search's prompt over the program's with an overlay's `display`, says which history item it is at, wraps to the newest or oldest input, and goes back through the history as DEL pops the search's states. `comint-history-isearch` set to `t` or `dwim` makes `C-r` search the history too.

The isearch cases in `tests/emacs/cases/isearch.json` still match Emacs; `tests/comint.rs` checks `M-r` on a shell.

## Consequences

- Packages that search in their own way can be ported as Emacs writes them: Dired's `dired-isearch-filenames`, Info's search over nodes, `multi-isearch-buffers` for the buffer list's `M-s a C-s`, and opening invisible text as isearch passes it.
- The state lives in editor variables, read and set on each search step; that costs little beside the search itself, and [docs/optimisation.md](../optimisation.md) is where it would go if it showed.
- Still missing from isearch: the search ring's `M-p` and `M-n`, `isearch-edit-string`, word and symbol search, lax whitespace, the lazy count, opening invisible text, and `search-exit-option`'s scrolling commands.

## Dependencies introduced

None.
