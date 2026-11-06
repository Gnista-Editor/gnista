// Magit, after Magit 4 (https://github.com/magit/magit): Git in a status
// buffer of sections. C-x g shows the repository: the branch and its
// upstream, untracked files, unstaged and staged changes as diffs, stashes
// and the commits not pushed. s stages and u unstages the file or hunk at
// point, k discards it, c commits, P pushes, F pulls, f fetches, b
// branches, l shows the log, z stashes, m merges, d shows diffs, g
// refreshes, $ shows the git commands run, q quits. The prefix keys open
// transient menus, as Magit's do.
//
// Commit messages are written in a COMMIT_EDITMSG buffer, C-c C-c to
// commit and C-c C-k to give up, as git-commit.el's are; Magit has git run
// Emacs as its editor for that, where E8 writes the message to a file
// for git commit -F.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, insertHeading, insertRoot, insertSection, magitSectionMode, sectionAt, sections, show, type Section } from "magit-section";
import { transientArgs, transientDefinePrefix, type Group } from "transient";
import { forwardLine, PerBuffer, truthy } from "subr";
import { withEditorEnv, withEditorFilter } from "with-editor";

// Faces.

const faces: [string, string, e8.FaceAttributes, e8.FaceAttributes?, e8.FaceAttributes?][] = [
  ["magit-branch-local", "Face for local branches.", {}, { foreground: "SkyBlue4" }, { foreground: "LightSkyBlue1" }],
  ["magit-branch-remote", "Face for remote branch head labels.", {}, { foreground: "DarkOliveGreen4" }, { foreground: "DarkSeaGreen2" }],
  ["magit-branch-current", "Face for the current branch.", { inherit: "magit-branch-local", box: true } as e8.FaceAttributes],
  ["magit-hash", "Face for the commit object name in the log output.", {}, { foreground: "grey60" }, { foreground: "grey40" }],
  ["magit-tag", "Face for tag labels shown in log buffer.", {}, { foreground: "Goldenrod4" }, { foreground: "LightGoldenrod2" }],
  ["magit-head", "Face for the symbolic ref HEAD.", { inherit: "magit-branch-local" }],
  ["magit-filename", "Face for filenames.", { weight: "normal" }],
  ["magit-dimmed", "Face for text that shouldn't stand out.", {}, { foreground: "grey50" }, { foreground: "grey50" }],
  ["magit-log-author", "Face for the author part of the log output.", {}, { foreground: "firebrick" }, { foreground: "tomato" }],
  ["magit-log-date", "Face for the date part of the log output.", {}, { foreground: "grey30" }, { foreground: "grey80" }],
  ["magit-diff-file-heading", "Face for diff file headings.", { extend: true, weight: "bold" }],
  ["magit-diff-hunk-heading", "Face for diff hunk headings.", { extend: true }, { background: "grey90", foreground: "grey20" }, { background: "grey25", foreground: "grey95" }],
  ["magit-diff-added", "Face for lines in a diff that have been added.", { extend: true }, { background: "#ddffdd", foreground: "#22aa22" }, { background: "#335533", foreground: "#ddffdd" }],
  ["magit-diff-removed", "Face for lines in a diff that have been removed.", { extend: true }, { background: "#ffdddd", foreground: "#aa2222" }, { background: "#553333", foreground: "#ffdddd" }],
  ["magit-diff-context", "Face for lines in a diff that are unchanged.", { extend: true }, { foreground: "grey50" }, { foreground: "grey70" }],
  ["magit-process-ok", "Face for zero exit-status.", { inherit: "magit-section-heading", foreground: "green" } as e8.FaceAttributes],
  ["magit-process-ng", "Face for non-zero exit-status.", { inherit: "magit-section-heading", foreground: "red" } as e8.FaceAttributes],
];
for (const [name, doc, attributes, light, dark] of faces) e8.defineFace({ name, doc, attributes, light, dark });

e8.defineVariable({ name: "magit-git-executable", doc: "The Git executable used by Magit.", value: "git" });
e8.defineVariable({ name: "magit-log-section-commit-count", doc: "How many recent commits the status buffer shows.", value: 10 });
e8.defineVariable({ name: "magit-save-repository-buffers", doc: "Whether to save the repository's modified file buffers before running git, as Magit asks.", value: true });

// Running git.

/** The repository's top directory, with a slash, for DIR or the current buffer's directory, as magit-toplevel. */
export function toplevel(dir = String(e8.variable("default-directory") ?? ".")): string | undefined {
  const r = e8.callProcess([git(), "rev-parse", "--show-toplevel"], { directory: e8.expandFileName(dir) });
  return r.exit === 0 ? e8.fileNameAsDirectory(r.output.trim()) : undefined;
}

const git = (): string => String(e8.variable("magit-git-executable") ?? "git");

/** The repository the current buffer belongs to, as Magit's buffers keep it in default-directory. */
function repo(): string {
  const top = toplevel();
  if (!top) e8.userError(`Not inside a Git repository: ${e8.abbreviateFileName(String(e8.variable("default-directory")))}`);
  return top!;
}

/** The commands run and their output, for $ to show, as the magit-process buffer has them. */
const processLog: { args: string[]; exit: number; output: string; dir: string }[] = [];

/** Runs git with ARGS in the repository and gives its output, as magit-git-string and magit-git-lines. */
export function gitOutput(args: string[], input?: string, dir = repo()): { exit: number; output: string } {
  return e8.callProcess([git(), "--no-pager", "--literal-pathspecs", "-c", "core.preloadindex=true", "-c", "log.showSignature=false", "-c", "color.ui=false", "-c", "color.diff=false", ...args], { directory: dir, input });
}

const gitString = (args: string[]): string | undefined => {
  const r = gitOutput(args);
  return r.exit === 0 ? r.output.replace(/\n$/, "") : undefined;
};
const gitLines = (args: string[]): string[] => {
  const r = gitOutput(args);
  return r.exit === 0 ? r.output.split("\n").filter((l) => l !== "") : [];
};

/** Runs git for its effect, logging it for $, and refreshes the status, as magit-run-git; an error says what git said. */
export function runGit(args: string[], input?: string): boolean {
  saveRepositoryBuffers();
  const dir = repo();
  const r = gitOutput(args, input, dir);
  processLog.push({ args, exit: r.exit, output: r.output, dir });
  refreshAll();
  if (r.exit !== 0) {
    const line = r.output.split("\n").find((l) => l.trim() !== "") ?? `git exited with code ${r.exit}`;
    e8.message(`${line.replace(/^(error|fatal): /, "")} ... [Hit $ to see buffer magit-process: ${e8.fileNameNondirectory(dir.replace(/\/$/, ""))} for details]`);
    return false;
  }
  return true;
}

/** Runs git without waiting, as push and pull do, logging its output and refreshing when it ends, as magit-run-git-async. */
export function runGitAsync(args: string[], what: string, editor = false, env: { [name: string]: string } = {}): void {
  saveRepositoryBuffers();
  const dir = repo();
  const entry = { args, exit: -1, output: "", dir };
  processLog.push(entry);
  e8.message(`Running git ${args.join(" ")}`);
  const collect = (_p: string, output: string) => {
    entry.output += output;
  };
  e8.makeProcess({
    name: "magit-git",
    command: [git(), "--no-pager", "-c", "color.ui=false", ...args],
    directory: dir,
    // With an editor, git asks E8 to edit its messages and lists, as magit-run-git-with-editor.
    env: { GIT_TERMINAL_PROMPT: "0", ...(editor ? withEditorEnv() : {}), ...env },
    connectionType: "pipe",
    filter: editor ? withEditorFilter(collect) : collect,
    sentinel: (_p, event) => {
      entry.exit = event.startsWith("finished") ? 0 : Number(/code (\d+)/.exec(event)?.[1] ?? 1);
      e8.withCurrentBuffer(e8.currentBuffer(), () => refreshAll(dir));
      if (entry.exit === 0) e8.message(`${what}...done`);
      else e8.message(`${(entry.output.split("\n").find((l) => l.trim()) ?? what).replace(/^(error|fatal): /, "")} ... [Hit $ to see buffer magit-process for details]`);
    },
  });
}

/** Saves the repository's modified file buffers first, as magit-save-repository-buffers. */
function saveRepositoryBuffers(): void {
  if (!truthy(e8.variable("magit-save-repository-buffers"))) return;
  const top = toplevel();
  if (!top) return;
  for (const b of e8.bufferList()) {
    e8.withCurrentBuffer(b, () => {
      const f = e8.bufferFileName();
      if (f && e8.bufferModified() && e8.expandFileName(f).startsWith(top)) e8.call("save-buffer");
    });
  }
}

// Inserting the status buffer.

const face = (text: string, f: string): e8.PropertizedString => e8.propertize(text, { face: f });

/** A ref as Magit shows it in a log line, from %D's decorations, as magit-format-ref-labels. */
function refLabels(decorations: string): e8.PropertizedString | string {
  const parts: e8.PropertizedString[] = [];
  for (const d of decorations.split(", ").filter((x) => x !== "")) {
    if (d.startsWith("HEAD -> ")) parts.push(face(d.slice(8), "magit-branch-current"));
    else if (d === "HEAD") parts.push(face("@", "magit-head"));
    else if (d.startsWith("tag: ")) parts.push(face(d.slice(5), "magit-tag"));
    else if (d.endsWith("/HEAD")) continue;
    else if (d.includes("/")) parts.push(face(d, "magit-branch-remote"));
    else parts.push(face(d, "magit-branch-local"));
  }
  return parts.length === 0 ? "" : e8.concat(...parts.flatMap((p, i) => (i === 0 ? [p] : [" ", p])), " ");
}

/** Inserts commits as a section's lines, hash, refs and subject, as magit-insert-log does in the status buffer. */
function insertCommits(range: string[]): number {
  const lines = gitLines(["log", "--format=%h%x00%D%x00%s", ...range, "--"]);
  for (const line of lines) {
    const [hash, refs, subject] = line.split("\0");
    insertSection("commit", hash, false, () => {
      insertHeading(face(hash, "magit-hash"), " ", refLabels(refs), subject, "\n");
    });
  }
  return lines.length;
}

/** The branch HEAD is on, or undefined if detached. */
const currentBranch = (): string | undefined => gitString(["symbolic-ref", "--short", "-q", "HEAD"]);
/** The upstream of BRANCH, as origin/main. */
const upstreamOf = (branch?: string): string | undefined => (branch ? gitString(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]) : undefined);

/** The status buffer's header lines: Head, Merge and Push, as magit-insert-status-headers. */
function insertHeaders(): void {
  const branch = currentBranch();
  const subject = gitString(["log", "-1", "--format=%s"]);
  const label = (s: string) => s.padEnd(10);
  const headLabel = branch ? face(branch, "magit-branch-local") : face(gitString(["rev-parse", "--short", "HEAD"]) ?? "", "magit-hash");
  e8.insert(e8.concat(label("Head:"), headLabel, subject !== undefined ? ` ${subject}` : " nothing committed (yet)", "\n"));
  const upstream = upstreamOf(branch);
  if (upstream) {
    const usubject = gitString(["log", "-1", "--format=%s", upstream]);
    const kind = gitString(["config", `branch.${branch}.rebase`]) === "true" ? "Rebase:" : "Merge:";
    e8.insert(e8.concat(label(kind), face(upstream, "magit-branch-remote"), usubject !== undefined ? ` ${usubject}` : "", "\n"));
  }
  const pushRemote = branch ? (gitString(["config", `branch.${branch}.pushRemote`]) ?? gitString(["config", "remote.pushDefault"])) : undefined;
  if (pushRemote && branch && `${pushRemote}/${branch}` !== upstream) {
    const target = `${pushRemote}/${branch}`;
    const psubject = gitString(["log", "-1", "--format=%s", target]);
    e8.insert(e8.concat(label("Push:"), face(target, "magit-branch-remote"), psubject !== undefined ? ` ${psubject}` : "", "\n"));
  }
  const tag = gitString(["describe", "--tags", "--abbrev=0"]);
  if (tag) {
    const count = gitString(["rev-list", "--count", `${tag}..HEAD`]);
    e8.insert(e8.concat(label("Tag:"), face(tag, "magit-tag"), count && count !== "0" ? ` (${count})` : "", "\n"));
  }
}

/** A file's change as git diff --name-status words it, as Magit's file headings do: modified, new file, deleted, renamed. */
const statusWords: { [k: string]: string } = { M: "modified", A: "new file", D: "deleted", R: "renamed", C: "copied", T: "new type", U: "unmerged" };

/** A file's diff: its heading and hunks. */
interface FileDiff {
  file: string;
  orig?: string;
  status: string;
  header: string[];
  hunks: { heading: string; lines: string[] }[];
}

/** Parses git diff's output into files and hunks, as magit-diff-wash-diffs does. */
function parseDiff(output: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let hunk: { heading: string; lines: string[] } | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/.exec(line);
      cur = { file: m?.[2] ?? line.slice(11), status: "modified", header: [line], hunks: [] };
      files.push(cur);
      hunk = undefined;
    } else if (!cur) {
      continue;
    } else if (line.startsWith("@@")) {
      hunk = { heading: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      if (line !== "" || hunk.lines.length === 0 || true) hunk.lines.push(line);
    } else {
      cur.header.push(line);
      if (line.startsWith("new file")) cur.status = "new file";
      else if (line.startsWith("deleted file")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.status = "renamed";
        cur.orig = line.slice(12);
      } else if (line.startsWith("Binary files")) cur.hunks = [];
    }
  }
  // The newline that ends the output is no line of the last hunk.
  for (const f of files) for (const h of f.hunks) while (h.lines.length > 0 && h.lines[h.lines.length - 1] === "") h.lines.pop();
  return files;
}

