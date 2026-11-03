// Saving and restoring sessions, after Emacs's desktop.el: with
// desktop-save-mode on, the buffers visiting files and Dired buffers, with
// their modes, points and marks, some global variables such as
// file-name-history, and the selected frame's windows are saved when Ember
// exits and every so often while idle, and read back when it starts. The
// first save asks for a directory, as Emacs's does; M-x desktop-save saves
// at once. The file is JSON, where Emacs writes Lisp, and a lock file next
// to it keeps two Embers from using it at once.

import { truthy } from "subr";
import { type WindowState, windowStateGet, windowStatePut } from "window";

for (const [name, value, doc] of [
  ["desktop-path", [], "The directories desktop-read looks for a desktop file in, in order: user-emacs-directory and ~ when empty."],
  ["desktop-dirname", null, "The directory the desktop was last read from or saved in, where it is saved again."],
  ["desktop-base-file-name", ".ember.desktop", "The desktop file's name, in desktop-dirname."],
  ["desktop-base-lock-name", ".ember.desktop.lock", "The lock file's name, which holds the process id of the Ember using the desktop."],
  [
    "desktop-save",
    "ask-if-new",
    'Whether quitting saves the desktop: t always, "ask-if-new" asking if there is no desktop file yet, "ask", "if-exists", "ask-if-exists", or nil never.',
  ],
  ["desktop-load-locked-desktop", "ask", 'What to do with a desktop another Ember has locked: t load it, nil do not, "ask", or "check-pid" load it if that Ember is not running.'],
  [
    "desktop-globals-to-save",
    ["desktop-missing-file-warning", "search-ring", "regexp-search-ring", "register-alist", "file-name-history"],
    "The global variables saved in the desktop.",
  ],
  [
    "desktop-locals-to-save",
    ["truncate-lines", "case-fold-search", "fill-column", "overwrite-mode", "indent-tabs-mode", "tab-width", "show-trailing-whitespace"],
    "The buffer-local variables saved for each buffer, where the buffer has its own value.",
  ],
  ["desktop-buffers-not-to-save", "\\` ", "A regexp for the names of buffers not visiting files that are not saved."],
  ["desktop-files-not-to-save", "\\`/[^/:]*:", "A regexp for the names of files whose buffers are not saved: remote ones."],
  ["desktop-modes-not-to-save", ["tags-table-mode"], "Major modes whose buffers are not saved."],
  ["desktop-restore-frames", true, "Whether the desktop saves and restores the selected frame's windows."],
  ["desktop-auto-save-timeout", 30, "Seconds idle after which the desktop is saved, if it has changed; nil or 0 for never."],
  ["desktop-missing-file-warning", null, "Whether a desktop buffer whose file is gone is made anyway, with a warning."],
  ["desktop-file-modes", 0o600, "The permissions the desktop file gets: only you can read it, as it lists your files."],
] as const) {
  ember.defineVariable({ name, value: value as ember.Value, doc });
}
for (const [name, doc] of [
  ["desktop-after-read-hook", "Run after the desktop is read."],
  ["desktop-save-hook", "Run before the desktop is saved."],
  ["desktop-no-desktop-file-hook", "Run when desktop-read finds no desktop file, in the directory it looked in."],
  ["desktop-not-loaded-hook", "Run when a desktop locked by another Ember is not loaded."],
] as const) {
  ember.defineHook(name, doc);
}

