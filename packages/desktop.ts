// Saving and restoring sessions, after Emacs's desktop.el: with
// desktop-save-mode on, the buffers visiting files and Dired buffers, with
// their modes, points and marks, some global variables such as
// file-name-history, and the selected frame's windows are saved when Gnista
// exits and every so often while idle, and read back when it starts. The
// first save asks for a directory, as Emacs's does; M-x desktop-save saves
// at once. The file is JSON, where Emacs writes Lisp, and a lock file next
// to it keeps two Gnistas from using it at once.

import { truthy } from "subr";
import { type WindowState, windowStateGet, windowStatePut } from "window";

for (const [name, value, doc] of [
  ["desktop-path", [], "The directories desktop-read looks for a desktop file in, in order: user-emacs-directory and ~ when empty."],
  ["desktop-dirname", null, "The directory the desktop was last read from or saved in, where it is saved again."],
  ["desktop-base-file-name", ".gnista.desktop", "The desktop file's name, in desktop-dirname."],
  ["desktop-base-lock-name", ".gnista.desktop.lock", "The lock file's name, which holds the process id of the Gnista using the desktop."],
  [
    "desktop-save",
    "ask-if-new",
    'Whether quitting saves the desktop: t always, "ask-if-new" asking if there is no desktop file yet, "ask", "if-exists", "ask-if-exists", or nil never.',
  ],
  ["desktop-load-locked-desktop", "ask", 'What to do with a desktop another Gnista has locked: t load it, nil do not, "ask", or "check-pid" load it if that Gnista is not running.'],
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
  gnista.defineVariable({ name, value: value as gnista.Value, doc });
}
for (const [name, doc] of [
  ["desktop-after-read-hook", "Run after the desktop is read."],
  ["desktop-save-hook", "Run before the desktop is saved."],
  ["desktop-no-desktop-file-hook", "Run when desktop-read finds no desktop file, in the directory it looked in."],
  ["desktop-not-loaded-hook", "Run when a desktop locked by another Gnista is not loaded."],
] as const) {
  gnista.defineHook(name, doc);
}

const strings = (v: gnista.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

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
  locals: { [name: string]: gnista.Value };
}

interface Desktop {
  version: 1;
  globals: { [name: string]: gnista.Value };
  buffers: SavedBuffer[];
  windows?: WindowState;
}

function desktopPath(): string[] {
  const path = strings(gnista.variable("desktop-path"));
  const own = gnista.variable("user-emacs-directory");
  return path.length > 0 ? path : [...(typeof own === "string" ? [own] : []), "~"];
}

/** The desktop file in a directory, desktop-dirname by default, as desktop-full-file-name. */
function fullFileName(dir = gnista.variable("desktop-dirname")): string | undefined {
  return typeof dir === "string" ? gnista.expandFileName(String(gnista.variable("desktop-base-file-name")), dir) : undefined;
}

function lockFileName(dir = gnista.variable("desktop-dirname")): string | undefined {
  return typeof dir === "string" ? gnista.expandFileName(String(gnista.variable("desktop-base-lock-name")), dir) : undefined;
}

/** The process id the desktop's lock holds, as desktop-owner. */
function owner(dir?: string): number | undefined {
  const lock = lockFileName(dir ?? gnista.variable("desktop-dirname"));
  if (!lock || !gnista.fileExists(lock)) return undefined;
  const pid = Number(gnista.readTextFile(lock).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function claimLock(dir: string): void {
  gnista.writeTextFile(lockFileName(dir)!, `${gnista.emacsPid()}`);
}

function releaseLock(dir: string | undefined = gnista.variable("desktop-dirname") as string | undefined): void {
  const lock = lockFileName(dir);
  if (lock && owner(dir) === gnista.emacsPid()) gnista.deleteFile(lock, { trash: false });
}

/** Whether a buffer is saved, as desktop-save-buffer-p. */
function saveBufferP(file: string | undefined, name: string, mode: string, directory: string): boolean {
  const notBuffers = gnista.variable("desktop-buffers-not-to-save");
  const notFiles = gnista.variable("desktop-files-not-to-save");
  const matches = (re: gnista.Value | undefined, s: string) => typeof re === "string" && gnista.stringMatch(re, s) !== undefined;
  if (!file && matches(notBuffers, name)) return false;
  if (strings(gnista.variable("desktop-modes-not-to-save")).includes(mode)) return false;
  if (file) return !matches(notFiles, file);
  return mode === "dired-mode" && !matches(notFiles, directory);
}

/** What the desktop file holds now, as desktop-save gathers it. */
function gather(): Desktop {
  const globals: { [name: string]: gnista.Value } = {};
  for (const name of strings(gnista.variable("desktop-globals-to-save"))) {
    const value = gnista.variable(name);
    if (value !== undefined) globals[name] = value;
  }
  const buffers: SavedBuffer[] = [];
  for (const name of gnista.bufferList()) {
    const saved = gnista.withCurrentBuffer(name, (): SavedBuffer | undefined => {
      const file = gnista.bufferFileName();
      const mode = String(gnista.variable("major-mode"));
      const directory = String(gnista.variable("default-directory") ?? "");
      if (!saveBufferP(file, name, mode, directory)) return undefined;
      const locals: { [name: string]: gnista.Value } = {};
      for (const local of strings(gnista.variable("desktop-locals-to-save"))) {
        if (gnista.isLocalVariable(local)) locals[local] = gnista.variable(local) ?? null;
      }
      const mark = gnista.mark();
      return {
        ...(file ? { file } : { directory }),
        name,
        mode,
        minorModes: gnista.localMinorModes(),
        point: gnista.point(),
        ...(typeof mark === "number" ? { mark } : {}),
        markActive: gnista.regionActive(),
        readOnly: gnista.bufferReadOnly(),
        locals,
      };
    });
    if (saved) buffers.push(saved);
  }
  return { version: 1, globals, buffers, ...(truthy(gnista.variable("desktop-restore-frames")) ? { windows: windowStateGet() } : {}) };
}

/** The text last written, so auto-saving a desktop that did not change writes nothing, as desktop-file-checksum. */
let lastSaved: string | undefined;

/** Saves the desktop in a directory, as desktop-save; with `onlyIfChanged`, as auto-saving does. */
function save(dir: string, release = false, onlyIfChanged = false): void {
  dir = gnista.fileNameAsDirectory(gnista.expandFileName(dir));
  gnista.runHooks("desktop-save-hook");
  const text = `${JSON.stringify(gather(), null, 1)}\n`;
  if (!(onlyIfChanged && text === lastSaved)) {
    if (!gnista.fileExists(dir)) gnista.makeDirectory(dir, { parents: true });
    const modes = gnista.variable("desktop-file-modes");
    gnista.writeTextFile(fullFileName(dir)!, text, { mode: typeof modes === "number" ? modes : undefined });
    lastSaved = text;
  }
  if (release) releaseLock(dir);
  else if (owner(dir) !== gnista.emacsPid()) claimLock(dir);
  gnista.setVariable("desktop-dirname", dir);
}

/** Whether to load a desktop another process holds, as desktop--load-locked-desktop-p. */
function loadLockedP(pid: number): boolean {
  if (pid === gnista.emacsPid()) return true;
  const choice = gnista.variable("desktop-load-locked-desktop");
  if (choice === "check-pid") return !gnista.processAliveP(pid);
  if (choice === "ask") {
    return gnista.yOrNP(
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
    if (!gnista.fileExists(saved.file)) {
      if (!truthy(gnista.variable("desktop-missing-file-warning"))) {
        gnista.message(`Desktop: File "${saved.file}" no longer exists.`);
        return false;
      }
    }
    name = gnista.findFileNoselect(saved.file);
  } else if (saved.directory && saved.mode === "dired-mode") {
    if (!gnista.fileExists(saved.directory)) return false;
    gnista.saveExcursion(() => {
      gnista.call("dired", saved.directory!);
      name = gnista.currentBuffer().name;
    });
  }
  if (!name) return false;
  gnista.withCurrentBuffer(name, () => {
    if (gnista.variable("major-mode") !== saved.mode && gnista.commandExists(saved.mode)) gnista.call(saved.mode as gnista.CommandName);
    for (const mode of saved.minorModes) {
      if (gnista.commandExists(mode) && !truthy(gnista.variable(mode))) gnista.callWithPrefix(1, mode as gnista.CommandName);
    }
    for (const [local, value] of Object.entries(saved.locals)) {
      gnista.makeLocalVariable(local);
      gnista.setVariable(local, value);
    }
    if (saved.readOnly) gnista.setReadOnly(true);
    if (saved.mark !== undefined) gnista.setMark(Math.min(saved.mark, gnista.bufferSize()));
    if (saved.markActive) gnista.activateMark();
    gnista.gotoChar(Math.min(saved.point, gnista.bufferSize()));
  });
  return true;
}

/** Reads the desktop in a directory, or the first in desktop-path that has one, as desktop-read. Whether one was read. */
function read(dirname?: string): boolean {
  if (owner() === gnista.emacsPid() && dirname === undefined) {
    gnista.message("Not reloading the desktop; already loaded");
    return false;
  }
  const dir =
    dirname && dirname !== ""
      ? dirname
      : (desktopPath().find((d) => gnista.fileExists(fullFileName(d)!)) ?? desktopPath()[0] ?? String(gnista.variable("user-emacs-directory")));
  gnista.setVariable("desktop-dirname", gnista.fileNameAsDirectory(gnista.expandFileName(dir)));
  const file = fullFileName()!;
  if (!gnista.fileExists(file)) {
    gnista.letBind({ "default-directory": gnista.variable("desktop-dirname") ?? null }, () => gnista.runHooks("desktop-no-desktop-file-hook"));
    gnista.message("No desktop file.");
    return false;
  }
  const locker = owner();
  if (locker !== undefined && !loadLockedP(locker)) {
    gnista.setVariable("desktop-dirname", null);
    gnista.runHooks("desktop-not-loaded-hook");
    if (gnista.variable("desktop-dirname") === null) gnista.message("Desktop file in use; not loaded.");
    return false;
  }
  const desktop = JSON.parse(gnista.readTextFile(file)) as Desktop;
  for (const [name, value] of Object.entries(desktop.globals ?? {})) gnista.setVariable(name, value);
  let ok = 0;
  let failed = 0;
  for (const saved of desktop.buffers ?? []) {
    if (restoreBuffer(saved)) ok++;
    else failed++;
  }
  if (locker !== gnista.emacsPid()) claimLock(String(gnista.variable("desktop-dirname")));
  if (desktop.windows && truthy(gnista.variable("desktop-restore-frames"))) windowStatePut(desktop.windows);
  else if (desktop.buffers?.length) {
    const first = desktop.buffers.find((b) => gnista.getBuffer(b.name));
    if (first) gnista.call("switch-to-buffer", first.name);
  }
  lastSaved = `${JSON.stringify(gather(), null, 1)}\n`;
  gnista.runHooks("desktop-after-read-hook");
  const s = (n: number) => (n === 1 ? "" : "s");
  gnista.message(`Desktop: ${desktop.windows ? "1 frame, " : ""}${ok} buffer${s(ok)} restored${failed > 0 ? `, ${failed} failed to restore` : ""}.`);
  return true;
}

/** Kills the buffers the desktop would save, as desktop-clear. */
function clear(): void {
  for (const name of strings(gnista.variable("desktop-globals-to-save"))) {
    if (name === "file-name-history" || name.endsWith("-ring")) gnista.setVariable(name, []);
  }
  for (const name of gnista.bufferList()) {
    if (/^\*(scratch|Messages)\*$/.test(name) || name.startsWith(" ")) continue;
    gnista.call("kill-buffer", name);
  }
  gnista.call("delete-other-windows");
}

/** What quitting does with the desktop, as desktop-kill: saves it as desktop-save says, asking for a directory the first time. */
function kill(): void {
  if (!truthy(gnista.variable("desktop-save-mode"))) return;
  const file = fullFileName();
  const exists = file !== undefined && gnista.fileExists(file);
  const choice = gnista.variable("desktop-save");
  const dirname = gnista.variable("desktop-dirname");
  const wanted =
    choice === true ||
    (exists && choice === "if-exists") ||
    (exists && typeof dirname === "string" && choice === "ask-if-new") ||
    ((choice === "ask" || choice === "ask-if-new" || (exists && choice === "ask-if-exists")) && gnista.yOrNP("Save desktop? "));
  if (wanted) {
    const dir = typeof dirname === "string" ? dirname : gnista.readFileName("Directory for desktop file: ", { mustMatch: true });
    save(dir, true);
  } else releaseLock();
}

let autoSaveTimer: number | undefined;

/** Saves the desktop after desktop-auto-save-timeout seconds idle, if it has a directory and changed, as desktop-auto-save. */
function autoSaveEnable(): void {
  if (autoSaveTimer !== undefined) gnista.cancelTimer(autoSaveTimer);
  autoSaveTimer = undefined;
  const timeout = gnista.variable("desktop-auto-save-timeout");
  if (typeof timeout !== "number" || timeout <= 0) return;
  autoSaveTimer = gnista.runWithIdleTimer(timeout, true, () => {
    const dir = gnista.variable("desktop-dirname");
    if (truthy(gnista.variable("desktop-save-mode")) && typeof dir === "string" && owner(dir) === gnista.emacsPid()) {
      gnista.letBind({ "inhibit-message": true }, () => save(dir, false, true));
    }
  });
}

gnista.defineMinorMode({
  name: "desktop-save-mode",
  global: true,
  doc:
    "Save the desktop, the buffers visiting files with their modes and places, some global variables and the windows, " +
    "when Gnista exits and while it is idle, and read it back when Gnista starts. M-x desktop-save saves it now, asking " +
    "where the first time; M-x desktop-read reads it.",
  onChange: (enabled) => {
    if (enabled) autoSaveEnable();
    else if (autoSaveTimer !== undefined) {
      gnista.cancelTimer(autoSaveTimer);
      autoSaveTimer = undefined;
    }
  },
});

gnista.addHook("kill-emacs-hook", () => kill());
// As desktop.el adds to after-init-hook: once init.ts has turned the mode on.
gnista.addHook("after-init-hook", () => {
  if (truthy(gnista.variable("desktop-save-mode"))) read();
});

gnista.defineCommand({
  name: "desktop-save",
  doc: "Save the desktop in a directory, which then is where it is saved again; with a prefix argument, release its lock too.",
  params: [
    { name: "dirname", kind: "file", prompt: "Directory to save desktop file in: ", initial: () => {
      const dir = [gnista.variable("desktop-dirname"), gnista.variable("user-emacs-directory")].find((d) => typeof d === "string");
      return typeof dir === "string" ? dir : "~/";
    } },
    { name: "release", kind: "prefix" },
  ],
  run: (dirname, release) => save(dirname, release !== null && release !== undefined),
});

gnista.defineCommand({
  name: "desktop-save-in-desktop-dir",
  doc: "Save the desktop in desktop-dirname, or ask for a directory if it has none.",
  run: () => {
    const dir = gnista.variable("desktop-dirname");
    if (typeof dir === "string") {
      save(dir);
      gnista.message(`Desktop saved in ${gnista.abbreviateFileName(dir)}`);
    } else gnista.callInteractively("desktop-save");
  },
});

gnista.defineCommand({
  name: "desktop-read",
  doc: "Read the desktop from the first directory of desktop-path that has one, or with a prefix argument from one asked for.",
  params: [{ name: "ask", kind: "prefix" }],
  run: (ask) => {
    read(ask !== null && ask !== undefined ? gnista.readFileName("Directory for desktop file: ", { mustMatch: true }) : undefined);
  },
});

gnista.defineCommand({
  name: "desktop-clear",
  doc: "Kill the buffers the desktop holds and empty its histories, leaving *scratch* and *Messages*.",
  run: () => clear(),
});

gnista.defineCommand({
  name: "desktop-revert",
  doc: "Put the desktop back as it was last read or saved.",
  run: () => {
    const dir = gnista.variable("desktop-dirname");
    if (typeof dir !== "string" || !gnista.fileExists(fullFileName(dir)!)) gnista.userError("Unknown desktop directory");
    releaseLock(dir);
    clear();
    read(dir);
  },
});

gnista.defineCommand({
  name: "desktop-change-dir",
  doc: "Save the desktop where it is, if desktop-save-mode would, then read the one in another directory.",
  params: [{ name: "dirname", kind: "file", prompt: "Desktop directory: " }],
  run: (dirname) => {
    kill();
    clear();
    read(dirname);
  },
});

gnista.defineCommand({
  name: "desktop-remove",
  doc: "Delete the desktop file and stop saving the desktop until one is saved again.",
  run: () => {
    const file = fullFileName();
    releaseLock();
    gnista.setVariable("desktop-dirname", null);
    if (file && gnista.fileExists(file)) gnista.deleteFile(file, { trash: false });
  },
});