/** Inserts the files of a diff, each hidden with its hunks, as magit-insert-diff and the washers do. */
function insertFiles(diffs: FileDiff[], kind: "unstaged" | "staged" | "commit"): void {
  for (const d of diffs) {
    insertSection("file", { file: d.file, diff: d, kind }, kind !== "commit", () => {
      const word = (statusWords[d.status[0]?.toUpperCase()] ?? d.status).padEnd(11);
      insertHeading(face(`${word}${d.orig ? `${d.orig} -> ` : ""}${d.file}`, "magit-diff-file-heading"), "\n");
      for (const h of d.hunks) {
        insertSection("hunk", { file: d.file, diff: d, hunk: h, kind }, false, () => {
          insertHeading(face(h.heading, "magit-diff-hunk-heading"), "\n");
          for (const l of h.lines) {
            const f = l.startsWith("+") ? "magit-diff-added" : l.startsWith("-") ? "magit-diff-removed" : "magit-diff-context";
            e8.insert(face(`${l}\n`, f));
          }
        });
      }
    });
  }
}

/** Whether HEAD names a commit yet. */
const hasCommits = (): boolean => gitOutput(["rev-parse", "--verify", "-q", "HEAD"]).exit === 0;

/** Inserts the status buffer, as magit-status-refresh-buffer and magit-status-sections-hook. */
function insertStatus(): void {
  insertRoot("status", () => {
    insertHeaders();
    e8.insert("\n");
    const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]);
    // Each section ends with the blank line after it, which hides with it, as Magit inserts it.
    if (untracked.length > 0) {
      insertSection("untracked", undefined, true, () => {
        insertHeading(face("Untracked files", "magit-section-heading"), ` (${untracked.length})`, "\n");
        for (const f of untracked) insertSection("file", { file: f, kind: "untracked" }, false, () => insertHeading(face(f, "magit-filename"), "\n"));
        e8.insert("\n");
      });
    }
    const unstaged = parseDiff(gitOutput(["diff", "--no-ext-diff", "--no-prefix", "-p"]).output);
    if (unstaged.length > 0) {
      insertSection("unstaged", undefined, false, () => {
        insertHeading(face("Unstaged changes", "magit-section-heading"), ` (${unstaged.length})`, "\n");
        insertFiles(unstaged, "unstaged");
        e8.insert("\n");
      });
    }
    const staged = parseDiff(gitOutput(["diff", "--cached", "--no-ext-diff", "--no-prefix", "-p"]).output);
    if (staged.length > 0) {
      insertSection("staged", undefined, false, () => {
        insertHeading(face("Staged changes", "magit-section-heading"), ` (${staged.length})`, "\n");
        insertFiles(staged, "staged");
        e8.insert("\n");
      });
    }
    const stashes = gitLines(["stash", "list", "--format=%gd%x00%gs"]);
    if (stashes.length > 0) {
      insertSection("stashes", undefined, true, () => {
        insertHeading(face("Stashes", "magit-section-heading"), ` (${stashes.length})`, "\n");
        for (const s of stashes) {
          const [ref, subject] = s.split("\0");
          insertSection("stash", ref, false, () => insertHeading(face(ref, "magit-hash"), ` ${subject}`, "\n"));
        }
        e8.insert("\n");
      });
    }
    const branch = currentBranch();
    const upstream = upstreamOf(branch);
    if (upstream && gitLines(["rev-list", `${upstream}..HEAD`]).length > 0) {
      insertSection("unpushed", upstream, false, () => {
        const n = gitLines(["rev-list", `${upstream}..HEAD`]).length;
        insertHeading(face("Unmerged into ", "magit-section-heading"), face(upstream, "magit-branch-remote"), ` (${n})`, "\n");
        insertCommits([`${upstream}..HEAD`]);
        e8.insert("\n");
      });
    } else if (!upstream && hasCommits()) {
      insertSection("recent", undefined, true, () => {
        insertHeading(face("Recent commits", "magit-section-heading"), "\n");
        insertCommits([`-${Number(e8.variable("magit-log-section-commit-count") ?? 10)}`]);
        e8.insert("\n");
      });
    }
    if (upstream && gitLines(["rev-list", `HEAD..${upstream}`]).length > 0) {
      insertSection("unpulled", upstream, false, () => {
        const n = gitLines(["rev-list", `HEAD..${upstream}`]).length;
        insertHeading(face("Unpulled from ", "magit-section-heading"), face(upstream, "magit-branch-remote"), ` (${n})`, "\n");
        insertCommits([`HEAD..${upstream}`]);
        e8.insert("\n");
      });
    }
  });
}

// Buffers.

/** What each Magit buffer shows and how to make it again. */
const buffers = new PerBuffer<{ kind: string; refresh: () => void }>();

/** Makes or shows a Magit buffer for the repository, as magit-setup-buffer: NAME, its mode, and what refreshes it. */
function setupBuffer(name: string, mode: e8.DefinedCommand, kind: string, refresh: () => void, select = true): string {
  const dir = repo();
  const existed = e8.bufferLiveP(e8.getBuffer(name));
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    if (!existed) {
      e8.call(mode);
      e8.makeLocalVariable("default-directory");
      e8.setVariable("default-directory", dir);
    }
    buffers.set(e8.currentBuffer(), { kind, refresh });
    refreshBuffer();
  });
  if (select) e8.call("switch-to-buffer", name);
  return name;
}

/** Makes the current Magit buffer again, keeping point on the same section, as magit-refresh-buffer. */
function refreshBuffer(): void {
  const entry = buffers.get(e8.currentBuffer());
  if (!entry) return;
  const at = currentSection();
  const line = e8.lineOf(e8.point());
  const id = at ? sectionPath(at) : undefined;
  e8.letBind({ "inhibit-read-only": true }, () => entry.refresh());
  const again = id ? (sections()?.all ?? []).find((s) => sectionPath(s) === id) : undefined;
  if (again) e8.gotoChar(again.start);
  else e8.gotoChar(e8.lineStart(Math.min(line, e8.lineCount() - 1)));
  e8.setBufferModified(false);
}

const sectionPath = (s: Section): string => {
  const parts: string[] = [];
  for (let x: Section | undefined = s; x && x.parent; x = x.parent) {
    const v = x.value as { file?: string; hunk?: { heading: string } } | string | undefined;
    parts.unshift(`${x.type}:${typeof v === "string" ? v : (v?.file ?? "")}${typeof v === "object" && v?.hunk ? v.hunk.heading : ""}`);
  }
  return parts.join("/");
};

/** Refreshes every Magit buffer of the repository, as magit-refresh does after a command. */
function refreshAll(dir = toplevel()): void {
  for (const b of e8.bufferList()) {
    const buf = e8.getBuffer(b);
    if (!buf || !buffers.get(buf)) continue;
    e8.withCurrentBuffer(b, () => {
      if (toplevel() === dir) refreshBuffer();
    });
  }
}

const repoName = (dir: string): string => e8.fileNameNondirectory(dir.replace(/\/$/, ""));

// Modes.

const modeBindings: { [keys: string]: string } = {};

export const magitMode = e8.defineMajorMode({
  name: "magit-mode",
  modeName: "Magit",
  parent: magitSectionMode,
  doc: "Parent major mode of Magit's buffers.",
});

export const magitStatusMode = e8.defineMajorMode({ name: "magit-status-mode", modeName: "Magit", parent: magitMode, doc: "Mode for looking at Git status: the files changed, staged and untracked, and the commits." });
export const magitLogMode = e8.defineMajorMode({ name: "magit-log-mode", modeName: "Magit Log", parent: magitMode, doc: "Mode for looking at Git log." });
export const magitRevisionMode = e8.defineMajorMode({ name: "magit-revision-mode", modeName: "Magit Rev", parent: magitMode, doc: "Mode for looking at a Git commit." });
export const magitDiffMode = e8.defineMajorMode({ name: "magit-diff-mode", modeName: "Magit Diff", parent: magitMode, doc: "Mode for looking at a Git diff." });
export const magitProcessMode = e8.defineMajorMode({ name: "magit-process-mode", modeName: "Magit Process", parent: magitMode, doc: "Mode for looking at Git process output." });
void modeBindings;

/** Shows the status of the repository, as magit-status. */
export const magitStatus = e8.defineCommand({
  name: "magit-status",
  doc: "Show the status of the current Git repository in a buffer: the branch, the changes and the commits not pushed.",
  run: () => {
    const dir = toplevel();
    if (!dir) {
      const answer = e8.readFileName("Initialize Git repository: ", { dir: String(e8.variable("default-directory")) });
      if (!e8.yOrNP(`Create repository in ${answer}? `)) e8.userError("Abort");
      e8.callProcess([git(), "init", e8.expandFileName(answer)]);
      e8.letBind({ "default-directory": e8.fileNameAsDirectory(e8.expandFileName(answer)) }, () => e8.call(magitStatus));
      return;
    }
    e8.letBind({ "default-directory": dir }, () => {
      setupBuffer(`magit: ${repoName(dir)}`, magitStatusMode, "status", insertStatus);
    });
    // Point starts on the first section after the headers, as Magit puts it.
    const first = sections()?.root.children[0];
    if (first) e8.gotoChar(first.start);
  },
});

const refreshCommand = e8.defineCommand({ name: "magit-refresh", doc: "Refresh the current buffer.", run: () => refreshBuffer() });
const refreshAllCommand = e8.defineCommand({ name: "magit-refresh-all", doc: "Refresh all buffers belonging to the current repository.", run: () => refreshAll() });

// Applying: staging, unstaging and discarding.

interface FileValue {
  file: string;
  kind: "untracked" | "unstaged" | "staged" | "commit";
  diff?: FileDiff;
  hunk?: { heading: string; lines: string[] };
}

/** The file or hunk at point, or the files of the section at point, as magit-apply's targets. */
function targets(): { section: Section; values: FileValue[] } | undefined {
  const s = currentSection();
  if (!s) return undefined;
  if (s.type === "file" || s.type === "hunk") return { section: s, values: [s.value as FileValue] };
  if (s.type === "untracked" || s.type === "unstaged" || s.type === "staged") return { section: s, values: s.children.map((c) => c.value as FileValue) };
  return { section: s, values: [] };
}

/** The patch for a hunk, with its file's header, for git apply. */
function hunkPatch(v: FileValue): string {
  const header = v.diff!.header.filter((l) => /^(diff --git|--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|index )/.test(l));
  return [...header, v.hunk!.heading, ...v.hunk!.lines, ""].join("\n");
}

/**
 * The patch for the lines of a hunk the region covers, as
 * magit-diff-hunk-region-patch makes it: the other lines changed are left
 * as they are, a removal kept as context and an addition dropped, the other
 * way round for a patch applied in REVERSE, and the counts made again.
 */
function regionPatch(v: FileValue, from: number, to: number, reverse: boolean): string {
  const header = v.diff!.header.filter((l) => /^(diff --git|--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|index )/.test(l));
  const [drop, keep] = reverse ? ["-", "+"] : ["+", "-"];
  const lines: string[] = [];
  v.hunk!.lines.forEach((l, i) => {
    const inside = i >= from && i <= to;
    if (inside || l.startsWith(" ") || l.startsWith("\\")) lines.push(l);
    else if (l.startsWith(keep)) lines.push(` ${l.slice(1)}`);
    else if (l.startsWith(drop)) return;
    else lines.push(l);
  });
  const old = lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
  const now = lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(v.hunk!.heading);
  const start = m ? Number(m[1]) : 1;
  return [...header, `@@ -${start},${old} +${reverse ? Number(m?.[2] ?? start) : start},${now} @@${m?.[3] ?? ""}`, ...lines, ""].join("\n");
}

/** The lines of the hunk at point the active region covers, as indices of its lines, or undefined without a region in a hunk. */
function regionLines(s: Section): [number, number] | undefined {
  const mark = e8.mark();
  if (s.type !== "hunk" || !e8.regionActive() || mark === undefined) return undefined;
  const [a, b] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  const first = e8.lineOf(s.content);
  const from = Math.max(0, e8.lineOf(a) - first);
  // A region ending at the start of a line leaves that line out.
  const end = b > a && b === e8.lineBeginningPosition(b) ? b - 1 : b;
  const to = e8.lineOf(end) - first;
  return to >= 0 ? [from, to] : undefined;
}

export const magitStage = e8.defineCommand({
  name: "magit-stage",
  doc: "Add the change at point to the staging area: an untracked or changed file, or a hunk.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) e8.userError("Nothing to stage");
    const lines = regionLines(t.section);
    for (const v of t.values) {
      if (v.kind === "staged") e8.userError("Already staged");
      if (v.hunk && lines) {
        runGit(["apply", "--cached", "-p0", "--recount", "-"], regionPatch(v, lines[0], lines[1], false));
        e8.deactivateMark();
      } else if (v.hunk) runGit(["apply", "--cached", "-p0", "--ignore-space-change", "-"], hunkPatch(v));
      else runGit(["add", "--", v.file]);
    }
  },
});

export const magitUnstage = e8.defineCommand({
  name: "magit-unstage",
  doc: "Remove the change at point from the staging area: a staged file or hunk.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) e8.userError("Nothing to unstage");
    const lines = regionLines(t.section);
    for (const v of t.values) {
      if (v.kind !== "staged") e8.userError("Already unstaged");
      if (v.hunk && lines) {
        runGit(["apply", "--cached", "--reverse", "-p0", "--recount", "-"], regionPatch(v, lines[0], lines[1], true));
        e8.deactivateMark();
      } else if (v.hunk) runGit(["apply", "--cached", "--reverse", "-p0", "-"], hunkPatch(v));
      else if (hasCommits()) runGit(["reset", "-q", "--", v.file]);
      else runGit(["rm", "--cached", "-q", "--", v.file]);
    }
  },
});

