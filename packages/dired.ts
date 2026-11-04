// Dired, after Emacs's dired.el and dired-aux.el, with the listing drawn as
// Emacs's ls-lisp.el draws it. C-x d lists a directory, one file a line;
// RET visits the file on a line, ^ goes up, and m, d, u and t mark files for
// the commands that act on them: C copies, R renames or moves, D deletes, x
// deletes the files flagged with d, and + makes a directory. g lists the
// directory again, keeping the marks. Deleting goes to the trash, as
// delete-by-moving-to-trash says.

// Faces.

gnista.defineFace({ name: "dired-header", doc: "The directory's name at the top of a listing.", attributes: { inherit: "font-lock-type-face" } });
gnista.defineFace({ name: "dired-directory", doc: "The names of directories in a listing.", attributes: { inherit: "font-lock-function-name-face" } });
gnista.defineFace({ name: "dired-symlink", doc: "The names of symbolic links in a listing.", attributes: { inherit: "font-lock-keyword-face" } });
gnista.defineFace({ name: "dired-mark", doc: "The mark at the start of a marked line.", attributes: { inherit: "font-lock-constant-face" } });
gnista.defineFace({ name: "dired-marked", doc: "The names of marked files.", attributes: { inherit: "warning" } });
gnista.defineFace({ name: "dired-flagged", doc: "The names of files flagged for deletion.", attributes: { inherit: "error" } });
gnista.defineFace({ name: "dired-ignored", doc: "Files of little interest, such as backups.", attributes: { inherit: "shadow" } });

// Variables.

const defvar = (name: string, value: gnista.Value, doc: string) => gnista.defineVariable({ name, value, doc });
defvar("dired-listing-switches", "-al", "How Dired lists a directory, as ls's switches: a lists dot files, A all but . and .., t sorts by time, S by size, r reverses, and h writes sizes as 1.2k.");
defvar("dired-recursive-deletes", "top", "Whether deleting a directory with files in it asks: top asks once for each, always never asks, and nil refuses.");
defvar("dired-recursive-copies", "top", "Whether copying a directory copies what it holds: top or always do, and nil refuses.");
defvar("dired-dwim-target", false, "Whether copying and renaming suggest the directory of a Dired buffer in another window.");
defvar("dired-keep-marker-copy", "C", "The mark copies get, or true for the mark the file had, or nil for none.");
defvar("dired-keep-marker-rename", true, "Whether renamed files keep their marks, or a mark they get instead.");
defvar("dired-copy-preserve-time", true, "Whether a copy keeps the modification time of what it copies.");
defvar("dired-trivial-filenames", "\\`\\.\\.?\\'\\|\\`\\.?#", "Names Dired passes over when it puts point on the first file, as a regular expression: . and .., and auto-save and lock files.");
defvar("dired-kill-when-opening-new-dired-buffer", false, "Whether visiting a directory from Dired kills the Dired buffer it came from.");
defvar("dired-auto-revert-buffer", false, "Whether going back to a Dired buffer lists its directory again.");
defvar("dired-directory", null, "The directory a Dired buffer lists.");
defvar("dired-actual-switches", null, "The switches this Dired buffer lists with, which s changes.");

gnista.defineHook("dired-after-readin-hook", "Functions called after a Dired buffer lists its directory, in that buffer.");

export const MARKER = "*";
export const DEL_MARKER = "D";

export const on = (name: string): boolean => {
  const v = gnista.variable(name);
  return v !== null && v !== false && v !== undefined;
};

// The listing, as ls-lisp formats it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as ls writes it: Oct 29 11:53 within the last six months, else Oct 29  2025. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, " ");
  const age = Date.now() - ms;
  if (age >= 0 && age < 15778476000) {
    return `${MONTHS[d.getMonth()]} ${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${MONTHS[d.getMonth()]} ${day}  ${d.getFullYear()}`;
}

/** A size as ls -h writes it, as Emacs's file-size-human-readable. */
function humanSize(size: number): string {
  const units = ["", "k", "M", "G", "T", "P"];
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? String(n) : n >= 10 ? `${Math.round(n)}${units[i]}` : `${n.toFixed(1).replace(/\.0$/, "")}${units[i]}`;
}

export function switchesOf(): string {
  const own = gnista.variable("dired-actual-switches");
  if (typeof own === "string") return own;
  return String(gnista.variable("dired-listing-switches") ?? "-al");
}

/** The lines listing a directory, as ls-lisp-insert-directory makes them for ls -l with these switches. */
export function listing(dir: string, switches: string, only?: string[]): string[] {
  const flags = new Set(switches.replace(/--\S+/g, "").replace(/[\s-]/g, ""));
  let names = only ?? gnista.directoryFiles(dir);
  if (only === undefined) {
    if (flags.has("A")) names = names.filter((n) => n !== "." && n !== "..");
    else if (!flags.has("a")) names = names.filter((n) => !n.startsWith("."));
  }
  const entries = names
    .map((name) => ({ name, attrs: gnista.fileAttributes(dir + name) }))
    .filter((e): e is { name: string; attrs: gnista.FileAttributes } => e.attrs !== undefined);
  if (flags.has("t")) entries.sort((a, b) => b.attrs.modified - a.attrs.modified);
  else if (flags.has("S")) entries.sort((a, b) => b.attrs.size - a.attrs.size);
  if (flags.has("r")) entries.reverse();
  const human = flags.has("h");
  const sizeOf = (e: { attrs: gnista.FileAttributes }) => (human ? humanSize(e.attrs.size) : String(e.attrs.size));
  const userWidth = Math.max(0, ...entries.map((e) => e.attrs.user.length));
  const groupWidth = Math.max(0, ...entries.map((e) => e.attrs.group.length));
  const sizeWidth = Math.max(0, ...entries.map((e) => sizeOf(e).length));
  return entries.map((e) => {
    const a = e.attrs;
    const link = a.type === "symlink" && a.linkTarget !== null ? ` -> ${a.linkTarget}` : "";
    const group = flags.has("G") ? "" : ` ${a.group.padEnd(groupWidth)}`;
    return `${a.modes}${String(a.links).padStart(3)} ${a.user.padEnd(userWidth)}${group} ${sizeOf(e).padStart(sizeWidth)} ${formatTime(a.modified)} ${e.name}${link}`;
  });
}

// Lines, as dired.el finds its way around them.

/** A file line: two columns for the mark, the details, then the name. */
const LINE = /^(.)\s([-dlbcps][-rwxsStT]{9}[@+.]?\s*\d+ .*? (?:[A-Z][a-z]{2} [ \d]\d (?:\d\d:\d\d| \d{4}))) (.*)$/;

export interface FileLine {
  mark: string;
  /** Where the name starts, in the buffer. */
  start: number;
  name: string;
  isDir: boolean;
  isLink: boolean;
}

export function fileLine(line: number): FileLine | undefined {
  if (line < 0 || line >= gnista.lineCount()) return undefined;
  const text = gnista.lineText(line);
  const m = LINE.exec(text);
  if (!m) return undefined;
  const isLink = m[2].startsWith("l");
  const shown = m[3];
  const arrow = isLink ? shown.indexOf(" -> ") : -1;
  return {
    mark: m[1],
    start: gnista.lineStart(line) + text.length - shown.length,
    name: arrow >= 0 ? shown.slice(0, arrow) : shown,
    isDir: m[2].startsWith("d"),
    isLink,
  };
}