const strings = (v: ember.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A buffer as the desktop file records it, as desktop-buffer-info does. */
interface SavedBuffer {
  file?: string;
  directory?: string;
  name: string;
  mode: string;
  minorModes: string[];
  point: number;
  mark?: number;
  markActive: boolean;
  readOnly: boolean;
  locals: { [name: string]: ember.Value };
}

interface Desktop {
  version: 1;
  globals: { [name: string]: ember.Value };
  buffers: SavedBuffer[];
  windows?: WindowState;
}

function desktopPath(): string[] {
  const path = strings(ember.variable("desktop-path"));
  const own = ember.variable("user-emacs-directory");
  return path.length > 0 ? path : [...(typeof own === "string" ? [own] : []), "~"];
}

/** The desktop file in a directory, desktop-dirname by default, as desktop-full-file-name. */
function fullFileName(dir = ember.variable("desktop-dirname")): string | undefined {
  return typeof dir === "string" ? ember.expandFileName(String(ember.variable("desktop-base-file-name")), dir) : undefined;
}

function lockFileName(dir = ember.variable("desktop-dirname")): string | undefined {
  return typeof dir === "string" ? ember.expandFileName(String(ember.variable("desktop-base-lock-name")), dir) : undefined;
}

/** The process id the desktop's lock holds, as desktop-owner. */
function owner(dir?: string): number | undefined {
  const lock = lockFileName(dir ?? ember.variable("desktop-dirname"));
  if (!lock || !ember.fileExists(lock)) return undefined;
  const pid = Number(ember.readTextFile(lock).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function claimLock(dir: string): void {
  ember.writeTextFile(lockFileName(dir)!, `${ember.emacsPid()}`);
}

function releaseLock(dir: string | undefined = ember.variable("desktop-dirname") as string | undefined): void {
  const lock = lockFileName(dir);
  if (lock && owner(dir) === ember.emacsPid()) ember.deleteFile(lock, { trash: false });
}

/** Whether a buffer is saved, as desktop-save-buffer-p. */
function saveBufferP(file: string | undefined, name: string, mode: string, directory: string): boolean {
  const notBuffers = ember.variable("desktop-buffers-not-to-save");
  const notFiles = ember.variable("desktop-files-not-to-save");
  const matches = (re: ember.Value | undefined, s: string) => typeof re === "string" && ember.stringMatch(re, s) !== undefined;
  if (!file && matches(notBuffers, name)) return false;
  if (strings(ember.variable("desktop-modes-not-to-save")).includes(mode)) return false;
  if (file) return !matches(notFiles, file);
  return mode === "dired-mode" && !matches(notFiles, directory);
}

/** What the desktop file holds now, as desktop-save gathers it. */
function gather(): Desktop {
  const globals: { [name: string]: ember.Value } = {};
  for (const name of strings(ember.variable("desktop-globals-to-save"))) {
    const value = ember.variable(name);
    if (value !== undefined) globals[name] = value;
  }
  const buffers: SavedBuffer[] = [];
  for (const name of ember.bufferList()) {
    const saved = ember.withCurrentBuffer(name, (): SavedBuffer | undefined => {
      const file = ember.bufferFileName();
      const mode = String(ember.variable("major-mode"));
      const directory = String(ember.variable("default-directory") ?? "");
      if (!saveBufferP(file, name, mode, directory)) return undefined;
      const locals: { [name: string]: ember.Value } = {};
      for (const local of strings(ember.variable("desktop-locals-to-save"))) {
        if (ember.isLocalVariable(local)) locals[local] = ember.variable(local) ?? null;
      }
      const mark = ember.mark();
      return {
        ...(file ? { file } : { directory }),
        name,
        mode,
        minorModes: ember.localMinorModes(),
        point: ember.point(),
        ...(typeof mark === "number" ? { mark } : {}),
        markActive: ember.regionActive(),
        readOnly: ember.bufferReadOnly(),
        locals,
      };
    });
    if (saved) buffers.push(saved);
  }
  return { version: 1, globals, buffers, ...(truthy(ember.variable("desktop-restore-frames")) ? { windows: windowStateGet() } : {}) };
}

/** The text last written, so auto-saving a desktop that did not change writes nothing, as desktop-file-checksum. */
let lastSaved: string | undefined;

/** Saves the desktop in a directory, as desktop-save; with `onlyIfChanged`, as auto-saving does. */
function save(dir: string, release = false, onlyIfChanged = false): void {
  dir = ember.fileNameAsDirectory(ember.expandFileName(dir));
  ember.runHooks("desktop-save-hook");
  const text = `${JSON.stringify(gather(), null, 1)}\n`;
  if (!(onlyIfChanged && text === lastSaved)) {
    if (!ember.fileExists(dir)) ember.makeDirectory(dir, { parents: true });
    const modes = ember.variable("desktop-file-modes");
    ember.writeTextFile(fullFileName(dir)!, text, { mode: typeof modes === "number" ? modes : undefined });
    lastSaved = text;
  }
  if (release) releaseLock(dir);
  else if (owner(dir) !== ember.emacsPid()) claimLock(dir);
  ember.setVariable("desktop-dirname", dir);
}

/** Whether to load a desktop another process holds, as desktop--load-locked-desktop-p. */
function loadLockedP(pid: number): boolean {
  if (pid === ember.emacsPid()) return true;
  const choice = ember.variable("desktop-load-locked-desktop");
  if (choice === "check-pid") return !ember.processAliveP(pid);
  if (choice === "ask") {
    return ember.yOrNP(
      `Warning: desktop file appears to be in use by process with PID ${pid}.\n` +
        "Using it may cause conflicts if the other process also saves it.  Use it anyway? ",
    );
  }
  return truthy(choice);
}

/** Makes a buffer from what the desktop recorded, as desktop-create-buffer. Whether it could. */
function restoreBuffer(saved: SavedBuffer): boolean {
  let name: string | undefined;
  if (saved.file) {
    if (!ember.fileExists(saved.file)) {
      if (!truthy(ember.variable("desktop-missing-file-warning"))) {
        ember.message(`Desktop: File "${saved.file}" no longer exists.`);
        return false;
      }
    }
    name = ember.findFileNoselect(saved.file);
  } else if (saved.directory && saved.mode === "dired-mode") {
    if (!ember.fileExists(saved.directory)) return false;
    ember.saveExcursion(() => {
      ember.call("dired", saved.directory!);
      name = ember.currentBuffer().name;
    });
  }
  if (!name) return false;
  ember.withCurrentBuffer(name, () => {
    if (ember.variable("major-mode") !== saved.mode && ember.commandExists(saved.mode)) ember.call(saved.mode as ember.CommandName);
    for (const mode of saved.minorModes) {
      if (ember.commandExists(mode) && !truthy(ember.variable(mode))) ember.callWithPrefix(1, mode as ember.CommandName);
    }
    for (const [local, value] of Object.entries(saved.locals)) {
      ember.makeLocalVariable(local);
      ember.setVariable(local, value);
    }
    if (saved.readOnly) ember.setReadOnly(true);
    if (saved.mark !== undefined) ember.setMark(Math.min(saved.mark, ember.bufferSize()));
    if (saved.markActive) ember.activateMark();
    ember.gotoChar(Math.min(saved.point, ember.bufferSize()));
  });
  return true;
}

/** Reads the desktop in a directory, or the first in desktop-path that has one, as desktop-read. Whether one was read. */
function read(dirname?: string): boolean {
  if (owner() === ember.emacsPid() && dirname === undefined) {
    ember.message("Not reloading the desktop; already loaded");
    return false;
  }
  const dir =
    dirname && dirname !== ""
      ? dirname
      : (desktopPath().find((d) => ember.fileExists(fullFileName(d)!)) ?? desktopPath()[0] ?? String(ember.variable("user-emacs-directory")));
  ember.setVariable("desktop-dirname", ember.fileNameAsDirectory(ember.expandFileName(dir)));
  const file = fullFileName()!;
  if (!ember.fileExists(file)) {
    ember.letBind({ "default-directory": ember.variable("desktop-dirname") ?? null }, () => ember.runHooks("desktop-no-desktop-file-hook"));
    ember.message("No desktop file.");
    return false;
  }
  const locker = owner();
  if (locker !== undefined && !loadLockedP(locker)) {
    ember.setVariable("desktop-dirname", null);
    ember.runHooks("desktop-not-loaded-hook");
    if (ember.variable("desktop-dirname") === null) ember.message("Desktop file in use; not loaded.");
    return false;
  }
  const desktop = JSON.parse(ember.readTextFile(file)) as Desktop;
  for (const [name, value] of Object.entries(desktop.globals ?? {})) ember.setVariable(name, value);
  let ok = 0;
  let failed = 0;
  for (const saved of desktop.buffers ?? []) {
    if (restoreBuffer(saved)) ok++;
    else failed++;
  }
  if (locker !== ember.emacsPid()) claimLock(String(ember.variable("desktop-dirname")));
  if (desktop.windows && truthy(ember.variable("desktop-restore-frames"))) windowStatePut(desktop.windows);
  else if (desktop.buffers?.length) {
    const first = desktop.buffers.find((b) => ember.getBuffer(b.name));
    if (first) ember.call("switch-to-buffer", first.name);
  }
  lastSaved = `${JSON.stringify(gather(), null, 1)}\n`;
  ember.runHooks("desktop-after-read-hook");
  const s = (n: number) => (n === 1 ? "" : "s");
  ember.message(`Desktop: ${desktop.windows ? "1 frame, " : ""}${ok} buffer${s(ok)} restored${failed > 0 ? `, ${failed} failed to restore` : ""}.`);
  return true;
}

/** Kills the buffers the desktop would save, as desktop-clear. */
function clear(): void {
  for (const name of strings(ember.variable("desktop-globals-to-save"))) {
    if (name === "file-name-history" || name.endsWith("-ring")) ember.setVariable(name, []);
  }
  for (const name of ember.bufferList()) {
    if (/^\*(scratch|Messages)\*$/.test(name) || name.startsWith(" ")) continue;
    ember.call("kill-buffer", name);
  }
  ember.call("delete-other-windows");
}

/** What quitting does with the desktop, as desktop-kill: saves it as desktop-save says, asking for a directory the first time. */
function kill(): void {
  if (!truthy(ember.variable("desktop-save-mode"))) return;
  const file = fullFileName();
  const exists = file !== undefined && ember.fileExists(file);
  const choice = ember.variable("desktop-save");
  const dirname = ember.variable("desktop-dirname");
  const wanted =
    choice === true ||
    (exists && choice === "if-exists") ||
    (exists && typeof dirname === "string" && choice === "ask-if-new") ||
    ((choice === "ask" || choice === "ask-if-new" || (exists && choice === "ask-if-exists")) && ember.yOrNP("Save desktop? "));
  if (wanted) {
    const dir = typeof dirname === "string" ? dirname : ember.readFileName("Directory for desktop file: ", { mustMatch: true });
    save(dir, true);
  } else releaseLock();
}

let autoSaveTimer: number | undefined;

/** Saves the desktop after desktop-auto-save-timeout seconds idle, if it has a directory and changed, as desktop-auto-save. */
function autoSaveEnable(): void {
  if (autoSaveTimer !== undefined) ember.cancelTimer(autoSaveTimer);
  autoSaveTimer = undefined;
  const timeout = ember.variable("desktop-auto-save-timeout");
  if (typeof timeout !== "number" || timeout <= 0) return;
  autoSaveTimer = ember.runWithIdleTimer(timeout, true, () => {
    const dir = ember.variable("desktop-dirname");
    if (truthy(ember.variable("desktop-save-mode")) && typeof dir === "string" && owner(dir) === ember.emacsPid()) {
      ember.letBind({ "inhibit-message": true }, () => save(dir, false, true));
    }
  });
}

ember.defineMinorMode({
  name: "desktop-save-mode",
  global: true,
  doc:
    "Save the desktop, the buffers visiting files with their modes and places, some global variables and the windows, " +
    "when Ember exits and while it is idle, and read it back when Ember starts. M-x desktop-save saves it now, asking " +
    "where the first time; M-x desktop-read reads it.",
  onChange: (enabled) => {
    if (enabled) autoSaveEnable();
    else if (autoSaveTimer !== undefined) {
      ember.cancelTimer(autoSaveTimer);
      autoSaveTimer = undefined;
    }
  },
});

ember.addHook("kill-emacs-hook", () => kill());
// As desktop.el adds to after-init-hook: once init.ts has turned the mode on.
ember.addHook("after-init-hook", () => {
  if (truthy(ember.variable("desktop-save-mode"))) read();
});

ember.defineCommand({
  name: "desktop-save",
  doc: "Save the desktop in a directory, which then is where it is saved again; with a prefix argument, release its lock too.",
  params: [
    { name: "dirname", kind: "file", prompt: "Directory to save desktop file in: ", initial: () => String(ember.variable("desktop-dirname") ?? ember.variable("user-emacs-directory") ?? "~/") },
    { name: "release", kind: "prefix" },
  ],
  run: (dirname, release) => save(dirname, release !== null && release !== undefined),
});

ember.defineCommand({
  name: "desktop-save-in-desktop-dir",
  doc: "Save the desktop in desktop-dirname, or ask for a directory if it has none.",
  run: () => {
    const dir = ember.variable("desktop-dirname");
    if (typeof dir === "string") {
      save(dir);
      ember.message(`Desktop saved in ${ember.abbreviateFileName(dir)}`);
    } else ember.callInteractively("desktop-save");
  },
});

ember.defineCommand({
  name: "desktop-read",
  doc: "Read the desktop from the first directory of desktop-path that has one, or with a prefix argument from one asked for.",
  params: [{ name: "ask", kind: "prefix" }],
  run: (ask) => {
    read(ask !== null && ask !== undefined ? ember.readFileName("Directory for desktop file: ", { mustMatch: true }) : undefined);
  },
});

ember.defineCommand({
  name: "desktop-clear",
  doc: "Kill the buffers the desktop holds and empty its histories, leaving *scratch* and *Messages*.",
  run: () => clear(),
});

ember.defineCommand({
  name: "desktop-revert",
  doc: "Put the desktop back as it was last read or saved.",
  run: () => {
    const dir = ember.variable("desktop-dirname");
    if (typeof dir !== "string" || !ember.fileExists(fullFileName(dir)!)) ember.userError("Unknown desktop directory");
    releaseLock(dir);
    clear();
    read(dir);
  },
});

ember.defineCommand({
  name: "desktop-change-dir",
  doc: "Save the desktop where it is, if desktop-save-mode would, then read the one in another directory.",
  params: [{ name: "dirname", kind: "file", prompt: "Desktop directory: " }],
  run: (dirname) => {
    kill();
    clear();
    read(dirname);
  },
});

ember.defineCommand({
  name: "desktop-remove",
  doc: "Delete the desktop file and stop saving the desktop until one is saved again.",
  run: () => {
    const file = fullFileName();
    releaseLock();
    ember.setVariable("desktop-dirname", null);
    if (file && ember.fileExists(file)) ember.deleteFile(file, { trash: false });
  },
});