const stageModified = e8.defineCommand({
  name: "magit-stage-modified",
  doc: "Stage all changes to files tracked in the repository; with a prefix argument, untracked files too.",
  params: [{ name: "all", kind: "prefix" }],
  run: (all: e8.Value) => void runGit(["add", truthy(all) ? "--all" : "-u", "."]),
});

const unstageAll = e8.defineCommand({
  name: "magit-unstage-all",
  doc: "Remove all changes from the staging area.",
  run: () => void runGit(hasCommits() ? ["reset", "-q", "HEAD", "--"] : ["rm", "--cached", "-r", "-q", "."]),
});

export const magitDiscard = e8.defineCommand({
  name: "magit-discard",
  doc: "Remove the change at point from the working tree, or the index for a staged one: an untracked file is deleted.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) e8.userError("Nothing to discard");
    const what = t.values.length === 1 ? (t.values[0].hunk ? "hunk" : t.values[0].file) : `${t.values.length} files`;
    const kind = t.values[0].kind;
    const verb = kind === "untracked" ? "Delete" : "Discard";
    if (!e8.yOrNP(`${verb} ${what}? `)) e8.userError("Abort");
    for (const v of t.values) {
      if (v.kind === "untracked") {
        e8.deleteFile(e8.expandFileName(v.file, repo()));
        refreshAll();
      } else if (v.hunk) {
        runGit(v.kind === "staged" ? ["apply", "--cached", "--reverse", "-p0", "-"] : ["apply", "--reverse", "-p0", "-"], hunkPatch(v));
      } else if (v.kind === "staged") {
        runGit(["reset", "-q", "--", v.file]);
        runGit(["checkout", "--", v.file]);
      } else {
        runGit(["checkout", "--", v.file]);
      }
    }
  },
});

/** Visits the file at point, at the line of the hunk line point is on, as magit-diff-visit-file. */
export const magitVisitThing = e8.defineCommand({
  name: "magit-visit-thing",
  doc: "Visit the thing at point: a file at the line point is on in its diff, a commit, a stash.",
  run: () => {
    const s = currentSection();
    if (!s) e8.userError("There is no thing at point that could be visited");
    if (s.type === "commit") {
      showCommit(String(s.value));
      return;
    }
    if (s.type === "stash") {
      showCommit(String(s.value));
      return;
    }
    const v = s.value as FileValue | undefined;
    if (!v?.file) e8.userError("There is no thing at point that could be visited");
    let line = 1;
    if (v.hunk) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(v.hunk.heading);
      line = Number(m?.[1] ?? 1);
      const here = e8.lineOf(e8.point());
      const first = e8.lineOf(s.content);
      for (let i = 0; i < here - first && i < v.hunk.lines.length; i++) if (!v.hunk.lines[i].startsWith("-")) line++;
    }
    const dir = repo();
    e8.call("find-file", e8.expandFileName(v.file, dir));
    e8.gotoChar(e8.lineStart(Math.max(0, Math.min(line - 1, e8.lineCount() - 1))));
  },
});

// Committing, after magit-commit.el and git-commit.el.

e8.defineVariable({ name: "git-commit-summary-max-length", doc: "Column beyond which characters in the summary line are highlighted.", value: 68 });
e8.defineFace({ name: "git-commit-summary", doc: "Face used for the summary in commit messages.", attributes: { inherit: "font-lock-type-face" } });
e8.defineFace({ name: "git-commit-comment-heading", doc: "Face used for headings in commit message comments.", attributes: { inherit: "git-commit-keyword" } });
e8.defineFace({ name: "git-commit-keyword", doc: "Face used for keywords in commit messages.", attributes: { inherit: "font-lock-string-face" } });

/** The diff a commit makes, shown beside its message, as magit-commit-diff; the buffer, to take away when done. */
let commitDiff: string | undefined;
/** Whether the commit being written amends the last one, for the diff to show. */
let amending = false;

/** Runs git commit with ARGS, its message written in COMMIT_EDITMSG through with-editor, as magit-commit-create. */
function editCommit(args: string[], amend = false): void {
  amending = amend;
  runGitAsync(["commit", ...args], "Committing", true);
}

/** Shows what the commit makes beside its message, as magit-commit-diff does when COMMIT_EDITMSG is visited. */
function showCommitDiff(): void {
  if (!/\/COMMIT_EDITMSG$/.test(e8.bufferFileName() ?? "")) return;
  const window = e8.selectedWindow();
  const staged = amending ? gitOutput(["diff", "--no-prefix", "-p", "HEAD^", "--cached"]) : gitOutput(["diff", "--cached", "--no-prefix", "-p"]);
  if (!staged.output.trim()) return;
  commitDiff = setupBuffer(`magit-diff: ${repoName(repo())}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(staged.output), "commit")), false);
  e8.call("display-buffer", commitDiff);
  e8.selectWindow(window);
}

/** Takes the commit's diff away once the message is done with. */
function hideCommitDiff(): void {
  if (!commitDiff || !e8.bufferLiveP(e8.getBuffer(commitDiff))) return;
  const w = e8.windowList().find((x) => e8.windowBuffer(x) === commitDiff);
  if (w !== undefined && e8.windowList().length > 1) e8.deleteWindow(w);
  e8.call("kill-buffer", commitDiff);
  commitDiff = undefined;
}

e8.addHook("with-editor-filter-visit-hook", showCommitDiff);
e8.addHook("with-editor-post-finish-hook", hideCommitDiff);
e8.addHook("with-editor-post-cancel-hook", hideCommitDiff);
e8.setDefault("with-editor-file-modes", [
  ...((e8.variable("with-editor-file-modes") as string[][] | null) ?? []),
  ["/\\(?:COMMIT\\|MERGE\\|TAG\\)_EDITMSG\\'", "git-commit-mode"],
  ["/git-rebase-todo\\'", "git-rebase-mode"],
]);

/** Highlights the summary line and comments, as git-commit-mode's font-lock keywords. */
function fontifyCommit(start: number, end: number): void {
  e8.withSilentModifications(() => {
    for (let line = e8.lineOf(start); line <= e8.lineOf(Math.max(start, end - 1)); line++) {
      const ls = e8.lineStart(line);
      const le = e8.lineEnd(line);
      const text = e8.lineText(line);
      if (text.startsWith("#")) e8.putTextProperty(ls, le, "face", "font-lock-comment-face");
      else if (line === 0) {
        const max = Number(e8.variable("git-commit-summary-max-length") ?? 68);
        e8.putTextProperty(ls, Math.min(le, ls + max), "face", "git-commit-summary");
        if (le > ls + max) e8.putTextProperty(ls + max, le, "face", "font-lock-warning-face");
      }
    }
  });
}

export const gitCommitMode = e8.defineMajorMode({
  name: "git-commit-mode",
  modeName: "Git-Commit",
  parent: "text-mode",
  doc: "Major mode for editing git commit messages: C-c C-c commits, C-c C-k cancels.",
  setup: () => {
    e8.makeLocalVariable("fill-column");
    e8.setVariable("fill-column", 72);
    e8.addHook("jit-lock-functions", fontifyCommit, { local: true });
  },
});

const commitArgs = (): string[] => transientArgs("magit-commit");

const commitCreate = e8.defineCommand({
  name: "magit-commit-create",
  doc: "Create a new commit on HEAD, writing its message in a buffer.",
  run: () => {
    const args = commitArgs();
    if (!args.includes("--all") && !args.includes("--allow-empty") && gitOutput(["diff", "--cached", "--quiet"]).exit === 0) {
      if (gitOutput(["diff", "--quiet"]).exit !== 0 && e8.yOrNP("Nothing staged.  Commit all uncommitted changes? ")) args.push("--all");
      else e8.userError("Nothing staged");
    }
    editCommit(args);
  },
});

const commitAmend = e8.defineCommand({
  name: "magit-commit-amend",
  doc: "Amend the last commit, with the staged changes and an edited message.",
  run: () => editCommit(["--amend", ...commitArgs()], true),
});

const commitExtend = e8.defineCommand({
  name: "magit-commit-extend",
  doc: "Amend the last commit with the staged changes, keeping its message.",
  run: () => void runGit(["commit", "--amend", "--no-edit", ...commitArgs()]),
});

const commitReword = e8.defineCommand({
  name: "magit-commit-reword",
  doc: "Reword the last commit, ignoring the staged changes.",
  run: () => editCommit(["--amend", "--only", ...commitArgs()], true),
});


// Branches, after magit-branch.el.

const localBranches = (): string[] => gitLines(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
const remoteBranches = (): string[] => gitLines(["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).filter((b) => !b.endsWith("/HEAD"));

/** Reads a branch or commit, as magit-read-branch-or-commit. */
function readBranch(prompt: string, choices = [...localBranches(), ...remoteBranches()], def?: string): string {
  const answer = e8.completingRead(def ? `${prompt} (default ${def}): ` : `${prompt}: `, choices, { default: def, history: "magit-revision-history" });
  if (answer === "") e8.userError("Nothing selected");
  return answer;
}
e8.defineVariable({ name: "magit-revision-history", doc: "Branches and commits Magit read.", value: [] });

const branchCheckout = e8.defineCommand({
  name: "magit-checkout",
  doc: "Check out a branch or commit.",
  run: () => {
    const cur = currentBranch();
    const target = readBranch("Checkout", [...localBranches().filter((b) => b !== cur), ...remoteBranches()]);
    const local = remoteBranches().includes(target) && !localBranches().includes(target.replace(/^[^/]+\//, "")) ? ["-b", target.replace(/^[^/]+\//, ""), "--track", target] : [target];
    runGit(["checkout", ...local]);
  },
});

const branchCreateCheckout = e8.defineCommand({
  name: "magit-branch-and-checkout",
  doc: "Create a branch starting at a commit and check it out.",
  run: () => {
    const start = readBranch("Create and checkout branch starting at", [...localBranches(), ...remoteBranches()], currentBranch());
    const name = e8.readString("Name for new branch: ");
    if (name === "") e8.userError("No name given");
    runGit(["checkout", "-b", name, start]);
  },
});

const branchCreate = e8.defineCommand({
  name: "magit-branch-create",
  doc: "Create a branch starting at a commit, without checking it out.",
  run: () => {
    const start = readBranch("Create branch starting at", [...localBranches(), ...remoteBranches()], currentBranch());
    const name = e8.readString("Name for new branch: ");
    if (name === "") e8.userError("No name given");
    runGit(["branch", name, start]);
  },
});

const branchDelete = e8.defineCommand({
  name: "magit-branch-delete",
  doc: "Delete a branch; one not merged is deleted only if confirmed.",
  run: () => {
    const name = readBranch("Delete branch", localBranches().filter((b) => b !== currentBranch()));
    if (!runGit(["branch", "-d", name]) && e8.yOrNP(`Delete unmerged branch ${name}? `)) runGit(["branch", "-D", name]);
  },
});

const branchRename = e8.defineCommand({
  name: "magit-branch-rename",
  doc: "Rename a branch.",
  run: () => {
    const old = readBranch("Rename branch", localBranches(), currentBranch());
    const name = e8.readString(`Rename branch '${old}' to: `);
    if (name === "") e8.userError("No name given");
    runGit(["branch", "-m", old, name]);
  },
});


// Pushing, pulling and fetching, after magit-push.el, magit-pull.el and magit-fetch.el.

const remotes = (): string[] => gitLines(["remote"]);

/** The upstream of the current branch, asking for one to set if there is none, as magit-push-current-to-upstream does. */
function ensureUpstream(verb: string): [string, string, boolean] {
  const branch = currentBranch();
  if (!branch) e8.userError("No branch is checked out");
  const upstream = upstreamOf(branch);
  if (upstream) {
    const [remote, ...rest] = upstream.split("/");
    return [remote, rest.join("/"), false];
  }
  const choice = readBranch(`Set upstream of ${branch} and ${verb} there`, remoteBranches().length > 0 ? remoteBranches() : remotes().map((r) => `${r}/${branch}`), remotes()[0] ? `${remotes()[0]}/${branch}` : undefined);
  const [remote, ...rest] = choice.split("/");
  return [remote, rest.join("/") || branch!, true];
}

const pushArgs = (): string[] => transientArgs("magit-push");

const pushUpstream = e8.defineCommand({
  name: "magit-push-current-to-upstream",
  doc: "Push the current branch to its upstream, setting one first if there is none.",
  run: () => {
    const branch = currentBranch()!;
    const [remote, target, set] = ensureUpstream("push");
    runGitAsync(["push", "-v", ...pushArgs(), ...(set ? ["--set-upstream"] : []), remote, `${branch}:refs/heads/${target}`], `Pushing to ${remote}/${target}`);
  },
});

const pushPushRemote = e8.defineCommand({
  name: "magit-push-current-to-pushremote",
  doc: "Push the current branch to its push remote, by default the upstream's remote.",
  run: () => {
    const branch = currentBranch();
    if (!branch) e8.userError("No branch is checked out");
    const remote = gitString(["config", `branch.${branch}.pushRemote`]) ?? gitString(["config", "remote.pushDefault"]) ?? upstreamOf(branch)?.split("/")[0] ?? remotes()[0];
    if (!remote) e8.userError("No remote to push to");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${branch}`], `Pushing to ${remote}/${branch}`);
  },
});


const pullUpstream = e8.defineCommand({
  name: "magit-pull-from-upstream",
  doc: "Pull from the upstream of the current branch, setting one first if there is none.",
  run: () => {
    const [remote, target, set] = ensureUpstream("pull");
    if (set) gitOutput(["branch", `--set-upstream-to=${remote}/${target}`]);
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, target], `Pulling from ${remote}/${target}`);
  },
});