const currentLine = (): number => gnista.lineOf(gnista.point());

/** Moves to the start of the file name on this line, as dired-move-to-filename: else to the line's start. */
export function moveToFilename(): number | undefined {
  const line = currentLine();
  const f = fileLine(line);
  gnista.gotoChar(f ? f.start : gnista.lineStart(line));
  return f?.start;
}

/** The directory this buffer lists, ending in a slash. */
export function currentDirectory(): string {
  const dir = gnista.variable("dired-directory");
  if (typeof dir !== "string") throw new Error("Not in a Dired buffer");
  return gnista.fileNameAsDirectory(gnista.expandFileName(dir));
}

export const isDot = (name: string): boolean => name === "." || name === "..";

/** The absolute name of the file on this line, as dired-get-filename, or undefined on a line with none. */
export function filenameAt(line = currentLine()): string | undefined {
  const f = fileLine(line);
  return f === undefined ? undefined : currentDirectory() + f.name;
}

export function requireDired(): void {
  if (gnista.variable("major-mode") !== "dired-mode") throw new Error("Not in a Dired buffer");
}

/** Runs `fn` with the read-only buffer writable, as inhibit-read-only. */
export function writable<T>(fn: () => T): T {
  return gnista.letBind({ "inhibit-read-only": true }, fn);
}

/** Puts a mark on a line, as dired-mark's delete-char and insert: the buffer is modified even if it had the mark. */
export function setMark(line: number, char: string): void {
  const start = gnista.lineStart(line);
  writable(() => {
    const point = gnista.point();
    gnista.deleteRegion(start, start + 1);
    gnista.gotoChar(start);
    gnista.insert(char);
    gnista.gotoChar(point);
  });
}

/** Repeats over `arg` file lines from this one, as dired-repeat-over-lines, ending at a file name. */
function repeatOverLines(arg: number, fn: (line: number) => void): void {
  let line = currentLine();
  const last = gnista.lineCount() - 1;
  const atEnd = (l: number) => l >= last && gnista.lineStart(l) >= gnista.bufferSize();
  while (arg > 0 && !atEnd(line)) {
    arg--;
    while (!atEnd(line) && fileLine(line) === undefined) line++;
    if (!atEnd(line)) fn(line);
    line = Math.min(line + 1, last);
  }
  while (arg < 0 && line > 0) {
    arg++;
    line--;
    while (line > 0 && fileLine(line) === undefined) line--;
    fn(line);
  }
  gnista.gotoChar(gnista.lineStart(line));
  if (arg === 0 || gnista.lineStart(line) < gnista.bufferSize()) moveToFilename();
}

/** The lines with `marker`, from the top. */
export function markedLines(marker = MARKER): number[] {
  const lines: number[] = [];
  for (let l = 0; l < gnista.lineCount(); l++) {
    const f = fileLine(l);
    if (f && f.mark === marker) lines.push(l);
  }
  return lines;
}

/**
 * The files a command acts on, as dired-get-marked-files: those marked,
 * else the next `arg` from point if it is a number, else the one at point.
 */
export function markedFiles(
  arg: gnista.PrefixArg | null,
  marker = MARKER,
  dotsError = false,
  noFiles = "No file on this line",
): { files: string[]; lines: number[]; marked: boolean } {
  if (typeof arg === "number" || arg === "-") {
    const lines: number[] = [];
    repeatOverLines(arg === "-" ? -1 : arg, (l) => lines.push(l));
    if (arg === "-" || (typeof arg === "number" && arg < 0)) lines.reverse();
    const kept = lines.filter((l) => fileLine(l) !== undefined);
    return { files: kept.map((l) => filenameAt(l)!), lines: kept, marked: false };
  }
  if (arg === null) {
    const lines = markedLines(marker);
    if (lines.length > 0) return { files: lines.map((l) => filenameAt(l)!), lines, marked: true };
  }
  const line = currentLine();
  const file = filenameAt(line);
  if (file === undefined) throw new Error(noFiles);
  if (dotsError && isDot(gnista.fileNameNondirectory(file))) throw new Error("Cannot operate on \u2018.\u2019 or \u2018..\u2019");
  return { files: [file], lines: [line], marked: false };
}

/** How a prompt names the files: foo.txt, or * [3 files], as dired-mark-prompt. */
export function markPrompt(arg: gnista.PrefixArg | null, files: string[], marker = MARKER): string {
  if (files.length === 1) return gnista.fileNameNondirectory(files[0]);
  return typeof arg === "number" ? `[next ${arg} files]` : `${marker} [${files.length} files]`;
}

// Making the buffer.

function insertListing(dir: string): void {
  const header = `  ${gnista.directoryFileName(dir)}:`;
  const lines = listing(dir, switchesOf()).map((l) => `  ${l}`);
  gnista.insert([header, ...lines].join("\n") + "\n");
}

/** Lists the directory in the current buffer again, as dired-revert: marks and point stay with their files. */
export function readin(keepState: boolean): void {
  const dir = currentDirectory();
  const marks = new Map<string, string>();
  let pointFile: string | undefined;
  let pointLine = currentLine();
  if (keepState) {
    for (let l = 0; l < gnista.lineCount(); l++) {
      const f = fileLine(l);
      if (f && f.mark !== " ") marks.set(f.name, f.mark);
    }
    pointFile = fileLine(pointLine)?.name;
  }
  writable(() => {
    gnista.deleteRegion(0, gnista.bufferSize());
    insertListing(dir);
  });
  gnista.runHooks("dired-after-readin-hook");
  // As dired-readin, the new listing is unmodified; restoring marks
  // modifies it again, as dired-mark-remembered does.
  gnista.setBufferModified(false);
  writable(() => {
    for (let l = 0; l < gnista.lineCount(); l++) {
      const f = fileLine(l);
      const mark = f && marks.get(f.name);
      if (mark !== undefined) setMarkRaw(l, mark);
    }
  });
  if (pointFile !== undefined) {
    const found = findLine(pointFile);
    if (found !== undefined) pointLine = found;
  }
  gnista.gotoChar(gnista.lineStart(Math.min(pointLine, gnista.lineCount() - 1)));
  moveToFilename();
}

function setMarkRaw(line: number, char: string): void {
  const start = gnista.lineStart(line);
  gnista.deleteRegion(start, start + 1);
  gnista.gotoChar(start);
  gnista.insert(char);
}

export function findLine(name: string): number | undefined {
  for (let l = 0; l < gnista.lineCount(); l++) if (fileLine(l)?.name === name) return l;
  return undefined;
}

/** Puts point on the first file worth visiting, as dired-initial-position. */
function initialPosition(): void {
  const trivial = gnista.variable("dired-trivial-filenames");
  const trivialName = (name: string): boolean => typeof trivial === "string" && gnista.stringMatch(trivial, name) !== undefined;
  let line = 1;
  while (line < gnista.lineCount() && fileLine(line) === undefined && gnista.lineStart(line) < gnista.bufferSize()) line++;
  while (line < gnista.lineCount() && gnista.lineStart(line) < gnista.bufferSize() && trivialName(fileLine(line)?.name ?? "")) line++;
  gnista.gotoChar(gnista.lineStart(Math.min(line, gnista.lineCount() - 1)));
  moveToFilename();
}

