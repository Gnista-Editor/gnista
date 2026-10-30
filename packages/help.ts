// Help: the *Help* buffer's mode, and describing variables and modes, after
// Emacs's help-mode.el and help-fns.el.

ember.defineMajorMode({
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
function showValue(value: ember.Value | undefined): string {
  // Functions and symbols show by name, as Emacs shows a hook's symbols.
  const shown = (_: string, v: unknown) =>
    typeof v === "function" ? v.name || "anonymous function" : typeof v === "symbol" ? v.description : v;
  return value === undefined ? "void" : JSON.stringify(value, shown);
}

const describeVariable = ember.defineCommand({
  name: "describe-variable",
  doc: "Show a variable's documentation, its value in the current buffer, and its global value.",
  params: [{ name: "variable", kind: "variable", prompt: "Describe variable: " }],
  run: (name) => {
    if (ember.variableDocumentation(name) === undefined) {
      throw new Error(`No such variable: ${name}`);
    }
    const source = ember.variableSource(name);
    const kind = ember.isHook(name) ? "hook" : "variable";
    let text = `${name} is a ${kind}${source ? ` defined in ${source}` : ""}.\n\n`;
    text += `Its value is ${showValue(ember.variable(name))}\n`;
    if (ember.isLocalVariable(name)) {
      text += `  Local in buffer ${ember.bufferName()}; global value is ${showValue(ember.defaultValue(name))}\n`;
    }
    text += `\n${ember.variableDocumentation(name)}\n`;
    ember.showHelp(text);
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
  const source = ember.commandSource(name);
  return `${title} (${name})${source ? `, defined in ${source}` : ""}:\n\n${ember.documentation(name) ?? ""}\n`;
}

const describeMode = ember.defineCommand({
  name: "describe-mode",
  doc: "Show the documentation of the current buffer's major mode and of the minor modes that are on.",
  run: () => {
    const major = String(ember.variable("major-mode"));
    let text = describeOne(`The major mode is ${String(ember.variable("mode-name"))} mode`, major);
    const minors = ember.enabledMinorModes();
    if (minors.length > 0) {
      text += `\nMinor modes that are on: ${minors.map(prettyModeName).join(", ")}.\n`;
      for (const minor of minors) {
        text += `\n${describeOne(prettyModeName(minor), minor)}`;
      }
    }
    ember.showHelp(text);
  },
});

ember.defineCommand({
  name: "describe-face",
  doc: "Show a face's documentation and attributes, and what it looks like on dark and light backgrounds.",
  params: [{ name: "face", kind: "face", prompt: "Describe face: " }],
  run: (name) => {
    const info = ember.faceInfo(name);
    if (info === undefined) {
      throw new Error(`No such face: ${name}`);
    }
    const show = (attrs: ember.FaceAttributes) => (Object.keys(attrs).length === 0 ? "none" : JSON.stringify(attrs));
    let text = `${name} is a face${info.source ? ` defined in ${info.source}` : ""}.\n\n${info.doc}\n\n`;
    text += `Its own attributes: ${show(info.attributes)}\n`;
    if (Object.keys(info.dark).length > 0) text += `  On a dark background: ${show(info.dark)}\n`;
    if (Object.keys(info.light).length > 0) text += `  On a light background: ${show(info.light)}\n`;
    text += `\nWith what it inherits, on a dark background: ${show(ember.faceAttributes(name, { dark: true }))}\n`;
    text += `On a light background: ${show(ember.faceAttributes(name, { dark: false }))}\n`;
    ember.showHelp(text);
  },
});

ember.bindKey("C-h v", describeVariable);
ember.bindKey("C-h m", describeMode);

ember.defineCommand({
  name: "view-echo-area-messages",
  doc: "Show the *Messages* buffer: the messages shown in the echo area, newest last.",
  run: () => {
    ember.getBufferCreate("*Messages*");
    ember.withCurrentBuffer("*Messages*", () => {
      ember.setReadOnly(false);
      ember.deleteRegion(0, ember.bufferSize());
      const lines = ember.messages();
      ember.insert(lines.length === 0 ? "" : lines.join("\n") + "\n");
      ember.setReadOnly(true);
      ember.setBufferModified(false);
      ember.gotoChar(ember.bufferSize());
    });
    ember.call("display-buffer", "*Messages*");
  },
});
ember.bindKey("C-h e", "view-echo-area-messages");

// The keys typed lately, after help.el's view-lossage.

const viewLossage = ember.defineCommand({
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
    for (const entry of ember.recentKeys(true)) {
      if (typeof entry === "string") {
        line += ` ${entry}`;
        continue;
      }
      const column = line.length;
      const indent = column >= 24 ? " " : "\t".repeat(3 - Math.floor(column / 8));
      text += `${line}${indent};; ${entry.command}\n`;
      line = "";
    }
    ember.showHelp(text + line);
  },
});
ember.bindKey("C-h l", viewLossage);