const fetchAll = e8.defineCommand({ name: "magit-fetch-all", doc: "Fetch from all remotes.", run: () => runGitAsync(["fetch", "--all", ...transientArgs("magit-fetch")], "Fetching all remotes") });
const fetchUpstream = e8.defineCommand({
  name: "magit-fetch-from-upstream",
  doc: "Fetch from the remote of the current branch's upstream.",
  run: () => {
    const remote = upstreamOf(currentBranch())?.split("/")[0] ?? remotes()[0];
    if (!remote) e8.userError("No remote to fetch from");
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});


// Merging, resetting and stashing.

const mergeCommand = e8.defineCommand({
  name: "magit-merge-plain",
  doc: "Merge a branch into the current one.",
  run: () => void runGit(["merge", ...transientArgs("magit-merge"), readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()])]),
});

const resetCommand = (mode: string, doc: string) =>
  e8.defineCommand({
    name: `magit-reset-${mode}`,
    doc,
    run: () => {
      const s = currentSection();
      const def = s?.type === "commit" ? String(s.value) : "HEAD";
      runGit(["reset", `--${mode}`, readBranch(`${mode[0].toUpperCase()}${mode.slice(1)} reset ${currentBranch() ?? "HEAD"} to`, [...localBranches(), ...remoteBranches()], def)]);
    },
  });

/** The stash at point, or one read. */
function stashAt(prompt: string): string {
  const s = currentSection();
  if (s?.type === "stash") return String(s.value);
  const list = gitLines(["stash", "list", "--format=%gd"]);
  if (list.length === 0) e8.userError("No stashes");
  return e8.completingRead(`${prompt} (default ${list[0]}): `, list, { default: list[0], requireMatch: true });
}

const stashBoth = e8.defineCommand({
  name: "magit-stash-both",
  doc: "Stash the changes in the index and the working tree, with a message.",
  run: () => {
    const msg = e8.readString(`Stash message (default: On ${currentBranch() ?? "HEAD"}: ...): `);
    runGit(["stash", "push", ...transientArgs("magit-stash"), ...(msg ? ["-m", msg] : [])]);
  },
});
const stashApply = e8.defineCommand({ name: "magit-stash-apply", doc: "Apply a stash to the working tree.", run: () => void runGit(["stash", "apply", stashAt("Apply stash")]) });
const stashPop = e8.defineCommand({ name: "magit-stash-pop", doc: "Apply a stash and remove it.", run: () => void runGit(["stash", "pop", stashAt("Pop stash")]) });
const stashDrop = e8.defineCommand({
  name: "magit-stash-drop",
  doc: "Remove a stash.",
  run: () => {
    const s = stashAt("Drop stash");
    if (e8.yOrNP(`Drop ${s}? `)) runGit(["stash", "drop", s]);
  },
});

// The log and commits, after magit-log.el and magit-diff.el.

/** Inserts a log of ARGS, a line a commit with its refs, author and date, as magit-insert-log. */
function insertLog(args: string[]): void {
  insertRoot("logbuf", () => {
    const lines = gitLines(["log", "--format=%h%x00%D%x00%s%x00%an%x00%ar", "-n256", ...args, "--"]);
    for (const line of lines) {
      const [hash, refs, subject, author, date] = line.split("\0");
      insertSection("commit", hash, false, () => {
        insertHeading(face(hash, "magit-hash"), " ", refLabels(refs), subject, "  ", face(author, "magit-log-author"), " ", face(date, "magit-log-date"), "\n");
      });
    }
  });
}

const logCurrent = e8.defineCommand({
  name: "magit-log-current",
  doc: "Show the log of the current branch.",
  run: () => {
    const dir = repo();
    const args = logArgs();
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, "HEAD"]));
    e8.gotoChar(0);
  },
});

const logAll = e8.defineCommand({
  name: "magit-log-all",
  doc: "Show the log of all references and HEAD.",
  run: () => {
    const dir = repo();
    const args = logArgs();
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, "--all"]));
    e8.gotoChar(0);
  },
});

const logOther = e8.defineCommand({
  name: "magit-log-other",
  doc: "Show the log of a branch or commit read.",
  run: () => {
    const dir = repo();
    const rev = readBranch("Log rev,s", [...localBranches(), ...remoteBranches()], currentBranch());
    const args = logArgs();
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, rev]));
    e8.gotoChar(0);
  },
});


/** Shows a commit: its header and diff, as magit-show-commit and magit-revision-mode. */
export function showCommit(rev: string): void {
  const dir = repo();
  setupBuffer(`magit-revision: ${repoName(dir)}`, magitRevisionMode, "revision", () => {
    const meta = gitOutput(["show", "-s", "--format=%H%nAuthor:     %an <%ae>%nAuthorDate: %ad%nCommit:     %cn <%ce>%nCommitDate: %cd%n%n%B", rev]).output;
    const diff = gitOutput(["show", "--format=", "--no-prefix", "-p", rev]).output;
    insertRoot("revision", () => {
      const [hash, ...rest] = meta.split("\n");
      insertSection("headers", hash, false, () => {
        insertHeading(face(hash, "magit-hash"), "\n");
        e8.insert(`${rest.join("\n").replace(/\n+$/, "")}\n\n`);
      });
      insertFiles(parseDiff(diff), "commit");
    });
  });
  e8.gotoChar(0);
}

const diffDwim = e8.defineCommand({
  name: "magit-diff-dwim",
  doc: "Show the changes in the working tree, unstaged and staged, or those of the commit at point.",
  run: () => {
    const s = currentSection();
    if (s?.type === "commit") {
      showCommit(String(s.value));
      return;
    }
    const dir = repo();
    const staged = s?.type === "staged" || (s?.value as FileValue | undefined)?.kind === "staged";
    setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () =>
      insertRoot("diff", () => insertFiles(parseDiff(gitOutput(staged ? ["diff", "--cached", "--no-prefix", "-p"] : ["diff", "--no-prefix", "-p"]).output), "commit")),
    );
    e8.gotoChar(0);
  },
});
const diffStaged = e8.defineCommand({
  name: "magit-diff-staged",
  doc: "Show the changes between the index and HEAD.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(gitOutput(["diff", "--cached", "--no-prefix", "-p"]).output), "commit")));
    e8.gotoChar(0);
  },
});
const diffUnstaged = e8.defineCommand({
  name: "magit-diff-unstaged",
  doc: "Show the changes between the working tree and the index.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(gitOutput(["diff", "--no-prefix", "-p"]).output), "commit")));
    e8.gotoChar(0);
  },
});

// The process buffer.

const processBuffer = e8.defineCommand({
  name: "magit-process-buffer",
  doc: "Show the git commands Magit ran and their output.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-process: ${repoName(dir)}`, magitProcessMode, "process", () =>
      insertRoot("processbuf", () => {
        for (const p of processLog.filter((x) => x.dir === dir)) {
          insertSection("process", p.args.join(" "), true, () => {
            insertHeading(face(`${p.exit < 0 ? "run" : String(p.exit).padStart(3)} `, p.exit === 0 ? "magit-process-ok" : "magit-process-ng"), face(`git ${p.args.join(" ")}`, "magit-section-heading"), "\n");
            if (p.output) e8.insert(p.output.endsWith("\n") ? p.output : `${p.output}\n`);
          });
        }
      }),
    );
    const last = sections()?.root.children.at(-1);
    if (last) {
      show(last);
      e8.gotoChar(last.start);
    }
  },
});

// The dispatch menu and the keys.

// The menus, after Magit's transient-define-prefix forms, laid out as
// Magit 4 lays them out, and the commands behind their suffixes.

/** A command that runs git with the arguments ARGS gives, as Magit's many small commands do. */
const gitCommand = (name: string, doc: string, args: () => string[] | undefined) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const a = args();
      if (a) runGit(a);
    },
  });

/** A command E8's Magit does not have yet, which says so. */
const notYet = (name: string, what: string) =>
  e8.defineCommand({ name, doc: `${what}: not in E8's Magit yet.`, run: () => e8.userError(`${what} is not in E8's Magit yet`) });

/** The commit at point, or one read from the log, as magit-read-branch-or-commit. */
function readCommit(prompt: string): string {
  const s = currentSection();
  const def = s?.type === "commit" ? String(s.value) : undefined;
  const log = gitLines(["log", "--format=%h %s", "-n100"]);
  const answer = e8.completingRead(def ? `${prompt} (default ${def}): ` : `${prompt}: `, log, { default: def, history: "magit-revision-history" });
  if (answer === "") e8.userError("Nothing selected");
  return answer.split(" ")[0];
}

/** A commit fixing up or squashing into a commit read, then rebasing them together if INSTANT, as magit-commit-fixup and its kin. */
function fixupCommand(name: string, doc: string, option: (rev: string) => string, edit: boolean, instant = false) {
  return e8.defineCommand({
    name,
    doc,
    run: () => {
      const rev = readCommit(doc.replace(/\.$/, ""));
      if (edit) {
        editCommit([option(rev), ...commitArgs()]);
        return;
      }
      if (!runGit(["commit", "--no-edit", option(rev), ...commitArgs()])) return;
      // Onto the commit's parent, or from the root for the first commit, as magit-rebase-autosquash does.
      const onto = gitOutput(["rev-parse", "--verify", "-q", `${rev}^`]).exit === 0 ? `${rev}^` : "--root";
      if (instant) runGit(["-c", "sequence.editor=:", "rebase", "-i", "--autosquash", "--autostash", "--keep-empty", onto]);
    },
  });
}

const commitFixup = fixupCommand("magit-commit-fixup", "Create a fixup commit.", (r) => `--fixup=${r}`, false);
const commitSquash = fixupCommand("magit-commit-squash", "Create a squash commit.", (r) => `--squash=${r}`, false);
const commitAlter = fixupCommand("magit-commit-alter", "Create a commit changing a commit and its message.", (r) => `--fixup=amend:${r}`, true);
const commitAugment = fixupCommand("magit-commit-augment", "Create a squash commit, writing its message.", (r) => `--squash=${r}`, true);
const commitRevise = fixupCommand("magit-commit-revise", "Create a commit rewording a commit.", (r) => `--fixup=reword:${r}`, true);
const commitInstantFixup = fixupCommand("magit-commit-instant-fixup", "Create a fixup commit and rebase it into place at once.", (r) => `--fixup=${r}`, false, true);
const commitInstantSquash = fixupCommand("magit-commit-instant-squash", "Create a squash commit and rebase it into place at once.", (r) => `--squash=${r}`, false, true);

const commitMenu = transientDefinePrefix("magit-commit", {
  doc: "Create a new commit or replace an existing commit.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-a", "Stage all modified and deleted files", "--all"],
        ["-e", "Allow empty commit", "--allow-empty"],
        ["-v", "Show diff of changes to be committed", "--verbose"],
        ["-n", "Disable hooks", "--no-verify"],
        ["-R", "Claim authorship and reset author date", "--reset-author"],
        ["-A", "Override the author", "--author=", { prompt: "Author: " }],
        ["-C", "Reuse commit message", "--reuse-message=", { reader: (p) => readCommit(p) }],
      ],
    },
    {
      items: [
        { description: "Create", items: [["c", "Commit", commitCreate]] },
        { description: "Edit HEAD", items: [["e", "Extend", commitExtend], "", ["a", "Amend", commitAmend], "", ["w", "Reword", commitReword]] },
        { description: "Edit", items: [["f", "Fixup", commitFixup], ["s", "Squash", commitSquash], ["A", "Alter", commitAlter], ["n", "Augment", commitAugment], ["W", "Revise", commitRevise]] },
        { description: "Edit and rebase", items: [["F", "Instant fixup", commitInstantFixup], ["S", "Instant squash", commitInstantSquash], "", ""] },
        { description: "Spread across commits", items: [] },
      ],
    },
  ],
});

// Push.

const branchOrHead = (): string => currentBranch() ?? "HEAD";
const pushRemoteOf = (branch?: string): string | undefined =>
  branch ? (gitString(["config", `branch.${branch}.pushRemote`]) ?? gitString(["config", "remote.pushDefault"])) : undefined;

/** Reads a remote, setting it as the branch's push remote, as magit-push-current-to-pushremote with no push remote does. */
function ensurePushRemote(): string {
  const branch = currentBranch();
  if (!branch) e8.userError("No branch is checked out");
  const remote = pushRemoteOf(branch);
  if (remote) return remote;
  const all = remotes();
  if (all.length === 0) e8.userError("No remote to push to");
  const chosen = e8.completingRead(`Set push-remote of ${branch} and push there: `, all, { requireMatch: true, default: all[0] });
  gitOutput(["config", `branch.${branch}.pushRemote`, chosen]);
  return chosen;
}

const pushPushRemoteSetting = e8.defineCommand({
  name: "magit-push-current-to-pushremote",
  doc: "Push the current branch to its push remote, setting one first if there is none.",
  run: () => {
    const branch = currentBranch()!;
    const remote = ensurePushRemote();
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${branch}`], `Pushing to ${remote}/${branch}`);
  },
});

const pushElsewhere = e8.defineCommand({
  name: "magit-push-current",
  doc: "Push the current branch to a branch read.",
  run: () => {
    const branch = currentBranch()!;
    const target = readBranch(`Push ${branch} to`, remoteBranches(), upstreamOf(branch));
    const [remote, ...rest] = target.split("/");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${rest.join("/")}`], `Pushing to ${target}`);
  },
});

