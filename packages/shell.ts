// A shell in a buffer, after Emacs's shell.el: M-x shell runs your shell
// on a terminal in *shell*, in shell-mode, built on comint, which follows
// the directory as cd, pushd and popd change it.

import { makeComintInBuffer, outputFilter } from "comint";

for (const [name, doc, value] of [
  ["explicit-shell-file-name", "The shell M-x shell runs, if not $ESHELL or shell-file-name.", null],
  ["explicit-bash-args", "What M-x shell gives bash: no line editing, and interactive.", ["--noediting", "-i"]],
  ["shell-prompt-pattern", "An Emacs regexp for a shell's prompt, which comint-prompt-regexp starts as in shell-mode.", "^[^#$%>\n]*[#$%>] *"],
  ["shell-dirtrack-mode", "Whether shell-mode follows cd, pushd and popd to keep default-directory where the shell is.", true],
] as const) {
  ember.defineVariable({ name, doc, value: value as ember.Value });
}

/** The directories pushd has pushed, newest first, as shell-dirstack. */
const dirstacks = new Map<string, string[]>();

/** Follows a command that changes directory, as shell-directory-tracker: cd, pushd and popd. */
function directoryTracker(input: string): void {
  if (ember.variable("shell-dirtrack-mode") === false) return;
  const buffer = ember.bufferName();
  const stack = dirstacks.get(buffer) ?? [];
  dirstacks.set(buffer, stack);
  // Each command of a line like "cd a; ls".
  for (const command of input.split(/[;&|]+/)) {
    const [word, ...args] = command.trim().split(/\s+/);
    const arg = args[0];
    const here = String(ember.variable("default-directory") ?? "~/");
    const go = (dir: string) => {
      const expanded = ember.expandFileName(dir, here);
      if (ember.fileDirectoryP(expanded)) ember.setVariable("default-directory", expanded.endsWith("/") ? expanded : `${expanded}/`);
    };
    if (word === "cd" || word === "chdir") {
      if (arg === undefined) go(ember.getenv("HOME") ?? "~");
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
ember.defun("shell-directory-tracker", directoryTracker);

ember.defineMajorMode({
  name: "shell-mode",
  modeName: "Shell",
  parent: "comint-mode",
  doc:
    "The major mode for a shell in a buffer: type commands after its prompt and send them with RET.\n\n" +
    "It is comint-mode, so M-p and M-n go through earlier commands and C-c C-c interrupts the job running, and " +
    "default-directory follows the shell's cd, pushd and popd.",
  setup: () => {
    ember.makeLocalVariable("comint-prompt-regexp");
    ember.setVariable("comint-prompt-regexp", ember.variable("shell-prompt-pattern") ?? null);
    ember.addHook("comint-input-filter-functions", directoryTracker, { local: true });
  },
});

ember.defineCommand({
  name: "shell",
  doc:
    "Run your shell in the buffer *shell*, or go to it if it runs there already.\n\n" +
    "The shell is explicit-shell-file-name, else $ESHELL, else shell-file-name; bash runs with explicit-bash-args, " +
    "and other shells with -i, or the variable explicit-NAME-args. With a prefix argument, ask for the buffer.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: ember.PrefixArg) => {
    const buffer =
      arg === null ? "*shell*" : (await ember.readString("Shell buffer: ", { default: ember.generateNewBufferName("*shell*") })) || "*shell*";
    const running = ember.getBufferProcess(buffer);
    if (running === undefined || !ember.processLiveP(running)) {
      const program = String(ember.variable("explicit-shell-file-name") ?? ember.getenv("ESHELL") ?? ember.variable("shell-file-name") ?? "/bin/sh");
      const name = program.replace(/.*\//, "");
      const explicit = ember.variable(`explicit-${name}-args`);
      const args = Array.isArray(explicit) ? explicit.map(String) : ["-i"];
      const startfile = [`~/.emacs_${name}`, `~/.emacs.d/init_${name}.sh`].map((f) => ember.expandFileName(f)).find((f) => ember.fileExistsP(f));
      ember.getBufferCreate(buffer);
      ember.withCurrentBuffer(buffer, () => {
        if (ember.variable("major-mode") !== "shell-mode") ember.call("shell-mode");
      });
      makeComintInBuffer("shell", buffer, program, startfile, ...args);
    }
    ember.call("switch-to-buffer", buffer);
  },
});

// Shell commands in the background, as simple.el's async-shell-command:
// on a terminal, through comint's filter, in *Async Shell Command*.

ember.defineCommand({
  name: "async-shell-command",
  doc:
    "Run a shell command in the background, its output going into *Async Shell Command* as it comes.\n\n" +
    "When it ends, a message says how.",
  params: [{ name: "command", kind: "string", prompt: "Async shell command: " }],
  run: async (command: string) => {
    const name = String(ember.variable("shell-command-buffer-name-async"));
    let buffer = name;
    const running = ember.getBufferProcess(buffer);
    if (running !== undefined && ember.processLiveP(running)) {
      // As async-shell-command-buffer's confirm-new-buffer.
      if (!(await ember.yesOrNoP("A command is running in the default buffer.  Use a new buffer? "))) throw new Error("Shell command in progress");
      buffer = ember.generateNewBufferName(name);
    }
    const directory = ember.expandFileName(".");
    ember.getBufferCreate(buffer);
    ember.withCurrentBuffer(buffer, () => {
      ember.letBind({ "inhibit-read-only": true }, () => ember.deleteRegion(0, ember.bufferSize()));
      ember.makeLocalVariable("default-directory");
      ember.setVariable("default-directory", directory.endsWith("/") ? directory : `${directory}/`);
    });
    const shell = String(ember.variable("shell-file-name"));
    ember.makeProcess({
      name: "Shell",
      buffer,
      command: [shell, String(ember.variable("shell-command-switch")), command],
      directory,
      env: { TERM: String(ember.variable("comint-terminfo-terminal") ?? "dumb") },
      filter: (p, text) => outputFilter(p, text),
      sentinel: (_p, event) => {
        const status = ember.processStatus(_p);
        if (status === "exit" || status === "signal" || status === undefined) ember.message(`${command}: ${event.replace(/\n$/, "")}.`);
      },
    });
    ember.call("display-buffer", buffer);
  },
});

ember.bindKey("M-&", "async-shell-command");
