// Recent files, after Emacs's recentf.el. recentf-mode keeps a list of the
// files you visit or save, newest first, in recentf-list, and saves it in
// user-emacs-directory when Gnista exits, for next time. recentf-open asks
// for one of them, with completion. Emacs keeps the list as Lisp; Gnista
// keeps it as JSON.

import { truthy } from "subr";

gnista.defineVariable({
  name: "recentf-list",
  doc: "The files visited or saved most recently, newest first, as recentf-mode keeps them.",
  value: [],
});
gnista.defineVariable({
  name: "recentf-max-saved-items",
  doc: "How many recent files are saved for next time. Nil saves them all.",
  value: 20,
});
gnista.defineVariable({
  name: "recentf-exclude",
  doc: "Regular expressions for file names left out of the list of recent files.",
  value: [],
});
gnista.defineVariable({
  name: "recentf-save-file",
  doc: "Where the list of recent files is saved: recentf in user-emacs-directory if nil.",
  value: null,
});
gnista.defineVariable({
  name: "recentf-auto-cleanup",
  doc: "When the list of recent files loses files that are gone: mode, when recentf-mode turns on, or never.",
  value: "mode",
});
gnista.defineVariable({
  name: "recentf-initialize-file-name-history",
  doc: "Whether an empty file-name-history, which M-p goes through in file prompts, starts with the recent files.",
  value: true,
});

const isOn = (name: string): boolean => {
  const v = gnista.variable(name);
  return v !== null && v !== false;
};

const recentList = (): string[] => {
  const list = gnista.variable("recentf-list");
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
};

function saveFile(): string | undefined {
  const file = gnista.variable("recentf-save-file");
  if (typeof file === "string") return gnista.expandFileName(file);
  const dir = gnista.variable("user-emacs-directory");
  return typeof dir === "string" ? gnista.expandFileName(`${dir}recentf`) : undefined;
}

/** A file name as the list keeps it, as recentf-expand-file-name: absolute, with ~ for home. */
const recentName = (file: string): string => gnista.abbreviateFileName(gnista.expandFileName(file));

function included(file: string): boolean {
  // Each an Emacs regexp, matched as string-match does with
  // recentf-case-fold-search, or a predicate on the file name.
  const exclude = gnista.variable("recentf-exclude") as unknown;
  const caseFold = truthy(gnista.variable("recentf-case-fold-search"));
  return !Array.isArray(exclude) || !exclude.some((re: unknown) =>
    typeof re === "string" ? gnista.stringMatch(re, file, { caseFold }) !== undefined : typeof re === "function" && truthy(gnista.funcall(re as (...args: unknown[]) => gnista.Value, file)));
}

/** Puts a file at the front of the list, as recentf-add-file, unless recentf-exclude leaves it out. */
function addFile(file: string): void {
  const name = recentName(file);
  if (!included(name)) return;
  gnista.setVariable("recentf-list", [name, ...recentList().filter((f) => f !== name)]);
}

function trackOpenedFile(): void {
  const file = gnista.bufferFileName();
  if (file !== undefined) addFile(file);
}

/** When a buffer is killed, its file leaves the list if it is gone, as recentf-track-closed-file. */
function trackClosedFile(): void {
  const file = gnista.bufferFileName();
  if (file === undefined || gnista.fileExists(file)) return;
  const name = recentName(file);
  gnista.setVariable("recentf-list", recentList().filter((f) => f !== name));
}

gnista.defineCommand({
  name: "recentf-save-list",
  doc: "Save the list of recent files, up to recentf-max-saved-items, for next time.",
  run: () => {
    const file = saveFile();
    if (file === undefined) return;
    const max = gnista.variable("recentf-max-saved-items");
    const list = typeof max === "number" ? recentList().slice(0, max) : recentList();
    gnista.writeTextFile(file, `${JSON.stringify(list, null, 2)}\n`);
  },
});

gnista.defineCommand({
  name: "recentf-load-list",
  doc: "Read the list of recent files saved last time, and start file-name-history with it if it is empty.",
  run: () => {
    const file = saveFile();
    if (file === undefined || !gnista.fileExists(file)) return;
    let list: unknown;
    try {
      list = JSON.parse(gnista.readTextFile(file));
    } catch {
      throw new Error(`Error reading ${gnista.abbreviateFileName(file)}`);
    }
    if (!Array.isArray(list)) return;
    gnista.setVariable("recentf-list", list.filter((f): f is string => typeof f === "string"));
    const history = gnista.variable("file-name-history");
    if (isOn("recentf-initialize-file-name-history") && (!Array.isArray(history) || history.length === 0)) {
      gnista.setVariable("file-name-history", recentList());
    }
  },
});

gnista.defineCommand({
  name: "recentf-cleanup",
  doc: "Take files that are gone, left out by recentf-exclude, or there twice, off the list of recent files.",
  run: () => {
    gnista.message("Cleaning up the recentf list...");
    const seen = new Set<string>();
    const kept: string[] = [];
    let removed = 0;
    for (const f of recentList()) {
      const name = recentName(f);
      if (included(name) && gnista.fileExists(name) && !seen.has(name)) {
        kept.push(name);
        seen.add(name);
      } else {
        removed++;
        gnista.message(`File ${name} removed from the recentf list`);
      }
    }
    gnista.message(`Cleaning up the recentf list...done (${removed} removed)`);
    gnista.setVariable("recentf-list", kept);
  },
});

const hooks: [string, () => void][] = [
  ["find-file-hook", trackOpenedFile],
  ["after-save-hook", trackOpenedFile],
  ["kill-buffer-hook", trackClosedFile],
  ["kill-emacs-hook", () => gnista.call("recentf-save-list")],
];

gnista.defineMinorMode({
  name: "recentf-mode",
  global: true,
  doc:
    "Keep a list of the files you visit and save, newest first, saved for next time.\n\n" +
    "recentf-open asks for one of them, with completion. The list is saved in user-emacs-directory when " +
    "Gnista exits, and read when the mode turns on, which also takes files that are gone off it.",
  onChange: (enabled) => {
    if (enabled) {
      gnista.call("recentf-load-list");
    } else {
      gnista.call("recentf-save-list");
    }
    if (enabled && gnista.variable("recentf-auto-cleanup") === "mode") gnista.call("recentf-cleanup");
    for (const [hook, fn] of hooks) {
      if (enabled) gnista.addHook(hook, fn);
      else gnista.removeHook(hook, fn);
    }
  },
});

gnista.defineCommand({
  name: "recentf-open",
  doc: "Visit one of the files visited or saved recently, asking which, with completion. Turns recentf-mode on first.",
  params: [{
    name: "file",
    prompt: "Open recent file: ",
    requireMatch: true,
    collection: () => {
      if (!isOn("recentf-mode")) gnista.callWithPrefix(1, "recentf-mode");
      return recentList();
    },
  }],
  run: (file: string) => {
    if (file !== "") gnista.call("find-file", file);
  },
});

gnista.defineCommand({
  name: "recentf",
  doc: "Visit one of the files visited or saved recently, as recentf-open does.",
  run: () => gnista.callInteractively("recentf-open"),
});