const pushOther = e8.defineCommand({
  name: "magit-push-other",
  doc: "Push a branch or commit to a remote branch, both read.",
  run: () => {
    const source = readBranch("Push", localBranches(), currentBranch());
    const target = readBranch(`Push ${source} to`, remoteBranches());
    const [remote, ...rest] = target.split("/");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${source}:refs/heads/${rest.join("/")}`], `Pushing to ${target}`);
  },
});

const pushRefspecs = e8.defineCommand({
  name: "magit-push-refspecs",
  doc: "Push refspecs read to a remote read.",
  run: () => {
    const remote = e8.completingRead("Push to remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    const specs = e8.readString(`Push refspec,s to ${remote}: `);
    runGitAsync(["push", "-v", ...pushArgs(), remote, ...specs.split(/[ ,]+/).filter(Boolean)], `Pushing to ${remote}`);
  },
});

const pushMatching = e8.defineCommand({
  name: "magit-push-matching",
  doc: "Push all branches that have a branch of the same name on a remote.",
  run: () => {
    const remote = e8.completingRead("Push matching branches to: ", remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["push", "-v", ...pushArgs(), remote, ":"], `Pushing to ${remote}`);
  },
});

const pushTag = e8.defineCommand({
  name: "magit-push-tag",
  doc: "Push a tag to a remote.",
  run: () => {
    const tag = e8.completingRead("Push tag: ", gitLines(["tag"]), { requireMatch: true });
    const remote = e8.completingRead(`Push ${tag} to remote: `, remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["push", ...pushArgs(), remote, tag], `Pushing ${tag}`);
  },
});

const pushTags = e8.defineCommand({
  name: "magit-push-tags",
  doc: "Push all tags to a remote.",
  run: () => {
    const remote = e8.completingRead("Push tags to remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["push", ...pushArgs(), remote, "--tags"], `Pushing tags to ${remote}`);
  },
});

const setVariables = e8.defineCommand({
  name: "magit-branch-configure",
  doc: "Configure the current branch's upstream, push remote and rebasing.",
  run: () => e8.call(branchMenu),
});

const pushMenu = transientDefinePrefix("magit-push", {
  doc: "Push to another repository.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-f", "Force with lease", "--force-with-lease"],
        ["-F", "Force", "--force"],
        ["-h", "Disable hooks", "--no-verify"],
        ["-n", "Dry run", "--dry-run"],
        ["-T", "Include all tags", "--tags"],
        ["-t", "Include related annotated tags", "--follow-tags"],
      ],
    },
    {
      description: () => `Push ${branchOrHead()} to`,
      items: [
        ["p", () => { const r = pushRemoteOf(currentBranch()); return r ? `${r}/${branchOrHead()}` : "pushRemote, setting that"; }, pushPushRemoteSetting],
        ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, creating it", pushUpstream],
        ["e", "elsewhere", pushElsewhere],
      ],
    },
    {
      description: "Push",
      items: [
        { items: [["o", "another branch", pushOther], ["r", "explicit refspecs", pushRefspecs], ["m", "matching branches", pushMatching]] },
        { items: [["T", "a tag", pushTag], ["t", "all tags", pushTags]] },
      ],
    },
    { description: "Configure", items: [["C", "Set variables...", setVariables]] },
  ],
});

// Pull and fetch.

const pullPushRemote = e8.defineCommand({
  name: "magit-pull-from-pushremote",
  doc: "Pull from the push remote of the current branch, setting one first if there is none.",
  run: () => {
    const remote = ensurePushRemote();
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, branchOrHead()], `Pulling from ${remote}`);
  },
});

const pullElsewhere = e8.defineCommand({
  name: "magit-pull-branch",
  doc: "Pull a branch read into the current one.",
  run: () => {
    const target = readBranch("Pull", remoteBranches());
    const [remote, ...rest] = target.split("/");
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, rest.join("/")], `Pulling from ${target}`);
  },
});

/** A git config variable a suffix cycles through CHOICES, shown as Magit shows one: name [a|b|default:x]. */
let configVariables = 0;
function configVariable(key: string, variable: () => string, choices: () => string[], fallback?: string): [string, () => e8.PropertizedString, e8.DefinedCommand] {
  // Named without asking git which variable it is: that waits for the menu.
  const command = e8.defineCommand({
    name: `magit:config-variable:${key}:${configVariables++}`,
    doc: "Cycle a git variable through its values.",
    run: () => {
      const name = variable();
      const now = gitString(["config", name]);
      const all = choices();
      const at = now === undefined ? -1 : all.indexOf(now);
      if (at + 1 < all.length) gitOutput(["config", name, all[at + 1]]);
      else gitOutput(["config", "--unset", name]);
      refreshAll();
    },
  });
  const describe = () => {
    const name = variable();
    const now = gitString(["config", name]);
    const parts = choices().flatMap((c, i) => [...(i > 0 ? [face("|", "transient-delimiter")] : []), face(c, c === now ? "transient-value" : "transient-inactive-value")]);
    const def = fallback !== undefined ? [face("|", "transient-delimiter"), face(`default:${fallback}`, now === undefined ? "transient-value" : "transient-inactive-value")] : [];
    return e8.concat(face(name, "transient-argument"), " ", face("[", "transient-delimiter"), ...parts, ...def, face("]", "transient-delimiter"));
  };
  return [key, describe, command];
}

const pullMenu = transientDefinePrefix("magit-pull", {
  doc: "Pull from another repository.",
  groups: [
    { description: "Arguments", items: [["-f", "Fast-forward only", "--ff-only"], ["-r", "Rebase local commits", "--rebase"], ["-F", "Force", "--force"]] },
    {
      description: () => `Pull into ${branchOrHead()} from`,
      items: [
        ["p", () => { const r = pushRemoteOf(currentBranch()); return r ? `${r}/${branchOrHead()}` : "pushRemote, setting that"; }, pullPushRemote],
        ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, setting that", pullUpstream],
        ["e", "elsewhere", pullElsewhere],
      ],
    },
    {
      description: "Configure",
      items: [configVariable("r", () => `branch.${branchOrHead()}.rebase`, () => ["true", "false"], "false"), ["C", "variables...", setVariables]],
    },
  ],
});

const fetchPushRemote = e8.defineCommand({
  name: "magit-fetch-from-pushremote",
  doc: "Fetch from the push remote of the current branch, setting one first if there is none.",
  run: () => {
    const remote = ensurePushRemote();
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});
const fetchElsewhere = e8.defineCommand({
  name: "magit-fetch-other",
  doc: "Fetch from a remote read.",
  run: () => {
    const remote = e8.completingRead("Fetch remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});
const fetchBranch = e8.defineCommand({
  name: "magit-fetch-branch",
  doc: "Fetch a branch from a remote.",
  run: () => {
    const remote = e8.completingRead("Fetch from remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    const branch = e8.readString(`Fetch branch from ${remote}: `);
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote, branch], `Fetching ${remote} ${branch}`);
  },
});
const fetchRefspec = e8.defineCommand({
  name: "magit-fetch-refspec",
  doc: "Fetch a refspec read from a remote read.",
  run: () => {
    const remote = e8.completingRead("Fetch from remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    const spec = e8.readString(`Fetch using refspec from ${remote}: `);
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote, spec], `Fetching ${remote}`);
  },
});
const fetchModules = gitCommand("magit-fetch-modules", "Fetch all submodules.", () => ["fetch", "--recurse-submodules"]);

const fetchMenu = transientDefinePrefix("magit-fetch", {
  doc: "Fetch from another repository.",
  groups: [
    { description: "Arguments", items: [["-p", "Prune deleted branches", "--prune"], ["-t", "Fetch all tags", "--tags"], ["-F", "Force", "--force"]] },
    {
      description: "Fetch from",
      items: [
        ["p", () => pushRemoteOf(currentBranch()) ?? "pushRemote, setting that", fetchPushRemote],
        ["u", () => upstreamOf(currentBranch())?.split("/")[0] ?? "", fetchUpstream, { if: () => upstreamOf(currentBranch()) !== undefined }],
        ["e", "elsewhere", fetchElsewhere],
        ["a", "all remotes", fetchAll],
      ],
    },
    { description: "Fetch", items: [["o", "another branch", fetchBranch], ["r", "explicit refspec", fetchRefspec], ["m", "submodules", fetchModules]] },
    { description: "Configure", items: [["C", "variables...", setVariables]] },
  ],
});

// Rebase, after magit-sequence.el and git-rebase.el.

/** Whether a rebase is going on, stopped for something, as magit-rebase-in-progress-p. */
function rebaseInProgress(): boolean {
  const gitDir = gitString(["rev-parse", "--absolute-git-dir"]);
  return gitDir !== undefined && (e8.fileExists(`${gitDir}/rebase-merge`) || e8.fileExists(`${gitDir}/rebase-apply`));
}

const rebaseArgs = (): string[] => transientArgs("magit-rebase");

/** The commit to rebase from, its parent or --root for the first, as magit-rebase-interactive-1 works it out. */
const ontoParent = (rev: string): string => (gitOutput(["rev-parse", "--verify", "-q", `${rev}^`]).exit === 0 ? `${rev}^` : "--root");

/** Rebases interactively from REV, with the todo list edited by SEQUENCE, a shell command, or in E8 if none. */
function rebaseInteractive(rev: string, what: string, sequence?: string): void {
  const args = ["rebase", "-i", ...rebaseArgs().filter((a) => a !== "--interactive"), ontoParent(rev)];
  // A sequence editor of its own wins over E8's, which still edits the messages.
  runGitAsync(args, what, true, sequence ? { GIT_SEQUENCE_EDITOR: sequence } : {});
}

/** A sequence editor that changes the first line's action, as magit-rebase-edit-commit and its kin have git do. */
const firstLineTo = (action: string): string => `perl -i -p -e 's/^pick/${action}/ if $. == 1'`;

const rebaseOntoUpstream = e8.defineCommand({
  name: "magit-rebase-onto-upstream",
  doc: "Rebase the current branch onto its upstream, setting one first if there is none.",
  run: () => {
    const [remote, target, set] = ensureUpstream("rebase");
    if (set) gitOutput(["branch", `--set-upstream-to=${remote}/${target}`]);
    runGitAsync(["rebase", ...rebaseArgs(), `${remote}/${target}`], "Rebasing", true);
  },
});
const rebaseOntoPushRemote = e8.defineCommand({
  name: "magit-rebase-onto-pushremote",
  doc: "Rebase the current branch onto its push remote's branch, setting one first if there is none.",
  run: () => {
    const remote = ensurePushRemote();
    runGitAsync(["rebase", ...rebaseArgs(), `${remote}/${branchOrHead()}`], "Rebasing", true);
  },
});
const rebaseElsewhere = e8.defineCommand({
  name: "magit-rebase-branch",
  doc: "Rebase the current branch onto a branch read.",
  run: () => runGitAsync(["rebase", ...rebaseArgs(), readBranch(`Rebase ${branchOrHead()} onto`, [...localBranches(), ...remoteBranches()])], "Rebasing", true),
});
const rebaseInteractively = e8.defineCommand({
  name: "magit-rebase-interactive",
  doc: "Rebase the commits from one read interactively, editing the todo list in git-rebase-mode.",
  run: () => rebaseInteractive(readCommit("Interactively rebase from"), "Rebasing"),
});
const rebaseSubset = e8.defineCommand({
  name: "magit-rebase-subset",
  doc: "Rebase the commits from one read onto a new base read.",
  run: () => {
    const start = readCommit("Rebase subset starting at");
    const onto = readBranch("Rebase subset onto", [...localBranches(), ...remoteBranches()]);
    runGitAsync(["rebase", ...rebaseArgs(), "--onto", onto, ontoParent(start)], "Rebasing", true);
  },
});
const rebaseEditCommit = e8.defineCommand({
  name: "magit-rebase-edit-commit",
  doc: "Stop at a commit read, to change it, then go on with r r.",
  run: () => rebaseInteractive(readCommit("Edit commit"), "Rebasing", firstLineTo("edit")),
});
const rebaseRewordCommit = e8.defineCommand({
  name: "magit-rebase-reword-commit",
  doc: "Write a commit's message again.",
  run: () => rebaseInteractive(readCommit("Reword commit"), "Rebasing", firstLineTo("reword")),
});
const rebaseRemoveCommit = e8.defineCommand({
  name: "magit-rebase-remove-commit",
  doc: "Take a commit out of the history.",
  run: () => {
    const rev = readCommit("Remove commit");
    if (e8.yOrNP(`Remove ${rev}? `)) rebaseInteractive(rev, "Rebasing", firstLineTo("drop"));
  },
});
const rebaseAutosquash = e8.defineCommand({
  name: "magit-rebase-autosquash",
  doc: "Squash the fixup and squash commits into the commits they name.",
  run: () => {
    const upstream = upstreamOf(currentBranch());
    const base = upstream ? gitString(["merge-base", "HEAD", upstream]) : undefined;
    runGitAsync(["rebase", "-i", "--autosquash", "--autostash", "--keep-empty", ...(base ? [base] : ["--root"])], "Autosquashing", true, { GIT_SEQUENCE_EDITOR: ":" });
  },
});
const rebaseContinue = e8.defineCommand({ name: "magit-rebase-continue", doc: "Go on with the rebase.", run: () => runGitAsync(["rebase", "--continue"], "Rebasing", true) });
const rebaseSkip = e8.defineCommand({ name: "magit-rebase-skip", doc: "Skip the commit the rebase stopped at.", run: () => runGitAsync(["rebase", "--skip"], "Rebasing", true) });
const rebaseEditTodo = e8.defineCommand({ name: "magit-rebase-edit", doc: "Edit the rest of the rebase's todo list.", run: () => runGitAsync(["rebase", "--edit-todo"], "Editing", true) });
const rebaseAbort = e8.defineCommand({
  name: "magit-rebase-abort",
  doc: "Abort the rebase, going back to where it started.",
  run: () => {
    if (e8.yOrNP("Abort this rebase? ")) runGit(["rebase", "--abort"]);
  },
});

const rebaseMenu = transientDefinePrefix("magit-rebase", {
  doc: "Transplant commits and/or modify existing commits.",
  groups: [
    {
      description: "Arguments",
      if: () => !rebaseInProgress(),
      items: [
        ["-k", "Keep empty commits", "--keep-empty"],
        ["-r", "Rebase merges", "--rebase-merges=", { choices: ["no-rebase-cousins", "rebase-cousins"] }],
        ["-u", "Update branches", "--update-refs"],
        ["-d", "Use author date as committer date", "--committer-date-is-author-date"],
        ["-t", "Use current time as author date", "--ignore-date"],
        ["-a", "Autosquash", "--autosquash"],
        ["-A", "Autostash", "--autostash"],
        ["-i", "Interactive", "--interactive"],
        ["-h", "Disable hooks", "--no-verify"],
      ],
    },
    {
      description: () => `Rebase ${branchOrHead()} onto`,
      if: () => !rebaseInProgress(),
      items: [
        ["p", () => { const r = pushRemoteOf(currentBranch()); return r ? `${r}/${branchOrHead()}` : "pushRemote, setting that"; }, rebaseOntoPushRemote],
        ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, setting that", rebaseOntoUpstream],
        ["e", "elsewhere", rebaseElsewhere],
      ],
    },
    {
      description: "Rebase",
      if: () => !rebaseInProgress(),
      items: [
        { items: [["i", "interactively", rebaseInteractively], ["s", "a subset", rebaseSubset]] },
        { items: [["m", "to modify a commit", rebaseEditCommit], ["w", "to reword a commit", rebaseRewordCommit], ["k", "to remove a commit", rebaseRemoveCommit]] },
        { items: [["f", "to autosquash", rebaseAutosquash]] },
      ],
    },
    {
      description: "Actions",
      if: () => rebaseInProgress(),
      items: [["r", "Continue", rebaseContinue], ["s", "Skip", rebaseSkip], ["e", "Edit", rebaseEditTodo], ["a", "Abort", rebaseAbort]],
    },
  ],
});

/** The actions a todo line can have, as git-rebase-command-re matches them. */
const TODO_LINE = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d|exec|x|break|b|label|l|reset|t|merge|m|update-ref|u)(\s|$)/;

/** Gives the todo line at point ACTION, and goes to the next, as git-rebase-set-action. */
function setAction(action: string): void {
  const line = e8.lineOf(e8.point());
  const text = e8.lineText(line);
  const m = TODO_LINE.exec(text);
  if (!m || ["exec", "x", "break", "b", "label", "l", "reset", "t", "merge", "m", "update-ref", "u"].includes(m[1])) {
    forwardLine(1);
    return;
  }
  e8.letBind({ "inhibit-read-only": true }, () => {
    const start = e8.lineStart(line);
    e8.deleteRegion(start, start + m[1].length);
    e8.gotoChar(start);
    e8.insert(action);
  });
  forwardLine(1);
}

/** Moves the todo line at point by N lines, as git-rebase-move-line-down. */
function moveLine(n: number): void {
  const line = e8.lineOf(e8.point());
  const target = line + n;
  if (target < 0 || !TODO_LINE.test(e8.lineText(line)) || !TODO_LINE.test(e8.lineText(target))) return;
  e8.letBind({ "inhibit-read-only": true }, () => {
    const [a, b] = [e8.lineText(line), e8.lineText(target)];
    for (const [l, t] of [[line, b], [target, a]] as const) {
      e8.deleteRegion(e8.lineStart(l), e8.lineEnd(l));
      e8.gotoChar(e8.lineStart(l));
      e8.insert(t);
    }
  });
  e8.gotoChar(e8.lineStart(target));
}

const todoCommand = (name: string, action: string, doc: string) => e8.defineCommand({ name, doc, run: () => setAction(action) });

/** Highlights the todo list's actions, hashes and comments, as git-rebase-mode's font-lock keywords. */
function fontifyTodo(start: number, end: number): void {
  e8.withSilentModifications(() => {
    for (let line = e8.lineOf(start); line <= e8.lineOf(Math.max(start, end - 1)); line++) {
      const ls = e8.lineStart(line);
      const text = e8.lineText(line);
      if (text.startsWith("#")) {
        e8.putTextProperty(ls, e8.lineEnd(line), "face", "font-lock-comment-face");
        continue;
      }
      const m = /^(\S+)(\s+)([0-9a-f]{4,40})?/.exec(text);
      if (!m || !TODO_LINE.test(text)) continue;
      e8.putTextProperty(ls, ls + m[1].length, "face", "font-lock-keyword-face");
      if (m[3]) e8.putTextProperty(ls + m[1].length + m[2].length, ls + m[1].length + m[2].length + m[3].length, "face", "magit-hash");
    }
  });
}

export const gitRebaseMode = e8.defineMajorMode({
  name: "git-rebase-mode",
  modeName: "Git Rebase",
  parent: "text-mode",
  doc: "Major mode for editing a rebase's todo list: c, r, e, s, f and d set a line's action, M-p and M-n move it, x adds a command to run, C-c C-c starts the rebase.",
  bindings: {
    c: todoCommand("git-rebase-pick", "pick", "Use the commit as it is."),
    r: todoCommand("git-rebase-reword", "reword", "Use the commit, writing its message again."),
    w: todoCommand("git-rebase-reword-w", "reword", "Use the commit, writing its message again."),
    e: todoCommand("git-rebase-edit", "edit", "Use the commit, stopping to change it."),
    m: todoCommand("git-rebase-edit-m", "edit", "Use the commit, stopping to change it."),
    s: todoCommand("git-rebase-squash", "squash", "Meld the commit into the one before, writing their message."),
    f: todoCommand("git-rebase-fixup", "fixup", "Meld the commit into the one before, keeping its message."),
    d: todoCommand("git-rebase-drop", "drop", "Leave the commit out."),
    k: todoCommand("git-rebase-kill-line", "drop", "Leave the commit out."),
    "C-k": todoCommand("git-rebase-kill-line-k", "drop", "Leave the commit out."),
    p: e8.defineCommand({ name: "git-rebase-backward-line", doc: "Go to the line before.", run: () => void forwardLine(-1) }),
    n: e8.defineCommand({ name: "git-rebase-forward-line", doc: "Go to the next line.", run: () => void forwardLine(1) }),
    "M-p": e8.defineCommand({ name: "git-rebase-move-line-up", doc: "Move the line up.", run: () => moveLine(-1) }),
    "M-n": e8.defineCommand({ name: "git-rebase-move-line-down", doc: "Move the line down.", run: () => moveLine(1) }),
    "M-<up>": "git-rebase-move-line-up" as e8.CommandName,
    "M-<down>": "git-rebase-move-line-down" as e8.CommandName,
    x: e8.defineCommand({
      name: "git-rebase-exec",
      doc: "Add a shell command to run at this point of the rebase.",
      run: () => {
        const cmd = e8.readString("Execute: ");
        if (cmd === "") return;
        e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
        e8.insert(`exec ${cmd}\n`);
      },
    }),
    b: e8.defineCommand({
      name: "git-rebase-break",
      doc: "Stop the rebase at this point.",
      run: () => {
        e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
        e8.insert("break\n");
      },
    }),
    RET: e8.defineCommand({
      name: "git-rebase-show-commit",
      doc: "Show the commit of the line at point.",
      run: () => {
        const m = /^\S+\s+([0-9a-f]{4,40})/.exec(e8.lineText(e8.lineOf(e8.point())));
        if (m) showCommit(m[1]);
      },
    }),
  },
  setup: () => {
    e8.addHook("jit-lock-functions", fontifyTodo, { local: true });
  },
});

// Branch.

/** A branch variable read and set, shown as Magit shows it: branch.main.description unset. */
function branchVariable(key: string, name: () => string, read: () => string | undefined): [string, () => e8.PropertizedString, e8.DefinedCommand] {
  const command = e8.defineCommand({
    name: `magit:branch-variable:${key}`,
    doc: "Set a variable of the current branch.",
    run: () => {
      const value = read();
      if (value === undefined || value === "") gitOutput(["config", "--unset", name()]);
      else gitOutput(["config", name(), value]);
      refreshAll();
    },
  });
  const describe = () => {
    const now = gitString(["config", name()]);
    return e8.concat(face(name(), "transient-argument"), " ", now === undefined ? face("unset", "transient-inactive-value") : face(now, "transient-value"));
  };
  return [key, describe, command];
}

const branchLocal = e8.defineCommand({
  name: "magit-branch-checkout",
  doc: "Check out a local branch, or create one from a remote branch.",
  run: () => runGit(["checkout", readBranch("Checkout branch", localBranches().filter((b) => b !== currentBranch()))]) as unknown as void,
});

const branchSpinoff = e8.defineCommand({
  name: "magit-branch-spinoff",
  doc: "Create a branch from the current one and check it out, taking the current one back to its upstream.",
  run: () => {
    const name = e8.readString("Spin off branch: ");
    if (name === "") e8.userError("No name given");
    const from = currentBranch();
    const upstream = upstreamOf(from);
    if (!runGit(["checkout", "-b", name])) return;
    if (from && upstream) runGit(["update-ref", `refs/heads/${from}`, gitString(["merge-base", from, upstream]) ?? upstream]);
  },
});

const branchSpinout = e8.defineCommand({
  name: "magit-branch-spinout",
  doc: "Create a branch from the current one, taking the current one back to its upstream, without checking the new one out.",
  run: () => {
    const name = e8.readString("Spin out branch: ");
    if (name === "") e8.userError("No name given");
    const from = currentBranch();
    const upstream = upstreamOf(from);
    if (!runGit(["branch", name])) return;
    if (from && upstream) runGit(["reset", "--keep", gitString(["merge-base", from, upstream]) ?? upstream]);
  },
});

const branchReset = e8.defineCommand({
  name: "magit-branch-reset",
  doc: "Reset a branch to a commit read.",
  run: () => {
    const branch = readBranch("Reset branch", localBranches(), currentBranch());
    const to = readBranch(`Reset ${branch} to`, [...localBranches(), ...remoteBranches()], upstreamOf(branch));
    if (branch === currentBranch()) runGit(["reset", "--hard", to]);
    else runGit(["update-ref", `refs/heads/${branch}`, to]);
  },
});

const updateDefaultBranch = gitCommand("magit-update-default-branch", "Update the default branch from the remote's HEAD.", () => {
  const remote = remotes()[0];
  return remote ? ["remote", "set-head", remote, "--auto"] : undefined;
});

const branchMenu = transientDefinePrefix("magit-branch", {
  doc: "Add, configure or remove a branch.",
  groups: [
    {
      description: () => `Configure ${branchOrHead()}`,
      items: [
        branchVariable("d", () => `branch.${branchOrHead()}.description`, () => e8.readString("Description: ")),
        branchVariable("u", () => `branch.${branchOrHead()}.merge`, () => {
          const up = readBranch("Upstream", remoteBranches());
          const [remote, ...rest] = up.split("/");
          gitOutput(["config", `branch.${branchOrHead()}.remote`, remote]);
          return `refs/heads/${rest.join("/")}`;
        }),
        [" ", { info: () => e8.concat(face(`branch.${branchOrHead()}.remote`, "transient-argument"), " ", ((r) => (r === undefined ? face("unset", "transient-inactive-value") : face(r, "transient-value")))(gitString(["config", `branch.${branchOrHead()}.remote`]))) }],
        configVariable("r", () => `branch.${branchOrHead()}.rebase`, () => ["true", "false"], "false"),
        configVariable("p", () => `branch.${branchOrHead()}.pushRemote`, () => remotes()),
      ],
    },
    {
      description: "Configure repository defaults",
      items: [configVariable("R", () => "pull.rebase", () => ["true", "false"], "false"), configVariable("P", () => "remote.pushDefault", () => remotes()), ["B", "Update default branch", updateDefaultBranch]],
    },
    { description: "Arguments", items: [] },
    {
      items: [
        { description: "Checkout", items: [["b", "branch/revision", branchCheckout], ["l", "local branch", branchLocal]] },
        { description: "", items: [["c", "new branch", branchCreateCheckout], ["s", "new spin-off", branchSpinoff]] },
        { description: "Create", items: [["n", "new branch", branchCreate], ["S", "new spin-out", branchSpinout]] },
        { description: "Do", items: [["C", "configure...", setVariables], ["m", "rename", branchRename], ["x", "reset", branchReset], ["k", "delete", branchDelete]] },
        { description: "", items: [] },
      ],
    },
  ],
});

// Log.

const logRelated = e8.defineCommand({
  name: "magit-log-related",
  doc: "Show the log of the current branch, its upstream and its push target.",
  run: () => {
    const dir = repo();
    const branch = currentBranch();
    const revs = ["HEAD", ...[upstreamOf(branch)].filter((r): r is string => r !== undefined)];
    const args = logArgs();
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, ...revs]));
    e8.gotoChar(0);
  },
});

const logBranches = (name: string, doc: string, refs: string[]) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const dir = repo();
      const args = logArgs();
      setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, ...refs]));
      e8.gotoChar(0);
    },
  });

/** Shows a reflog, as magit-reflog-current. */
const reflog = (name: string, doc: string, ref: () => string) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const dir = repo();
      const r = ref();
      setupBuffer(`magit-reflog: ${repoName(dir)}`, magitLogMode, "reflog", () =>
        insertRoot("reflogbuf", () => {
          for (const line of gitLines(["reflog", "show", "--format=%h%x00%gs", "-n256", r])) {
            const [hash, subject] = line.split("\0");
            insertSection("commit", hash, false, () => insertHeading(face(hash, "magit-hash"), " ", subject, "\n"));
          }
        }),
      );
      e8.gotoChar(0);
    },
  });

const shortlog = e8.defineCommand({
  name: "magit-shortlog",
  doc: "Show the commits by author, as git shortlog.",
  run: () => {
    const dir = repo();
    const out = gitOutput(["shortlog", "HEAD"]).output;
    setupBuffer(`magit-shortlog: ${repoName(dir)}`, magitLogMode, "shortlog", () => insertRoot("shortlog", () => e8.insert(out)));
    e8.gotoChar(0);
  },
});

/** The log arguments, those that change what git log lists rather than how it draws it. */
const logArgs = (): string[] => transientArgs("magit-log").filter((a) => !["--graph", "--color", "--decorate", "++header", "--show-signature"].includes(a));

const logMenu = transientDefinePrefix("magit-log", {
  doc: "Show a commit or reference log.",
  value: ["-n256", "--graph", "--decorate"],
  groups: [
    {
      description: "Commit limiting",
      items: [
        ["-n", "Limit number of commits", "-n", { class: "option", prompt: "Limit number of commits: " }],
        ["-A", "Limit to author", "--author=", { prompt: "Limit to author: " }],
        ["-F", "Search messages", "--grep=", { prompt: "Search messages: " }],
        ["-G", "Search changes", "-G", { class: "option", prompt: "Search changes: " }],
        ["-S", "Search occurrences", "-S", { class: "option", prompt: "Search occurrences: " }],
        ["-L", "Trace line evolution", "-L", { class: "option", prompt: "Trace line evolution: " }],
      ],
    },
    {
      description: "History simplification",
      items: [
        ["-D", "Simplify by decoration", "--simplify-by-decoration"],
        ["--", "Limit to files", "--", { class: "option", prompt: "Limit to files: " }],
        ["-f", "Follow renames when showing single-file log", "--follow"],
      ],
    },
    {
      description: "Commit ordering",
      items: [
        ["-o", "Order commits by", "--", { class: "switches", argumentFormat: "--%s-order", choices: ["topo", "author-date", "date"] }],
        ["-r", "Reverse order", "--reverse"],
      ],
    },
    {
      description: "Formatting",
      items: [
        ["-g", "Show graph", "--graph"],
        ["-c", "Show graph in color", "--color"],
        ["-d", "Show refnames", "--decorate"],
        ["=S", "Show signatures", "--show-signature"],
        ["-h", "Show header", "++header", { class: "switch" }],
        ["-p", "Show diffs", "--patch"],
        ["-s", "Show diffstats", "--stat"],
      ],
    },
    {
      items: [
        { description: "Log", items: [["l", "current", logCurrent], ["o", "other", logOther], ["u", "related", logRelated]] },
        {
          description: "",
          items: [
            ["L", "local branches", logBranches("magit-log-branches", "Show the log of all local branches and HEAD.", ["--branches", "HEAD"])],
            ["b", "all branches", logBranches("magit-log-all-branches", "Show the log of all local and remote branches and HEAD.", ["--branches", "--remotes", "HEAD"])],
            ["a", "all references", logAll],
          ],
        },
        {
          description: "Reflog",
          items: [
            ["r", "current", reflog("magit-reflog-current", "Show the reflog of the current branch.", () => branchOrHead())],
            ["O", "other", reflog("magit-reflog-other", "Show the reflog of a branch read.", () => readBranch("Show reflog for", localBranches(), currentBranch()))],
            ["H", "HEAD", reflog("magit-reflog-head", "Show the HEAD reflog.", () => "HEAD")],
          ],
        },
        { description: "Other", items: [["s", "shortlog", shortlog]] },
      ],
    },
  ],
});

// Merge.

const mergeWith = (name: string, doc: string, extra: string[]) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const branch = readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()]);
      runGit(["merge", ...transientArgs("magit-merge"), ...extra, branch]);
    },
  });
const mergePlain = mergeWith("magit-merge-plain", "Merge a branch into the current one.", ["--no-edit"]);
const mergeEdit = e8.defineCommand({
  name: "magit-merge-editmsg",
  doc: "Merge a branch into the current one, writing the merge commit's message.",
  run: () => {
    const branch = readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()]);
    runGitAsync(["merge", "--edit", ...transientArgs("magit-merge"), branch], "Merging", true);
  },
});
const mergeNocommit = mergeWith("magit-merge-nocommit", "Merge a branch into the current one, without committing.", ["--no-commit", "--no-ff"]);
const mergeSquash = mergeWith("magit-merge-squash", "Squash the changes of a branch into the index, without committing.", ["--squash"]);
const mergeAbsorb = e8.defineCommand({
  name: "magit-merge-absorb",
  doc: "Merge a branch into the current one and delete it.",
  run: () => {
    const branch = readBranch("Absorb branch", localBranches().filter((b) => b !== currentBranch()));
    if (runGit(["merge", "--no-edit", ...transientArgs("magit-merge"), branch])) runGit(["branch", "-D", branch]);
  },
});
const mergeDissolve = e8.defineCommand({
  name: "magit-merge-into",
  doc: "Merge the current branch into another and delete the current one.",
  run: () => {
    const from = currentBranch();
    if (!from) e8.userError("No branch is checked out");
    const into = readBranch(`Merge ${from} into`, localBranches().filter((b) => b !== from), upstreamOf(from)?.replace(/^[^/]+\//, ""));
    if (runGit(["checkout", into]) && runGit(["merge", "--no-edit", ...transientArgs("magit-merge"), from])) runGit(["branch", "-D", from]);
  },
});
const mergePreview = e8.defineCommand({
  name: "magit-merge-preview",
  doc: "Show the changes merging a branch would make.",
  run: () => {
    const branch = readBranch("Preview merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()]);
    const dir = repo();
    const base = gitString(["merge-base", "HEAD", branch]) ?? "HEAD";
    const out = gitOutput(["diff", "--no-prefix", "-p", base, branch]).output;
    setupBuffer(`magit-merge-preview: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(out), "commit")));
    e8.gotoChar(0);
  },
});

