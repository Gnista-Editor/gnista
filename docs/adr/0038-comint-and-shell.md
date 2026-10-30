# 0038. Comint and M-x shell

Status: accepted · 2026-10-30

## Context

With programs on a pseudo-terminal ([ADR 0037](0037-terminals-sockets-and-process-codings.md)), the next thing Emacs builds is comint.el: a program's conversation in a buffer. It also underlies `M-x shell`, `M-x run-python`, inferior Lisps, SQL and most REPLs. Fields ([ADR 0034](0034-buffer-and-text-property-primitives.md)) were the missing piece for it: comint marks output as the `output` field so C-a and the word commands stop at the prompt.

## Decision

`packages/comint.ts` and `packages/shell.ts`, ported from comint.el and shell.el.

**Comint:**
- **Output** goes through `comint-preoutput-filter-functions`, then in at the process mark as the `output` field. Carriage returns and backspaces work as a terminal shows them, as `comint-carriage-motion` does. Then `comint-output-filter-functions` run. The last line becomes the prompt, read-only with `comint-prompt-read-only`, highlighted as `comint-highlight-prompt`.
- **RET** (`comint-send-input`) sends what is after the prompt, or, before it, the old input at point again. It marks what was sent, runs `comint-input-filter-functions` and keeps the input in a history.
- **The history.** `M-p` and `M-n` go through it, as `comint-input-ring` with its size and `comint-input-ignoredups`.
- **Signals.** `C-c C-c`, `C-c C-z` and `C-c C-\` signal the job in the foreground, as the terminal's own characters (C-c, C-z, C-\) do. That is what Emacs does where signals go via characters, as on macOS and BSD, so the shell sees the interrupt as it would at a terminal.
- **The other keys:** `C-c C-d` and `C-d` at the end send end of file, `C-c C-u` kills the input, `C-c C-o` deletes the last output, `C-c M-o` clears the buffer, `C-c C-a` goes to the start of the input, `C-c C-n` and `C-c C-p` go from prompt to prompt, `C-c C-m` copies old input, and `C-c C-r` and `C-c C-e` show output.
- **`make-comint-in-buffer` and `comint-exec`** start a program on a terminal, with `TERM` from `comint-terminfo-terminal` and the window's size.

**Shell.**
- **Which shell.** `M-x shell` runs `explicit-shell-file-name`, else `$ESHELL`, else `shell-file-name` (from `$SHELL`) in `*shell*`. Bash gets `explicit-bash-args` (`--noediting -i`), and another shell `explicit-NAME-args` or `-i`, with `~/.emacs_NAME` as its first input if it exists. With a prefix argument it asks for the buffer.
- **`shell-mode`**, built on `comint-mode`, follows `cd`, `pushd` and `popd` into `default-directory`, as `shell-dirtrack-mode` does.

**Shell commands**, from simple.el:
- `shell-command` on `M-!` runs a command with `shell-file-name` and `shell-command-switch`. Output that fits the echo area (`max-mini-window-height`) shows there; more goes into `*Shell Command Output*`. No output gives Emacs's messages, `(Shell command succeeded with no output)` and `(Shell command failed with code N and no output)`. With a prefix argument the output goes in at point, with the mark after it. A command ending in `&` runs in the background.
- `shell-command-on-region` on `M-|` gives the region as input; with a prefix argument the output replaces it.
- `async-shell-command` on `M-&` runs on a terminal through comint's filter into `*Async Shell Command*`. It asks for a new buffer if one is running there, and says how it ended.

**Supporting changes:**
- `getenv`, and a directory argument to `expandFileName`, as Emacs's have.
- A process on a terminal is interrupted, quit or stopped with CURRENT-GROUP by writing the terminal's character, as Emacs's SIGNALS_VIA_CHARACTERS.

The tests are in `tests/comint.rs` and drive `/bin/sh -i` on a terminal:
- commands and their output, marked as the `output` field, with C-a stopping at the prompt;
- the history and sending old input again;
- interrupting a job and ending the shell;
- the directory following `cd`;
- carriage returns and backspaces.

A real terminal was checked for what the shell does on C-c. The interactive Emacs this would be compared against cannot run in batch. The shell commands have 8 Emacs comparison cases (`shell-commands.json`).

## Consequences

`M-x shell` works, and REPL modes can be written on comint as Emacs's are.

Not done yet:
- `comint-use-prompt-regexp`;
- history files (`comint-input-ring-file-name`) and `M-r`;
- completing file names and commands at the prompt;
- ANSI colours (`ansi-color`);
- `comint-accumulate`;
- an error buffer for shell commands' standard error (`shell-command-default-error-buffer`).

## Dependencies introduced

None.
