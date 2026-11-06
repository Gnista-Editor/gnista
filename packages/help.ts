// Help: the *Help* buffer's mode, and describing variables and modes, after
// Emacs's help-mode.el and help-fns.el.

e8.defineMajorMode({
  name: "help-mode",
  modeName: "Help",
  doc: "The major mode of the *Help* buffer. q goes back to the buffer before it.",
  bindings: {
    q: "quit-window",
    SPC: "scroll-up-command",
    DEL: "scroll-down-command",
  },
});

/** A value as a script would write it. */
function showValue(value: e8.Value | undefined): string {
  // Functions and symbols show by name, as Emacs shows a hook's symbols.
  const shown = (_: string, v: unknown) =>
    typeof v === "function" ? v.name || "anonymous function" : typeof v === "symbol" ? v.description : v;
  return value === undefined ? "void" : JSON.stringify(value, shown);
}

const describeVariable = e8.defineCommand({
  name: "describe-variable",
  doc: "Show a variable's documentation, its value in the current buffer, and its global value.",
  params: [{ name: "variable", kind: "variable", prompt: "Describe variable: " }],
  run: (name) => {
    if (e8.variableDocumentation(name) === undefined) {
      throw new Error(`No such variable: ${name}`);
    }
    const source = e8.variableSource(name);
    const kind = e8.isHook(name) ? "hook" : "variable";
    let text = `${name} is a ${kind}${source ? ` defined in ${source}` : ""}.\n\n`;
    text += `Its value is ${showValue(e8.variable(name))}\n`;
    if (e8.isLocalVariable(name)) {
      text += `  Local in buffer ${e8.bufferName()}; global value is ${showValue(e8.defaultValue(name))}\n`;
    }
    text += `\n${e8.variableDocumentation(name)}\n`;
    e8.showHelp(text);
  },
});

/** "delete-selection-mode" is "Delete-Selection mode", as Emacs writes it. */
function prettyModeName(name: string): string {
  return (
    name
      .replace(/-mode$/, "")
      .split("-")
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join("-") + " mode"
  );
}

function describeOne(title: string, name: string): string {
  const source = e8.commandSource(name);
  return `${title} (${name})${source ? `, defined in ${source}` : ""}:\n\n${e8.documentation(name) ?? ""}\n`;
}

const describeMode = e8.defineCommand({
  name: "describe-mode",
  doc: "Show the documentation of the current buffer's major mode and of the minor modes that are on.",
  run: () => {
    const major = String(e8.variable("major-mode"));
    let text = describeOne(`The major mode is ${String(e8.variable("mode-name"))} mode`, major);
    const minors = e8.enabledMinorModes();
    if (minors.length > 0) {
      text += `\nMinor modes that are on: ${minors.map(prettyModeName).join(", ")}.\n`;
      for (const minor of minors) {
        text += `\n${describeOne(prettyModeName(minor), minor)}`;
      }
    }
    e8.showHelp(text);
  },
});

e8.defineCommand({
  name: "describe-face",
  doc: "Show a face's documentation and attributes, and what it looks like on dark and light backgrounds.",
  params: [{ name: "face", kind: "face", prompt: "Describe face: " }],
  run: (name) => {
    const info = e8.faceInfo(name);
    if (info === undefined) {
      throw new Error(`No such face: ${name}`);
    }
    const show = (attrs: e8.FaceAttributes) => (Object.keys(attrs).length === 0 ? "none" : JSON.stringify(attrs));
    let text = `${name} is a face${info.source ? ` defined in ${info.source}` : ""}.\n\n${info.doc}\n\n`;
    text += `Its own attributes: ${show(info.attributes)}\n`;
    if (Object.keys(info.dark).length > 0) text += `  On a dark background: ${show(info.dark)}\n`;
    if (Object.keys(info.light).length > 0) text += `  On a light background: ${show(info.light)}\n`;
    text += `\nWith what it inherits, on a dark background: ${show(e8.faceAttributes(name, { dark: true }))}\n`;
    text += `On a light background: ${show(e8.faceAttributes(name, { dark: false }))}\n`;
    e8.showHelp(text);
  },
});

e8.bindKey("C-h v", describeVariable);
e8.bindKey("C-h m", describeMode);

e8.defineCommand({
  name: "view-echo-area-messages",
  doc: "Show the *Messages* buffer: the messages shown in the echo area, newest last.",
  run: () => {
    e8.getBufferCreate("*Messages*");
    e8.withCurrentBuffer("*Messages*", () => {
      e8.setReadOnly(false);
      e8.deleteRegion(0, e8.bufferSize());
      const lines = e8.messages();
      e8.insert(lines.length === 0 ? "" : lines.join("\n") + "\n");
      e8.setReadOnly(true);
      e8.setBufferModified(false);
      e8.gotoChar(e8.bufferSize());
    });
    e8.call("display-buffer", "*Messages*");
  },
});
e8.bindKey("C-h e", "view-echo-area-messages");

// The keys typed lately, after help.el's view-lossage.

const viewLossage = e8.defineCommand({
  name: "view-lossage",
  doc:
    "Show the keys typed lately and the commands they ran, oldest first.\n\n" +
    "Each line is the keys of one command, with the command as a comment. lossage-size says how many keys are kept.",
  run: () => {
    // As view-lossage writes them: the keys separated by spaces, a line a
    // command, its name a comment indented to column 24 with tabs, as
    // comment-indent leaves it, or a space after keys that reach past it.
    let text = "";
    let line = "";
    for (const entry of e8.recentKeys(true)) {
      if (typeof entry === "string") {
        line += ` ${entry}`;
        continue;
      }
      const column = line.length;
      const indent = column >= 24 ? " " : "\t".repeat(3 - Math.floor(column / 8));
      text += `${line}${indent};; ${entry.command}\n`;
      line = "";
    }
    e8.showHelp(text + line);
  },
});
e8.bindKey("C-h l", viewLossage);