const mergeMenu = transientDefinePrefix("magit-merge", {
  doc: "Merge branches.",
  groups: [
    { description: "Arguments", items: [["-f", "Fast-forward only", "--ff-only"], ["-n", "No fast-forward", "--no-ff"], ["-s", "Strategy", "--strategy=", { choices: ["resolve", "recursive", "octopus", "ours", "subtree", "ort"] }]] },
    {
      description: "Actions",
      items: [
        { items: [["m", "Merge", mergePlain], ["e", "Merge and edit message", mergeEdit], ["n", "Merge but don't commit", mergeNocommit], ["a", "Absorb", mergeAbsorb]] },
        { items: [["p", "Preview merge", mergePreview], "", ["s", "Squash merge", mergeSquash], ["d", "Dissolve", mergeDissolve]] },
      ],
    },
  ],
});

// Reset.

const resetFile = e8.defineCommand({
  name: "magit-file-checkout",
  doc: "Reset a file in the index and the working tree to a commit.",
  run: () => {
    const rev = readBranch("Checkout from revision", [...localBranches(), ...remoteBranches()], "HEAD");
    const file = e8.completingRead(`Checkout file from ${rev}: `, gitLines(["ls-files"]), { requireMatch: true });
    runGit(["checkout", rev, "--", file]);
  },
});

