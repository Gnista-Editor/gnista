// Comparing files, after Emacs's diff.el and diff-mode.el: M-x diff runs
// diff on two files into *Diff*, diff-buffer-with-file compares a buffer
// with its file, and diff-mode colours the hunks, moves between them with
// n and p, and goes to the source with RET.

import { escapeRegExp, PerBuffer } from "subr";

for (const [name, doc, value] of [
  ["diff-command", "The program M-x diff runs.", "diff"],
  ["diff-switches", "The options M-x diff gives diff: a string or a list of strings.", "-u"],
] as const) {
  gnista.defineVariable({ name, doc, value });
}

for (const [name, doc, attributes] of [
  ["diff-header", "Hunk headers in diff-mode.", { background: "#d9d9d9" }],
  ["diff-file-header", "The lines naming the files in diff-mode.", { bold: true, background: "#bfbfbf" }],
  ["diff-hunk-header", "The @@ line starting each hunk in diff-mode.", { background: "#d9d9d9" }],
  ["diff-removed", "Lines a diff takes away.", { background: "#ffdddd" }],
  ["diff-added", "Lines a diff adds.", { background: "#ddffdd" }],
  ["diff-context", "Lines a diff leaves as they are.", {}],
] as const) {
  gnista.defineFace({ name, doc, attributes: attributes as gnista.FaceAttributes });
}
gnista.defineFace({ name: "diff-indicator-removed", doc: "The - starting a line a diff takes away.", attributes: { inherit: "diff-removed" } as gnista.FaceAttributes });
gnista.defineFace({ name: "diff-indicator-added", doc: "The + starting a line a diff adds.", attributes: { inherit: "diff-added" } as gnista.FaceAttributes });

/** The current time as current-time-string writes it: "Sat Oct 31 03:30:00 2026". */
function currentTimeString(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}

/** A shell word quoted as shell-quote-argument quotes it. */
const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * Runs diff on two files into a buffer, as diff-no-select: the command on
 * the first line, then diff's output, then whether they differed. `labels`
 * names files that stand for something else, as --label does.
 */
export function diffNoSelect(oldFile: string, newFile: string, labels?: [string, string], buffer = "*Diff*"): string {
  const switchesValue = gnista.variable("diff-switches");
  const switches = Array.isArray(switchesValue) ? switchesValue.map(String) : typeof switchesValue === "string" ? switchesValue.split(/\s+/).filter(Boolean) : [];
  const args = [...switches, ...(labels ? ["--label", labels[0], "--label", labels[1]] : []), oldFile, newFile];
  const program = String(gnista.variable("diff-command") ?? "diff");
  const command = [program, ...args.map(shellQuote)].join(" ");
  const dir = gnista.expandFileName(".");
  gnista.getBufferCreate(buffer);
  const result = gnista.callProcess([program, ...args]);
  gnista.withCurrentBuffer(buffer, () => {
    if (gnista.variable("major-mode") !== "diff-mode") gnista.call("diff-mode");
    gnista.setVariable("default-directory", dir.endsWith("/") ? dir : `${dir}/`);
    gnista.letBind({ "inhibit-read-only": true }, () => {
      gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
      gnista.insert(`${command}\n`);
      gnista.insert(result.output);
      const status = result.exit === 0 ? " (no differences)" : result.exit === 1 ? "" : ` (diff error, exit status ${result.exit})`;
      gnista.insert(`\nDiff finished${status}.  ${currentTimeString()}\n`);
    });
    gnista.gotoChar(gnista.pointMin());
    gnista.setBufferModified(false);
    diffBuffers.set(buffer, { oldFile, newFile, labels });
  });
  return buffer;
}

/** What each diff buffer compared, to make it again with g. */
const diffBuffers = new PerBuffer<{ oldFile: string; newFile: string; labels?: [string, string] }>();

