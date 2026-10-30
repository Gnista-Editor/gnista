# 0039. Imenu

Status: accepted · 2026-10-30

## Context

`M-x imenu`, going to a definition by name, is how many people find their way round a file in Emacs. Tree-sitter modes make its index from the syntax tree (`treesit-simple-imenu-settings`), Org lists its headings, and other modes give regexps (`imenu-generic-expression`). With nodes and searches for scripts ([ADR 0036](0036-tree-sitter-for-scripts.md)), each of these could be ported as Emacs writes it.

## Decision

**`packages/imenu.ts`, from imenu.el:**
- **Choosing.** `M-x imenu` reads an item of the buffer's index with completion. A submenu's name, such as `Fn`, reads one of its items in turn, and a submenu's own entry is `" "`. Spaces in names show as `imenu-space-replacement` (`.`), the default is the symbol at point if it is in the index, and the history is `imenu--history-list`.
- **Going there.** It pushes the mark, goes to the item, widening if it lies outside a narrowing, and runs `imenu-after-jump-hook`.
- **Making the index.** `imenu-create-index-function` makes it. The default, `imenu-default-create-index-function`, uses `imenu-generic-expression`, as `imenu--generic-function`: each pattern's matches from the start of their line, under their title, sorted by position.

**Tree-sitter** (`treesit.ts`):
- `treesit-induce-sparse-tree` and `treesit-simple-imenu`, from treesit.el and treesit.c. Each setting's matching nodes become entries under their category. A node with matching nodes inside it becomes a submenu with itself as `" "`, named by the setting's function or `treesit-defun-name`. `treesit-major-mode-setup` turns it on.
- `rust-ts-mode`, `js-ts-mode` and `json-ts-mode` have Emacs's settings, including js-mode's `js--treesit-valid-imenu-entry` as Emacs has it. That keeps the Variable category empty for top-level declarations, as Emacs 30's does. The JSON defun name loses the key's quotes, as Emacs's does.

**Org** (`org.ts`): `org-imenu-get-tree` lists headings to `org-imenu-depth` (2), without TODO, priority or tags, with links shown as they read. A heading with headings under it is a submenu of them. After a jump, the heading and its ancestors' heading lines are shown and their entries stay folded, as `org-fold-show-context` with `ancestors` does.

The Emacs comparison has 12 cases (`imenu.json`), all matching: Rust functions, structs, impls and their methods, modules, JavaScript classes and functions, nested JSON keys, the mark, and Org headings, folded ones included.

## Consequences

`M-x imenu` works in the tree-sitter modes and Org, and in any mode that gives regexps.

Not done yet:
- **Caching:** the index is made afresh each time, with no `*Rescan*` item.
- **Other ways to choose:** no menu bar index, `imenu-flatten` or `imenu-sort-function`.
- **Other modes:** Python and outline modes give no index yet.

## Dependencies introduced

None.
