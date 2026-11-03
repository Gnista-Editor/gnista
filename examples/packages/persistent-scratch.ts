// Persistent scratch buffers, after persistent-scratch.el 0.3.9
// (https://github.com/Fanael/persistent-scratch): the scratch buffers' text,
// point, mark, mode and narrowing saved to a file and read back next time,
// saved every few minutes and on quitting with
// persistent-scratch-autosave-mode, with backups if asked for.
//
// The file is in the format persistent-scratch.el writes, a printed list of
// vectors with positions counted from 1, so either editor can read the
// other's.
//
// Copyright (c) 2015-2023, Fanael Linithien
// Ported to Ember in 2026.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//   * Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
//   * Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in the
//     documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
// IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
// TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
// PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
// TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
// PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
// LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
// NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import { truthy } from "subr";

ember.defun("persistent-scratch-default-scratch-buffer-p", () => ember.bufferName() === "*scratch*");

ember.defineVariable({
  name: "persistent-scratch-scratch-buffer-p-function",
  doc: "A function, called with no arguments in a buffer, that says whether it is a scratch buffer, to be saved.",
  value: "persistent-scratch-default-scratch-buffer-p",
});
ember.defineVariable({
  name: "persistent-scratch-save-file",
  doc: "File to save to the scratch buffers to.",
  value: ember.expandFileName(".persistent-scratch", String(ember.variable("user-emacs-directory") ?? "~/.config/ember")),
});
ember.defineHook(
  "persistent-scratch-before-save-commit-functions",
  "Functions called with the temporary file holding the save data, before it is moved to persistent-scratch-save-file, as to change its permissions.",
);
ember.defineVariable({
  name: "persistent-scratch-what-to-save",
  doc: 'What to save of each scratch buffer besides its name and text: "major-mode", "point" (and the mark), "narrowing" and "text-properties".',
  value: ["major-mode", "point", "narrowing"],
});
ember.defineVariable({
  name: "persistent-scratch-autosave-interval",
  doc: 'Seconds between autosaves, or ["idle", N] to save each time Ember has been idle for N seconds. Turn persistent-scratch-autosave-mode on again after changing it.',
  value: 300,
});
ember.defineVariable({
  name: "persistent-scratch-backup-directory",
  doc: "Directory to save old versions of scratch buffer saves to. When nil, backups are disabled.",
  value: null,
});
ember.defineVariable({
  name: "persistent-scratch-backup-filter",
  doc: "A function called with the names of the files in the backup directory, unsorted, that returns those to delete. By default none are.",
  value: "ignore",
});
ember.defineVariable({
  name: "persistent-scratch-backup-file-name-format",
  doc: "Format of backup file names, as format-time-string takes it.",
  value: "%Y-%m-%d--%H-%M-%S-%N",
});
if (!ember.fboundp("ignore")) ember.defun("ignore", () => undefined);

// Printing and reading the save file, as prin1 and read do for its forms.

/** A Lisp value as the save file holds it. */
type Form = string | number | { symbol: string } | { cons: Form[]; tail?: Form } | { vector: Form[] };

const nil = { symbol: "nil" };
const t = { symbol: "t" };

function print(form: Form | undefined): string {
  if (form === undefined) return "nil";
  if (typeof form === "string") return `"${form.replace(/[\\"]/g, "\\$&")}"`;
  if (typeof form === "number") return String(form);
  if ("symbol" in form) return form.symbol;
  if ("vector" in form) return `[${form.vector.map(print).join(" ")}]`;
  const items = form.cons.map(print).join(" ");
  return form.tail === undefined || isNil(form.tail) ? `(${items})` : `(${items} . ${print(form.tail)})`;
}

const isNil = (form: Form | undefined): boolean => form === undefined || (typeof form === "object" && "symbol" in form && form.symbol === "nil");