/** A Dired buffer already listing `dir`, as dired-find-buffer-nocreate. */
function findDiredBuffer(dir: string): string | undefined {
  return gnista.bufferList().find((b) =>
    gnista.withCurrentBuffer(b, () => gnista.variable("major-mode") === "dired-mode" && gnista.variable("dired-directory") === dir)
  );
}

/** The buffer listing a directory, made if need be, as dired-noselect. */
function diredNoselect(input: string): string {
  const dir = gnista.fileNameAsDirectory(gnista.expandFileName(input));
  if (!gnista.fileDirectoryP(dir)) throw new Error(`${gnista.directoryFileName(gnista.expandFileName(input))}: No such file or directory`);
  const short = gnista.abbreviateFileName(dir);
  const existing = findDiredBuffer(short);
  if (existing !== undefined) {
    if (on("dired-auto-revert-buffer")) gnista.withCurrentBuffer(existing, () => readin(true));
    return existing;
  }
  const base = gnista.fileNameNondirectory(gnista.directoryFileName(dir)) || "/";
  let name = base;
  for (let n = 2; gnista.bufferList().includes(name); n++) name = `${base}<${n}>`;
  gnista.getBufferCreate(name);
  gnista.withCurrentBuffer(name, () => {
    gnista.call("dired-mode");
    gnista.makeLocalVariable("default-directory");
    gnista.setVariable("default-directory", dir);
    gnista.makeLocalVariable("dired-directory");
    gnista.setVariable("dired-directory", short);
    writable(() => insertListing(dir));
    gnista.runHooks("dired-after-readin-hook");
    gnista.setBufferModified(false);
    initialPosition();
  });
  return name;
}

function showDired(name: string, where: "same" | "other" | "frame"): void {
  if (where === "same") gnista.call("switch-to-buffer", name);
  else if (where === "other") gnista.call("switch-to-buffer-other-window", name);
  else gnista.call("switch-to-buffer-other-frame" as gnista.CommandName, name);
}

const dirParam = (prompt: string): gnista.Param => ({ name: "dirname", kind: "file", prompt });

