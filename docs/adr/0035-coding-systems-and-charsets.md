# 0035. Coding systems and charsets

Status: accepted · 2026-10-30

## Context

Ember read and wrote UTF-8, UTF-8 with a signature and Latin-1, each with Unix, DOS or Mac line ends ([ADR 0018](0018-files-and-saving.md)). Emacs has dozens of coding systems, and the primitives Lisp uses to convert text itself: `encode-coding-string`, `decode-coding-region`, `detect-coding-string`, `find-coding-systems-region` and their kin, used for files, network data, hashing and process output. It also has charsets, with `encode-char` and `decode-char`. A file in Shift_JIS, GBK, KOI8-R or UTF-16 could not be opened in Ember. [docs/plan.md](../plan.md) lists these eighth among the gaps in the core.

## Options considered

1. **Tables of Ember's own**, generated from Emacs's charset maps as the character tables are ([ADR 0032](0032-character-tables.md)). This gives Emacs's mappings exactly, but means writing and maintaining every multibyte coder.
2. **`encoding_rs`**, the Encoding Standard's implementation that Firefox uses, for the multibyte and single-byte tables, with Emacs's names, mnemonics, defaults and detection around it, and the few places its mappings differ from Emacs's mended.

## Decision

Option 2.

**Coding systems** (`coding.rs`):
- **Which.** Fifty-five of them, under Emacs's names and aliases:
  - `undecided` and `prefer-utf-8`;
  - UTF-8 with and without a signature, and `utf-8-auto`;
  - the five UTF-16s;
  - `us-ascii`, Latin-1 to Latin-10 and the other ISO 8859 sets, and TIS-620;
  - Windows 1250 to 1258, 874 and 866, KOI8-R and KOI8-U, and Mac Roman;
  - Shift_JIS and code page 932, EUC-JP, ISO-2022-JP and `iso-2022-7bit`;
  - GB 2312, GBK, GB 18030, Big5 and Big5-HKSCS, EUC-KR and code page 949;
  - `raw-text` and `no-conversion`.
- **Line ends.** Each has `-unix`, `-dos` and `-mac` forms, or line ends found from the text when undecided.
- **What Emacs gives.** The mnemonics, `coding-system-type`, MIME charsets and the default character are Emacs's. The default character, which a character the coding cannot write becomes, is a space, or `?` for ASCII.
- **Mending the tables.** The Encoding Standard reads ISO 8859-9 and -11 as Windows code pages, with no C1 controls, so those come from tables built once. It reads Shift_JIS and EUC-JP as Microsoft does, with fullwidth forms, so Emacs's JIS mapping (U+301C for 81 60, and the rest) is restored for those codings, while code page 932 keeps Microsoft's. GB 2312 and EUC-KR are kept to their 94×94 sets.
- **ISO 2022.** `iso-2022-7bit` reads the designations Emacs writes (JIS X 0208, 0212 and 0201, GB 2312, KS C 5601 and the ISO 8859 sets).

**Raw bytes.** Bytes that are no text in their coding decode to raw-byte characters, as Emacs's eight-bit charset does, so they are written back as they were. Emacs's raw bytes lie beyond Unicode, where Ember's text cannot go. Ember's are the last 128 code points, U+10FF80 to U+10FFFF, which Unicode leaves for private use. They and the C1 controls show as octal escapes, `\351`, as in Emacs.

**Visiting** finds a file's coding as Emacs's `set-auto-coding` and detection do:
- a byte order mark for UTF-8 or UTF-16;
- a `coding:` in the `-*-` line, or the second line after `#!`;
- a `Local Variables:` list at the end;
- otherwise from the bytes: binary if there is a NUL, `iso-2022-7bit` for its escapes, undecided for ASCII, UTF-8 if valid, Latin-1 otherwise.

`coding-system-for-read` and `coding-system-for-write` override this, and `last-coding-system-used` says what was used.

**Commands** (`mule.ts`):
- `set-buffer-file-coding-system` on `C-x RET f` now takes any coding.
- `revert-buffer-with-coding-system` on `C-x RET r`.
- `universal-coding-system-argument` on `C-x RET c`, which runs the next command with a coding, as `C-x RET c latin-1 C-x C-s` saves in Latin-1.
- Saving text the buffer's coding cannot write asks `Select coding system (default utf-8): `, as `select-safe-coding-system` does.

