// Dired, after Emacs's dired.el and dired-aux.el, with the listing drawn as
// Emacs's ls-lisp.el draws it. C-x d lists a directory, one file a line;
// RET visits the file on a line, ^ goes up, and m, d, u and t mark files for
// the commands that act on them: C copies, R renames or moves, D deletes, x
// deletes the files flagged with d, and + makes a directory. g lists the
// directory again, keeping the marks. Deleting goes to the trash, as
// delete-by-moving-to-trash says.

// Faces.

ember.defineFace({ name: "dired-header", doc: "The directory's name at the top of a listing.", attributes: { inherit: "font-lock-type-face" } });
ember.defineFace({ name: "dired-directory", doc: "The names of directories in a listing.", attributes: { inherit: "font-lock-function-name-face" } });
ember.defineFace({ name: "dired-symlink", doc: "The names of symbolic links in a listing.", attributes: { inherit: "font-lock-keyword-face" } });
ember.defineFace({ name: "dired-mark", doc: "The mark at the start of a marked line.", attributes: { inherit: "font-lock-constant-face" } });
ember.defineFace({ name: "dired-marked", doc: "The names of marked files.", attributes: { inherit: "warning" } });
ember.defineFace({ name: "dired-flagged", doc: "The names of files flagged for deletion.", attributes: { inherit: "error" } });
ember.defineFace({ name: "dired-ignored", doc: "Files of little interest, such as backups.", attributes: { inherit: "shadow" } });

// Variables.

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("dired-listing-switches", "-al", "How Dired lists a directory, as ls's switches: a lists dot files, A all but . and .., t sorts by time, S by size, r reverses, and h writes sizes as 1.2k.");
defvar("dired-recursive-deletes", "top", "Whether deleting a directory with files in it asks: top asks once for each, always never asks, and nil refuses.");
defvar("dired-recursive-copies", "top", "Whether copying a directory copies what it holds: top or always do, and nil refuses.");
defvar("dired-dwim-target", false, "Whether copying and renaming suggest the directory of a Dired buffer in another window.");
defvar("dired-keep-marker-copy", "C", "The mark copies get, or true for the mark the file had, or nil for none.");
defvar("dired-keep-marker-rename", true, "Whether renamed files keep their marks, or a mark they get instead.");
defvar("dired-copy-preserve-time", true, "Whether a copy keeps the modification time of what it copies.");
defvar("dired-trivial-filenames", "^\\.\\.?$|^\\.?#", "Names Dired passes over when it puts point on the first file, as a regular expression: . and .., and auto-save and lock files.");
defvar("dired-kill-when-opening-new-dired-buffer", false, "Whether visiting a directory from Dired kills the Dired buffer it came from.");
defvar("dired-auto-revert-buffer", false, "Whether going back to a Dired buffer lists its directory again.");
defvar("dired-directory", null, "The directory a Dired buffer lists.");
defvar("dired-actual-switches", null, "The switches this Dired buffer lists with, which s changes.");

const MARKER = "*";
const DEL_MARKER = "D";

