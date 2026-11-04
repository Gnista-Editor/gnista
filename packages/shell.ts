// A shell in a buffer, after Emacs's shell.el: M-x shell runs your shell
// on a terminal in *shell*, in shell-mode, built on comint, which follows
// the directory as cd, pushd and popd change it.

import { makeComintInBuffer, outputFilter, readInputRing } from "comint";
import { PerBuffer } from "subr";

for (const [name, doc, value] of [
  ["explicit-shell-file-name", "The shell M-x shell runs, if not $ESHELL or shell-file-name.", null],
  ["explicit-bash-args", "What M-x shell gives bash: no line editing, and interactive.", ["--noediting", "-i"]],
  ["shell-prompt-pattern", "An Emacs regexp for a shell's prompt, which comint-prompt-regexp starts as in shell-mode.", "^[^#$%>\n]*[#$%>] *"],
  ["shell-dirtrack-mode", "Whether shell-mode follows cd, pushd and popd to keep default-directory where the shell is.", true],
] as const) {
  gnista.defineVariable({ name, doc, value: value as gnista.Value });
}

/** The directories pushd has pushed, newest first, as shell-dirstack. */
const dirstacks = new PerBuffer<string[]>();

/** Follows a command that changes directory, as shell-directory-tracker: cd, pushd and popd. */
function directoryTracker(input: string): void {
  if (gnista.variable("shell-dirtrack-mode") === false) return;
  const buffer = gnista.bufferName();
  const stack = dirstacks.get(buffer) ?? [];
  dirstacks.set(buffer, stack);
  // Each command of a line like "cd a; ls".
  for (const command of input.split(/[;&|]+/)) {
    const [word, ...args] = command.trim().split(/\s+/);
    const arg = args[0];
    const here = String(gnista.variable("default-directory") ?? "~/");
    const go = (dir: string) => {
      const expanded = gnista.expandFileName(dir, here);
      if (gnista.fileDirectoryP(expanded)) gnista.setVariable("default-directory", expanded.endsWith("/") ? expanded : `${expanded}/`);
    };
    if (word === "cd" || word === "chdir") {
      if (arg === undefined) go(gnista.getenv("HOME") ?? "~");
      else if (arg === "-") go(stack[0] ?? here);
      else go(arg);
    } else if (word === "pushd") {
      if (arg !== undefined) {
        stack.unshift(here);
        go(arg);
      } else if (stack.length > 0) {
        const top = stack.shift()!;
        stack.unshift(here);
        go(top);
      }
    } else if (word === "popd" && stack.length > 0) {
      go(stack.shift()!);
    }
  }
}
gnista.defun("shell-directory-tracker", directoryTracker);

gnista.defineVariable({
  name: "shell-history-file-name",
  doc: "The file shell-mode reads the history from: nil for $HISTFILE or the shell's own default, t for none.",
  value: null,
});
gnista.defineVariable({ name: "shell--start-prog", doc: "The name of the shell this buffer runs.", value: null, local: true });
gnista.put("shell--start-prog", "permanent-local", true);

/**
 * Reads the shell's history file into the buffer's history, as shell-mode
 * does: shell-history-file-name, else $HISTFILE, else the shell's own
 * default, with $HISTSIZE for the history's size.
 */
function historySetup(): void {
  const shell = String(gnista.variable("shell--start-prog") ?? "");
  const named = gnista.variable("shell-history-file-name");
  let file: string | undefined = typeof named === "string" ? named : named === null || named === undefined ? gnista.getenv("HISTFILE") : undefined;
  if (file === "") file = undefined;
  if (file === undefined && (named === null || named === undefined)) {
    file = { bash: "~/.bash_history", ksh: "~/.sh_history", zsh: "~/.zsh_history" }[shell] ?? "~/.history";
  }
  if (file !== undefined) {
    const size = Number(gnista.getenv("HISTSIZE") ?? "");
    if (Number.isInteger(size) && size > 0) {
      gnista.makeLocalVariable("comint-input-ring-size");
      gnista.setVariable("comint-input-ring-size", size);
    }
  }
  if (file !== undefined && gnista.fileTruename(gnista.expandFileName(file)) === gnista.fileTruename("/dev/null")) file = undefined;
  gnista.setVariable("comint-input-ring-file-name", file ?? null);
  if (shell === "zsh") {
    gnista.setVariable("comint-input-ring-file-prefix", ": [[:digit:]]+:[[:digit:]]+;");
  }
  readInputRing(true);
}

