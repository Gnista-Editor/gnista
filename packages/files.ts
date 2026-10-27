// Choosing a major mode for a file, after Emacs's files.el.

ember.defineVariable({
  name: "auto-mode-alist",
  doc:
    "Which major mode files get, by name: a list of [pattern, mode] pairs, tried in order.\n\n" +
    "Each pattern is a JavaScript regular expression matched against the whole file name, " +
    "and mode is the command that turns the mode on. Files that match nothing get Fundamental mode.",
  value: [["\\.te?xt$", "text-mode"]],
});

/**
 * The mode a file's first line asks for, as Emacs reads "-*- text -*-" or
 * "-*- mode: text -*-": the name with "-mode" added.
 */
function modeFromFirstLine(): string | undefined {
  const text = ember.bufferText();
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const inside = /-\*-(.*?)-\*-/.exec(firstLine)?.[1]?.trim();
  if (!inside) {
    return undefined;
  }
  const mode = /(?:^|;)\s*mode:\s*([\w-]+)/i.exec(inside)?.[1] ?? (inside.includes(":") ? undefined : inside);
  return mode === undefined ? undefined : `${mode.toLowerCase()}-mode`;
}

function modeFromFileName(): string | undefined {
  const file = ember.bufferFileName();
  const alist = ember.variable("auto-mode-alist");
  if (file === undefined || !Array.isArray(alist)) {
    return undefined;
  }
  for (const entry of alist) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      if (new RegExp(entry[0]).test(file)) {
        return entry[1];
      }
    }
  }
  return undefined;
}

ember.defineCommand({
  name: "normal-mode",
  doc:
    "Choose the current buffer's major mode, as when its file is visited.\n\n" +
    "A mode named on the first line, as in -*- text -*-, comes first; then auto-mode-alist, " +
    "matched against the file name; otherwise Fundamental mode.",
  run: () => {
    const mode = [modeFromFirstLine(), modeFromFileName()].find(
      (mode) => mode !== undefined && ember.commandExists(mode),
    );
    ember.call((mode ?? "fundamental-mode") as ember.CommandName);
  },
});