gnista.defineCommand({
  name: "dired",
  doc:
    "List a directory, one file a line, for visiting, marking and managing its files.\n\n" +
    "RET visits a file, ^ goes up, m marks, d flags for deletion, x deletes what is flagged, " +
    "C copies, R renames, D deletes and + makes a directory. ? sums up the keys.",
  params: [dirParam("Dired (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "same"),
});
gnista.defineCommand({
  name: "dired-other-window",
  doc: "List a directory in another window, as dired does.",
  params: [dirParam("Dired in other window (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "other"),
});
gnista.defineCommand({
  name: "dired-other-frame",
  doc: "List a directory in another frame, as dired does.",
  params: [dirParam("Dired in other frame (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "frame"),
});

function jump(otherWindow: boolean): void {
  const file = gnista.bufferFileName();
  const dir = gnista.variable("major-mode") === "dired-mode"
    ? gnista.fileNameDirectory(gnista.directoryFileName(currentDirectory())) ?? "/"
    : file !== undefined
      ? gnista.fileNameDirectory(file)!
      : gnista.fileNameAsDirectory(gnista.expandFileName("."));
  const target = gnista.variable("major-mode") === "dired-mode" ? gnista.directoryFileName(currentDirectory()) : file;
  showDired(diredNoselect(dir), otherWindow ? "other" : "same");
  if (target !== undefined) {
    const line = findLine(gnista.fileNameNondirectory(target));
    if (line !== undefined) {
      gnista.gotoChar(gnista.lineStart(line));
      moveToFilename();
    }
  }
}

gnista.defineCommand({
  name: "dired-jump",
  doc: "List the directory of the current buffer's file, with point on the file. In Dired, go up a directory.",
  run: () => jump(gnista.prefixArg() !== null),
});
gnista.defineCommand({
  name: "dired-jump-other-window",
  doc: "List the directory of the current buffer's file in another window, with point on the file.",
  run: () => jump(true),
});

// Fontifying, as dired-font-lock-keywords: marks, names of directories
// and links, and the header. Details are invisible in dired-hide-details-mode.

function fontify(start: number, end: number): void {
  if (gnista.variable("major-mode") !== "dired-mode") return;
  gnista.removeTextProperty(start, end, "face");
  gnista.removeTextProperty(start, end, "invisible");
  for (let line = gnista.lineOf(start); line < gnista.lineCount() && gnista.lineStart(line) < end; line++) {
    const ls = gnista.lineStart(line);
    const le = gnista.lineEnd(line);
    const f = fileLine(line);
    if (f === undefined) {
      if (/^ {2}\S.*:$/.test(gnista.lineText(line))) gnista.putTextProperty(ls + 2, le, "face", "dired-header");
      continue;
    }
    gnista.putTextProperty(ls + 2, f.start, "invisible", "dired-hide-details-detail");
    const nameEnd = f.start + f.name.length;
    if (f.isLink && nameEnd < le) gnista.putTextProperty(nameEnd, le, "invisible", "dired-hide-details-link");
    if (f.mark === DEL_MARKER) {
      gnista.putTextProperty(ls, ls + 1, "face", "dired-flagged");
      gnista.putTextProperty(f.start, nameEnd, "face", "dired-flagged");
    } else if (f.mark !== " ") {
      gnista.putTextProperty(ls, ls + 1, "face", "dired-mark");
      gnista.putTextProperty(f.start, nameEnd, "face", "dired-marked");
    } else if (f.isDir) {
      gnista.putTextProperty(f.start, nameEnd, "face", "dired-directory");
    } else if (f.isLink) {
      gnista.putTextProperty(f.start, nameEnd, "face", "dired-symlink");
    } else if (/~$|^#.*#$/.test(f.name)) {
      gnista.putTextProperty(f.start, nameEnd, "face", "dired-ignored");
    }
  }
}

// Moving.

/** Moves down `arg` lines and to the file name there, as dired--trivial-next-line. */
function nextLine(arg: number): void {
  const column = gnista.currentColumn();
  const target = Math.max(0, Math.min(gnista.lineCount() - 1, currentLine() + arg));
  gnista.gotoChar(gnista.lineStart(target));
  gnista.moveToColumn(column);
  moveToFilename();
}

const count = (): number => gnista.prefixNumericValue(gnista.prefixArg());

gnista.defineCommand({
  name: "dired-next-line",
  doc: "Move down a line, or as many as the prefix argument says, to the file name there.",
  run: () => nextLine(count()),
});
gnista.defineCommand({
  name: "dired-previous-line",
  doc: "Move up a line, or as many as the prefix argument says, to the file name there.",
  run: () => nextLine(-count()),
});

function nextDirline(arg: number): void {
  const start = gnista.point();
  let line = currentLine();
  let left = Math.abs(arg);
  const step = arg > 0 ? 1 : -1;
  while (left > 0) {
    line += step;
    if (line < 0 || line >= gnista.lineCount()) {
      gnista.gotoChar(start);
      throw new Error("No more subdirectories");
    }
    if (fileLine(line)?.isDir) left--;
  }
  gnista.gotoChar(gnista.lineStart(line));
  moveToFilename();
}

gnista.defineCommand({
  name: "dired-next-dirline",
  doc: "Move down to the next directory's line, or as many as the prefix argument says.",
  run: () => nextDirline(count()),
});
gnista.defineCommand({
  name: "dired-prev-dirline",
  doc: "Move up to the previous directory's line, or as many as the prefix argument says.",
  run: () => nextDirline(-count()),
});

/** Moves to the `arg`th next marked line, as dired-next-marked-file: typed, it wraps around once, saying so. */
function nextMarked(arg: number, wrap: boolean): void {
  const marked: number[] = [];
  for (let l = 0; l < gnista.lineCount(); l++) {
    if (/^[^ \n]/.test(gnista.lineText(l))) marked.push(l);
  }
  const find = (from: number, back: boolean): number | undefined => {
    let line = from;
    for (let k = 0; k < Math.abs(arg); k++) {
      const next = back ? [...marked].reverse().find((l) => l < line) : marked.find((l) => l > line);
      if (next === undefined) return undefined;
      line = next;
    }
    return line;
  };
  const back = arg < 0;
  let found = find(currentLine(), back);
  if (found === undefined && wrap) {
    gnista.message("(Wraparound for next marked file)");
    found = find(back ? gnista.lineCount() : -1, back);
  }
  if (found === undefined) throw new Error("No next marked file");
  gnista.gotoChar(gnista.lineStart(found));
  moveToFilename();
}

gnista.defineCommand({
  name: "dired-next-marked-file",
  doc: "Move down to the next marked file, going round to the top if there is none below.",
  run: () => nextMarked(count(), gnista.calledInteractively()),
});
gnista.defineCommand({
  name: "dired-prev-marked-file",
  doc: "Move up to the previous marked file, going round to the bottom if there is none above.",
  run: () => nextMarked(-count(), gnista.calledInteractively()),
});

/** Goes to the line of a file in this listing, as dired-goto-file; false if it is not there. */
export function gotoFile(file: string): boolean {
  const name = gnista.fileNameNondirectory(gnista.directoryFileName(gnista.expandFileName(file)));
  const dir = gnista.fileNameDirectory(gnista.directoryFileName(gnista.expandFileName(file)));
  if (dir !== currentDirectory()) return false;
  const line = findLine(name);
  if (line === undefined) return false;
  gnista.gotoChar(gnista.lineStart(line));
  moveToFilename();
  return true;
}

gnista.defineCommand({
  name: "dired-goto-file",
  doc: "Go to the line of a file in this listing.",
  params: [{ name: "file", kind: "file", prompt: "Goto file: " }],
  run: (file: string) => {
    requireDired();
    if (gnista.calledInteractively()) {
      gnista.setMark(gnista.point());
      gnista.message("Mark set");
    }
    gotoFile(file);
  },
});

gnista.defineCommand({
  name: "dired-up-directory",
  doc: "List the directory above this one, with point on this one. With a prefix argument, in another window.",
  run: () => {
    requireDired();
    const dir = currentDirectory();
    const up = gnista.fileNameDirectory(gnista.directoryFileName(dir));
    if (up === undefined || up === dir) return;
    const name = diredNoselect(up);
    showDired(name, gnista.prefixArg() !== null ? "other" : "same");
    gotoFile(gnista.directoryFileName(dir));
  },
});

// Visiting.

/** The file to visit from this line, as dired-get-file-for-visit. */
function fileForVisit(): string {
  const file = filenameAt();
  if (file === undefined) throw new Error("No file on this line");
  if (!gnista.fileExists(file) && gnista.fileAttributes(file) === undefined) throw new Error("File no longer exists; type \u2018g\u2019 to update Dired buffer");
  return file;
}

function visit(file: string, where: "same" | "other"): void {
  const target = isDot(gnista.fileNameNondirectory(file)) ? gnista.expandFileName(file) : file;
  if (gnista.fileDirectoryP(target)) {
    const from = gnista.bufferName();
    showDired(diredNoselect(target), where);
    if (where === "same" && on("dired-kill-when-opening-new-dired-buffer") && gnista.bufferName() !== from) gnista.call("kill-buffer", from);
    return;
  }
  gnista.call(where === "same" ? "find-file" : "find-file-other-window", target);
}

gnista.defineCommand({
  name: "dired-find-file",
  doc: "Visit the file or directory on this line.",
  run: () => visit(fileForVisit(), "same"),
});
gnista.defineCommand({
  name: "dired-find-file-other-window",
  doc: "Visit the file or directory on this line in another window.",
  run: () => visit(fileForVisit(), "other"),
});
gnista.defineCommand({
  name: "dired-display-file",
  doc: "Show the file on this line in another window, staying in Dired.",
  run: () => {
    const file = fileForVisit();
    const window = gnista.selectedWindow();
    visit(file, "other");
    gnista.selectWindow(window);
  },
});
gnista.defineCommand({
  name: "dired-view-file",
  doc: "Visit the file on this line read-only, or list it if it is a directory.",
  run: () => {
    const file = fileForVisit();
    visit(file, "same");
    if (!gnista.fileDirectoryP(file)) gnista.setReadOnly(true);
  },
});
gnista.defineCommand({
  name: "dired-find-alternate-file",
  doc: "Visit the file or directory on this line in place of this Dired buffer, which is killed.",
  run: () => {
    const file = fileForVisit();
    const from = gnista.bufferName();
    visit(file, "same");
    if (gnista.bufferName() !== from) gnista.call("kill-buffer", from);
  },
});

// Marking.

/** Whether this line is a directory's header, as dired-get-subdir sees it. */
const onHeader = (line = currentLine()): boolean => fileLine(line) === undefined && /^ {2}\S.*:$/.test(gnista.lineText(line));

/**
 * Marks lines from point, as dired-mark: the region's files, or on the
 * header every file but . and .., or the next `arg`. `.` and `..` are never flagged.
 */
function mark(char: string, n = gnista.prefixNumericValue(gnista.prefixArg())): void {
  if (!(gnista.regionActive() && gnista.mark() !== undefined && gnista.mark() !== gnista.point()) && onHeader()) {
    for (let l = 0; l < gnista.lineCount(); l++) {
      const f = fileLine(l);
      if (f && !isDot(f.name)) setMark(l, char);
    }
    return;
  }
  if (gnista.regionActive() && gnista.mark() !== undefined && gnista.mark() !== gnista.point()) {
    const [a, b] = [Math.min(gnista.point(), gnista.mark()!), Math.max(gnista.point(), gnista.mark()!)];
    const point = gnista.point();
    const first = gnista.lineOf(a);
    let last = gnista.lineOf(b);
    if (gnista.lineStart(last) === b) last--;
    for (let l = first; l <= last; l++) {
      const f = fileLine(l);
      if (f && !isDot(f.name)) setMark(l, char);
    }
    gnista.gotoChar(point);
    return;
  }
  repeatOverLines(n, (l) => {
    const f = fileLine(l);
    if (f && (!isDot(f.name) || f.isLink || char !== DEL_MARKER)) setMark(l, char);
  });
}

gnista.defineCommand({
  name: "dired-mark",
  doc: "Mark the file on this line, and move down. With a prefix argument, the next that many; in the region, its files.",
  run: () => mark(MARKER),
});
gnista.defineCommand({
  name: "dired-unmark",
  doc: "Take the mark or flag off the file on this line, and move down.",
  run: () => mark(" "),
});
gnista.defineCommand({
  name: "dired-flag-file-deletion",
  doc: "Flag the file on this line for deletion, which x does, and move down.",
  run: () => mark(DEL_MARKER),
});
gnista.defineCommand({
  name: "dired-unmark-backward",
  doc: "Move up a line and take the mark or flag off the file there.",
  // As dired-unmark with a negative count, so on the header line it unmarks every file.
  run: () => mark(" ", -count()),
});

gnista.defineCommand({
  name: "dired-toggle-marks",
  doc: "Mark the files that are not marked and unmark those that are. Flags for deletion stay, and . and .. are left alone.",
  run: () => {
    requireDired();
    for (let l = 0; l < gnista.lineCount(); l++) {
      const f = fileLine(l);
      if (!f || isDot(f.name)) continue;
      if (f.mark === " ") setMark(l, MARKER);
      else if (f.mark === MARKER) setMark(l, " ");
    }
  },
});

function unmarkAll(which: string | undefined): void {
  let n = 0;
  for (let l = 0; l < gnista.lineCount(); l++) {
    const f = fileLine(l);
    if (f && f.mark !== " " && (which === undefined || f.mark === which)) {
      setMark(l, " ");
      n++;
    }
  }
  gnista.message(n === 1 ? "1 mark removed" : `${n} marks removed`);
}

gnista.defineCommand({
  name: "dired-unmark-all-marks",
  doc: "Take every mark and flag off.",
  run: () => unmarkAll(undefined),
});
gnista.defineCommand({
  name: "dired-unmark-all-files",
  doc: "Take a mark off every file that has it: the mark character typed, or every mark for RET.",
  params: [{ name: "mark", prompt: "Remove marks (RET means all): " }],
  run: (char: string) => unmarkAll(char === "" ? undefined : char[0]),
});

/** Marks the files a test picks, as dired-mark-if, saying how many. */
export function markIf(test: (f: FileLine) => boolean, what: string, char = MARKER): void {
  const doing = char === " " ? "Unmarking" : char === DEL_MARKER ? "Flagging" : "Marking";
  gnista.message(`${doing} ${what}s${char === DEL_MARKER ? " for deletion" : ""}...`);
  let n = 0;
  for (let l = 0; l < gnista.lineCount(); l++) {
    const f = fileLine(l);
    if (f && test(f) && f.mark !== char) {
      setMark(l, char);
      n++;
    }
  }
  const verb = char === " " ? "un" : "";
  gnista.message(`${n} ${what}${n === 1 ? "" : "s"} ${verb}${char === DEL_MARKER ? "flagged" : "marked"}`);
}

export const regexpParam = (prompt: string): gnista.Param => ({ name: "regexp", prompt, history: "dired-regexp-history" });

gnista.defineCommand({
  name: "dired-mark-files-regexp",
  doc: "Mark the files whose names match a regular expression. With a prefix argument, unmark them.",
  params: [regexpParam("Mark files (regexp): ")],
  run: (regexp: string) => {
    markIf((f) => !isDot(f.name) && gnista.stringMatch(regexp, f.name) !== undefined, "matching file", gnista.prefixArg() !== null ? " " : MARKER);
  },
});
gnista.defineCommand({
  name: "dired-flag-files-regexp",
  doc: "Flag for deletion the files whose names match a regular expression.",
  params: [regexpParam("Flag for deletion (regexp): ")],
  run: (regexp: string) => {
    markIf((f) => !isDot(f.name) && gnista.stringMatch(regexp, f.name) !== undefined, "matching file", DEL_MARKER);
  },
});
gnista.defineCommand({
  name: "dired-mark-directories",
  doc: "Mark the directories, but not . and ... With a prefix argument, unmark them.",
  run: () => markIf((f) => f.isDir && !isDot(f.name), "directory file", gnista.prefixArg() !== null ? " " : MARKER),
});
gnista.defineCommand({
  name: "dired-mark-symlinks",
  doc: "Mark the symbolic links. With a prefix argument, unmark them.",
  run: () => markIf((f) => f.isLink, "symbolic link", gnista.prefixArg() !== null ? " " : MARKER),
});
gnista.defineCommand({
  name: "dired-mark-executables",
  doc: "Mark the files anyone can run. With a prefix argument, unmark them.",
  run: () => {
    markIf((f) => {
      const a = gnista.fileAttributes(currentDirectory() + f.name);
      return a !== undefined && a.type === "file" && /x/.test(a.modes);
    }, "executable file", gnista.prefixArg() !== null ? " " : MARKER);
  },
});
gnista.defineCommand({
  name: "dired-flag-backup-files",
  doc: "Flag for deletion the backup files, whose names end in ~. With a prefix argument, unflag them.",
  run: () => markIf((f) => f.name.endsWith("~"), "backup file", gnista.prefixArg() !== null ? " " : DEL_MARKER),
});
gnista.defineCommand({
  name: "dired-flag-auto-save-files",
  doc: "Flag for deletion the auto-save files, named #like-this#. With a prefix argument, unflag them.",
  run: () => markIf((f) => /^#.*#$/.test(f.name), "auto save file", gnista.prefixArg() !== null ? " " : DEL_MARKER),
});
gnista.defineCommand({
  name: "dired-change-marks",
  doc: "Change one mark to another on every file that has it.",
  params: [{ name: "old", prompt: "Change (old mark): " }, { name: "new", prompt: (old) => `Change ${old} marks to (new mark): ` }],
  run: (old: string, next: string) => {
    for (let l = 0; l < gnista.lineCount(); l++) if (fileLine(l)?.mark === old[0]) setMark(l, next[0] ?? " ");
  },
});
gnista.defineCommand({
  name: "dired-number-of-marked-files",
  doc: "Say how many files are marked, and their size.",
  run: () => {
    const files = markedLines(MARKER).map((l) => filenameAt(l)!);
    if (files.length === 0) {
      gnista.message("No marked files");
      return;
    }
    const size = files.reduce((sum, f) => sum + (gnista.fileAttributes(f)?.size ?? 0), 0);
    gnista.message(`${files.length} marked file${files.length === 1 ? "" : "s"} (${humanSize(size)})`);
  },
});

// Acting on files.

/** Takes a file's line out of every Dired buffer listing its directory, as dired-remove-file. */
export function removeEntry(file: string): void {
  const dir = gnista.fileNameDirectory(file);
  const name = gnista.fileNameNondirectory(file);
  for (const b of gnista.bufferList()) {
    gnista.withCurrentBuffer(b, () => {
      if (gnista.variable("major-mode") !== "dired-mode" || currentDirectory() !== dir) return;
      const line = findLine(name);
      if (line === undefined) return;
      writable(() => gnista.deleteRegion(gnista.lineStart(line), Math.min(gnista.lineStart(line + 1), gnista.bufferSize())));
    });
  }
}

/** Adds a line for a new file at point, if this buffer lists its directory, as dired-add-entry. */
export function addEntry(file: string, marker?: string): void {
  const dir = gnista.fileNameDirectory(gnista.directoryFileName(file));
  const name = gnista.fileNameNondirectory(gnista.directoryFileName(file));
  if (dir !== currentDirectory()) return;
  const [line] = listing(dir, switchesOf(), [name]);
  if (line === undefined) return;
  writable(() => {
    const at = gnista.lineStart(Math.max(currentLine(), 1));
    gnista.gotoChar(at);
    gnista.insert(`${marker ?? " "} ${line}\n`);
    gnista.gotoChar(at);
  });
  moveToFilename();
}

/** Deletes files, asking first, as dired-internal-do-deletions: directories with files in them ask again. */
function doDeletions(files: string[], arg: gnista.PrefixArg | null, marker: string): void {
  const trashing = on("delete-by-moving-to-trash");
  if (!gnista.yesOrNoP(`${trashing ? "Trash" : "Delete"} ${markPrompt(arg, files, marker)} `)) {
    gnista.message("(No deletions performed)");
    return;
  }
  // Point stays with its line, or goes to the next if that line goes, as
  // Emacs's save-excursion keeps it.
  const pointLine = currentLine();
  const pointName = fileLine(pointLine)?.name;
  const linesBefore = files.filter((f) => {
    const l = findLine(gnista.fileNameNondirectory(f));
    return l !== undefined && l < pointLine;
  });
  const failures: string[] = [];
  let recursive = gnista.variable("dired-recursive-deletes");
  for (const file of files) {
    // As dired-delete-file: a directory with files in it is deleted with
    // them only as dired-recursive-deletes, or the answer, says.
    let rec = false;
    const full = gnista.fileAttributes(file)?.type === "directory" && gnista.directoryFiles(file).length > 2;
    if (full && recursive === "always") rec = true;
    else if (full && recursive !== null && recursive !== false) {
      const answer = gnista.readAnswer(`Recursively ${trashing ? "trash" : "delete"} ${gnista.fileNameNondirectory(file)}? `, ["yes", "no", "all", "quit"]);
      if (answer === "quit") throw new Error("Quit");
      if (answer === "all") recursive = "always";
      rec = answer !== "no";
    }
    try {
      if (gnista.fileAttributes(file)?.type === "directory") gnista.deleteDirectory(file, { recursive: rec, trash: true });
      else gnista.deleteFile(file, { trash: true });
      removeEntry(file);
    } catch {
      failures.push(file);
    }
  }
  if (failures.length > 0) {
    gnista.message(`${failures.length} of ${files.length} deletion${files.length === 1 ? "" : "s"} failed`);
  } else {
    gnista.message(`${trashing ? "Trashing" : "Deleting"}...done`);
  }
  const kept = pointName === undefined ? undefined : findLine(pointName);
  const gone = linesBefore.filter((f) => !failures.includes(f)).length;
  const line = kept ?? Math.max(0, pointLine - gone);
  gnista.gotoChar(gnista.lineStart(Math.min(line, gnista.lineCount() - 1)));
  moveToFilename();
}

gnista.defineCommand({
  name: "dired-do-flagged-delete",
  doc: "Delete the files flagged with d, after asking. Deleting goes to the trash, as delete-by-moving-to-trash says.",
  run: () => {
    requireDired();
    const lines = markedLines(DEL_MARKER);
    if (lines.length === 0) {
      gnista.message("(No deletions requested)");
      return;
    }
    doDeletions(lines.map((l) => filenameAt(l)!), null, DEL_MARKER);
  },
});
gnista.defineCommand({
  name: "dired-do-delete",
  doc: "Delete the marked files, or the one on this line, after asking. With a prefix argument, the next that many.",
  run: () => {
    requireDired();
    const arg = gnista.prefixArg();
    const { files, lines } = markedFiles(arg, MARKER, true);
    if (files.some((f) => isDot(gnista.fileNameNondirectory(f)))) throw new Error("Cannot operate on \u2018.\u2019 or \u2018..\u2019");
    doDeletions(files, arg, MARKER);
  },
});

/** Where a copy or rename suggests going, as dired-dwim-target-directory. */
export function dwimTarget(): string {
  if (on("dired-dwim-target")) {
    const here = gnista.selectedWindow();
    for (const w of gnista.windowList()) {
      if (w === here) continue;
      const b = gnista.windowBuffer(w);
      const dir = b && gnista.withCurrentBuffer(b, () => gnista.variable("major-mode") === "dired-mode" ? currentDirectory() : undefined);
      if (dir) return dir;
    }
  }
  return currentDirectory();
}

export type Creator = (from: string, to: string) => void;

/**
 * A question asked of each file in turn, as dired-query: y or SPC says yes
 * and n or DEL no to this one, ! yes and q or ESC no to the rest without
 * asking again.
 */
export function makeQuery(): (prompt: string) => boolean {
  let answer = "";
  return (prompt) => {
    if (answer === "!") return true;
    if (answer === "q" || answer === "\x1b") return false;
    answer = gnista.readCharChoice(`${prompt} [Type yn!q or C-h] `, "y n\x7f!q\x1b");
    return answer === "y" || answer === " " || answer === "!";
  };
}

/** States how a command over several files went, as dired-log-summary: one failure shows what was logged for it. */
function logSummary(summary: string, files: string[], logged: string): void {
  if (files.length === 1) gnista.message(logged);
  else gnista.message(`${summary}--type ? for details (${files.map((f) => gnista.fileNameNondirectory(f)).join(" ")})`);
}

/**
 * Makes a new file from each of `files`, as dired-create-files: `nameOf`
 * gives each one's new name, or undefined to skip it; a file already there
 * is overwritten only if you say so; and the new files are listed, marked
 * as `marker` says.
 */
export function createFiles(
  operation: string,
  files: string[],
  nameOf: (from: string) => string | undefined,
  creator: Creator,
  marker: (from: string) => string | undefined,
): void {
  let done = 0;
  const failures: string[] = [];
  const skipped: string[] = [];
  // The last failure, as dired-log writes it.
  let logged = "";
  const overwriteQuery = makeQuery();
  for (const from of files) {
    gotoFile(from);
    let dest = nameOf(from);
    if (dest === from) {
      logged = `Cannot ${operation.toLowerCase()} to same file: ${from}\n`;
      dest = undefined;
    }
    if (dest === undefined) {
      skipped.push(from);
      continue;
    }
    // As dired-create-files, before trying: a directory cannot be copied into itself.
    const destDir = gnista.fileNameDirectory(dest) ?? "/";
    if (operation === "Copy" && gnista.fileDirectoryP(from)) {
      const real = gnista.fileNameAsDirectory(gnista.expandFileName(from));
      if (gnista.fileNameAsDirectory(gnista.expandFileName(destDir)).startsWith(real)) {
        throw new Error(`Cannot copy \u2018${from}\u2019 into its subdirectory \u2018${dest}\u2019`);
      }
    }
    const overwrite = gnista.fileExists(dest);
    if (overwrite && !overwriteQuery(`Overwrite \u2018${dest}\u2019?`)) {
      failures.push(from);
      logged = `${operation}: \u2018${from}\u2019 to \u2018${dest}\u2019 failed:\n(file-already-exists File already exists ${dest})\n`;
      continue;
    }
    // As dired-create-files, a file error is a failure to log; anything
    // else, as quitting a question the creator asks, goes on up.
    try {
      const mk = marker(from);
      creator(from, dest);
      if (overwrite) removeEntry(dest);
      done++;
      gnista.message(`${operation}: ${done} of ${files.length}`);
      addEntry(dest, mk);
    } catch (e) {
      if (!gnista.errorConditions(e).includes("file-error")) throw e;
      failures.push(from);
      const err = e as Partial<gnista.SignalledError>;
      const printed = err.symbol ? `(${[err.symbol, ...(err.data ?? []).map(String)].join(" ")})` : String(err.message ?? e);
      logged = `${operation}: \u2018${from}\u2019 to \u2018${dest}\u2019 failed:\n${printed}\n`;
    }
  }
  const total = files.length;
  if (failures.length > 0) logSummary(`${operation}: ${failures.length} of ${total} file${total === 1 ? "" : "s"} failed`, failures, logged);
  else if (skipped.length > 0) logSummary(`${operation}: ${skipped.length} of ${total} file${total === 1 ? "" : "s"} skipped`, skipped, logged);
  else gnista.message(`${operation}: ${done} file${done === 1 ? "" : "s"} done`);
  moveToFilename();
}

/**
 * Makes a new file from each marked file, as dired-do-create-files: asking
 * where, a new name for one file or a directory to put several in. Links
 * are made from the name asked for, so their prompts say from, not to.
 */
export function doCreateFiles(operation: string, op1: string, creator: Creator, marker: (from: string) => string | undefined, link = false): void {
  requireDired();
  const arg = gnista.prefixArg();
  const { files } = markedFiles(arg, MARKER, false, "No files specified");
  const one = files.length === 1;
  const targetDir = dwimTarget();
  const prompt = `${one ? op1 : operation} ${markPrompt(arg, files)} ${link ? "from" : "to"}: `;
  const dflt = one && !on("dired-dwim-target") ? targetDir + gnista.fileNameNondirectory(files[0]) : undefined;
  const target = gnista.expandFileName(gnista.readFileName(prompt, { dir: targetDir, default: dflt }));
  // A rename that only changes the case of one name, on a file system that
  // ignores case, is a rename, not a move into the directory it names.
  const caseOnly = one && operation === "Move" && files[0].toLowerCase() === target.toLowerCase() &&
    gnista.fileNameNondirectory(files[0]) !== gnista.fileNameNondirectory(target);
  const intoDir = !caseOnly && gnista.fileDirectoryP(target);
  if (!one && !intoDir) throw new Error(`Marked ${operation}: target must be a directory: ${target}`);
  createFiles(
    operation,
    files,
    (from) => intoDir ? gnista.fileNameAsDirectory(target) + gnista.fileNameNondirectory(from) : gnista.directoryFileName(target),
    creator,
    marker,
  );
}

export const markOf = (file: string): string => {
  const line = findLine(gnista.fileNameNondirectory(file));
  return line === undefined ? " " : fileLine(line)!.mark;
};

gnista.defineCommand({
  name: "dired-do-copy",
  doc:
    "Copy the marked files, or the one on this line, asking where to: a new name for one, a directory for several.\n\n" +
    "Copies are marked C, as dired-keep-marker-copy says, and keep their modification times.",
  run: () => {
    const keep = gnista.variable("dired-keep-marker-copy");
    // As dired-copy-file-recursive: a directory is copied with what it
    // holds if dired-recursive-copies is always, or you say so; otherwise
    // copy-file refuses it.
    const recursive = gnista.variable("dired-recursive-copies");
    doCreateFiles(
      "Copy",
      "Copy",
      (from, to) => {
        const directory = gnista.fileAttributes(from)?.type === "directory";
        if (directory && on("dired-recursive-copies") && (recursive === "always" || gnista.yesOrNoP(`Copy ${from} recursively? `))) {
          gnista.copyDirectory(from, to, { keepTime: on("dired-copy-preserve-time") });
        } else {
          gnista.copyFile(from, to, { okIfExists: true, keepTime: on("dired-copy-preserve-time") });
        }
      },
      (from) => typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined,
    );
  },
});

gnista.defineCommand({
  name: "dired-do-rename",
  doc:
    "Rename the marked files, or the one on this line, asking to what: a new name for one, a directory for several, " +
    "to move them there. Buffers visiting them follow.",
  run: () => {
    const { files } = markedFiles(gnista.prefixArg(), MARKER, false, "No files specified");
    if (files.some((f) => isDot(gnista.fileNameNondirectory(f)))) throw new Error(`Can\u2019t rename "." or ".." files`);
    const keep = gnista.variable("dired-keep-marker-rename");
    doCreateFiles("Move", "Rename", (from, to) => {
      gnista.renameFile(from, to, { okIfExists: true });
      for (const b of gnista.bufferList()) {
        gnista.withCurrentBuffer(b, () => {
          if (gnista.bufferFileName() === from) gnista.setVisitedFileName(to, { alongWithFile: true });
        });
      }
      removeEntry(from);
    }, (from) => typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined);
  },
});

gnista.defineCommand({
  name: "dired-create-directory",
  doc: "Make a directory, with any missing above it, and list it here.",
  params: [{ name: "directory", kind: "file", prompt: "Create directory: " }],
  run: (input: string) => {
    requireDired();
    const dir = gnista.directoryFileName(gnista.expandFileName(input));
    if (gnista.fileExists(dir)) throw new Error(`Cannot create directory ${dir}: file exists`);
    // The topmost directory that is new is the one this listing may show.
    let top = dir;
    for (let up = gnista.fileNameDirectory(top); up !== undefined && !gnista.fileExists(up); up = gnista.fileNameDirectory(gnista.directoryFileName(up))) {
      top = gnista.directoryFileName(up);
    }
    gnista.makeDirectory(dir, { parents: true });
    addEntry(top);
  },
});

gnista.defineCommand({
  name: "dired-create-empty-file",
  doc: "Make an empty file, with any missing directories above it, and list it here.",
  params: [{ name: "file", kind: "file", prompt: "Create empty file: " }],
  run: (input: string) => {
    requireDired();
    const file = gnista.expandFileName(input);
    if (gnista.fileExists(file)) throw new Error(`Cannot create file ${file}: file exists`);
    const dir = gnista.fileNameDirectory(file);
    if (dir !== undefined) gnista.makeDirectory(dir, { parents: true });
    gnista.writeTextFile(file, "");
    addEntry(file);
  },
});

gnista.defineCommand({
  name: "dired-do-kill-lines",
  doc:
    "Take the marked files' lines out of the listing; with a prefix argument, the next that many lines instead. " +
    "The files stay; g brings the lines back.",
  run: () => {
    requireDired();
    const arg = gnista.prefixArg();
    if (arg !== null) {
      // As dired-kill-line: from this line on, or back with a negative count.
      let n = gnista.prefixNumericValue(arg);
      writable(() => {
        while (n !== 0) {
          const line = currentLine();
          if (fileLine(line) === undefined) throw new Error("Can only kill file lines");
          gnista.deleteRegion(gnista.lineStart(line), Math.min(gnista.lineStart(line + 1), gnista.bufferSize()));
          if (n > 0) n--;
          else {
            n++;
            gnista.gotoChar(gnista.lineStart(Math.max(0, currentLine() - 1)));
          }
        }
      });
      moveToFilename();
      return;
    }
    const point = gnista.point();
    const lines = markedLines(MARKER);
    let shift = 0;
    writable(() => {
      for (const l of [...lines].sort((a, b) => b - a)) {
        const start = gnista.lineStart(l);
        const end = Math.min(gnista.lineStart(l + 1), gnista.bufferSize());
        if (start < point) shift += Math.min(end, point) - start;
        gnista.deleteRegion(start, end);
      }
    });
    gnista.gotoChar(point - shift);
    gnista.message(`Killed ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
  },
});

gnista.defineCommand({
  name: "dired-copy-filename-as-kill",
  doc:
    "Put the names of the marked files, or this line's, in the kill ring, separated by spaces.\n\n" +
    "With a zero prefix argument, their whole names; with C-u, relative to this directory.",
  run: () => {
    requireDired();
    // On the header, the directory's whole name, as dired-get-subdir gives it.
    if (onHeader()) {
      const dir = currentDirectory();
      gnista.killNew(dir);
      gnista.message(dir);
      return;
    }
    const arg = gnista.prefixArg();
    const absolute = arg !== null && gnista.prefixNumericValue(arg) === 0;
    // With no file here and none marked, there is nothing to copy, as Emacs says nothing.
    if (filenameAt() === undefined && markedLines(MARKER).length === 0) return;
    const { files } = markedFiles(arg === null || absolute || Array.isArray(arg) ? null : arg);
    const names = files.map((f) => (absolute ? f : gnista.fileNameNondirectory(f)));
    const text = names.length === 1 ? names[0] : names.map((n) => (/[ "']/.test(n) ? JSON.stringify(n) : n)).join(" ");
    if (text === "") return;
    gnista.killNew(text);
    gnista.message(text);
  },
});

gnista.defineCommand({
  name: "dired-revert",
  doc: "List the directory again, keeping the marks and point on the same file.",
  run: () => {
    requireDired();
    readin(true);
  },
});

gnista.defineCommand({
  name: "dired-do-redisplay",
  doc: "List the directory again, as g does.",
  run: () => gnista.call("dired-revert"),
});

gnista.defineCommand({
  name: "dired-sort-toggle-or-edit",
  doc: "Sort the listing by date if it is sorted by name, else by name. With a prefix argument, type the switches.",
  run: () => {
    requireDired();
    const switches = switchesOf();
    const byDate = /^-\S*t|\s-\S*t/.test(switches);
    const toggled = byDate ? switches.replace(/(-\S*?)t/, "$1").replace(/ -(?=\s|$)/, "") : `${switches}t`;
    gnista.makeLocalVariable("dired-actual-switches");
    gnista.setVariable("dired-actual-switches", toggled);
    gnista.setVariable("mode-name", byDate ? "Dired by name" : "Dired by date");
    readin(true);
  },
});

gnista.defineMinorMode({
  name: "dired-hide-details-mode",
  lighter: "",
  doc: "Show only the files' names in Dired, hiding their sizes, dates and the rest.",
  onChange: (enabled) => {
    for (const spec of ["dired-hide-details-detail", "dired-hide-details-link"]) {
      if (enabled) gnista.addToInvisibilitySpec(spec);
      else gnista.removeFromInvisibilitySpec(spec);
    }
  },
});

gnista.defineCommand({
  name: "dired-summary",
  doc: "Sum up Dired's most used keys in the echo area.",
  run: () => gnista.message("d-elete, u-ndelete, x-punge, f-ind, o-ther window, R-ename, C-opy, h-elp"),
});

gnista.defineCommand({
  name: "dired-undo",
  doc: "Undo marks and flags, as far as the buffer remembers them. Changes to files stay.",
  run: () => writable(() => gnista.call("undo")),
});

// The mode.

gnista.defineMajorMode({
  name: "dired-mode",
  modeName: "Dired by name",
  doc:
    "List a directory's files, one a line, for visiting and managing them.\n\n" +
    "RET or f visits the file on a line and o visits it in another window; ^ goes up a directory. " +
    "m marks a file, u unmarks it, t toggles marks and U takes them all off; d flags a file for deletion and x " +
    "deletes what is flagged. C copies, R renames or moves and D deletes the marked files, or the one on the line. " +
    "+ makes a directory, g lists the directory again, s sorts by date or name, and ( hides the details.",
  bindings: {
    RET: "dired-find-file", f: "dired-find-file", e: "dired-find-file", o: "dired-find-file-other-window",
    "C-o": "dired-display-file", v: "dired-view-file", a: "dired-find-alternate-file",
    n: "dired-next-line", p: "dired-previous-line", SPC: "dired-next-line", "S-SPC": "dired-previous-line",
    "C-n": "dired-next-line", "C-p": "dired-previous-line", "<down>": "dired-next-line", "<up>": "dired-previous-line",
    ">": "dired-next-dirline", "<": "dired-prev-dirline", "^": "dired-up-directory", j: "dired-goto-file",
    "M-}": "dired-next-marked-file", "M-{": "dired-prev-marked-file", "* C-n": "dired-next-marked-file", "* C-p": "dired-prev-marked-file",
    m: "dired-mark", "* m": "dired-mark", u: "dired-unmark", "* u": "dired-unmark", d: "dired-flag-file-deletion",
    DEL: "dired-unmark-backward", "* DEL": "dired-unmark-backward", t: "dired-toggle-marks", "* t": "dired-toggle-marks",
    U: "dired-unmark-all-marks", "* !": "dired-unmark-all-marks", "* ?": "dired-unmark-all-files", "M-DEL": "dired-unmark-all-files",
    "% m": "dired-mark-files-regexp", "* %": "dired-mark-files-regexp", "% d": "dired-flag-files-regexp",
    "* /": "dired-mark-directories", "* @": "dired-mark-symlinks", "* *": "dired-mark-executables",
    "~": "dired-flag-backup-files", "#": "dired-flag-auto-save-files", "* c": "dired-change-marks", "* N": "dired-number-of-marked-files",
    x: "dired-do-flagged-delete", D: "dired-do-delete", C: "dired-do-copy", R: "dired-do-rename",
    "+": "dired-create-directory", k: "dired-do-kill-lines", w: "dired-copy-filename-as-kill",
    g: "revert-buffer", l: "dired-do-redisplay", s: "dired-sort-toggle-or-edit", "(": "dired-hide-details-mode",
    "?": "dired-summary", q: "quit-window", "C-/": "dired-undo", "C-_": "dired-undo", "C-x u": "dired-undo",
  },
  setup: () => {
    gnista.setReadOnly(true);
    gnista.makeLocalVariable("revert-buffer-function");
    gnista.setVariable("revert-buffer-function", "dired-revert");
    gnista.addHook("jit-lock-functions", fontify, { local: true });
  },
});

gnista.bindKey("C-x d", "dired");
gnista.bindKey("C-x 4 d", "dired-other-window");
gnista.bindKey("C-x 5 d", "dired-other-frame");
gnista.bindKey("C-x C-j", "dired-jump");
gnista.bindKey("C-x 4 C-j", "dired-jump-other-window");
