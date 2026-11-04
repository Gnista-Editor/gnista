// Saving minibuffer history between sessions, after Emacs's savehist.el.
// With savehist-mode on, the history of each prompt used, and the
// variables in savehist-additional-variables, are saved to savehist-file
// every few minutes and when Gnista exits, and read back when the mode is
// first turned on. The file is JSON, where Emacs writes Lisp.

gnista.defineVariable({
  name: "savehist-file",
  doc: "The file minibuffer history is saved in: history in user-emacs-directory if nil.",
  value: null,
});
gnista.defineVariable({
  name: "savehist-save-minibuffer-history",
  doc: "Whether to save the history of each prompt used, as well as savehist-additional-variables.",
  value: true,
});
gnista.defineVariable({
  name: "savehist-additional-variables",
  doc: "More variables to save, such as kill-ring or search-ring.",
  value: [],
});
gnista.defineVariable({
  name: "savehist-ignored-variables",
  doc: "History variables not to save.",
  value: [],
});
gnista.defineVariable({
  name: "savehist-file-modes",
  doc: "The permissions the history file gets: only you can read it, by default, as it holds what you typed.",
  value: 0o600,
});
gnista.defineVariable({
  name: "savehist-autosave-interval",
  doc: "How many seconds between saves, or nil to save only when Gnista exits.",
  value: 300,
});
gnista.defineVariable({
  name: "savehist-minibuffer-history-variables",
  doc: "The history variables of the prompts used, which Savehist mode saves.",
  value: [],
});
gnista.defineHook("savehist-save-hook", "Run before Savehist mode saves the history.");

const strings = (v: gnista.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function historyFile(): string | undefined {
  const file = gnista.variable("savehist-file");
  if (typeof file === "string") return gnista.expandFileName(file);
  const dir = gnista.variable("user-emacs-directory");
  return typeof dir === "string" ? gnista.expandFileName(`${dir}history`) : undefined;
}

/** Whether the file has been read this session, as savehist-loaded. */
let loaded = false;
/** What was last written, so an auto-save that would change nothing does not write. */
let lastSaved: string | undefined;
let timer: number | undefined;

/** The variables to save: the histories used, and the additional ones. */
function variablesToSave(): string[] {
  const ignored = strings(gnista.variable("savehist-ignored-variables"));
  const histories = gnista.variable("savehist-save-minibuffer-history") === false ? [] : strings(gnista.variable("savehist-minibuffer-history-variables"));
  return [...new Set([...histories, ...strings(gnista.variable("savehist-additional-variables"))])].filter((v) => !ignored.includes(v));
}

/** Writes the history out, as savehist-save; when auto-saving, only if it changed. */
function save(autoSave: boolean): void {
  const file = historyFile();
  if (file === undefined) return;
  gnista.runHooks("savehist-save-hook");
  const saved: { [name: string]: gnista.Value } = {};
  // The histories used, so they are kept track of next time too.
  saved["savehist-minibuffer-history-variables"] = variablesToSave().filter((v) => !strings(gnista.variable("savehist-additional-variables")).includes(v));
  for (const name of variablesToSave()) {
    const value = gnista.variable(name);
    if (value !== undefined) saved[name] = value;
  }
  const text = `${JSON.stringify(saved, null, 1)}\n`;
  if (autoSave && text === lastSaved) return;
  const modes = gnista.variable("savehist-file-modes");
  gnista.writeTextFile(file, text, { mode: typeof modes === "number" ? modes : undefined });
  lastSaved = text;
}

/** Reads the saved history back, as loading savehist-file does. */
function load(): void {
  const file = historyFile();
  if (file === undefined || !gnista.fileExists(file)) return;
  const saved = JSON.parse(gnista.readTextFile(file));
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw new Error(`Error reading ${gnista.abbreviateFileName(file)}`);
  for (const [name, value] of Object.entries(saved)) {
    if (gnista.variable(name) === undefined) {
      gnista.defineVariable({ name, doc: "Earlier answers to minibuffer prompts, newest first.", value: value as gnista.Value });
    } else {
      gnista.setDefault(name, value as gnista.Value);
    }
  }
  loaded = true;
}

/** Notes the history variable of each prompt opened, as savehist-minibuffer-hook. */
function minibufferHook(): void {
  const history = gnista.minibufferInfo()?.history;
  if (history === undefined || strings(gnista.variable("savehist-ignored-variables")).includes(history)) return;
  const known = strings(gnista.variable("savehist-minibuffer-history-variables"));
  if (!known.includes(history)) gnista.setDefault("savehist-minibuffer-history-variables", [history, ...known]);
}

const autosave = (): void => save(true);

gnista.defineCommand({
  name: "savehist-save",
  doc: "Save the minibuffer history now, to savehist-file.",
  run: () => save(false),
});

gnista.defineMinorMode({
  name: "savehist-mode",
  global: true,
  doc:
    "Save minibuffer history between sessions: the history of each prompt used, and savehist-additional-variables, " +
    "in savehist-file, every few minutes and when Gnista exits. The first time it is turned on, it reads the history back.",
  onChange: (on) => {
    gnista.removeHook("minibuffer-setup-hook", minibufferHook);
    gnista.removeHook("kill-emacs-hook", autosave);
    if (timer !== undefined) gnista.cancelTimer(timer);
    timer = undefined;
    if (!on) return;
    if (!loaded) {
      try {
        load();
      } catch (e) {
        // Not turned on if reading failed, which would lose the history at the next save.
        gnista.setVariable("savehist-mode", false);
        throw e;
      }
    }
    gnista.addHook("minibuffer-setup-hook", minibufferHook);
    gnista.addHook("kill-emacs-hook", autosave);
    const interval = gnista.variable("savehist-autosave-interval");
    if (typeof interval === "number" && interval > 0) timer = gnista.runWithTimer(interval, interval, autosave);
  },
});