const on = (name: string): boolean => {
  const v = ember.variable(name);
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

function switchesOf(): string {
  const own = ember.variable("dired-actual-switches");
  if (typeof own === "string") return own;
  return String(ember.variable("dired-listing-switches") ?? "-al");
}

/** The lines listing a directory, as ls-lisp-insert-directory makes them for ls -l with these switches. */
function listing(dir: string, switches: string, only?: string[]): string[] {
  const flags = new Set(switches.replace(/--\S+/g, "").replace(/[\s-]/g, ""));
  let names = only ?? ember.directoryFiles(dir);
  if (only === undefined) {
    if (flags.has("A")) names = names.filter((n) => n !== "." && n !== "..");
    else if (!flags.has("a")) names = names.filter((n) => !n.startsWith("."));
  }
  const entries = names
    .map((name) => ({ name, attrs: ember.fileAttributes(dir + name) }))
    .filter((e): e is { name: string; attrs: ember.FileAttributes } => e.attrs !== undefined);
  if (flags.has("t")) entries.sort((a, b) => b.attrs.modified - a.attrs.modified);
  else if (flags.has("S")) entries.sort((a, b) => b.attrs.size - a.attrs.size);
  if (flags.has("r")) entries.reverse();
  const human = flags.has("h");
  const sizeOf = (e: { attrs: ember.FileAttributes }) => (human ? humanSize(e.attrs.size) : String(e.attrs.size));
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

interface FileLine {
  mark: string;
  /** Where the name starts, in the buffer. */
  start: number;
  name: string;
  isDir: boolean;
  isLink: boolean;
}

function fileLine(line: number): FileLine | undefined {
  if (line < 0 || line >= ember.lineCount()) return undefined;
  const text = ember.lineText(line);
  const m = LINE.exec(text);
  if (!m) return undefined;
  const isLink = m[2].startsWith("l");
  const shown = m[3];
  const arrow = isLink ? shown.indexOf(" -> ") : -1;
  return {
    mark: m[1],
    start: ember.lineStart(line) + text.length - shown.length,
    name: arrow >= 0 ? shown.slice(0, arrow) : shown,
    isDir: m[2].startsWith("d"),
    isLink,
  };
}

const currentLine = (): number => ember.lineOf(ember.point());

/** Moves to the start of the file name on this line, as dired-move-to-filename: else to the line's start. */
function moveToFilename(): number | undefined {
  const line = currentLine();
  const f = fileLine(line);
  ember.gotoChar(f ? f.start : ember.lineStart(line));
  return f?.start;
}

/** The directory this buffer lists, ending in a slash. */
function currentDirectory(): string {
  const dir = ember.variable("dired-directory");
  if (typeof dir !== "string") throw new Error("Not in a Dired buffer");
  return ember.fileNameAsDirectory(ember.expandFileName(dir));
}

const isDot = (name: string): boolean => name === "." || name === "..";

/** The absolute name of the file on this line, as dired-get-filename, or undefined on a line with none. */
function filenameAt(line = currentLine()): string | undefined {
  const f = fileLine(line);
  return f === undefined ? undefined : currentDirectory() + f.name;
}

function requireDired(): void {
  if (ember.variable("major-mode") !== "dired-mode") throw new Error("Not in a Dired buffer");
}

/** Runs `fn` with the read-only buffer writable, as inhibit-read-only. */
function writable<T>(fn: () => T): T {
  const was = ember.bufferReadOnly();
  ember.setReadOnly(false);
  try {
    return fn();
  } finally {
    ember.setReadOnly(was);
  }
}

/** Puts a mark on a line, as dired-mark's delete-char and insert: the buffer is modified even if it had the mark. */
function setMark(line: number, char: string): void {
  const start = ember.lineStart(line);
  writable(() => {
    const point = ember.point();
    ember.deleteRegion(start, start + 1);
    ember.gotoChar(start);
    ember.insert(char);
    ember.gotoChar(point);
  });
}

/** Repeats over `arg` file lines from this one, as dired-repeat-over-lines, ending at a file name. */
function repeatOverLines(arg: number, fn: (line: number) => void): void {
  let line = currentLine();
  const last = ember.lineCount() - 1;
  const atEnd = (l: number) => l >= last && ember.lineStart(l) >= ember.bufferSize();
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
  ember.gotoChar(ember.lineStart(line));
  if (arg === 0 || ember.lineStart(line) < ember.bufferSize()) moveToFilename();
}

/** The lines with `marker`, from the top. */
function markedLines(marker = MARKER): number[] {
  const lines: number[] = [];
  for (let l = 0; l < ember.lineCount(); l++) {
    const f = fileLine(l);
    if (f && f.mark === marker) lines.push(l);
  }
  return lines;
}

/**
 * The files a command acts on, as dired-get-marked-files: those marked,
 * else the next `arg` from point if it is a number, else the one at point.
 */
function markedFiles(
  arg: ember.PrefixArg | null,
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
  if (dotsError && isDot(ember.fileNameNondirectory(file))) throw new Error("Cannot operate on \u2018.\u2019 or \u2018..\u2019");
  return { files: [file], lines: [line], marked: false };
}

/** How a prompt names the files: foo.txt, or * [3 files], as dired-mark-prompt. */
function markPrompt(arg: ember.PrefixArg | null, files: string[], marker = MARKER): string {
  if (files.length === 1) return ember.fileNameNondirectory(files[0]);
  return typeof arg === "number" ? `[next ${arg} files]` : `${marker} [${files.length} files]`;
}

// Making the buffer.

function insertListing(dir: string): void {
  const header = `  ${ember.directoryFileName(dir)}:`;
  const lines = listing(dir, switchesOf()).map((l) => `  ${l}`);
  ember.insert([header, ...lines].join("\n") + "\n");
}

/** Lists the directory in the current buffer again, as dired-revert: marks and point stay with their files. */
function readin(keepState: boolean): void {
  const dir = currentDirectory();
  const marks = new Map<string, string>();
  let pointFile: string | undefined;
  let pointLine = currentLine();
  if (keepState) {
    for (let l = 0; l < ember.lineCount(); l++) {
      const f = fileLine(l);
      if (f && f.mark !== " ") marks.set(f.name, f.mark);
    }
    pointFile = fileLine(pointLine)?.name;
  }
  writable(() => {
    ember.deleteRegion(0, ember.bufferSize());
    insertListing(dir);
  });
  // As dired-readin, the new listing is unmodified; restoring marks
  // modifies it again, as dired-mark-remembered does.
  ember.setBufferModified(false);
  writable(() => {
    for (let l = 0; l < ember.lineCount(); l++) {
      const f = fileLine(l);
      const mark = f && marks.get(f.name);
      if (mark !== undefined) setMarkRaw(l, mark);
    }
  });
  if (pointFile !== undefined) {
    const found = findLine(pointFile);
    if (found !== undefined) pointLine = found;
  }
  ember.gotoChar(ember.lineStart(Math.min(pointLine, ember.lineCount() - 1)));
  moveToFilename();
}

function setMarkRaw(line: number, char: string): void {
  const start = ember.lineStart(line);
  ember.deleteRegion(start, start + 1);
  ember.gotoChar(start);
  ember.insert(char);
}

function findLine(name: string): number | undefined {
  for (let l = 0; l < ember.lineCount(); l++) if (fileLine(l)?.name === name) return l;
  return undefined;
}

/** Puts point on the first file worth visiting, as dired-initial-position. */
function initialPosition(): void {
  const trivial = ember.variable("dired-trivial-filenames");
  const re = typeof trivial === "string" ? new RegExp(trivial) : undefined;
  let line = 1;
  while (line < ember.lineCount() && fileLine(line) === undefined && ember.lineStart(line) < ember.bufferSize()) line++;
  if (re !== undefined) {
    while (line < ember.lineCount() && ember.lineStart(line) < ember.bufferSize() && re.test(fileLine(line)?.name ?? "")) line++;
  }
  ember.gotoChar(ember.lineStart(Math.min(line, ember.lineCount() - 1)));
  moveToFilename();
}

/** A Dired buffer already listing `dir`, as dired-find-buffer-nocreate. */
function findDiredBuffer(dir: string): string | undefined {
  return ember.bufferList().find((b) =>
    ember.withCurrentBuffer(b, () => ember.variable("major-mode") === "dired-mode" && ember.variable("dired-directory") === dir)
  );
}

/** The buffer listing a directory, made if need be, as dired-noselect. */
function diredNoselect(input: string): string {
  const dir = ember.fileNameAsDirectory(ember.expandFileName(input));
  if (!ember.fileDirectoryP(dir)) throw new Error(`${ember.directoryFileName(ember.expandFileName(input))}: No such file or directory`);
  const short = ember.abbreviateFileName(dir);
  const existing = findDiredBuffer(short);
  if (existing !== undefined) {
    if (on("dired-auto-revert-buffer")) ember.withCurrentBuffer(existing, () => readin(true));
    return existing;
  }
  const base = ember.fileNameNondirectory(ember.directoryFileName(dir)) || "/";
  let name = base;
  for (let n = 2; ember.bufferList().includes(name); n++) name = `${base}<${n}>`;
  ember.getBufferCreate(name);
  ember.withCurrentBuffer(name, () => {
    ember.call("dired-mode");
    ember.makeLocalVariable("default-directory");
    ember.setVariable("default-directory", dir);
    ember.makeLocalVariable("dired-directory");
    ember.setVariable("dired-directory", short);
    writable(() => insertListing(dir));
    ember.setBufferModified(false);
    initialPosition();
  });
  return name;
}

function showDired(name: string, where: "same" | "other" | "frame"): void {
  if (where === "same") ember.call("switch-to-buffer", name);
  else if (where === "other") ember.call("switch-to-buffer-other-window", name);
  else ember.call("switch-to-buffer-other-frame" as ember.CommandName, name);
}

const dirParam = (prompt: string): ember.Param => ({ name: "dirname", kind: "file", prompt });

ember.defineCommand({
  name: "dired",
  doc:
    "List a directory, one file a line, for visiting, marking and managing its files.\n\n" +
    "RET visits a file, ^ goes up, m marks, d flags for deletion, x deletes what is flagged, " +
    "C copies, R renames, D deletes and + makes a directory. ? sums up the keys.",
  params: [dirParam("Dired (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "same"),
});
ember.defineCommand({
  name: "dired-other-window",
  doc: "List a directory in another window, as dired does.",
  params: [dirParam("Dired in other window (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "other"),
});
ember.defineCommand({
  name: "dired-other-frame",
  doc: "List a directory in another frame, as dired does.",
  params: [dirParam("Dired in other frame (directory): ")],
  run: (dir: string) => showDired(diredNoselect(dir), "frame"),
});

function jump(otherWindow: boolean): void {
  const file = ember.bufferFileName();
  const dir = ember.variable("major-mode") === "dired-mode"
    ? ember.fileNameDirectory(ember.directoryFileName(currentDirectory())) ?? "/"
    : file !== undefined
      ? ember.fileNameDirectory(file)!
      : ember.fileNameAsDirectory(ember.expandFileName("."));
  const target = ember.variable("major-mode") === "dired-mode" ? ember.directoryFileName(currentDirectory()) : file;
  showDired(diredNoselect(dir), otherWindow ? "other" : "same");
  if (target !== undefined) {
    const line = findLine(ember.fileNameNondirectory(target));
    if (line !== undefined) {
      ember.gotoChar(ember.lineStart(line));
      moveToFilename();
    }
  }
}

ember.defineCommand({
  name: "dired-jump",
  doc: "List the directory of the current buffer's file, with point on the file. In Dired, go up a directory.",
  run: () => jump(ember.prefixArg() !== null),
});
ember.defineCommand({
  name: "dired-jump-other-window",
  doc: "List the directory of the current buffer's file in another window, with point on the file.",
  run: () => jump(true),
});

// Fontifying, as dired-font-lock-keywords: marks, names of directories
// and links, and the header. Details are invisible in dired-hide-details-mode.

function fontify(start: number, end: number): void {
  if (ember.variable("major-mode") !== "dired-mode") return;
  ember.removeTextProperty(start, end, "face");
  ember.removeTextProperty(start, end, "invisible");
  for (let line = ember.lineOf(start); line < ember.lineCount() && ember.lineStart(line) < end; line++) {
    const ls = ember.lineStart(line);
    const le = ember.lineEnd(line);
    const f = fileLine(line);
    if (f === undefined) {
      if (/^ {2}\S.*:$/.test(ember.lineText(line))) ember.putTextProperty(ls + 2, le, "face", "dired-header");
      continue;
    }
    ember.putTextProperty(ls + 2, f.start, "invisible", "dired-hide-details-detail");
    const nameEnd = f.start + f.name.length;
    if (f.isLink && nameEnd < le) ember.putTextProperty(nameEnd, le, "invisible", "dired-hide-details-link");
    if (f.mark === DEL_MARKER) {
      ember.putTextProperty(ls, ls + 1, "face", "dired-flagged");
      ember.putTextProperty(f.start, nameEnd, "face", "dired-flagged");
    } else if (f.mark !== " ") {
      ember.putTextProperty(ls, ls + 1, "face", "dired-mark");
      ember.putTextProperty(f.start, nameEnd, "face", "dired-marked");
    } else if (f.isDir) {
      ember.putTextProperty(f.start, nameEnd, "face", "dired-directory");
    } else if (f.isLink) {
      ember.putTextProperty(f.start, nameEnd, "face", "dired-symlink");
    } else if (/~$|^#.*#$/.test(f.name)) {
      ember.putTextProperty(f.start, nameEnd, "face", "dired-ignored");
    }
  }
}

// Moving.

/** Moves down `arg` lines and to the file name there, as dired--trivial-next-line. */
function nextLine(arg: number): void {
  const column = ember.currentColumn();
  const target = Math.max(0, Math.min(ember.lineCount() - 1, currentLine() + arg));
  ember.gotoChar(ember.lineStart(target));
  ember.moveToColumn(column);
  moveToFilename();
}

const count = (): number => ember.prefixNumericValue(ember.prefixArg());

ember.defineCommand({
  name: "dired-next-line",
  doc: "Move down a line, or as many as the prefix argument says, to the file name there.",
  run: () => nextLine(count()),
});
ember.defineCommand({
  name: "dired-previous-line",
  doc: "Move up a line, or as many as the prefix argument says, to the file name there.",
  run: () => nextLine(-count()),
});

function nextDirline(arg: number): void {
  const start = ember.point();
  let line = currentLine();
  let left = Math.abs(arg);
  const step = arg > 0 ? 1 : -1;
  while (left > 0) {
    line += step;
    if (line < 0 || line >= ember.lineCount()) {
      ember.gotoChar(start);
      throw new Error("No more subdirectories");
    }
    if (fileLine(line)?.isDir) left--;
  }
  ember.gotoChar(ember.lineStart(line));
  moveToFilename();
}

ember.defineCommand({
  name: "dired-next-dirline",
  doc: "Move down to the next directory's line, or as many as the prefix argument says.",
  run: () => nextDirline(count()),
});
ember.defineCommand({
  name: "dired-prev-dirline",
  doc: "Move up to the previous directory's line, or as many as the prefix argument says.",
  run: () => nextDirline(-count()),
});

/** Moves to the `arg`th next marked line, as dired-next-marked-file: typed, it wraps around once, saying so. */
function nextMarked(arg: number, wrap: boolean): void {
  const marked: number[] = [];
  for (let l = 0; l < ember.lineCount(); l++) {
    if (/^[^ \n]/.test(ember.lineText(l))) marked.push(l);
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
    ember.message("(Wraparound for next marked file)");
    found = find(back ? ember.lineCount() : -1, back);
  }
  if (found === undefined) throw new Error("No next marked file");
  ember.gotoChar(ember.lineStart(found));
  moveToFilename();
}

ember.defineCommand({
  name: "dired-next-marked-file",
  doc: "Move down to the next marked file, going round to the top if there is none below.",
  run: () => nextMarked(count(), ember.calledInteractively()),
});
ember.defineCommand({
  name: "dired-prev-marked-file",
  doc: "Move up to the previous marked file, going round to the bottom if there is none above.",
  run: () => nextMarked(-count(), ember.calledInteractively()),
});

/** Goes to the line of a file in this listing, as dired-goto-file; false if it is not there. */
function gotoFile(file: string): boolean {
  const name = ember.fileNameNondirectory(ember.directoryFileName(ember.expandFileName(file)));
  const dir = ember.fileNameDirectory(ember.directoryFileName(ember.expandFileName(file)));
  if (dir !== currentDirectory()) return false;
  const line = findLine(name);
  if (line === undefined) return false;
  ember.gotoChar(ember.lineStart(line));
  moveToFilename();
  return true;
}

ember.defineCommand({
  name: "dired-goto-file",
  doc: "Go to the line of a file in this listing.",
  params: [{ name: "file", kind: "file", prompt: "Goto file: " }],
  run: (file: string) => {
    requireDired();
    if (ember.calledInteractively()) {
      ember.setMark(ember.point());
      ember.message("Mark set");
    }
    gotoFile(file);
  },
});

ember.defineCommand({
  name: "dired-up-directory",
  doc: "List the directory above this one, with point on this one. With a prefix argument, in another window.",
  run: () => {
    requireDired();
    const dir = currentDirectory();
    const up = ember.fileNameDirectory(ember.directoryFileName(dir));
    if (up === undefined || up === dir) return;
    const name = diredNoselect(up);
    showDired(name, ember.prefixArg() !== null ? "other" : "same");
    gotoFile(ember.directoryFileName(dir));
  },
});

// Visiting.

/** The file to visit from this line, as dired-get-file-for-visit. */
function fileForVisit(): string {
  const file = filenameAt();
  if (file === undefined) throw new Error("No file on this line");
  if (!ember.fileExists(file) && ember.fileAttributes(file) === undefined) throw new Error("File no longer exists; type \u2018g\u2019 to update Dired buffer");
  return file;
}

function visit(file: string, where: "same" | "other"): void {
  const target = isDot(ember.fileNameNondirectory(file)) ? ember.expandFileName(file) : file;
  if (ember.fileDirectoryP(target)) {
    const from = ember.bufferName();
    showDired(diredNoselect(target), where);
    if (where === "same" && on("dired-kill-when-opening-new-dired-buffer") && ember.bufferName() !== from) ember.call("kill-buffer", from);
    return;
  }
  ember.call(where === "same" ? "find-file" : "find-file-other-window", target);
}

ember.defineCommand({
  name: "dired-find-file",
  doc: "Visit the file or directory on this line.",
  run: () => visit(fileForVisit(), "same"),
});
ember.defineCommand({
  name: "dired-find-file-other-window",
  doc: "Visit the file or directory on this line in another window.",
  run: () => visit(fileForVisit(), "other"),
});
ember.defineCommand({
  name: "dired-display-file",
  doc: "Show the file on this line in another window, staying in Dired.",
  run: () => {
    const file = fileForVisit();
    const window = ember.selectedWindow();
    visit(file, "other");
    ember.selectWindow(window);
  },
});
ember.defineCommand({
  name: "dired-view-file",
  doc: "Visit the file on this line read-only, or list it if it is a directory.",
  run: () => {
    const file = fileForVisit();
    visit(file, "same");
    if (!ember.fileDirectoryP(file)) ember.setReadOnly(true);
  },
});
ember.defineCommand({
  name: "dired-find-alternate-file",
  doc: "Visit the file or directory on this line in place of this Dired buffer, which is killed.",
  run: () => {
    const file = fileForVisit();
    const from = ember.bufferName();
    visit(file, "same");
    if (ember.bufferName() !== from) ember.call("kill-buffer", from);
  },
});

// Marking.

/** Whether this line is a directory's header, as dired-get-subdir sees it. */
const onHeader = (line = currentLine()): boolean => fileLine(line) === undefined && /^ {2}\S.*:$/.test(ember.lineText(line));

/**
 * Marks lines from point, as dired-mark: the region's files, or on the
 * header every file but . and .., or the next `arg`. `.` and `..` are never flagged.
 */
function mark(char: string): void {
  const arg = ember.prefixArg();
  if (!(ember.regionActive() && ember.mark() !== undefined && ember.mark() !== ember.point()) && onHeader()) {
    for (let l = 0; l < ember.lineCount(); l++) {
      const f = fileLine(l);
      if (f && !isDot(f.name)) setMark(l, char);
    }
    return;
  }
  if (ember.regionActive() && ember.mark() !== undefined && ember.mark() !== ember.point()) {
    const [a, b] = [Math.min(ember.point(), ember.mark()!), Math.max(ember.point(), ember.mark()!)];
    const point = ember.point();
    const first = ember.lineOf(a);
    let last = ember.lineOf(b);
    if (ember.lineStart(last) === b) last--;
    for (let l = first; l <= last; l++) {
      const f = fileLine(l);
      if (f && !isDot(f.name)) setMark(l, char);
    }
    ember.gotoChar(point);
    return;
  }
  repeatOverLines(ember.prefixNumericValue(arg), (l) => {
    const f = fileLine(l);
    if (f && (!isDot(f.name) || f.isLink || char !== DEL_MARKER)) setMark(l, char);
  });
}

ember.defineCommand({
  name: "dired-mark",
  doc: "Mark the file on this line, and move down. With a prefix argument, the next that many; in the region, its files.",
  run: () => mark(MARKER),
});
ember.defineCommand({
  name: "dired-unmark",
  doc: "Take the mark or flag off the file on this line, and move down.",
  run: () => mark(" "),
});
ember.defineCommand({
  name: "dired-flag-file-deletion",
  doc: "Flag the file on this line for deletion, which x does, and move down.",
  run: () => mark(DEL_MARKER),
});
ember.defineCommand({
  name: "dired-unmark-backward",
  doc: "Move up a line and take the mark or flag off the file there.",
  run: () => {
    const n = count();
    repeatOverLines(-n, (l) => {
      if (fileLine(l)) setMark(l, " ");
    });
  },
});

ember.defineCommand({
  name: "dired-toggle-marks",
  doc: "Mark the files that are not marked and unmark those that are. Flags for deletion stay, and . and .. are left alone.",
  run: () => {
    requireDired();
    for (let l = 0; l < ember.lineCount(); l++) {
      const f = fileLine(l);
      if (!f || isDot(f.name)) continue;
      if (f.mark === " ") setMark(l, MARKER);
      else if (f.mark === MARKER) setMark(l, " ");
    }
  },
});

function unmarkAll(which: string | undefined): void {
  let n = 0;
  for (let l = 0; l < ember.lineCount(); l++) {
    const f = fileLine(l);
    if (f && f.mark !== " " && (which === undefined || f.mark === which)) {
      setMark(l, " ");
      n++;
    }
  }
  ember.message(n === 1 ? "1 mark removed" : `${n} marks removed`);
}

ember.defineCommand({
  name: "dired-unmark-all-marks",
  doc: "Take every mark and flag off.",
  run: () => unmarkAll(undefined),
});
ember.defineCommand({
  name: "dired-unmark-all-files",
  doc: "Take a mark off every file that has it: the mark character typed, or every mark for RET.",
  params: [{ name: "mark", prompt: "Remove marks (RET means all): " }],
  run: (char: string) => unmarkAll(char === "" ? undefined : char[0]),
});

/** Marks the files a test picks, as dired-mark-if, saying how many. */
function markIf(test: (f: FileLine) => boolean, what: string, char = MARKER): void {
  const doing = char === " " ? "Unmarking" : char === DEL_MARKER ? "Flagging" : "Marking";
  ember.message(`${doing} ${what}s${char === DEL_MARKER ? " for deletion" : ""}...`);
  let n = 0;
  for (let l = 0; l < ember.lineCount(); l++) {
    const f = fileLine(l);
    if (f && test(f) && f.mark !== char) {
      setMark(l, char);
      n++;
    }
  }
  const verb = char === " " ? "un" : "";
  ember.message(`${n} ${what}${n === 1 ? "" : "s"} ${verb}${char === DEL_MARKER ? "flagged" : "marked"}`);
}

const regexpParam = (prompt: string): ember.Param => ({ name: "regexp", prompt, history: "dired-regexp-history" });

ember.defineCommand({
  name: "dired-mark-files-regexp",
  doc: "Mark the files whose names match a regular expression. With a prefix argument, unmark them.",
  params: [regexpParam("Mark files (regexp): ")],
  run: (regexp: string) => {
    markIf((f) => !isDot(f.name) && ember.stringMatch(regexp, f.name) !== undefined, "matching file", ember.prefixArg() !== null ? " " : MARKER);
  },
});
ember.defineCommand({
  name: "dired-flag-files-regexp",
  doc: "Flag for deletion the files whose names match a regular expression.",
  params: [regexpParam("Flag for deletion (regexp): ")],
  run: (regexp: string) => {
    markIf((f) => !isDot(f.name) && ember.stringMatch(regexp, f.name) !== undefined, "matching file", DEL_MARKER);
  },
});
ember.defineCommand({
  name: "dired-mark-directories",
  doc: "Mark the directories, but not . and ... With a prefix argument, unmark them.",
  run: () => markIf((f) => f.isDir && !isDot(f.name), "directory file", ember.prefixArg() !== null ? " " : MARKER),
});
ember.defineCommand({
  name: "dired-mark-symlinks",
  doc: "Mark the symbolic links. With a prefix argument, unmark them.",
  run: () => markIf((f) => f.isLink, "symbolic link", ember.prefixArg() !== null ? " " : MARKER),
});
ember.defineCommand({
  name: "dired-mark-executables",
  doc: "Mark the files anyone can run. With a prefix argument, unmark them.",
  run: () => {
    markIf((f) => {
      const a = ember.fileAttributes(currentDirectory() + f.name);
      return a !== undefined && a.type === "file" && /x/.test(a.modes);
    }, "executable file", ember.prefixArg() !== null ? " " : MARKER);
  },
});
ember.defineCommand({
  name: "dired-flag-backup-files",
  doc: "Flag for deletion the backup files, whose names end in ~. With a prefix argument, unflag them.",
  run: () => markIf((f) => f.name.endsWith("~"), "backup file", ember.prefixArg() !== null ? " " : DEL_MARKER),
});
ember.defineCommand({
  name: "dired-flag-auto-save-files",
  doc: "Flag for deletion the auto-save files, named #like-this#. With a prefix argument, unflag them.",
  run: () => markIf((f) => /^#.*#$/.test(f.name), "auto save file", ember.prefixArg() !== null ? " " : DEL_MARKER),
});
ember.defineCommand({
  name: "dired-change-marks",
  doc: "Change one mark to another on every file that has it.",
  params: [{ name: "old", prompt: "Change (old mark): " }, { name: "new", prompt: (old) => `Change ${old} marks to (new mark): ` }],
  run: (old: string, next: string) => {
    for (let l = 0; l < ember.lineCount(); l++) if (fileLine(l)?.mark === old[0]) setMark(l, next[0] ?? " ");
  },
});
ember.defineCommand({
  name: "dired-number-of-marked-files",
  doc: "Say how many files are marked, and their size.",
  run: () => {
    const files = markedLines(MARKER).map((l) => filenameAt(l)!);
    if (files.length === 0) {
      ember.message("No marked files");
      return;
    }
    const size = files.reduce((sum, f) => sum + (ember.fileAttributes(f)?.size ?? 0), 0);
    ember.message(`${files.length} marked file${files.length === 1 ? "" : "s"} (${humanSize(size)})`);
  },
});

// Acting on files.

/** Takes a file's line out of every Dired buffer listing its directory, as dired-remove-file. */
function removeEntry(file: string): void {
  const dir = ember.fileNameDirectory(file);
  const name = ember.fileNameNondirectory(file);
  for (const b of ember.bufferList()) {
    ember.withCurrentBuffer(b, () => {
      if (ember.variable("major-mode") !== "dired-mode" || currentDirectory() !== dir) return;
      const line = findLine(name);
      if (line === undefined) return;
      writable(() => ember.deleteRegion(ember.lineStart(line), Math.min(ember.lineStart(line + 1), ember.bufferSize())));
    });
  }
}

/** Adds a line for a new file at point, if this buffer lists its directory, as dired-add-entry. */
function addEntry(file: string, marker?: string): void {
  const dir = ember.fileNameDirectory(ember.directoryFileName(file));
  const name = ember.fileNameNondirectory(ember.directoryFileName(file));
  if (dir !== currentDirectory()) return;
  const [line] = listing(dir, switchesOf(), [name]);
  if (line === undefined) return;
  writable(() => {
    const at = ember.lineStart(Math.max(currentLine(), 1));
    ember.gotoChar(at);
    ember.insert(`${marker ?? " "} ${line}\n`);
    ember.gotoChar(at);
  });
  moveToFilename();
}

/** Deletes files, asking first, as dired-internal-do-deletions: directories with files in them ask again. */
function doDeletions(files: string[], lines: number[], arg: ember.PrefixArg | null, marker: string): void {
  const trashing = on("delete-by-moving-to-trash");
  const prompt = `${trashing ? "Trash" : "Delete"} ${markPrompt(arg, files, marker)} `;
  ember.yesOrNoP(prompt, (yes) => {
    if (!yes) {
      ember.message("(No deletions performed)");
      return;
    }
    // Point stays with its line, or goes to the next if that line goes, as
    // Emacs's save-excursion keeps it.
    const pointLine = currentLine();
    const pointName = fileLine(pointLine)?.name;
    const linesBefore = files.filter((f) => {
      const l = findLine(ember.fileNameNondirectory(f));
      return l !== undefined && l < pointLine;
    });
    let done = 0;
    const failures: string[] = [];
    let recursive = ember.variable("dired-recursive-deletes");
    const next = (k: number): void => {
      if (k >= files.length) {
        if (failures.length > 0) {
          ember.message(`${failures.length} of ${files.length} deletion${files.length === 1 ? "" : "s"} failed`);
        } else {
          ember.message(`${trashing ? "Trashing" : "Deleting"}...done`);
        }
        const kept = pointName === undefined ? undefined : findLine(pointName);
        const gone = linesBefore.filter((f) => !failures.includes(f)).length;
        const line = kept ?? Math.max(0, pointLine - gone);
        ember.gotoChar(ember.lineStart(Math.min(line, ember.lineCount() - 1)));
        moveToFilename();
        return;
      }
      const file = files[k];
      const remove = (rec: boolean) => {
        try {
          if (ember.fileAttributes(file)?.type === "directory") ember.deleteDirectory(file, { recursive: rec, trash: true });
          else ember.deleteFile(file, { trash: true });
          done++;
          removeEntry(file);
        } catch (e) {
          failures.push(file);
          void e;
        }
        next(k + 1);
      };
      const attrs = ember.fileAttributes(file);
      const full = attrs?.type === "directory" && ember.directoryFiles(file).length > 2;
      if (!full) return remove(false);
      if (recursive === null || recursive === false) return remove(false);
      if (recursive === "always") return remove(true);
      ember.readAnswer(`Recursively ${trashing ? "trash" : "delete"} ${ember.fileNameNondirectory(file)}? `, ["yes", "no", "all", "quit"], (answer) => {
        if (answer === "all") {
          recursive = "always";
          return remove(true);
        }
        if (answer === "yes") return remove(true);
        if (answer === "no") return remove(false);
        throw new Error("Quit");
      });
    };
    void done;
    void lines;
    next(0);
  });
}

ember.defineCommand({
  name: "dired-do-flagged-delete",
  doc: "Delete the files flagged with d, after asking. Deleting goes to the trash, as delete-by-moving-to-trash says.",
  run: () => {
    requireDired();
    const lines = markedLines(DEL_MARKER);
    if (lines.length === 0) {
      ember.message("(No deletions requested)");
      return;
    }
    doDeletions(lines.map((l) => filenameAt(l)!), lines, null, DEL_MARKER);
  },
});
ember.defineCommand({
  name: "dired-do-delete",
  doc: "Delete the marked files, or the one on this line, after asking. With a prefix argument, the next that many.",
  run: () => {
    requireDired();
    const arg = ember.prefixArg();
    const { files, lines } = markedFiles(arg, MARKER, true);
    if (files.some((f) => isDot(ember.fileNameNondirectory(f)))) throw new Error("Cannot operate on \u2018.\u2019 or \u2018..\u2019");
    doDeletions(files, lines, arg, MARKER);
  },
});

/** Where a copy or rename suggests going, as dired-dwim-target-directory. */
function dwimTarget(): string {
  if (on("dired-dwim-target")) {
    const here = ember.selectedWindow();
    for (const w of ember.windowList()) {
      if (w === here) continue;
      const b = ember.windowBuffer(w);
      const dir = b && ember.withCurrentBuffer(b, () => ember.variable("major-mode") === "dired-mode" ? currentDirectory() : undefined);
      if (dir) return dir;
    }
  }
  return currentDirectory();
}

type Creator = (from: string, to: string) => void;

/**
 * Copies or renames the marked files, as dired-do-create-files: asking where
 * to, into a directory for several, and before overwriting each file.
 */
function createFiles(operation: string, op1: string, creator: Creator, marker: (from: string) => string | undefined): void {
  requireDired();
  const arg = ember.prefixArg();
  const { files } = markedFiles(arg, MARKER, false, "No files specified");
  const one = files.length === 1;
  const targetDir = dwimTarget();
  const prompt = `${one ? op1 : operation} ${markPrompt(arg, files)} to: `;
  const dflt = one && !on("dired-dwim-target") ? targetDir + ember.fileNameNondirectory(files[0]) : undefined;
  ember.readFileName(prompt, (answer) => {
    const target = ember.expandFileName(answer);
    const intoDir = ember.fileDirectoryP(target);
    if (!one && !intoDir) throw new Error(`Marked ${operation}: target must be a directory: ${target}`);
    const to = (from: string) => intoDir ? ember.fileNameAsDirectory(target) + ember.fileNameNondirectory(from) : ember.directoryFileName(target);
    let done = 0;
    const failures: string[] = [];
    let query: string | undefined;
    const next = (k: number): void => {
      if (k >= files.length) {
        if (failures.length > 0) ember.message(`${operation}: ${failures.length} of ${files.length} file${files.length === 1 ? "" : "s"} failed`);
        else ember.message(`${operation}: ${done} file${done === 1 ? "" : "s"} done`);
        moveToFilename();
        return;
      }
      const from = files[k];
      gotoFile(from);
      const dest = to(from);
      if (dest === from) {
        failures.push(from);
        return next(k + 1);
      }
      // As dired-create-files, before trying: a directory cannot be copied into itself.
      const destDir = ember.fileNameDirectory(dest) ?? "/";
      if (operation === "Copy" && ember.fileDirectoryP(from)) {
        const real = ember.fileNameAsDirectory(ember.expandFileName(from));
        if (ember.fileNameAsDirectory(ember.expandFileName(destDir)).startsWith(real)) {
          throw new Error(`Cannot copy \u2018${from}\u2019 into its subdirectory \u2018${dest}\u2019`);
        }
      }
      const go = () => {
        try {
          const overwrite = ember.fileExists(dest);
          const mk = marker(from);
          creator(from, dest);
          if (overwrite) removeEntry(dest);
          done++;
          ember.message(`${operation}: ${done} of ${files.length}`);
          addEntry(dest, mk);
        } catch (e) {
          failures.push(from);
          ember.message(String(e instanceof Error ? e.message : e));
        }
        next(k + 1);
      };
      if (!ember.fileExists(dest) || query === "!") return go();
      if (query === "q") {
        failures.push(from);
        return next(k + 1);
      }
      ember.readCharChoice(`Overwrite \u2018${dest}\u2019? [Type y, n, q or !] `, "yn!q", (c) => {
        query = c;
        if (c === "y" || c === "!") return go();
        failures.push(from);
        next(k + 1);
      });
    };
    next(0);
  }, { dir: targetDir, default: dflt });
}

const markOf = (file: string): string => {
  const line = findLine(ember.fileNameNondirectory(file));
  return line === undefined ? " " : fileLine(line)!.mark;
};

ember.defineCommand({
  name: "dired-do-copy",
  doc:
    "Copy the marked files, or the one on this line, asking where to: a new name for one, a directory for several.\n\n" +
    "Copies are marked C, as dired-keep-marker-copy says, and keep their modification times.",
  run: () => {
    const keep = ember.variable("dired-keep-marker-copy");
    createFiles("Copy", "Copy", (from, to) => {
      if (ember.fileAttributes(from)?.type === "directory") {
        if (ember.variable("dired-recursive-copies") === null || ember.variable("dired-recursive-copies") === false) {
          throw new Error(`Cannot copy directories: ${from}`);
        }
        ember.copyDirectory(from, to, { keepTime: on("dired-copy-preserve-time") });
      } else {
        ember.copyFile(from, to, { okIfExists: true, keepTime: on("dired-copy-preserve-time") });
      }
    }, (from) => typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined);
  },
});

ember.defineCommand({
  name: "dired-do-rename",
  doc:
    "Rename the marked files, or the one on this line, asking to what: a new name for one, a directory for several, " +
    "to move them there. Buffers visiting them follow.",
  run: () => {
    const { files } = markedFiles(ember.prefixArg(), MARKER, false, "No files specified");
    if (files.some((f) => isDot(ember.fileNameNondirectory(f)))) throw new Error(`Can\u2019t rename "." or ".." files`);
    const keep = ember.variable("dired-keep-marker-rename");
    createFiles("Move", "Rename", (from, to) => {
      ember.renameFile(from, to, { okIfExists: true });
      for (const b of ember.bufferList()) {
        ember.withCurrentBuffer(b, () => {
          if (ember.bufferFileName() === from) ember.setVisitedFileName(to, { alongWithFile: true });
        });
      }
      removeEntry(from);
    }, (from) => typeof keep === "string" ? keep : keep === true ? markOf(from) : undefined);
  },
});

ember.defineCommand({
  name: "dired-create-directory",
  doc: "Make a directory, with any missing above it, and list it here.",
  params: [{ name: "directory", kind: "file", prompt: "Create directory: " }],
  run: (input: string) => {
    requireDired();
    const dir = ember.directoryFileName(ember.expandFileName(input));
    if (ember.fileExists(dir)) throw new Error(`Cannot create directory ${dir}: file exists`);
    // The topmost directory that is new is the one this listing may show.
    let top = dir;
    for (let up = ember.fileNameDirectory(top); up !== undefined && !ember.fileExists(up); up = ember.fileNameDirectory(ember.directoryFileName(up))) {
      top = ember.directoryFileName(up);
    }
    ember.makeDirectory(dir, { parents: true });
    addEntry(top);
  },
});

ember.defineCommand({
  name: "dired-create-empty-file",
  doc: "Make an empty file, with any missing directories above it, and list it here.",
  params: [{ name: "file", kind: "file", prompt: "Create empty file: " }],
  run: (input: string) => {
    requireDired();
    const file = ember.expandFileName(input);
    if (ember.fileExists(file)) throw new Error(`Cannot create file ${file}: file exists`);
    const dir = ember.fileNameDirectory(file);
    if (dir !== undefined) ember.makeDirectory(dir, { parents: true });
    ember.writeTextFile(file, "");
    addEntry(file);
  },
});

ember.defineCommand({
  name: "dired-do-kill-lines",
  doc:
    "Take the marked files' lines out of the listing; with a prefix argument, the next that many lines instead. " +
    "The files stay; g brings the lines back.",
  run: () => {
    requireDired();
    const arg = ember.prefixArg();
    if (arg !== null) {
      // As dired-kill-line: from this line on, or back with a negative count.
      let n = ember.prefixNumericValue(arg);
      writable(() => {
        while (n !== 0) {
          const line = currentLine();
          if (fileLine(line) === undefined) throw new Error("Can only kill file lines");
          ember.deleteRegion(ember.lineStart(line), Math.min(ember.lineStart(line + 1), ember.bufferSize()));
          if (n > 0) n--;
          else {
            n++;
            ember.gotoChar(ember.lineStart(Math.max(0, currentLine() - 1)));
          }
        }
      });
      moveToFilename();
      return;
    }
    const point = ember.point();
    const lines = markedLines(MARKER);
    let shift = 0;
    writable(() => {
      for (const l of [...lines].sort((a, b) => b - a)) {
        const start = ember.lineStart(l);
        const end = Math.min(ember.lineStart(l + 1), ember.bufferSize());
        if (start < point) shift += Math.min(end, point) - start;
        ember.deleteRegion(start, end);
      }
    });
    ember.gotoChar(point - shift);
    ember.message(`Killed ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
  },
});

ember.defineCommand({
  name: "dired-copy-filename-as-kill",
  doc:
    "Put the names of the marked files, or this line's, in the kill ring, separated by spaces.\n\n" +
    "With a zero prefix argument, their whole names; with C-u, relative to this directory.",
  run: () => {
    requireDired();
    // On the header, the directory's whole name, as dired-get-subdir gives it.
    if (onHeader()) {
      const dir = currentDirectory();
      ember.killNew(dir);
      ember.message(dir);
      return;
    }
    const arg = ember.prefixArg();
    const absolute = arg !== null && ember.prefixNumericValue(arg) === 0;
    // With no file here and none marked, there is nothing to copy, as Emacs says nothing.
    if (filenameAt() === undefined && markedLines(MARKER).length === 0) return;
    const { files } = markedFiles(arg === null || absolute || Array.isArray(arg) ? null : arg);
    const names = files.map((f) => (absolute ? f : ember.fileNameNondirectory(f)));
    const text = names.length === 1 ? names[0] : names.map((n) => (/[ "']/.test(n) ? JSON.stringify(n) : n)).join(" ");
    if (text === "") return;
    ember.killNew(text);
    ember.message(text);
  },
});

ember.defineCommand({
  name: "dired-revert",
  doc: "List the directory again, keeping the marks and point on the same file.",
  run: () => {
    requireDired();
    readin(true);
  },
});

ember.defineCommand({
  name: "dired-do-redisplay",
  doc: "List the directory again, as g does.",
  run: () => ember.call("dired-revert"),
});

ember.defineCommand({
  name: "dired-sort-toggle-or-edit",
  doc: "Sort the listing by date if it is sorted by name, else by name. With a prefix argument, type the switches.",
  run: () => {
    requireDired();
    const switches = switchesOf();
    const byDate = /^-\S*t|\s-\S*t/.test(switches);
    const toggled = byDate ? switches.replace(/(-\S*?)t/, "$1").replace(/ -(?=\s|$)/, "") : `${switches}t`;
    ember.makeLocalVariable("dired-actual-switches");
    ember.setVariable("dired-actual-switches", toggled);
    ember.setVariable("mode-name", byDate ? "Dired by name" : "Dired by date");
    readin(true);
  },
});

ember.defineMinorMode({
  name: "dired-hide-details-mode",
  lighter: "",
  doc: "Show only the files' names in Dired, hiding their sizes, dates and the rest.",
  onChange: (enabled) => {
    for (const spec of ["dired-hide-details-detail", "dired-hide-details-link"]) {
      if (enabled) ember.addToInvisibilitySpec(spec);
      else ember.removeFromInvisibilitySpec(spec);
    }
  },
});

ember.defineCommand({
  name: "dired-summary",
  doc: "Sum up Dired's most used keys in the echo area.",
  run: () => ember.message("d-elete, u-ndelete, x-punge, f-ind, o-ther window, R-ename, C-opy, h-elp"),
});

ember.defineCommand({
  name: "dired-undo",
  doc: "Undo marks and flags, as far as the buffer remembers them. Changes to files stay.",
  run: () => writable(() => ember.call("undo")),
});

// The mode.

ember.defineMajorMode({
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
    ember.setReadOnly(true);
    ember.makeLocalVariable("revert-buffer-function");
    ember.setVariable("revert-buffer-function", "dired-revert");
    ember.addHook("jit-lock-functions", fontify, { local: true });
  },
});

ember.bindKey("C-x d", "dired");
ember.bindKey("C-x 4 d", "dired-other-window");
ember.bindKey("C-x 5 d", "dired-other-frame");
ember.bindKey("C-x C-j", "dired-jump");
ember.bindKey("C-x 4 C-j", "dired-jump-other-window");