/** Reads one form from TEXT at `at.pos`, as read does, enough for what persistent-scratch writes. */
function read(text: string, at = { pos: 0 }): Form {
  const skip = () => {
    for (;;) {
      while (at.pos < text.length && /\s/.test(text[at.pos])) at.pos++;
      if (text[at.pos] !== ";") return;
      while (at.pos < text.length && text[at.pos] !== "\n") at.pos++;
    }
  };
  skip();
  const c = text[at.pos];
  if (c === undefined) ember.signal("end-of-file", "End of file during parsing");
  if (c === '"') {
    let s = "";
    at.pos++;
    while (text[at.pos] !== '"') {
      if (at.pos >= text.length) ember.signal("end-of-file", "End of file during parsing");
      let ch = text[at.pos++];
      if (ch === "\\") {
        ch = text[at.pos++];
        if (ch === "n") ch = "\n";
        else if (ch === "t") ch = "\t";
        else if (ch === "\n") ch = "";
      }
      s += ch;
    }
    at.pos++;
    return s;
  }
  if (c === "(" || c === "[") {
    const close = c === "(" ? ")" : "]";
    at.pos++;
    const items: Form[] = [];
    let tail: Form | undefined;
    for (;;) {
      skip();
      if (text[at.pos] === close) {
        at.pos++;
        break;
      }
      if (c === "(" && text[at.pos] === "." && /[\s()]/.test(text[at.pos + 1] ?? " ")) {
        at.pos++;
        tail = read(text, at);
        continue;
      }
      items.push(read(text, at));
    }
    return c === "(" ? { cons: items, tail } : { vector: items };
  }
  if (c === "#" && text[at.pos + 1] === "(") {
    // A string with text properties: the string, its properties left behind.
    at.pos++;
    const parts = read(text, at) as { cons: Form[] };
    return parts.cons[0];
  }
  const start = at.pos;
  while (at.pos < text.length && !/[\s()[\]";]/.test(text[at.pos])) at.pos++;
  const atom = text.slice(start, at.pos);
  return /^[-+]?\d+(\.\d+)?$/.test(atom) ? Number(atom) : { symbol: atom.replace(/\\(.)/g, "$1") };
}

// Saving and restoring.

function whatToSave(): string[] {
  const value = ember.variable("persistent-scratch-what-to-save");
  return Array.isArray(value) ? value.map(String) : [];
}

/** Whether transient-mark-mode is on: always, unless a config defines the variable as nil, as Ember has no other mode. */
const transientMarkMode = (): boolean => {
  const value = ember.variable("transient-mark-mode");
  return value === undefined || truthy(value);
};

const isScratch = (): boolean => truthy(ember.funcall(ember.variable("persistent-scratch-scratch-buffer-p-function") as string));

/** The current buffer's state, as persistent-scratch--get-buffer-state: name, text, point and mark, mode, narrowing, whether the region is active. */
function bufferState(): Form {
  const what = whatToSave();
  const text = ember.saveRestriction(() => {
    ember.widen();
    return ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax());
  });
  const mark = ember.mark();
  const narrowed = ember.bufferNarrowedP();
  return {
    vector: [
      ember.bufferName(),
      text,
      what.includes("point") ? { cons: [ember.point() + 1], tail: typeof mark === "number" ? mark + 1 : nil } : nil,
      what.includes("major-mode") ? { symbol: String(ember.variable("major-mode")) } : nil,
      narrowed && what.includes("narrowing") ? { cons: [ember.pointMin() + 1], tail: ember.pointMax() + 1 } : nil,
      what.includes("point") ? (!transientMarkMode() || ember.regionActive() ? t : nil) : nil,
    ],
  };
}

/** The scratch buffers and the text to save for them, as persistent-scratch--save-buffers-state. */
function saveBuffersState(): [string[], string] {
  const buffers: string[] = [];
  const data: Form[] = [];
  for (const buffer of ember.bufferList()) {
    ember.withCurrentBuffer(buffer, () => {
      if (!isScratch()) return;
      buffers.unshift(buffer);
      data.unshift(bufferState());
    });
  }
  return [buffers, print({ cons: data })];
}

/** Today's time in a backup's file name, as format-time-string does for the codes the default format uses. */
function formatTime(format: string, date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const codes: { [c: string]: string } = {
    Y: String(date.getFullYear()),
    m: pad(date.getMonth() + 1),
    d: pad(date.getDate()),
    H: pad(date.getHours()),
    M: pad(date.getMinutes()),
    S: pad(date.getSeconds()),
    N: pad(date.getMilliseconds() * 1_000_000, 9),
    "%": "%",
  };
  return format.replace(/%(.)/g, (all, c: string) => codes[c] ?? all);
}

let currentBackupTime = new Date();

/** Copies the save file into the backup directory, as persistent-scratch--update-backup. */
function updateBackup(): void {
  const dir = ember.variable("persistent-scratch-backup-directory");
  if (typeof dir !== "string") return;
  const name = ember.expandFileName(formatTime(String(ember.variable("persistent-scratch-backup-file-name-format")), currentBackupTime), dir);
  ember.makeDirectory(dir, { parents: true });
  ember.copyFile(String(ember.variable("persistent-scratch-save-file")), name, { okIfExists: true, keepTime: true });
}

/** Deletes the backups persistent-scratch-backup-filter names, as persistent-scratch--cleanup-backups. */
function cleanupBackups(): void {
  const dir = ember.variable("persistent-scratch-backup-directory");
  if (typeof dir !== "string") return;
  const directory = ember.fileNameAsDirectory(dir);
  const names = ember.directoryFiles(directory, { nosort: true }).filter((n) => n !== "." && n !== "..");
  const doomed = ember.funcall(ember.variable("persistent-scratch-backup-filter") as string, names);
  if (Array.isArray(doomed)) for (const name of doomed) ember.deleteFile(directory + String(name));
}

/**
 * Saves the scratch buffers' state to FILE, or to persistent-scratch-save-file
 * with a backup if there is a backup directory, as persistent-scratch-save:
 * written to FILE.new, readable only by the user, then moved over it.
 */
export function save(file?: string): string {
  const actual = file ?? String(ember.variable("persistent-scratch-save-file"));
  const tmp = `${actual}.new`;
  const [buffers, text] = saveBuffersState();
  ember.writeTextFile(tmp, text, { mode: 0o600 });
  ember.runHooks("persistent-scratch-before-save-commit-functions", tmp);
  ember.renameFile(tmp, actual, { okIfExists: true });
  for (const buffer of buffers) ember.withCurrentBuffer(buffer, () => ember.setBufferModified(false));
  if (file === undefined) {
    updateBackup();
    cleanupBackups();
  }
  return actual;
}

/** Restores the scratch buffers saved in FILE, or persistent-scratch-save-file, as persistent-scratch-restore. */
export function restore(file?: string): void {
  const text = ember.readTextFile(ember.expandFileName(file ?? String(ember.variable("persistent-scratch-save-file"))));
  const data = read(text);
  if (isNil(data)) return;
  if (typeof data !== "object" || !("cons" in data)) ember.signal("invalid-read-syntax", "Not a list of saved buffers");
  for (const saved of data.cons) {
    if (typeof saved !== "object" || !("vector" in saved)) continue;
    const [name, contents, pointAndMark, mode, narrowing, active] = saved.vector;
    ember.getBufferCreate(String(name));
    ember.withCurrentBuffer(String(name), () => {
      ember.widen();
      ember.deleteRegion(ember.pointMin(), ember.pointMax());
      ember.insert(String(contents));
      if (typeof mode === "object" && "symbol" in mode && !isNil(mode) && ember.fboundp(mode.symbol)) ember.call(mode.symbol as ember.CommandName);
      const max = ember.pointMax();
      const position = (f: Form | undefined) => (typeof f === "number" ? Math.max(0, Math.min(f - 1, max)) : undefined);
      if (typeof pointAndMark === "object" && "cons" in pointAndMark) {
        const point = position(pointAndMark.cons[0]);
        if (point !== undefined) ember.gotoChar(point);
        const mark = position(pointAndMark.tail);
        ember.setMark(mark ?? null);
        // set-mark activates the mark, in transient-mark-mode.
        if (mark !== undefined && transientMarkMode()) ember.activateMark();
      }
      if (typeof narrowing === "object" && "cons" in narrowing) {
        const [start, end] = [position(narrowing.cons[0]), position(narrowing.tail)];
        if (start !== undefined && end !== undefined) ember.narrowToRegion(start, end);
      }
      if (saved.vector.length >= 6 && isNil(active)) ember.deactivateMark();
    });
  }
}

let autoRestored = false;

/** Restores the scratch buffers once a session, showing what went wrong rather than failing, as persistent-scratch--auto-restore. */
function autoRestore(): void {
  if (autoRestored) return;
  ember.conditionCase(() => restore(), {
    error: (e) => ember.message(`Failed to restore scratch buffers: ${e.message}`),
  });
  autoRestored = true;
}

const saveCommand = ember.defineCommand({
  name: "persistent-scratch-save",
  doc: "Save the current state of scratch buffers to persistent-scratch-save-file, keeping a backup if persistent-scratch-backup-directory names a directory.",
  run: () => ember.message(`Wrote persistent-scratch file ${save()}`),
});

const saveToFile = ember.defineCommand({
  name: "persistent-scratch-save-to-file",
  doc: "Save the current state of scratch buffers to a file.",
  params: [{ name: "file", kind: "file", prompt: "Save scratch buffers to file: " }],
  run: (file: string) => ember.message(`Wrote persistent-scratch file ${save(file)}`),
});

ember.defineCommand({
  name: "persistent-scratch-restore",
  doc: "Restore the scratch buffers saved in persistent-scratch-save-file. A buffer of the same name as a saved one has its text replaced.",
  run: () => restore(),
});

ember.defineCommand({
  name: "persistent-scratch-restore-from-file",
  doc: "Restore the scratch buffers from a file.",
  params: [{ name: "file", kind: "file", prompt: "Restore scratch buffers from file: " }],
  run: (file: string) => restore(file),
});

ember.defineMinorMode({
  name: "persistent-scratch-mode",
  lighter: " PS",
  doc: "Save scratch buffers with save-buffer and write-file, as persistent-scratch-save and persistent-scratch-save-to-file. Only in a scratch buffer.",
  onChange: (enabled) => {
    if (enabled && !isScratch()) {
      ember.setVariable("persistent-scratch-mode", false);
      ember.signal("error", "This buffer isn't managed by `persistent-scratch', not enabling mode.");
    }
  },
});
ember.remapCommand("persistent-scratch-mode-map", "save-buffer", saveCommand);
ember.remapCommand("persistent-scratch-mode-map", "write-file", saveToFile);

let autosaveTimer: number | undefined;
const saveQuietly = () => void save();

function autosaveOff(): void {
  ember.removeHook("kill-emacs-hook", saveQuietly);
  if (autosaveTimer !== undefined) ember.cancelTimer(autosaveTimer);
  autosaveTimer = undefined;
}

function autosaveOn(): void {
  ember.addHook("kill-emacs-hook", saveQuietly);
  const interval = ember.variable("persistent-scratch-autosave-interval");
  autosaveTimer =
    Array.isArray(interval) && interval[0] === "idle"
      ? ember.runWithIdleTimer(Number(interval[1]), true, saveQuietly)
      : ember.runWithTimer(Number(interval), Number(interval), saveQuietly);
}

ember.defineMinorMode({
  name: "persistent-scratch-autosave-mode",
  global: true,
  doc: "Save the scratch buffers every persistent-scratch-autosave-interval seconds and when Ember quits. Turning it on restores them first, once a session.",
  onChange: (enabled) => {
    autoRestore();
    autosaveOff();
    if (enabled) autosaveOn();
  },
});

ember.defineCommand({
  name: "persistent-scratch-new-backup",
  doc: "Start a new backup file: the next save makes it and keeps using it.",
  run: () => {
    currentBackupTime = new Date();
  },
});

/** Turns persistent-scratch-autosave-mode on and restores the scratch buffers, as persistent-scratch-setup-default. */
export function setupDefault(): void {
  autoRestore();
  ember.call("persistent-scratch-autosave-mode" as ember.CommandName);
}
ember.defun("persistent-scratch-setup-default", setupDefault);

/** A backup filter that keeps the N newest backups, as persistent-scratch-keep-n-newest-backups. */
export function keepNNewestBackups(n: number): (files: string[]) => string[] {
  return (files) => [...files].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(n);
}
ember.defun("persistent-scratch-keep-n-newest-backups", keepNNewestBackups);

/** A backup filter that keeps the backups newer than SECONDS, as persistent-scratch-keep-backups-not-older-than. */
export function keepBackupsNotOlderThan(seconds: number): (files: string[]) => string[] {
  return (files) => {
    const limit = formatTime(String(ember.variable("persistent-scratch-backup-file-name-format")), new Date(Date.now() - seconds * 1000));
    return files.filter((f) => f < limit);
  };
}
ember.defun("persistent-scratch-keep-backups-not-older-than", keepBackupsNotOlderThan);
