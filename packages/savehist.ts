// Saving minibuffer history between sessions, after Emacs's savehist.el.
// With savehist-mode on, the history of each prompt used, and the
// variables in savehist-additional-variables, are saved to savehist-file
// every few minutes and when Ember exits, and read back when the mode is
// first turned on. The file is JSON, where Emacs writes Lisp.

ember.defineVariable({
  name: "savehist-file",
  doc: "The file minibuffer history is saved in: history in user-emacs-directory if nil.",
  value: null,
});
ember.defineVariable({
  name: "savehist-save-minibuffer-history",
  doc: "Whether to save the history of each prompt used, as well as savehist-additional-variables.",
  value: true,
});
ember.defineVariable({
  name: "savehist-additional-variables",
  doc: "More variables to save, such as kill-ring or search-ring.",
  value: [],
});
ember.defineVariable({
  name: "savehist-ignored-variables",
  doc: "History variables not to save.",
  value: [],
});
ember.defineVariable({
  name: "savehist-autosave-interval",
  doc: "How many seconds between saves, or nil to save only when Ember exits.",
  value: 300,
});
ember.defineVariable({
  name: "savehist-minibuffer-history-variables",
  doc: "The history variables of the prompts used, which Savehist mode saves.",
  value: [],
});
ember.defineHook("savehist-save-hook", "Run before Savehist mode saves the history.");

const strings = (v: ember.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function historyFile(): string | undefined {
  const file = ember.variable("savehist-file");
  if (typeof file === "string") return ember.expandFileName(file);
  const dir = ember.variable("user-emacs-directory");
  return typeof dir === "string" ? ember.expandFileName(`${dir}history`) : undefined;
}

/** Whether the file has been read this session, as savehist-loaded. */
let loaded = false;
/** What was last written, so an auto-save that would change nothing does not write. */
let lastSaved: string | undefined;
let timer: number | undefined;

/** The variables to save: the histories used, and the additional ones. */
function variablesToSave(): string[] {
  const ignored = strings(ember.variable("savehist-ignored-variables"));
  const histories = ember.variable("savehist-save-minibuffer-history") === false ? [] : strings(ember.variable("savehist-minibuffer-history-variables"));
  return [...new Set([...histories, ...strings(ember.variable("savehist-additional-variables"))])].filter((v) => !ignored.includes(v));
}

/** Writes the history out, as savehist-save; when auto-saving, only if it changed. */
function save(autoSave: boolean): void {
  const file = historyFile();
  if (file === undefined) return;
  ember.runHooks("savehist-save-hook");
  const saved: { [name: string]: ember.Value } = {};
  // The histories used, so they are kept track of next time too.
  saved["savehist-minibuffer-history-variables"] = variablesToSave().filter((v) => !strings(ember.variable("savehist-additional-variables")).includes(v));
  for (const name of variablesToSave()) {
    const value = ember.variable(name);
    if (value !== undefined) saved[name] = value;
  }
  const text = `${JSON.stringify(saved, null, 1)}\n`;
  if (autoSave && text === lastSaved) return;
  ember.writeTextFile(file, text);
  lastSaved = text;
}

/** Reads the saved history back, as loading savehist-file does. */
function load(): void {
  const file = historyFile();
  if (file === undefined || !ember.fileExists(file)) return;
  const saved = JSON.parse(ember.readTextFile(file));
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw new Error(`Error reading ${ember.abbreviateFileName(file)}`);
  for (const [name, value] of Object.entries(saved)) {
    if (ember.variable(name) === undefined) {
      ember.defineVariable({ name, doc: "Earlier answers to minibuffer prompts, newest first.", value: value as ember.Value });
    } else {
      ember.setDefault(name, value as ember.Value);
    }
  }
  loaded = true;
}

/** Notes the history variable of each prompt opened, as savehist-minibuffer-hook. */
function minibufferHook(): void {
  const history = ember.minibufferInfo()?.history;
  if (history === undefined || strings(ember.variable("savehist-ignored-variables")).includes(history)) return;
  const known = strings(ember.variable("savehist-minibuffer-history-variables"));
  if (!known.includes(history)) ember.setDefault("savehist-minibuffer-history-variables", [history, ...known]);
}

const autosave = (): void => save(true);

ember.defineCommand({
  name: "savehist-save",
  doc: "Save the minibuffer history now, to savehist-file.",
  run: () => save(false),
});

ember.defineMinorMode({
  name: "savehist-mode",
  global: true,
  doc:
    "Save minibuffer history between sessions: the history of each prompt used, and savehist-additional-variables, " +
    "in savehist-file, every few minutes and when Ember exits. The first time it is turned on, it reads the history back.",
  onChange: (on) => {
    ember.removeHook("minibuffer-setup-hook", minibufferHook);
    ember.removeHook("kill-emacs-hook", autosave);
    if (timer !== undefined) ember.cancelTimer(timer);
    timer = undefined;
    if (!on) return;
    if (!loaded) {
      try {
        load();
      } catch (e) {
        // Not turned on if reading failed, which would lose the history at the next save.
        ember.setVariable("savehist-mode", false);
        throw e;
      }
    }
    ember.addHook("minibuffer-setup-hook", minibufferHook);
    ember.addHook("kill-emacs-hook", autosave);
    const interval = ember.variable("savehist-autosave-interval");
    if (typeof interval === "number" && interval > 0) timer = ember.runWithTimer(interval, interval, autosave);
  },
});