gnista.defineMajorMode({
  name: "shell-mode",
  modeName: "Shell",
  parent: "comint-mode",
  doc:
    "The major mode for a shell in a buffer: type commands after its prompt and send them with RET.\n\n" +
    "It is comint-mode, so M-p and M-n go through earlier commands and C-c C-c interrupts the job running, and " +
    "default-directory follows the shell's cd, pushd and popd.",
  setup: () => {
    gnista.makeLocalVariable("comint-prompt-regexp");
    gnista.setVariable("comint-prompt-regexp", gnista.variable("shell-prompt-pattern") ?? null);
    gnista.addHook("comint-input-filter-functions", directoryTracker, { local: true });
    historySetup();
  },
});

gnista.defineCommand({
  name: "shell",
  doc:
    "Run your shell in the buffer *shell*, or go to it if it runs there already.\n\n" +
    "The shell is explicit-shell-file-name, else $ESHELL, else shell-file-name; bash runs with explicit-bash-args, " +
    "and other shells with -i, or the variable explicit-NAME-args. With a prefix argument, ask for the buffer.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: gnista.PrefixArg) => {
    const buffer =
      arg === null ? "*shell*" : (await gnista.readString("Shell buffer: ", { default: gnista.generateNewBufferName("*shell*") })) || "*shell*";
    const running = gnista.getBufferProcess(buffer);
    if (running === undefined || !gnista.processLiveP(running)) {
      const program = String(gnista.variable("explicit-shell-file-name") ?? gnista.getenv("ESHELL") ?? gnista.variable("shell-file-name") ?? "/bin/sh");
      const name = program.replace(/.*\//, "");
      const explicit = gnista.variable(`explicit-${name}-args`);
      const args = Array.isArray(explicit) ? explicit.map(String) : ["-i"];
      const startfile = [`~/.emacs_${name}`, `~/.emacs.d/init_${name}.sh`].map((f) => gnista.expandFileName(f)).find((f) => gnista.fileExistsP(f));
      gnista.getBufferCreate(buffer);
      gnista.withCurrentBuffer(buffer, () => {
        gnista.setVariable("shell--start-prog", name);
        if (gnista.variable("major-mode") !== "shell-mode") gnista.call("shell-mode");
      });
      makeComintInBuffer("shell", buffer, program, startfile, ...args);
    }
    gnista.call("switch-to-buffer", buffer);
  },
});

// Shell commands in the background, as simple.el's async-shell-command:
// on a terminal, through comint's filter, in *Async Shell Command*.

gnista.defineCommand({
  name: "async-shell-command",
  doc:
    "Run a shell command in the background, its output going into *Async Shell Command* as it comes.\n\n" +
    "When it ends, a message says how.",
  params: [{ name: "command", kind: "string", prompt: "Async shell command: " }],
  run: async (command: string) => {
    const name = String(gnista.variable("shell-command-buffer-name-async"));
    let buffer = name;
    const running = gnista.getBufferProcess(buffer);
    if (running !== undefined && gnista.processLiveP(running)) {
      // As async-shell-command-buffer's confirm-new-buffer.
      if (!(await gnista.yesOrNoP("A command is running in the default buffer.  Use a new buffer? "))) gnista.userError("Shell command in progress");
      buffer = gnista.generateNewBufferName(name);
    }
    const directory = gnista.expandFileName(".");
    gnista.getBufferCreate(buffer);
    gnista.withCurrentBuffer(buffer, () => {
      gnista.letBind({ "inhibit-read-only": true }, () => gnista.deleteRegion(0, gnista.bufferSize()));
      gnista.makeLocalVariable("default-directory");
      gnista.setVariable("default-directory", directory.endsWith("/") ? directory : `${directory}/`);
    });
    const shell = String(gnista.variable("shell-file-name"));
    gnista.makeProcess({
      name: "Shell",
      buffer,
      command: [shell, String(gnista.variable("shell-command-switch")), command],
      directory,
      env: { TERM: String(gnista.variable("comint-terminfo-terminal") ?? "dumb") },
      filter: (p, text) => outputFilter(p, text),
      sentinel: (_p, event) => {
        const status = gnista.processStatus(_p);
        if (status === "exit" || status === "signal" || status === undefined) gnista.message(`${command}: ${event.replace(/\n$/, "")}.`);
      },
    });
    gnista.call("display-buffer", buffer);
  },
});

gnista.bindKey("M-&", "async-shell-command");
