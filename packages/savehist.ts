// Saving minibuffer history between sessions, after Emacs's savehist.el.
// With savehist-mode on, the history of each prompt used, and the
// variables in savehist-additional-variables, are saved to savehist-file
// every few minutes and when E8 exits, and read back when the mode is
// first turned on. The file is JSON, where Emacs writes Lisp.

e8.defineVariable({
  name: "savehist-file",
  doc: "The file minibuffer history is saved in: history in user-emacs-directory if nil.",
  value: null,
});
e8.defineVariable({
  name: "savehist-save-minibuffer-history",
  doc: "Whether to save the history of each prompt used, as well as savehist-additional-variables.",
  value: true,
});
e8.defineVariable({
  name: "savehist-additional-variables",
  doc: "More variables to save, such as kill-ring or search-ring.",
  value: [],
});
e8.defineVariable({
  name: "savehist-ignored-variables",
  doc: "History variables not to save.",
  value: [],
});
e8.defineVariable({
  name: "savehist-file-modes",
  doc: "The permissions the history file gets: only you can read it, by default, as it holds what you typed.",
  value: 0o600,
});
e8.defineVariable({
  name: "savehist-autosave-interval",
  doc: "How many seconds between saves, or nil to save only when E8 exits.",
  value: 300,
});
e8.defineVariable({
  name: "savehist-minibuffer-history-variables",
  doc: "The history variables of the prompts used, which Savehist mode saves.",
  value: [],
});
e8.defineHook("savehist-save-hook", "Run before Savehist mode saves the history.");

const strings = (v: e8.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function historyFile(): string | undefined {
  const file = e8.variable("savehist-file");
  if (typeof file === "string") return e8.expandFileName(file);
  const dir = e8.variable("user-emacs-directory");
  return typeof dir === "string" ? e8.expandFileName(`${dir}history`) : undefined;
}

/** Whether the file has been read this session, as savehist-loaded. */
let loaded = false;
/** What was last written, so an auto-save that would change nothing does not write. */
let lastSaved: string | undefined;
let timer: number | undefined;

/** The variables to save: the histories used, and the additional ones. */
function variablesToSave(): string[] {
  const ignored = strings(e8.variable("savehist-ignored-variables"));
  const histories = e8.variable("savehist-save-minibuffer-history") === false ? [] : strings(e8.variable("savehist-minibuffer-history-variables"));
  return [...new Set([...histories, ...strings(e8.variable("savehist-additional-variables"))])].filter((v) => !ignored.includes(v));
}

/** Writes the history out, as savehist-save; when auto-saving, only if it changed. */
function save(autoSave: boolean): void {
  const file = historyFile();
  if (file === undefined) return;
  e8.runHooks("savehist-save-hook");
  const saved: { [name: string]: e8.Value } = {};
  // The histories used, so they are kept track of next time too.
  saved["savehist-minibuffer-history-variables"] = variablesToSave().filter((v) => !strings(e8.variable("savehist-additional-variables")).includes(v));
  for (const name of variablesToSave()) {
    const value = e8.variable(name);
    if (value !== undefined) saved[name] = value;
  }
  const text = `${JSON.stringify(saved, null, 1)}\n`;
  if (autoSave && text === lastSaved) return;
  const modes = e8.variable("savehist-file-modes");
  e8.writeTextFile(file, text, { mode: typeof modes === "number" ? modes : undefined });
  lastSaved = text;
}

/** Reads the saved history back, as loading savehist-file does. */
function load(): void {
  const file = historyFile();
  if (file === undefined || !e8.fileExists(file)) return;
  const saved = JSON.parse(e8.readTextFile(file));
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw new Error(`Error reading ${e8.abbreviateFileName(file)}`);
  for (const [name, value] of Object.entries(saved)) {
    if (e8.variable(name) === undefined) {
      e8.defineVariable({ name, doc: "Earlier answers to minibuffer prompts, newest first.", value: value as e8.Value });
    } else {
      e8.setDefault(name, value as e8.Value);
    }
  }
  loaded = true;
}

/** Notes the history variable of each prompt opened, as savehist-minibuffer-hook. */
function minibufferHook(): void {
  const history = e8.minibufferInfo()?.history;
  if (history === undefined || strings(e8.variable("savehist-ignored-variables")).includes(history)) return;
  const known = strings(e8.variable("savehist-minibuffer-history-variables"));
  if (!known.includes(history)) e8.setDefault("savehist-minibuffer-history-variables", [history, ...known]);
}

const autosave = (): void => save(true);

e8.defineCommand({
  name: "savehist-save",
  doc: "Save the minibuffer history now, to savehist-file.",
  run: () => save(false),
});

e8.defineMinorMode({
  name: "savehist-mode",
  global: true,
  doc:
    "Save minibuffer history between sessions: the history of each prompt used, and savehist-additional-variables, " +
    "in savehist-file, every few minutes and when E8 exits. The first time it is turned on, it reads the history back.",
  onChange: (on) => {
    e8.removeHook("minibuffer-setup-hook", minibufferHook);
    e8.removeHook("kill-emacs-hook", autosave);
    if (timer !== undefined) e8.cancelTimer(timer);
    timer = undefined;
    if (!on) return;
    if (!loaded) {
      try {
        load();
      } catch (e) {
        // Not turned on if reading failed, which would lose the history at the next save.
        e8.setVariable("savehist-mode", false);
        throw e;
      }
    }
    e8.addHook("minibuffer-setup-hook", minibufferHook);
    e8.addHook("kill-emacs-hook", autosave);
    const interval = e8.variable("savehist-autosave-interval");
    if (typeof interval === "number" && interval > 0) timer = e8.runWithTimer(interval, interval, autosave);
  },
});