/** The newest numbered or plain backup of a file, as diff-latest-backup-file finds it. */
function latestBackup(file: string): string | undefined {
  const dir = file.replace(/[^/]*$/, "");
  const base = file.replace(/.*\//, "");
  const names = gnista.directoryFiles(dir).filter((n) => n === `${base}~` || new RegExp(`^${escapeRegExp(base)}\\.~\\d+~$`).test(n));
  if (names.length === 0) return undefined;
  const version = (n: string) => Number(/\.~(\d+)~$/.exec(n)?.[1] ?? 0);
  names.sort((a, b) => version(b) - version(a));
  return dir + names[0];
}

gnista.defineCommand({
  name: "diff",
  doc: "Compare two files with diff, showing the differences in *Diff*. The new file is this buffer's by default, the old one its backup.",
  run: async () => {
    const own = gnista.bufferFileName();
    const newFile = gnista.expandFileName(await gnista.readFileName("Diff new file: ", { default: own, initial: own === undefined ? undefined : "" }) || own || "");
    const backup = latestBackup(newFile);
    const oldAnswer = await gnista.readFileName(`Diff original file${backup === undefined ? "" : ` (default ${backup.replace(/.*\//, "")})`}: `, { default: backup });
    const oldFile = gnista.expandFileName(oldAnswer || backup || "");
    if (gnista.fileDirectoryP(newFile) || gnista.fileDirectoryP(oldFile)) gnista.userError("diff of directories is not supported here");
    gnista.call("display-buffer", diffNoSelect(oldFile, newFile));
  },
});

gnista.defineCommand({
  name: "diff-backup",
  doc: "Compare a file with its newest backup.",
  params: [{ name: "file", kind: "file", prompt: "Diff (file with backup): " }],
  run: (file: string) => {
    const path = gnista.expandFileName(file);
    const backup = latestBackup(path);
    if (backup === undefined) gnista.userError(`No backup found for ${path}`);
    gnista.call("display-buffer", diffNoSelect(backup!, path));
  },
});

gnista.defineCommand({
  name: "diff-buffer-with-file",
  doc: "Compare a buffer with the file it visits, to see what saving would change.",
  params: [{ name: "buffer", kind: "buffer", prompt: "Buffer: " }],
  run: (buffer: string) => {
    const file = gnista.withCurrentBuffer(buffer, () => gnista.bufferFileName());
    if (file === undefined) gnista.userError(`Buffer ${buffer} has no associated file on disk`);
    const text = gnista.withCurrentBuffer(buffer, () => gnista.saveRestriction(() => {
      gnista.widen();
      return gnista.bufferText(gnista.pointMin(), gnista.pointMax());
    }));
    const temp = gnista.makeTempFile("buffer-content-", { text });
    try {
      gnista.call("display-buffer", diffNoSelect(file!, temp, [file!, buffer]));
    } finally {
      // Gone for good, as a temporary file of diff's own, not to the trash.
      gnista.deleteFile(temp);
    }
  },
});

// diff-mode.

const HUNK = "^@@ -\\([0-9]+\\)\\(?:,\\([0-9]+\\)\\)? \\+\\([0-9]+\\)\\(?:,\\([0-9]+\\)\\)? @@";
const FILE = "^--- ";

/** Colours the lines of a diff from start to end, as diff-mode's font-lock keywords. */
function fontify(start: number, end: number): void {
  gnista.saveExcursion(() => {
    gnista.gotoChar(gnista.lineBeginningPosition(start));
    while (gnista.point() < end && gnista.point() < gnista.pointMax()) {
      const bol = gnista.point();
      const eol = gnista.lineEndPosition();
      const line = gnista.bufferSubstringNoProperties(bol, eol);
      const to = Math.min(eol + 1, gnista.pointMax());
      let face: string | undefined;
      if (/^@@ /.test(line)) face = "diff-hunk-header";
      else if (/^(---|\+\+\+) /.test(line)) face = "diff-file-header";
      else if (/^-/.test(line)) face = "diff-removed";
      else if (/^\+/.test(line)) face = "diff-added";
      else if (/^(diff |Only in |Diff finished)/.test(line)) face = "diff-header";
      if (face !== undefined) gnista.putTextProperty(bol, to, "face", face);
      gnista.gotoChar(to);
      if (to >= gnista.pointMax()) break;
    }
  });
}

/** Moves to the `n`th next hunk header, back if negative, as diff-hunk-next. */
function hunkNext(n: number, regexp = HUNK, what = "hunk"): void {
  for (let i = 0; i < Math.abs(n); i++) {
    if (n > 0) {
      const at = gnista.saveExcursion(() => {
        if (gnista.lookingAt(regexp)) gnista.gotoChar(gnista.lineEndPosition());
        return gnista.reSearchForward(regexp, { noerror: true }) === undefined ? undefined : gnista.matchBeginning(0);
      });
      if (at === undefined) gnista.userError(`No next ${what}`);
      gnista.gotoChar(at!);
    } else {
      const at = gnista.saveExcursion(() => (gnista.reSearchBackward(regexp, { noerror: true }) === undefined ? undefined : gnista.point()));
      if (at === undefined) gnista.userError(`No previous ${what}`);
      gnista.gotoChar(at!);
    }
  }
}

/** The file a diff names, without the date diff puts after a tab. */
const fileName = (line: string): string => line.slice(4).replace(/\t.*$/, "");

/** The file and line in it the diff's line at point stands for, in the new file or with `old` the old one, as diff-find-source-location. */
function sourceLocation(old: boolean): [string, number] {
  return gnista.saveExcursion(() => {
    const here = gnista.lineBeginningPosition();
    if (!gnista.lookingAt(HUNK) && gnista.reSearchBackward(HUNK, { noerror: true }) === undefined) gnista.userError("Not in a hunk");
    gnista.gotoChar(gnista.lineBeginningPosition());
    gnista.lookingAt(HUNK);
    let line = Number(gnista.matchString(old ? 1 : 3));
    const hunkStart = gnista.point();
    const files = gnista.saveExcursion(() => {
      if (gnista.reSearchBackward(FILE, { noerror: true }) === undefined) gnista.userError("Can't find the file this hunk is for");
      const from = fileName(gnista.bufferSubstringNoProperties(gnista.point(), gnista.lineEndPosition()));
      gnista.gotoChar(Math.min(gnista.lineEndPosition() + 1, gnista.pointMax()));
      const to = fileName(gnista.bufferSubstringNoProperties(gnista.point(), gnista.lineEndPosition()));
      return [from, to];
    });
    // Count the lines before point in the hunk that are in the file wanted.
    gnista.gotoChar(Math.min(gnista.lineEndPosition() + 1, gnista.pointMax()));
    while (gnista.point() < here && gnista.point() > hunkStart) {
      const c = gnista.charAfter(gnista.point());
      if (c === " " || (old ? c === "-" : c === "+")) line++;
      gnista.gotoChar(Math.min(gnista.lineEndPosition() + 1, gnista.pointMax()));
    }
    return [old ? files[0]! : files[1]!, line];
  });
}

/** Goes to the source of the diff's line at point, in another window, as diff-goto-source. */
function gotoSource(old: boolean, select: boolean): void {
  const [file, line] = sourceLocation(old);
  const dir = String(gnista.variable("default-directory") ?? "");
  const path = gnista.expandFileName(file, dir || undefined);
  if (!gnista.fileExistsP(path)) gnista.userError(`Can't find the source file ${file}`);
  const buffer = gnista.findFileNoselect(path);
  const diffWindow = gnista.selectedWindow();
  gnista.call("switch-to-buffer-other-window", buffer);
  gnista.gotoChar(gnista.lineStart(Math.max(0, Math.min(line - 1, gnista.lineCount() - 1))));
  if (!select) gnista.selectWindow(diffWindow);
}

for (const [name, doc, run] of [
  ["diff-hunk-next", "Move to the next hunk; with a prefix argument, that many.", () => hunkNext(gnista.prefixNumericValue())],
  ["diff-hunk-prev", "Move to the hunk before; with a prefix argument, that many back.", () => hunkNext(-gnista.prefixNumericValue())],
  ["diff-file-next", "Move to the next file's part of the diff.", () => hunkNext(gnista.prefixNumericValue(), FILE, "file")],
  ["diff-file-prev", "Move to the file's part of the diff before.", () => hunkNext(-gnista.prefixNumericValue(), FILE, "file")],
  ["diff-goto-source", "Go to the line of the source this line of the diff is for, in another window; with a prefix argument, in the old file.", () => gotoSource(gnista.prefixArg() !== null, true)],
  ["diff-revert-buffer", "Run the diff again.", () => {
    const d = diffBuffers.get(gnista.bufferName());
    if (d !== undefined) diffNoSelect(d.oldFile, d.newFile, d.labels, gnista.bufferName());
  }],
] as const) {
  gnista.defineCommand({ name, doc, run });
}

gnista.defineMajorMode({
  name: "diff-mode",
  modeName: "Diff",
  doc: "The mode of a diff: n and p go between hunks, N and P between files, RET and o go to the source line, g runs the diff again, q quits.",
  bindings: {
    n: "diff-hunk-next",
    p: "diff-hunk-prev",
    "M-n": "diff-hunk-next",
    "M-p": "diff-hunk-prev",
    N: "diff-file-next",
    P: "diff-file-prev",
    "}": "diff-file-next",
    "{": "diff-file-prev",
    RET: "diff-goto-source",
    o: "diff-goto-source",
    "C-c C-c": "diff-goto-source",
    g: "diff-revert-buffer",
    q: "quit-window",
  } as Record<string, gnista.CommandName>,
  setup: () => {
    gnista.setReadOnly(true);
    gnista.addHook("jit-lock-functions", fontify, { local: true });
  },
});
// Files named as diffs and patches open in diff-mode, as auto-mode-alist has them.
const alist = gnista.defaultValue("auto-mode-alist");
gnista.setDefault("auto-mode-alist", [...(Array.isArray(alist) ? alist : []), ["\\.\\(?:diffs?\\|patch\\|rej\\)\\'", "diff-mode"]]);
