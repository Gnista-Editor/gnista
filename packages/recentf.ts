// Recent files, after Emacs's recentf.el. recentf-mode keeps a list of the
// files you visit or save, newest first, in recentf-list, and saves it in
// user-emacs-directory when E8 exits, for next time. recentf-open asks
// for one of them, with completion. Emacs keeps the list as Lisp; E8
// keeps it as JSON.

import { truthy } from "subr";

e8.defineVariable({
  name: "recentf-list",
  doc: "The files visited or saved most recently, newest first, as recentf-mode keeps them.",
  value: [],
});
e8.defineVariable({
  name: "recentf-max-saved-items",
  doc: "How many recent files are saved for next time. Nil saves them all.",
  value: 20,
});
e8.defineVariable({
  name: "recentf-exclude",
  doc: "Regular expressions for file names left out of the list of recent files.",
  value: [],
});
e8.defineVariable({
  name: "recentf-save-file",
  doc: "Where the list of recent files is saved: recentf in user-emacs-directory if nil.",
  value: null,
});
e8.defineVariable({
  name: "recentf-auto-cleanup",
  doc: "When the list of recent files loses files that are gone: mode, when recentf-mode turns on, or never.",
  value: "mode",
});
e8.defineVariable({
  name: "recentf-initialize-file-name-history",
  doc: "Whether an empty file-name-history, which M-p goes through in file prompts, starts with the recent files.",
  value: true,
});

const isOn = (name: string): boolean => {
  const v = e8.variable(name);
  return v !== null && v !== false;
};

const recentList = (): string[] => {
  const list = e8.variable("recentf-list");
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
};

function saveFile(): string | undefined {
  const file = e8.variable("recentf-save-file");
  if (typeof file === "string") return e8.expandFileName(file);
  const dir = e8.variable("user-emacs-directory");
  return typeof dir === "string" ? e8.expandFileName(`${dir}recentf`) : undefined;
}

/** A file name as the list keeps it, as recentf-expand-file-name: absolute, with ~ for home. */
const recentName = (file: string): string => e8.abbreviateFileName(e8.expandFileName(file));

function included(file: string): boolean {
  // Each an Emacs regexp, matched as string-match does with
  // recentf-case-fold-search, or a predicate on the file name.
  const exclude = e8.variable("recentf-exclude") as unknown;
  const caseFold = truthy(e8.variable("recentf-case-fold-search"));
  return !Array.isArray(exclude) || !exclude.some((re: unknown) =>
    typeof re === "string" ? e8.stringMatch(re, file, { caseFold }) !== undefined : typeof re === "function" && truthy(e8.funcall(re as (...args: unknown[]) => e8.Value, file)));
}

/** Puts a file at the front of the list, as recentf-add-file, unless recentf-exclude leaves it out. */
function addFile(file: string): void {
  const name = recentName(file);
  if (!included(name)) return;
  e8.setVariable("recentf-list", [name, ...recentList().filter((f) => f !== name)]);
}

function trackOpenedFile(): void {
  const file = e8.bufferFileName();
  if (file !== undefined) addFile(file);
}

/** When a buffer is killed, its file leaves the list if it is gone, as recentf-track-closed-file. */
function trackClosedFile(): void {
  const file = e8.bufferFileName();
  if (file === undefined || e8.fileExists(file)) return;
  const name = recentName(file);
  e8.setVariable("recentf-list", recentList().filter((f) => f !== name));
}

e8.defineCommand({
  name: "recentf-save-list",
  doc: "Save the list of recent files, up to recentf-max-saved-items, for next time.",
  run: () => {
    const file = saveFile();
    if (file === undefined) return;
    const max = e8.variable("recentf-max-saved-items");
    const list = typeof max === "number" ? recentList().slice(0, max) : recentList();
    e8.writeTextFile(file, `${JSON.stringify(list, null, 2)}\n`);
  },
});

e8.defineCommand({
  name: "recentf-load-list",
  doc: "Read the list of recent files saved last time, and start file-name-history with it if it is empty.",
  run: () => {
    const file = saveFile();
    if (file === undefined || !e8.fileExists(file)) return;
    let list: unknown;
    try {
      list = JSON.parse(e8.readTextFile(file));
    } catch {
      throw new Error(`Error reading ${e8.abbreviateFileName(file)}`);
    }
    if (!Array.isArray(list)) return;
    e8.setVariable("recentf-list", list.filter((f): f is string => typeof f === "string"));
    const history = e8.variable("file-name-history");
    if (isOn("recentf-initialize-file-name-history") && (!Array.isArray(history) || history.length === 0)) {
      e8.setVariable("file-name-history", recentList());
    }
  },
});

e8.defineCommand({
  name: "recentf-cleanup",
  doc: "Take files that are gone, left out by recentf-exclude, or there twice, off the list of recent files.",
  run: () => {
    e8.message("Cleaning up the recentf list...");
    const seen = new Set<string>();
    const kept: string[] = [];
    let removed = 0;
    for (const f of recentList()) {
      const name = recentName(f);
      if (included(name) && e8.fileExists(name) && !seen.has(name)) {
        kept.push(name);
        seen.add(name);
      } else {
        removed++;
        e8.message(`File ${name} removed from the recentf list`);
      }
    }
    e8.message(`Cleaning up the recentf list...done (${removed} removed)`);
    e8.setVariable("recentf-list", kept);
  },
});

const hooks: [string, () => void][] = [
  ["find-file-hook", trackOpenedFile],
  ["after-save-hook", trackOpenedFile],
  ["kill-buffer-hook", trackClosedFile],
  ["kill-emacs-hook", () => e8.call("recentf-save-list")],
];

e8.defineMinorMode({
  name: "recentf-mode",
  global: true,
  doc:
    "Keep a list of the files you visit and save, newest first, saved for next time.\n\n" +
    "recentf-open asks for one of them, with completion. The list is saved in user-emacs-directory when " +
    "E8 exits, and read when the mode turns on, which also takes files that are gone off it.",
  onChange: (enabled) => {
    if (enabled) {
      e8.call("recentf-load-list");
    } else {
      e8.call("recentf-save-list");
    }
    if (enabled && e8.variable("recentf-auto-cleanup") === "mode") e8.call("recentf-cleanup");
    for (const [hook, fn] of hooks) {
      if (enabled) e8.addHook(hook, fn);
      else e8.removeHook(hook, fn);
    }
  },
});

e8.defineCommand({
  name: "recentf-open",
  doc: "Visit one of the files visited or saved recently, asking which, with completion. Turns recentf-mode on first.",
  params: [{
    name: "file",
    prompt: "Open recent file: ",
    requireMatch: true,
    collection: () => {
      if (!isOn("recentf-mode")) e8.callWithPrefix(1, "recentf-mode");
      return recentList();
    },
  }],
  run: (file: string) => {
    if (file !== "") e8.call("find-file", file);
  },
});

e8.defineCommand({
  name: "recentf",
  doc: "Visit one of the files visited or saved recently, as recentf-open does.",
  run: () => e8.callInteractively("recentf-open"),
});