**Primitives** for scripts (`codingfns.rs`), by Emacs's names:
- **Converting:** `encodeCodingString`, `decodeCodingString`, `encodeCodingRegion`, `decodeCodingRegion`.
- **Finding a coding:** `detectCodingString`, `detectCodingRegion`, `findCodingSystemsString`, `findCodingSystemsRegion`, `unencodableCharPosition`, `checkCodingSystemsRegion`.
- **About coding systems:** `checkCodingSystem`, `codingSystemP`, `codingSystemList`, `codingSystemAliases`, `codingSystemBase`, `codingSystemType`, `codingSystemEolType`, `codingSystemChangeEolConversion` and `-TextConversion`, `codingSystemGet`, `codingSystemMnemonic`.
- **Charsets** (`charset.rs`): `charsetp`, `charsetList`, `charsetPriorityList`, `charCharset`, `encodeChar`, `decodeChar`. Fifty-five charsets cover the ISO 8859 sets and their 96-character halves, JIS X 0208, 0212 and 0201's katakana, GB 2312, GBK, Big5, KS C 5601, the Windows and other single-byte sets, `unicode`, `emacs` and `eight-bit`, with Emacs's code points.

Scripts hold bytes as strings of characters U+0000 to U+00FF, one for each byte, as Emacs's unibyte strings print. A string with other characters stands for the UTF-8 Emacs would hold it in.

Emacs 30.2 checked the behaviour two ways:
- **The Emacs comparison** (22 cases in `codings.json`): visiting files in UTF-16, ISO-2022-JP and Latin-2 by cookie, setting and reverting codings, `C-x RET c`, and the question when saving. The comparison compares the bytes written.
- **Batch probes**, whose answers the tests hold (`tests/codings.rs`, and the unit tests in `coding.rs` and `charset.rs`).

## Consequences

Ember opens and saves files in the codings people meet: Japanese, Chinese, Korean and Cyrillic, legacy Windows files, and UTF-16. Packages can convert text as their Lisp does. Detection costs one more pass over a file: opening 100 MB went from 131 to 138 ms.

What differs from Emacs is in [differences.md](../differences.md):
- Decoded text has no `charset` property, so `iso-2022-7bit` chooses each character's set from the text's script rather than from where it was read.
- There are no unibyte strings.
- Detection has no language environment, so Shift_JIS and EUC-JP files without a cookie open as Latin-1. Emacs's own result without a Japanese environment is no better.

Not done yet:
- **Coding systems Emacs has and Ember lacks:** `emacs-mule`, UTF-7, the ISO-2022 variants beyond JIS, CNS 11643 and the Indic and Vietnamese ones.
- **Choosing codings:** language environments, and `auto-coding-alist` by file name.
- **The priority list** in `describe-current-coding-system`.

Added since: processes' codings ([ADR 0037](0037-terminals-sockets-and-process-codings.md)), and `describe-coding-system` on `C-h C` (`packages/mule-diag.ts`, from mule-diag.el). Emacs's description of each coding system, its documentation, type, ISO 2022 designations and charsets, is generated from Emacs by `tests/emacs/mule-diag.el` into a table, and the mnemonic, aliases and line ends are worked out as `print-coding-system-briefly` does. With no name it shows the coding systems in use, as `describe-current-coding-system`, up to the priority list. Thirteen Emacs comparison cases match (`mule-diag.json`).

Then `prefer-coding-system`, from mule-cmds.el, with `set-coding-system-priority` and `coding-system-priority-list` in the core: detection tries the preferred coding systems first, each only if the file's bytes read in it without error, before its own order. Emacs prefers by coding category, so preferring `windows-1252` there wins over UTF-8 for any file that is not ASCII, as here. `set-default-coding-systems` makes it the default for new buffers and processes, and a buffer still undecided, as an ASCII file's, is written in the default when text that needs more is saved. The priority is the editor thread's. Three cases match Emacs: reading Shift_JIS again after preferring it, a new file saved in it, and Windows-1252 read in place of UTF-8.

## Dependencies introduced

`encoding_rs` 0.8 in `ember-core`, for the single-byte and multibyte tables and their encoders and decoders: Mozilla's implementation of the WHATWG Encoding Standard, pure Rust, used by Firefox. It brings two small crates with it, `core_detect` and `multiversion_no_op`. It does no networking.
