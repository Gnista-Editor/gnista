// Help: the *Help* buffer's mode, and describing variables and modes, after
// Emacs's help-mode.el and help-fns.el.

gnista.defineMajorMode({
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
function showValue(value: gnista.Value | undefined): string {
  // Functions and symbols show by name, as Emacs shows a hook's symbols.
  const shown = (_: string, v: unknown) =>
    typeof v === "function" ? v.name || "anonymous function" : typeof v === "symbol" ? v.description : v;
  return value === undefined ? "void" : JSON.stringify(value, shown);
}

const describeVariable = gnista.defineCommand({
  name: "describe-variable",
  doc: "Show a variable's documentation, its value in the current buffer, and its global value.",
  params: [{ name: "variable", kind: "variable", prompt: "Describe variable: " }],
  run: (name) => {
    if (gnista.variableDocumentation(name) === undefined) {
      throw new Error(`No such variable: ${name}`);
    }
    const source = gnista.variableSource(name);
    const kind = gnista.isHook(name) ? "hook" : "variable";
    let text = `${name} is a ${kind}${source ? ` defined in ${source}` : ""}.\n\n`;
    text += `Its value is ${showValue(gnista.variable(name))}\n`;
    if (gnista.isLocalVariable(name)) {
      text += `  Local in buffer ${gnista.bufferName()}; global value is ${showValue(gnista.defaultValue(name))}\n`;
    }
    text += `\n${gnista.variableDocumentation(name)}\n`;
    gnista.showHelp(text);
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
  const source = gnista.commandSource(name);
  return `${title} (${name})${source ? `, defined in ${source}` : ""}:\n\n${gnista.documentation(name) ?? ""}\n`;
}

const describeMode = gnista.defineCommand({
  name: "describe-mode",
  doc: "Show the documentation of the current buffer's major mode and of the minor modes that are on.",
  run: () => {
    const major = String(gnista.variable("major-mode"));
    let text = describeOne(`The major mode is ${String(gnista.variable("mode-name"))} mode`, major);
    const minors = gnista.enabledMinorModes();
    if (minors.length > 0) {
      text += `\nMinor modes that are on: ${minors.map(prettyModeName).join(", ")}.\n`;
      for (const minor of minors) {
        text += `\n${describeOne(prettyModeName(minor), minor)}`;
      }
    }
    gnista.showHelp(text);
  },
});

gnista.defineCommand({
  name: "describe-face",
  doc: "Show a face's documentation and attributes, and what it looks like on dark and light backgrounds.",
  params: [{ name: "face", kind: "face", prompt: "Describe face: " }],
  run: (name) => {
    const info = gnista.faceInfo(name);
    if (info === undefined) {
      throw new Error(`No such face: ${name}`);
    }
    const show = (attrs: gnista.FaceAttributes) => (Object.keys(attrs).length === 0 ? "none" : JSON.stringify(attrs));
    let text = `${name} is a face${info.source ? ` defined in ${info.source}` : ""}.\n\n${info.doc}\n\n`;
    text += `Its own attributes: ${show(info.attributes)}\n`;
    if (Object.keys(info.dark).length > 0) text += `  On a dark background: ${show(info.dark)}\n`;
    if (Object.keys(info.light).length > 0) text += `  On a light background: ${show(info.light)}\n`;
    text += `\nWith what it inherits, on a dark background: ${show(gnista.faceAttributes(name, { dark: true }))}\n`;
    text += `On a light background: ${show(gnista.faceAttributes(name, { dark: false }))}\n`;
    gnista.showHelp(text);
  },
});

gnista.bindKey("C-h v", describeVariable);
gnista.bindKey("C-h m", describeMode);

gnista.defineCommand({
  name: "view-echo-area-messages",
  doc: "Show the *Messages* buffer: the messages shown in the echo area, newest last.",
  run: () => {
    gnista.getBufferCreate("*Messages*");
    gnista.withCurrentBuffer("*Messages*", () => {
      gnista.setReadOnly(false);
      gnista.deleteRegion(0, gnista.bufferSize());
      const lines = gnista.messages();
      gnista.insert(lines.length === 0 ? "" : lines.join("\n") + "\n");
      gnista.setReadOnly(true);
      gnista.setBufferModified(false);
      gnista.gotoChar(gnista.bufferSize());
    });
    gnista.call("display-buffer", "*Messages*");
  },
});
gnista.bindKey("C-h e", "view-echo-area-messages");

// The keys typed lately, after help.el's view-lossage.

const viewLossage = gnista.defineCommand({
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
    for (const entry of gnista.recentKeys(true)) {
      if (typeof entry === "string") {
        line += ` ${entry}`;
        continue;
      }
      const column = line.length;
      const indent = column >= 24 ? " " : "\t".repeat(3 - Math.floor(column / 8));
      text += `${line}${indent};; ${entry.command}\n`;
      line = "";
    }
    gnista.showHelp(text + line);
  },
});
gnista.bindKey("C-h l", viewLossage);
