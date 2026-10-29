// Recent files, after Emacs's recentf.el. recentf-mode keeps a list of the
// files you visit or save, newest first, in recentf-list, and saves it in
// user-emacs-directory when Ember exits, for next time. recentf-open asks
// for one of them, with completion. Emacs keeps the list as Lisp; Ember
// keeps it as JSON.

ember.defineVariable({
  name: "recentf-list",
  doc: "The files visited or saved most recently, newest first, as recentf-mode keeps them.",
  value: [],
});
ember.defineVariable({
  name: "recentf-max-saved-items",
  doc: "How many recent files are saved for next time. Nil saves them all.",
  value: 20,
});
ember.defineVariable({
  name: "recentf-exclude",
  doc: "Regular expressions for file names left out of the list of recent files.",
  value: [],
});
ember.defineVariable({
  name: "recentf-save-file",
  doc: "Where the list of recent files is saved: recentf in user-emacs-directory if nil.",
  value: null,
});
ember.defineVariable({
  name: "recentf-auto-cleanup",
  doc: "When the list of recent files loses files that are gone: mode, when recentf-mode turns on, or never.",
  value: "mode",
});
ember.defineVariable({
  name: "recentf-initialize-file-name-history",
  doc: "Whether an empty file-name-history, which M-p goes through in file prompts, starts with the recent files.",
  value: true,
});

const isOn = (name: string): boolean => {
  const v = ember.variable(name);
  return v !== null && v !== false;
};

const recentList = (): string[] => {
  const list = ember.variable("recentf-list");
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
};

function saveFile(): string | undefined {
  const file = ember.variable("recentf-save-file");
  if (typeof file === "string") return ember.expandFileName(file);
  const dir = ember.variable("user-emacs-directory");
  return typeof dir === "string" ? ember.expandFileName(`${dir}recentf`) : undefined;
}

/** A file name as the list keeps it, as recentf-expand-file-name: absolute, with ~ for home. */
const recentName = (file: string): string => ember.abbreviateFileName(ember.expandFileName(file));

function included(file: string): boolean {
  const exclude = ember.variable("recentf-exclude");
  return !Array.isArray(exclude) || !exclude.some((re) => typeof re === "string" && new RegExp(re).test(file));
}

/** Puts a file at the front of the list, as recentf-add-file, unless recentf-exclude leaves it out. */
function addFile(file: string): void {
  const name = recentName(file);
  if (!included(name)) return;
  ember.setVariable("recentf-list", [name, ...recentList().filter((f) => f !== name)]);
}

function trackOpenedFile(): void {
  const file = ember.bufferFileName();
  if (file !== undefined) addFile(file);
}

/** When a buffer is killed, its file leaves the list if it is gone, as recentf-track-closed-file. */
function trackClosedFile(): void {
  const file = ember.bufferFileName();
  if (file === undefined || ember.fileExists(file)) return;
  const name = recentName(file);
  ember.setVariable("recentf-list", recentList().filter((f) => f !== name));
}

ember.defineCommand({
  name: "recentf-save-list",
  doc: "Save the list of recent files, up to recentf-max-saved-items, for next time.",
  run: () => {
    const file = saveFile();
    if (file === undefined) return;
    const max = ember.variable("recentf-max-saved-items");
    const list = typeof max === "number" ? recentList().slice(0, max) : recentList();
    ember.writeTextFile(file, `${JSON.stringify(list, null, 2)}\n`);
  },
});

ember.defineCommand({
  name: "recentf-load-list",
  doc: "Read the list of recent files saved last time, and start file-name-history with it if it is empty.",
  run: () => {
    const file = saveFile();
    if (file === undefined || !ember.fileExists(file)) return;
    let list: unknown;
    try {
      list = JSON.parse(ember.readTextFile(file));
    } catch {
      throw new Error(`Error reading ${ember.abbreviateFileName(file)}`);
    }
    if (!Array.isArray(list)) return;
    ember.setVariable("recentf-list", list.filter((f): f is string => typeof f === "string"));
    const history = ember.variable("file-name-history");
    if (isOn("recentf-initialize-file-name-history") && (!Array.isArray(history) || history.length === 0)) {
      ember.setVariable("file-name-history", recentList());
    }
  },
});

ember.defineCommand({
  name: "recentf-cleanup",
  doc: "Take files that are gone, left out by recentf-exclude, or there twice, off the list of recent files.",
  run: () => {
    ember.message("Cleaning up the recentf list...");
    const seen = new Set<string>();
    const kept: string[] = [];
    let removed = 0;
    for (const f of recentList()) {
      const name = recentName(f);
      if (included(name) && ember.fileExists(name) && !seen.has(name)) {
        kept.push(name);
        seen.add(name);
      } else {
        removed++;
        ember.message(`File ${name} removed from the recentf list`);
      }
    }
    ember.message(`Cleaning up the recentf list...done (${removed} removed)`);
    ember.setVariable("recentf-list", kept);
  },
});

const hooks: [string, () => void][] = [
  ["find-file-hook", trackOpenedFile],
  ["after-save-hook", trackOpenedFile],
  ["kill-buffer-hook", trackClosedFile],
  ["kill-emacs-hook", () => ember.call("recentf-save-list")],
];

ember.defineMinorMode({
  name: "recentf-mode",
  global: true,
  doc:
    "Keep a list of the files you visit and save, newest first, saved for next time.\n\n" +
    "recentf-open asks for one of them, with completion. The list is saved in user-emacs-directory when " +
    "Ember exits, and read when the mode turns on, which also takes files that are gone off it.",
  onChange: (enabled) => {
    if (enabled) {
      ember.call("recentf-load-list");
    } else {
      ember.call("recentf-save-list");
    }
    if (enabled && ember.variable("recentf-auto-cleanup") === "mode") ember.call("recentf-cleanup");
    for (const [hook, fn] of hooks) {
      if (enabled) ember.addHook(hook, fn);
      else ember.removeHook(hook, fn);
    }
  },
});

ember.defineCommand({
  name: "recentf-open",
  doc: "Visit one of the files visited or saved recently, asking which, with completion. Turns recentf-mode on first.",
  params: [{
    name: "file",
    prompt: "Open recent file: ",
    requireMatch: true,
    collection: () => {
      if (!isOn("recentf-mode")) ember.callWithPrefix(1, "recentf-mode");
      return recentList();
    },
  }],
  run: (file: string) => {
    if (file !== "") ember.call("find-file", file);
  },
});

ember.defineCommand({
  name: "recentf",
  doc: "Visit one of the files visited or saved recently, as recentf-open does.",
  run: () => ember.callInteractively("recentf-open"),
});
