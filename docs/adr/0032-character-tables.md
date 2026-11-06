# 0032. Character tables

Status: accepted · 2026-10-30

## Context

[ADR 0027](0027-emacs-regexps.md) gave the core Emacs's standard tables as generated data: each character's general category, script, standard syntax entry, case and categories. Lisp uses more than that. It changes case with `upcase`, `capitalize` and the commands on `M-u`, `M-l`, `M-c`, `C-x C-u` and `C-x C-l`, none of which E8 had. And it treats char-tables as values (casefiddle.c, casetab.c, category.c, chartab.c: none of 42 primitives, [docs/plan.md](../plan.md)'s fifth gap):
- language environments and modes make case tables of their own, such as Turkish's, where I and ı are a pair;
- packages define categories and put characters in them for `\cX` in their regexps;
- and `char-width-table`, display tables and `char-script-table` are char-tables too.

## Options considered

1. **Tables as Rust types**, a case table and a category table, each with the functions on it. Lisp's char-tables are one type with subtypes and extra slots, and code passes them to `map-char-table`, `char-table-range` and `aref` without caring which kind they are.
2. **Char-tables as values**, as Emacs's are, with case tables and category tables as char-tables of their subtypes.

## Decision

Option 2.

**Char-tables** (`chartab.rs`) are values, `Value::CharTable`, held in the editor by id as keymaps are, and a `CharTable` object in scripts. A table keeps runs of characters with one value, so a range costs what a character does. It has `make-char-table`'s initial value, a default for nil values, a parent after that, a subtype and extra slots, as many as the subtype's `char-table-extra-slots` property says. The functions are `make-char-table`, `char-table-range`, `set-char-table-range`, `aref`, `aset`, `map-char-table`, `copy-sequence`, `char-table-parent`, `set-char-table-parent`, `char-table-extra-slot` and `set-char-table-extra-slot`. Characters are code points, as Emacs's are, or one-character strings where a script gives them.

**Changing case** (`casefiddle.rs`) is casefiddle.c's:
- Strings use `upcase`, `downcase`, `capitalize` and `upcase-initials`; the buffer has the region and word commands.
- Words follow the buffer's syntax table, with `case-symbols-as-words`.
- In strings and buffers, characters Unicode cases into several do so, ß to SS. A capital sigma ending a word becomes final sigma, and title case is Unicode's. `unicode.el` writes these tables from Emacs.
- A change keeps text properties, undoes as one replacement, and leaves markers where they were, as replace_range_2 does.

**Case tables** (`casetab.rs`) are char-tables of subtype `case-table`: lower cases, with upper cases in extra slot 0. Each buffer has one, the standard one unless it sets its own with `set-case-table`, and changing case and folding case in regexp searches follow it. `case-table.ts` ports case-table.el's `copy-case-table`, `set-case-syntax-pair`, `set-case-syntax-delims` and `set-case-syntax`; the prelude has `with-case-table`. Those functions change the standard syntax table, as in Emacs, which E8 no longer refuses.

**Category tables** (`category.rs`) are char-tables of subtype `category-table`, with each character's set written as its designators, `".Lalr"`, and the docstrings in extra slot 0. The functions are `define-category`, `category-docstring`, `get-unused-category`, `modify-category-entry`, `char-category-set`, which gives the mnemonics directly, and `make-`, `copy-`, `set-` and `standard-category-table`. `\cX` follows the buffer's table.

**Speed.** The standard tables are made as char-tables only when code asks for them. Until then, and while they are unchanged, the generated tables answer for them, as before. Each table counts its changes, so the fast path holds exactly while nothing has changed. A buffer with its own table puts it in effect for its searches, through a per-thread setting checked by a single atomic load. The compiled regexps kept for it are keyed by the tables they were compiled for. Searches over 10 MB take what they did before.

## Consequences

The case commands work as in Emacs, checked by 18 cases against it, and packages can make and use case and category tables and char-tables of their own. What differs from Emacs:
- Emacs's `downcase` of an ASCII-only string ignores the case table, as such strings are unibyte there. JavaScript strings make no such difference, so E8 follows the table.
- Literal searches fold case by the standard table, not a buffer's own.
- Equivalence tables (extra slot 2) are not worked out.
- `upcase-region` and `downcase-region` are not disabled for new users, as novice.el disables them.
- Unicode's other character properties (`get-char-code-property`) and syntax tables as char-tables are still to come.

## Dependencies introduced

None.