const resetMenu = transientDefinePrefix("magit-reset", {
  doc: "Reset the current branch.",
  groups: [
    {
      items: [
        { description: "Reset", items: [["b", "branch", branchReset], ["f", "file", resetFile]] },
        {
          description: "Reset this",
          items: [
            ["m", "mixed    (HEAD and index)", resetCommand("mixed", "Reset HEAD and the index to a commit, keeping the working tree.")],
            ["s", "soft     (HEAD only)", resetCommand("soft", "Reset HEAD to a commit, keeping the index and working tree.")],
            ["h", "hard     (HEAD, index and worktree)", resetCommand("hard", "Reset HEAD, the index and the working tree to a commit.")],
            ["k", "keep     (HEAD and index, keeping uncommitted)", resetCommand("keep", "Reset HEAD and the index to a commit, keeping uncommitted changes.")],
            ["i", "index    (only)", gitCommand("magit-reset-index", "Reset the index to a commit, keeping HEAD and the working tree.", () => ["reset", readBranch("Reset index to", [...localBranches(), ...remoteBranches()], "HEAD"), "--", "."])],
            ["w", "worktree (only)", gitCommand("magit-reset-worktree", "Reset the working tree to a commit, keeping HEAD and the index.", () => ["checkout", readBranch("Reset worktree to", [...localBranches(), ...remoteBranches()], "HEAD"), "--", "."])],
          ],
        },
      ],
    },
  ],
});

// Diff.

const diffArgs = (): string[] => transientArgs("magit-diff").filter((a) => a !== "--stat" && !a.startsWith("--show-signature"));
const diffBuffer = (args: string[]) => {
  const dir = repo();
  const out = gitOutput(["diff", "--no-prefix", "-p", ...diffArgs(), ...args]).output;
  setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(out), "commit")));
  e8.gotoChar(0);
};
const diffRange = e8.defineCommand({ name: "magit-diff-range", doc: "Show the differences between two commits, as A..B read.", run: () => diffBuffer([e8.readString("Diff for range: ", { default: "HEAD~..HEAD" }) || "HEAD~..HEAD"]) });
const diffPaths = e8.defineCommand({
  name: "magit-diff-paths",
  doc: "Show the changes between two files.",
  run: () => diffBuffer(["--no-index", e8.readFileName("First file: "), e8.readFileName("Second file: ")]),
});
const diffWorktree = e8.defineCommand({ name: "magit-diff-working-tree", doc: "Show the changes between the working tree and HEAD.", run: () => diffBuffer(["HEAD"]) });
const showCommitCommand = e8.defineCommand({ name: "magit-show-commit", doc: "Show a commit read, or the one at point.", run: () => showCommit(readCommit("Show commit")) });
const showStash = e8.defineCommand({ name: "magit-stash-show", doc: "Show a stash.", run: () => showCommit(stashAt("Show stash")) });

const diffMenu = transientDefinePrefix("magit-diff", {
  doc: "Show changes between different versions.",
  groups: [
    {
      description: "Limit arguments",
      items: [
        ["--", "Limit to files", "--", { class: "option", prompt: "Limit to files: " }],
        ["-i", "Ignore submodules", "--ignore-submodules=", { choices: ["untracked", "dirty", "all"] }],
        ["-b", "Ignore whitespace changes", "--ignore-space-change"],
        ["-w", "Ignore all whitespace", "--ignore-all-space"],
      ],
    },
    { description: "Context arguments", items: [["-U", "Context lines", "-U", { class: "option", prompt: "Context lines: " }], ["-W", "Show surrounding functions", "--function-context"]] },
    {
      description: "Tune arguments",
      items: [
        ["-A", "Diff algorithm", "--diff-algorithm=", { choices: ["default", "minimal", "patience", "histogram"] }],
        ["-X", "Diff merges", "--diff-merges=", { choices: ["off", "on", "first-parent", "separate", "combined", "dense-combined", "remerge"] }],
        ["-M", "Detect renames", "-M", { class: "option", prompt: "Detect renames: " }],
        ["-C", "Detect copies", "-C", { class: "option", prompt: "Detect copies: " }],
        ["-x", "Disallow external diff drivers", "--no-ext-diff"],
        ["-s", "Show stats", "--stat"],
        ["=g", "Show signature", "--show-signature"],
      ],
    },
    {
      description: "Actions",
      items: [
        { items: [["d", "Dwim", diffDwim], ["r", "Diff range", diffRange], ["p", "Diff paths", diffPaths]] },
        { items: [["u", "Diff unstaged", diffUnstaged], ["s", "Diff staged", diffStaged], ["w", "Diff worktree", diffWorktree]] },
        { items: [["c", "Show commit", showCommitCommand], ["t", "Show stash", showStash]] },
      ],
    },
  ],
});

// Stash.

const stashIndex = gitCommand("magit-stash-index", "Stash the changes in the index only.", () => ["stash", "push", "--staged", ...transientArgs("magit-stash")]);
const stashWorktree = gitCommand("magit-stash-worktree", "Stash the changes in the working tree only, keeping the index.", () => ["stash", "push", "--keep-index", ...transientArgs("magit-stash")]);
const stashKeepIndex = gitCommand("magit-stash-keep-index", "Stash the changes in the index and the working tree, keeping the index.", () => ["stash", "push", "--keep-index", ...transientArgs("magit-stash")]);
const snapshot = (name: string, doc: string, extra: string[]) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const r = gitOutput(["stash", "create", ...extra]);
      const hash = r.output.trim();
      if (hash === "") e8.userError("No local changes to save");
      runGit(["stash", "store", "-m", `Snapshot of ${branchOrHead()}`, hash]);
    },
  });
const stashToWip = e8.defineCommand({
  name: "magit-wip-commit",
  doc: "Commit the working tree's changes to a work-in-progress ref, refs/wip/wtree/refs/heads/BRANCH.",
  run: () => {
    const hash = gitOutput(["stash", "create"]).output.trim();
    if (hash === "") e8.userError("No local changes to save");
    runGit(["update-ref", `refs/wip/wtree/refs/heads/${branchOrHead()}`, hash]);
  },
});
const stashList = e8.defineCommand({
  name: "magit-stash-list",
  doc: "List the stashes.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-stashes: ${repoName(dir)}`, magitLogMode, "stashes", () =>
      insertRoot("stashesbuf", () => {
        for (const s of gitLines(["stash", "list", "--format=%gd%x00%gs"])) {
          const [ref, subject] = s.split("\0");
          insertSection("stash", ref, false, () => insertHeading(face(ref, "magit-hash"), ` ${subject}`, "\n"));
        }
      }),
    );
    e8.gotoChar(0);
  },
});
const stashBranch = e8.defineCommand({
  name: "magit-stash-branch",
  doc: "Create a branch from a stash's commit, apply the stash to it and drop the stash.",
  run: () => {
    const s = stashAt("Branch from stash");
    const name = e8.readString("Branch name: ");
    runGit(["stash", "branch", name, s]);
  },
});
const stashBranchHere = e8.defineCommand({
  name: "magit-stash-branch-here",
  doc: "Create a branch at HEAD, check it out, apply a stash to it and drop the stash.",
  run: () => {
    const s = stashAt("Branch from stash");
    const name = e8.readString("Branch name: ");
    if (runGit(["checkout", "-b", name]) && runGit(["stash", "apply", s])) runGit(["stash", "drop", s]);
  },
});
const stashFormatPatch = e8.defineCommand({
  name: "magit-stash-format-patch",
  doc: "Write a stash as a patch file.",
  run: () => {
    const s = stashAt("Format patch from stash");
    const out = gitOutput(["stash", "show", "-p", s]).output;
    const file = e8.expandFileName(`${s.replace(/[@{}]/g, "")}.patch`, repo());
    e8.writeTextFile(file, out);
    e8.message(`Wrote ${file}`);
  },
});

const stashMenu = transientDefinePrefix("magit-stash", {
  doc: "Stash uncommitted changes.",
  groups: [
    { description: "Arguments", items: [["-u", "Also save untracked files", "--include-untracked"], ["-a", "Also save untracked and ignored files", "--all"]] },
    {
      items: [
        { description: "Stash", items: [["z", "both", stashBoth], ["i", "index", stashIndex], ["w", "worktree", stashWorktree], ["x", "keeping index", stashKeepIndex]] },
        {
          description: "Snapshot",
          items: [
            ["Z", "both", snapshot("magit-snapshot-both", "Save a stash of the index and working tree, keeping them.", [])],
            ["I", "index", snapshot("magit-snapshot-index", "Save a stash of the index, keeping it.", [])],
            ["W", "worktree", snapshot("magit-snapshot-worktree", "Save a stash of the working tree, keeping it.", [])],
            ["r", "to wip ref", stashToWip],
          ],
        },
        { description: "Use", items: [["a", "Apply", stashApply], ["p", "Pop", stashPop], ["k", "Drop", stashDrop]] },
        { description: "Inspect", items: [["l", "List", stashList], ["v", "Show", showStash]] },
        { description: "Transform", items: [["b", "Branch", stashBranch], ["B", "Branch here", stashBranchHere], ["f", "Format patch", stashFormatPatch]] },
      ],
    },
  ],
});

// The other menus and commands the dispatch menu names.

const cherryPick = e8.defineCommand({
  name: "magit-cherry-pick",
  doc: "Apply the commit at point, or one read, to the current branch, as git cherry-pick.",
  run: () => runGit(["cherry-pick", readCommit("Cherry-pick")]) as unknown as void,
});
const revertCommit = e8.defineCommand({
  name: "magit-revert-and-commit",
  doc: "Revert the commit at point, or one read, committing the reversion.",
  run: () => runGit(["revert", "--no-edit", readCommit("Revert commit")]) as unknown as void,
});
const tagCreate = e8.defineCommand({
  name: "magit-tag-create",
  doc: "Create a tag at the commit at point, or one read.",
  run: () => {
    const name = e8.readString("Tag name: ");
    if (name === "") e8.userError("No name given");
    runGit(["tag", name, readCommit(`Place ${name} on`)]);
  },
});
const gitignore = e8.defineCommand({
  name: "magit-gitignore-in-topdir",
  doc: "Add a file or pattern to the .gitignore at the top of the repository.",
  run: () => {
    const s = currentSection();
    const def = s?.type === "file" ? (s.value as FileValue).file : undefined;
    const pattern = e8.readString(def ? `File or pattern to ignore (default ${def}): ` : "File or pattern to ignore: ", { default: def });
    if (pattern === "") e8.userError("Nothing to ignore");
    const file = `${repo()}.gitignore`;
    const old = e8.fileExists(file) ? e8.readTextFile(file) : "";
    e8.writeTextFile(file, `${old}${old && !old.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    refreshAll();
  },
});
const gitInit = e8.defineCommand({
  name: "magit-init",
  doc: "Create a Git repository in a directory read.",
  run: () => {
    const dir = e8.readFileName("Create repository in: ", { dir: String(e8.variable("default-directory")) });
    e8.callProcess([git(), "init", e8.expandFileName(dir)]);
    e8.letBind({ "default-directory": e8.fileNameAsDirectory(e8.expandFileName(dir)) }, () => e8.call(magitStatus));
  },
});
const gitClone = e8.defineCommand({
  name: "magit-clone",
  doc: "Clone a repository from a URL read into a directory read.",
  run: () => {
    const url = e8.readString("Clone repository: ");
    const dir = e8.readFileName("Clone to: ", { dir: String(e8.variable("default-directory")), initial: url.replace(/\.git$/, "").replace(/.*[/:]/, "") });
    const r = e8.callProcess([git(), "clone", url, e8.expandFileName(dir)]);
    if (r.exit !== 0) e8.userError(r.output.trim());
    e8.letBind({ "default-directory": e8.fileNameAsDirectory(e8.expandFileName(dir)) }, () => e8.call(magitStatus));
  },
});
const gitRun = e8.defineCommand({
  name: "magit-git-command",
  doc: "Run git with arguments read, as ! ! does.",
  run: () => {
    const args = e8.readString("Run git: ");
    runGit(args.split(/\s+/).filter(Boolean));
  },
});
const showRefs = e8.defineCommand({
  name: "magit-show-refs",
  doc: "List the branches and tags, with their commits.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-refs: ${repoName(dir)}`, magitLogMode, "refs", () =>
      insertRoot("refbuf", () => {
        for (const [title, pattern] of [
          ["Branches", "refs/heads"],
          ["Remote branches", "refs/remotes"],
          ["Tags", "refs/tags"],
        ] as const) {
          const refs = gitLines(["for-each-ref", "--format=%(refname:short)%00%(objectname:short)%00%(subject)", pattern]);
          if (refs.length === 0) continue;
          insertSection("refs", title, false, () => {
            insertHeading(face(title, "magit-section-heading"), "\n");
            for (const r of refs) {
              const [name, hash, subject] = r.split("\0");
              insertSection("commit", hash, false, () => insertHeading("  ", face(name.padEnd(20), pattern === "refs/remotes" ? "magit-branch-remote" : pattern === "refs/tags" ? "magit-tag" : "magit-branch-local"), " ", face(hash, "magit-hash"), " ", subject, "\n"));
            }
            e8.insert("\n");
          });
        }
      }),
    );
    e8.gotoChar(0);
  },
});
const cherries = e8.defineCommand({
  name: "magit-cherry",
  doc: "Show the commits of the current branch not in its upstream, as git cherry.",
  run: () => {
    const dir = repo();
    const up = upstreamOf(currentBranch()) ?? readBranch("Cherry upstream", remoteBranches());
    setupBuffer(`magit-cherry: ${repoName(dir)}`, magitLogMode, "cherry", () => insertRoot("cherry", () => insertCommits([`${up}..HEAD`])));
    e8.gotoChar(0);
  },
});
const remoteAdd = e8.defineCommand({
  name: "magit-remote-add",
  doc: "Add a remote, by a name and URL read.",
  run: () => {
    const name = e8.readString("Remote name: ");
    const url = e8.readString("Remote url: ");
    runGit(["remote", "add", name, url]);
  },
});
const formatPatches = e8.defineCommand({
  name: "magit-format-patch",
  doc: "Write the commit at point, or one read, as a patch file.",
  run: () => runGit(["format-patch", "-1", readCommit("Format patch for")]) as unknown as void,
});
const jumpToSection = e8.defineCommand({
  name: "magit-status-jump",
  doc: "Jump to a section of the status buffer, chosen by its heading.",
  run: () => {
    const top = sections()?.root.children ?? [];
    const names = top.map((s) => e8.bufferSubstringNoProperties(s.start, e8.lineEndPosition(s.start)));
    const chosen = e8.completingRead("Jump to section: ", names, { requireMatch: true });
    const s = top[names.indexOf(chosen)];
    if (s) e8.gotoChar(s.start);
  },
});
const displayRepositoryBuffer = e8.defineCommand({
  name: "magit-display-repository-buffer",
  doc: "Show one of the repository's Magit buffers.",
  run: () => {
    const names = e8.bufferList().filter((b) => /^magit[-a-z]*: /.test(b));
    e8.call("switch-to-buffer", e8.completingRead("Display buffer: ", names, { requireMatch: true }));
  },
});
const sectionInfo = e8.defineCommand({
  name: "magit-describe-section",
  doc: "Say what the section at point is.",
  run: () => {
    const s = currentSection();
    if (!s) e8.userError("No section at point");
    const chain: string[] = [];
    for (let x: Section | undefined = s; x && x.parent; x = x.parent) chain.push(x.type);
    e8.message(`(${chain.join(" ")}) [${s.start}-${s.end}]`);
  },
});
const help = e8.defineCommand({ name: "magit-info", doc: "Show what Magit's keys do.", run: () => e8.call("describe-mode") });

const dispatch = transientDefinePrefix("magit-dispatch", {
  doc: "Invoke a Magit command from a list of available commands.",
  groups: [
    {
      description: "Transient and dwim commands",
      items: [
        {
          items: [
            ["A", "Apply", cherryPick],
            ["b", "Branch", branchMenu],
            ["B", "Bisect", notYet("magit-bisect", "Bisecting")],
            ["c", "Commit", commitMenu],
            ["C", "Clone", gitClone],
            ["d", "Diff", diffMenu],
            ["D", "Diff (change)", diffMenu],
            ["e", "Ediff (dwim)", notYet("magit-ediff-dwim", "Ediff")],
            ["E", "Ediff", notYet("magit-ediff", "Ediff")],
            ["f", "Fetch", fetchMenu],
            ["F", "Pull", pullMenu],
            ["h", "Help", help],
            ["H", "Section info", sectionInfo],
          ],
        },
        {
          items: [
            ["i", "Ignore", gitignore],
            ["I", "Init", gitInit],
            ["j", "Jump to section", jumpToSection],
            ["J", "Display buffer", displayRepositoryBuffer],
            ["l", "Log", logMenu],
            ["L", "Log (change)", logMenu],
            ["m", "Merge", mergeMenu],
            ["M", "Remote", remoteAdd],
            ["o", "Submodule", notYet("magit-submodule", "Submodules")],
            ["O", "Subtree", notYet("magit-subtree", "Subtrees")],
            ["P", "Push", pushMenu],
            ["Q", "Command", gitRun],
          ],
        },
        {
          items: [
            ["r", "Rebase", rebaseMenu],
            ["t", "Tag", tagCreate],
            ["T", "Note", notYet("magit-notes", "Notes")],
            ["V", "Revert", revertCommit],
            ["w", "Apply patches", notYet("magit-am", "Applying patches")],
            ["W", "Format patches", formatPatches],
            ["X", "Reset", resetMenu],
            ["y", "Show Refs", showRefs],
            ["Y", "Cherries", cherries],
            ["z", "Stash", stashMenu],
            ["Z", "Worktree", notYet("magit-worktree", "Worktrees")],
            ["!", "Run", gitRun],
          ],
        },
      ],
    },
    {
      description: "Applying changes",
      items: [
        { items: [["a", "Apply", notYet("magit-apply", "Applying a change from elsewhere")], ["v", "Reverse", notYet("magit-reverse", "Reversing a change")], ["k", "Discard", magitDiscard]] },
        { items: [["s", "Stage", magitStage], ["u", "Unstage", magitUnstage]] },
        { items: [["S", "Stage all", stageModified], ["U", "Unstage all", unstageAll]] },
      ],
    },
    {
      description: "Essential commands",
      items: [
        {
          padKeys: true,
          items: [
            ["g", "Refresh current buffer", refreshCommand],
            ["q", "Bury current buffer", "quit-window"],
            ["<tab>", "Toggle section at point", "magit-section-toggle"],
            ["<return>", "Visit thing at point", magitVisitThing],
          ],
        },
        { items: [["C-x m", "Show all key bindings", "describe-mode"], ["C-x i", "Show Info manual", help]] },
      ],
    },
  ],
});

const bindings: [string, e8.DefinedCommand | string][] = [
  ["s", magitStage],
  ["S", stageModified],
  ["u", magitUnstage],
  ["U", unstageAll],
  ["k", magitDiscard],
  ["RET", magitVisitThing],
  ["g", refreshCommand],
  ["G", refreshAllCommand],
  ["$", processBuffer],
  ["c", commitMenu],
  ["b", branchMenu],
  ["P", pushMenu],
  ["F", pullMenu],
  ["f", fetchMenu],
  ["m", mergeMenu],
  ["X", resetMenu],
  ["z", stashMenu],
  ["r", rebaseMenu],
  ["l", logMenu],
  ["d", diffMenu],
  ["h", dispatch],
  ["?", dispatch],
  ["q", "quit-window"],
];
for (const [key, command] of bindings) e8.defineKey("magit-mode-map", key, command as e8.DefinedCommand);

e8.bindKey("C-x g", magitStatus);
e8.bindKey("C-x M-g", dispatch);

void sectionAt;
