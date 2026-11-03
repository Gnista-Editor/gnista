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
// Emacs as its editor for that, where Ember writes the message to a file
// for git commit -F.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, insertHeading, insertRoot, insertSection, magitSectionMode, sectionAt, sections, show, type Section } from "magit-section";
import { transientArgs, transientDefinePrefix, type Group } from "transient";
import { PerBuffer, truthy } from "subr";

// Faces.

const faces: [string, string, ember.FaceAttributes, ember.FaceAttributes?, ember.FaceAttributes?][] = [
  ["magit-branch-local", "Face for local branches.", {}, { foreground: "SkyBlue4" }, { foreground: "LightSkyBlue1" }],
  ["magit-branch-remote", "Face for remote branch head labels.", {}, { foreground: "DarkOliveGreen4" }, { foreground: "DarkSeaGreen2" }],
  ["magit-branch-current", "Face for the current branch.", { inherit: "magit-branch-local", box: true } as ember.FaceAttributes],
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
  ["magit-process-ok", "Face for zero exit-status.", { inherit: "magit-section-heading", foreground: "green" } as ember.FaceAttributes],
  ["magit-process-ng", "Face for non-zero exit-status.", { inherit: "magit-section-heading", foreground: "red" } as ember.FaceAttributes],
];
for (const [name, doc, attributes, light, dark] of faces) ember.defineFace({ name, doc, attributes, light, dark });

ember.defineVariable({ name: "magit-git-executable", doc: "The Git executable used by Magit.", value: "git" });
ember.defineVariable({ name: "magit-log-section-commit-count", doc: "How many recent commits the status buffer shows.", value: 10 });
ember.defineVariable({ name: "magit-save-repository-buffers", doc: "Whether to save the repository's modified file buffers before running git, as Magit asks.", value: true });

// Running git.

/** The repository's top directory, with a slash, for DIR or the current buffer's directory, as magit-toplevel. */
export function toplevel(dir = String(ember.variable("default-directory") ?? ".")): string | undefined {
  const r = ember.callProcess([git(), "rev-parse", "--show-toplevel"], { directory: ember.expandFileName(dir) });
  return r.exit === 0 ? ember.fileNameAsDirectory(r.output.trim()) : undefined;
}

const git = (): string => String(ember.variable("magit-git-executable") ?? "git");

/** The repository the current buffer belongs to, as Magit's buffers keep it in default-directory. */
function repo(): string {
  const top = toplevel();
  if (!top) ember.userError(`Not inside a Git repository: ${ember.abbreviateFileName(String(ember.variable("default-directory")))}`);
  return top!;
}

/** The commands run and their output, for $ to show, as the magit-process buffer has them. */
const processLog: { args: string[]; exit: number; output: string; dir: string }[] = [];

/** Runs git with ARGS in the repository and gives its output, as magit-git-string and magit-git-lines. */
export function gitOutput(args: string[], input?: string, dir = repo()): { exit: number; output: string } {
  return ember.callProcess([git(), "--no-pager", "--literal-pathspecs", "-c", "core.preloadindex=true", "-c", "log.showSignature=false", "-c", "color.ui=false", "-c", "color.diff=false", ...args], { directory: dir, input });
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
    ember.message(`${line.replace(/^(error|fatal): /, "")} ... [Hit $ to see buffer magit-process: ${ember.fileNameNondirectory(dir.replace(/\/$/, ""))} for details]`);
    return false;
  }
  return true;
}

/** Runs git without waiting, as push and pull do, logging its output and refreshing when it ends, as magit-run-git-async. */
export function runGitAsync(args: string[], what: string): void {
  saveRepositoryBuffers();
  const dir = repo();
  const entry = { args, exit: -1, output: "", dir };
  processLog.push(entry);
  ember.message(`Running git ${args.join(" ")}`);
  ember.makeProcess({
    name: "magit-git",
    command: [git(), "--no-pager", "-c", "color.ui=false", ...args],
    directory: dir,
    env: { GIT_TERMINAL_PROMPT: "0" },
    connectionType: "pipe",
    filter: (_p, output) => {
      entry.output += output;
    },
    sentinel: (_p, event) => {
      entry.exit = event.startsWith("finished") ? 0 : Number(/code (\d+)/.exec(event)?.[1] ?? 1);
      ember.withCurrentBuffer(ember.currentBuffer(), () => refreshAll(dir));
      if (entry.exit === 0) ember.message(`${what}...done`);
      else ember.message(`${(entry.output.split("\n").find((l) => l.trim()) ?? what).replace(/^(error|fatal): /, "")} ... [Hit $ to see buffer magit-process for details]`);
    },
  });
}

/** Saves the repository's modified file buffers first, as magit-save-repository-buffers. */
function saveRepositoryBuffers(): void {
  if (!truthy(ember.variable("magit-save-repository-buffers"))) return;
  const top = toplevel();
  if (!top) return;
  for (const b of ember.bufferList()) {
    ember.withCurrentBuffer(b, () => {
      const f = ember.bufferFileName();
      if (f && ember.bufferModified() && ember.expandFileName(f).startsWith(top)) ember.call("save-buffer");
    });
  }
}

// Inserting the status buffer.

const face = (text: string, f: string): ember.PropertizedString => ember.propertize(text, { face: f });

/** A ref as Magit shows it in a log line, from %D's decorations, as magit-format-ref-labels. */
function refLabels(decorations: string): ember.PropertizedString | string {
  const parts: ember.PropertizedString[] = [];
  for (const d of decorations.split(", ").filter((x) => x !== "")) {
    if (d.startsWith("HEAD -> ")) parts.push(face(d.slice(8), "magit-branch-current"));
    else if (d === "HEAD") parts.push(face("@", "magit-head"));
    else if (d.startsWith("tag: ")) parts.push(face(d.slice(5), "magit-tag"));
    else if (d.endsWith("/HEAD")) continue;
    else if (d.includes("/")) parts.push(face(d, "magit-branch-remote"));
    else parts.push(face(d, "magit-branch-local"));
  }
  return parts.length === 0 ? "" : ember.concat(...parts.flatMap((p, i) => (i === 0 ? [p] : [" ", p])), " ");
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
  ember.insert(ember.concat(label("Head:"), headLabel, subject !== undefined ? ` ${subject}` : " nothing committed (yet)", "\n"));
  const upstream = upstreamOf(branch);
  if (upstream) {
    const usubject = gitString(["log", "-1", "--format=%s", upstream]);
    const kind = gitString(["config", `branch.${branch}.rebase`]) === "true" ? "Rebase:" : "Merge:";
    ember.insert(ember.concat(label(kind), face(upstream, "magit-branch-remote"), usubject !== undefined ? ` ${usubject}` : "", "\n"));
  }
  const pushRemote = branch ? (gitString(["config", `branch.${branch}.pushRemote`]) ?? gitString(["config", "remote.pushDefault"])) : undefined;
  if (pushRemote && branch && `${pushRemote}/${branch}` !== upstream) {
    const target = `${pushRemote}/${branch}`;
    const psubject = gitString(["log", "-1", "--format=%s", target]);
    ember.insert(ember.concat(label("Push:"), face(target, "magit-branch-remote"), psubject !== undefined ? ` ${psubject}` : "", "\n"));
  }
  const tag = gitString(["describe", "--tags", "--abbrev=0"]);
  if (tag) {
    const count = gitString(["rev-list", "--count", `${tag}..HEAD`]);
    ember.insert(ember.concat(label("Tag:"), face(tag, "magit-tag"), count && count !== "0" ? ` (${count})` : "", "\n"));
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
            ember.insert(face(`${l}\n`, f));
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
    ember.insert("\n");
    const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]);
    // Each section ends with the blank line after it, which hides with it, as Magit inserts it.
    if (untracked.length > 0) {
      insertSection("untracked", undefined, true, () => {
        insertHeading(face("Untracked files", "magit-section-heading"), ` (${untracked.length})`, "\n");
        for (const f of untracked) insertSection("file", { file: f, kind: "untracked" }, false, () => insertHeading(face(f, "magit-filename"), "\n"));
        ember.insert("\n");
      });
    }
    const unstaged = parseDiff(gitOutput(["diff", "--no-ext-diff", "--no-prefix", "-p"]).output);
    if (unstaged.length > 0) {
      insertSection("unstaged", undefined, false, () => {
        insertHeading(face("Unstaged changes", "magit-section-heading"), ` (${unstaged.length})`, "\n");
        insertFiles(unstaged, "unstaged");
        ember.insert("\n");
      });
    }
    const staged = parseDiff(gitOutput(["diff", "--cached", "--no-ext-diff", "--no-prefix", "-p"]).output);
    if (staged.length > 0) {
      insertSection("staged", undefined, false, () => {
        insertHeading(face("Staged changes", "magit-section-heading"), ` (${staged.length})`, "\n");
        insertFiles(staged, "staged");
        ember.insert("\n");
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
        ember.insert("\n");
      });
    }
    const branch = currentBranch();
    const upstream = upstreamOf(branch);
    if (upstream && gitLines(["rev-list", `${upstream}..HEAD`]).length > 0) {
      insertSection("unpushed", upstream, false, () => {
        const n = gitLines(["rev-list", `${upstream}..HEAD`]).length;
        insertHeading(face("Unmerged into ", "magit-section-heading"), face(upstream, "magit-branch-remote"), ` (${n})`, "\n");
        insertCommits([`${upstream}..HEAD`]);
        ember.insert("\n");
      });
    } else if (!upstream && hasCommits()) {
      insertSection("recent", undefined, true, () => {
        insertHeading(face("Recent commits", "magit-section-heading"), "\n");
        insertCommits([`-${Number(ember.variable("magit-log-section-commit-count") ?? 10)}`]);
        ember.insert("\n");
      });
    }
    if (upstream && gitLines(["rev-list", `HEAD..${upstream}`]).length > 0) {
      insertSection("unpulled", upstream, false, () => {
        const n = gitLines(["rev-list", `HEAD..${upstream}`]).length;
        insertHeading(face("Unpulled from ", "magit-section-heading"), face(upstream, "magit-branch-remote"), ` (${n})`, "\n");
        insertCommits([`HEAD..${upstream}`]);
        ember.insert("\n");
      });
    }
  });
}

// Buffers.

/** What each Magit buffer shows and how to make it again. */
const buffers = new PerBuffer<{ kind: string; refresh: () => void }>();

/** Makes or shows a Magit buffer for the repository, as magit-setup-buffer: NAME, its mode, and what refreshes it. */
function setupBuffer(name: string, mode: ember.DefinedCommand, kind: string, refresh: () => void, select = true): string {
  const dir = repo();
  const existed = ember.bufferLiveP(ember.getBuffer(name));
  ember.getBufferCreate(name);
  ember.withCurrentBuffer(name, () => {
    if (!existed) {
      ember.call(mode);
      ember.makeLocalVariable("default-directory");
      ember.setVariable("default-directory", dir);
    }
    buffers.set(ember.currentBuffer(), { kind, refresh });
    refreshBuffer();
  });
  if (select) ember.call("switch-to-buffer", name);
  return name;
}

/** Makes the current Magit buffer again, keeping point on the same section, as magit-refresh-buffer. */
function refreshBuffer(): void {
  const entry = buffers.get(ember.currentBuffer());
  if (!entry) return;
  const at = currentSection();
  const line = ember.lineOf(ember.point());
  const id = at ? sectionPath(at) : undefined;
  ember.letBind({ "inhibit-read-only": true }, () => entry.refresh());
  const again = id ? (sections()?.all ?? []).find((s) => sectionPath(s) === id) : undefined;
  if (again) ember.gotoChar(again.start);
  else ember.gotoChar(ember.lineStart(Math.min(line, ember.lineCount() - 1)));
  ember.setBufferModified(false);
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
  for (const b of ember.bufferList()) {
    const buf = ember.getBuffer(b);
    if (!buf || !buffers.get(buf)) continue;
    ember.withCurrentBuffer(b, () => {
      if (toplevel() === dir) refreshBuffer();
    });
  }
}

const repoName = (dir: string): string => ember.fileNameNondirectory(dir.replace(/\/$/, ""));

// Modes.

const modeBindings: { [keys: string]: string } = {};

export const magitMode = ember.defineMajorMode({
  name: "magit-mode",
  modeName: "Magit",
  parent: magitSectionMode,
  doc: "Parent major mode of Magit's buffers.",
});

export const magitStatusMode = ember.defineMajorMode({ name: "magit-status-mode", modeName: "Magit", parent: magitMode, doc: "Mode for looking at Git status: the files changed, staged and untracked, and the commits." });
export const magitLogMode = ember.defineMajorMode({ name: "magit-log-mode", modeName: "Magit Log", parent: magitMode, doc: "Mode for looking at Git log." });
export const magitRevisionMode = ember.defineMajorMode({ name: "magit-revision-mode", modeName: "Magit Rev", parent: magitMode, doc: "Mode for looking at a Git commit." });
export const magitDiffMode = ember.defineMajorMode({ name: "magit-diff-mode", modeName: "Magit Diff", parent: magitMode, doc: "Mode for looking at a Git diff." });
export const magitProcessMode = ember.defineMajorMode({ name: "magit-process-mode", modeName: "Magit Process", parent: magitMode, doc: "Mode for looking at Git process output." });
void modeBindings;

/** Shows the status of the repository, as magit-status. */
export const magitStatus = ember.defineCommand({
  name: "magit-status",
  doc: "Show the status of the current Git repository in a buffer: the branch, the changes and the commits not pushed.",
  run: () => {
    const dir = toplevel();
    if (!dir) {
      const answer = ember.readFileName("Initialize Git repository: ", { dir: String(ember.variable("default-directory")) });
      if (!ember.yOrNP(`Create repository in ${answer}? `)) ember.userError("Abort");
      ember.callProcess([git(), "init", ember.expandFileName(answer)]);
      ember.letBind({ "default-directory": ember.fileNameAsDirectory(ember.expandFileName(answer)) }, () => ember.call(magitStatus));
      return;
    }
    ember.letBind({ "default-directory": dir }, () => {
      setupBuffer(`magit: ${repoName(dir)}`, magitStatusMode, "status", insertStatus);
    });
    // Point starts on the first section after the headers, as Magit puts it.
    const first = sections()?.root.children[0];
    if (first) ember.gotoChar(first.start);
  },
});

const refreshCommand = ember.defineCommand({ name: "magit-refresh", doc: "Refresh the current buffer.", run: () => refreshBuffer() });
const refreshAllCommand = ember.defineCommand({ name: "magit-refresh-all", doc: "Refresh all buffers belonging to the current repository.", run: () => refreshAll() });

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

export const magitStage = ember.defineCommand({
  name: "magit-stage",
  doc: "Add the change at point to the staging area: an untracked or changed file, or a hunk.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) ember.userError("Nothing to stage");
    for (const v of t.values) {
      if (v.kind === "staged") ember.userError("Already staged");
      if (v.hunk) runGit(["apply", "--cached", "-p0", "--ignore-space-change", "-"], hunkPatch(v));
      else runGit(["add", "--", v.file]);
    }
  },
});

export const magitUnstage = ember.defineCommand({
  name: "magit-unstage",
  doc: "Remove the change at point from the staging area: a staged file or hunk.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) ember.userError("Nothing to unstage");
    for (const v of t.values) {
      if (v.kind !== "staged") ember.userError("Already unstaged");
      if (v.hunk) runGit(["apply", "--cached", "--reverse", "-p0", "-"], hunkPatch(v));
      else if (hasCommits()) runGit(["reset", "-q", "--", v.file]);
      else runGit(["rm", "--cached", "-q", "--", v.file]);
    }
  },
});

const stageModified = ember.defineCommand({
  name: "magit-stage-modified",
  doc: "Stage all changes to files tracked in the repository; with a prefix argument, untracked files too.",
  params: [{ name: "all", kind: "prefix" }],
  run: (all: ember.Value) => void runGit(["add", truthy(all) ? "--all" : "-u", "."]),
});

const unstageAll = ember.defineCommand({
  name: "magit-unstage-all",
  doc: "Remove all changes from the staging area.",
  run: () => void runGit(hasCommits() ? ["reset", "-q", "HEAD", "--"] : ["rm", "--cached", "-r", "-q", "."]),
});

export const magitDiscard = ember.defineCommand({
  name: "magit-discard",
  doc: "Remove the change at point from the working tree, or the index for a staged one: an untracked file is deleted.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) ember.userError("Nothing to discard");
    const what = t.values.length === 1 ? (t.values[0].hunk ? "hunk" : t.values[0].file) : `${t.values.length} files`;
    const kind = t.values[0].kind;
    const verb = kind === "untracked" ? "Delete" : "Discard";
    if (!ember.yOrNP(`${verb} ${what}? `)) ember.userError("Abort");
    for (const v of t.values) {
      if (v.kind === "untracked") {
        ember.deleteFile(ember.expandFileName(v.file, repo()));
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
export const magitVisitThing = ember.defineCommand({
  name: "magit-visit-thing",
  doc: "Visit the thing at point: a file at the line point is on in its diff, a commit, a stash.",
  run: () => {
    const s = currentSection();
    if (!s) ember.userError("There is no thing at point that could be visited");
    if (s.type === "commit") {
      showCommit(String(s.value));
      return;
    }
    if (s.type === "stash") {
      showCommit(String(s.value));
      return;
    }
    const v = s.value as FileValue | undefined;
    if (!v?.file) ember.userError("There is no thing at point that could be visited");
    let line = 1;
    if (v.hunk) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(v.hunk.heading);
      line = Number(m?.[1] ?? 1);
      const here = ember.lineOf(ember.point());
      const first = ember.lineOf(s.content);
      for (let i = 0; i < here - first && i < v.hunk.lines.length; i++) if (!v.hunk.lines[i].startsWith("-")) line++;
    }
    const dir = repo();
    ember.call("find-file", ember.expandFileName(v.file, dir));
    ember.gotoChar(ember.lineStart(Math.max(0, Math.min(line - 1, ember.lineCount() - 1))));
  },
});

// Committing, after magit-commit.el and git-commit.el.

ember.defineVariable({ name: "git-commit-summary-max-length", doc: "Column beyond which characters in the summary line are highlighted.", value: 68 });
ember.defineFace({ name: "git-commit-summary", doc: "Face used for the summary in commit messages.", attributes: { inherit: "font-lock-type-face" } });
ember.defineFace({ name: "git-commit-comment-heading", doc: "Face used for headings in commit message comments.", attributes: { inherit: "git-commit-keyword" } });
ember.defineFace({ name: "git-commit-keyword", doc: "Face used for keywords in commit messages.", attributes: { inherit: "font-lock-string-face" } });

/** What the commit buffer is for: the git commit arguments and the buffers to go back to. */
const commitBuffers = new PerBuffer<{ args: string[]; dir: string; window: number; diffBuffer?: string }>();

/** The comments under a commit message, as git's own template has them. */
function commitTemplate(amend: boolean): string {
  const status = gitOutput(["status"]).output.split("\n").filter((l) => !l.startsWith("  (use"));
  const lines = [
    "",
    "# Please enter the commit message for your changes. Lines starting",
    "# with '#' will be ignored, and an empty message aborts the commit.",
    "#",
    ...(amend ? ["# Date:      " + (gitString(["log", "-1", "--format=%ad"]) ?? ""), "#"] : []),
    ...status.map((l) => (l === "" ? "#" : l.startsWith("\t") ? `#${l}` : `# ${l}`)),
  ];
  return `${lines.join("\n").replace(/(#\n)+$/, "#\n")}`;
}

/** Opens COMMIT_EDITMSG for a commit with ARGS, with MESSAGE to start, and shows what it commits, as magit-commit-create does through with-editor. */
function editCommit(args: string[], message = "", amend = false): void {
  const dir = repo();
  const window = ember.selectedWindow();
  const gitDir = gitString(["rev-parse", "--absolute-git-dir"]) ?? `${dir}.git`;
  const file = `${gitDir}/COMMIT_EDITMSG`;
  ember.writeTextFile(file, `${message}${commitTemplate(amend)}`);
  // The diff to commit, beside, as magit-commit-diff shows it.
  let diffBuffer: string | undefined;
  const staged = amend ? gitOutput(["diff", "--no-prefix", "-p", "HEAD^", ...(args.includes("--only") ? ["HEAD"] : [])]) : gitOutput(["diff", "--cached", "--no-prefix", "-p"]);
  if (staged.output.trim()) {
    diffBuffer = setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(staged.output), "commit")), false);
  }
  ember.call("find-file", file);
  ember.call(gitCommitMode);
  commitBuffers.set(ember.currentBuffer(), { args, dir, window, diffBuffer });
  ember.gotoChar(0);
  if (diffBuffer) ember.call("display-buffer", diffBuffer);
  ember.message("Type C-c C-c to finish, or C-c C-k to cancel");
}

/** Commits with the message the buffer has, as with-editor-finish and git commit do. */
const commitFinish = ember.defineCommand({
  name: "with-editor-finish",
  doc: "Finish the commit with the message in this buffer.",
  run: () => {
    const info = commitBuffers.get(ember.currentBuffer());
    if (!info) ember.userError("Not a commit message buffer");
    ember.call("save-buffer");
    const file = ember.bufferFileName()!;
    const message = ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax());
    const body = message.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
    if (body === "" && !info.args.includes("--allow-empty-message")) {
      ember.message("Aborting commit due to empty commit message.");
      return;
    }
    const r = ember.letBind({ "default-directory": info.dir }, () => {
      processLog.push({ args: ["commit", ...info.args], exit: 0, output: "", dir: info.dir });
      return gitOutput(["commit", "--cleanup=strip", "-F", file, ...info.args], undefined, info.dir);
    });
    processLog[processLog.length - 1].exit = r.exit;
    processLog[processLog.length - 1].output = r.output;
    closeCommit(info);
    if (r.exit !== 0) ember.message((r.output.split("\n").find((l) => l.trim()) ?? "Commit failed").replace(/^(error|fatal): /, ""));
    else ember.message(r.output.split("\n")[0]);
    ember.letBind({ "default-directory": info.dir }, () => refreshAll(info.dir));
  },
});

const commitCancel = ember.defineCommand({
  name: "with-editor-cancel",
  doc: "Cancel the commit, keeping its message for next time.",
  run: () => {
    const info = commitBuffers.get(ember.currentBuffer());
    if (!info) ember.userError("Not a commit message buffer");
    closeCommit(info);
    ember.message("Canceled by user");
  },
});

function closeCommit(info: { window: number; diffBuffer?: string }): void {
  ember.setBufferModified(false);
  ember.call("kill-buffer", ember.bufferName());
  if (info.diffBuffer && ember.bufferLiveP(ember.getBuffer(info.diffBuffer))) {
    const w = ember.windowList().find((x) => ember.windowBuffer(x) === info.diffBuffer);
    if (w !== undefined && ember.windowList().length > 1) ember.deleteWindow(w);
    ember.call("kill-buffer", info.diffBuffer);
  }
  if (ember.windowList().includes(info.window)) ember.selectWindow(info.window);
}

/** Highlights the summary line and comments, as git-commit-mode's font-lock keywords. */
function fontifyCommit(start: number, end: number): void {
  ember.withSilentModifications(() => {
    for (let line = ember.lineOf(start); line <= ember.lineOf(Math.max(start, end - 1)); line++) {
      const ls = ember.lineStart(line);
      const le = ember.lineEnd(line);
      const text = ember.lineText(line);
      if (text.startsWith("#")) ember.putTextProperty(ls, le, "face", "font-lock-comment-face");
      else if (line === 0) {
        const max = Number(ember.variable("git-commit-summary-max-length") ?? 68);
        ember.putTextProperty(ls, Math.min(le, ls + max), "face", "git-commit-summary");
        if (le > ls + max) ember.putTextProperty(ls + max, le, "face", "font-lock-warning-face");
      }
    }
  });
}

export const gitCommitMode = ember.defineMajorMode({
  name: "git-commit-mode",
  modeName: "Git-Commit",
  parent: "text-mode",
  doc: "Major mode for editing git commit messages: C-c C-c commits, C-c C-k cancels.",
  bindings: { "C-c C-c": commitFinish, "C-c C-k": commitCancel },
  setup: () => {
    ember.makeLocalVariable("fill-column");
    ember.setVariable("fill-column", 72);
    ember.addHook("jit-lock-functions", fontifyCommit, { local: true });
  },
});

const commitArgs = (): string[] => transientArgs("magit-commit");

const commitCreate = ember.defineCommand({
  name: "magit-commit-create",
  doc: "Create a new commit on HEAD, writing its message in a buffer.",
  run: () => {
    const args = commitArgs();
    if (!args.includes("--all") && !args.includes("--allow-empty") && gitOutput(["diff", "--cached", "--quiet"]).exit === 0) {
      if (gitOutput(["diff", "--quiet"]).exit !== 0 && ember.yOrNP("Nothing staged.  Commit all uncommitted changes? ")) args.push("--all");
      else ember.userError("Nothing staged");
    }
    editCommit(args);
  },
});

const commitAmend = ember.defineCommand({
  name: "magit-commit-amend",
  doc: "Amend the last commit, with the staged changes and an edited message.",
  run: () => editCommit(["--amend", ...commitArgs()], gitString(["log", "-1", "--format=%B"]) ?? "", true),
});

const commitExtend = ember.defineCommand({
  name: "magit-commit-extend",
  doc: "Amend the last commit with the staged changes, keeping its message.",
  run: () => void runGit(["commit", "--amend", "--no-edit", ...commitArgs()]),
});

const commitReword = ember.defineCommand({
  name: "magit-commit-reword",
  doc: "Reword the last commit, ignoring the staged changes.",
  run: () => editCommit(["--amend", "--only", ...commitArgs()], gitString(["log", "-1", "--format=%B"]) ?? "", true),
});

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
        ["-s", "Add Signed-off-by line", "--signoff"],
      ],
    },
    {
      items: [
        { description: "Create", items: [["c", "Commit", commitCreate]] },
        {
          description: "Edit HEAD",
          items: [
            ["e", "Extend", commitExtend],
            ["w", "Reword", commitReword],
            ["a", "Amend", commitAmend],
          ],
        },
      ],
    },
  ],
});

// Branches, after magit-branch.el.

const localBranches = (): string[] => gitLines(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
const remoteBranches = (): string[] => gitLines(["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).filter((b) => !b.endsWith("/HEAD"));

/** Reads a branch or commit, as magit-read-branch-or-commit. */
function readBranch(prompt: string, choices = [...localBranches(), ...remoteBranches()], def?: string): string {
  const answer = ember.completingRead(def ? `${prompt} (default ${def}): ` : `${prompt}: `, choices, { default: def, history: "magit-revision-history" });
  if (answer === "") ember.userError("Nothing selected");
  return answer;
}
ember.defineVariable({ name: "magit-revision-history", doc: "Branches and commits Magit read.", value: [] });

const branchCheckout = ember.defineCommand({
  name: "magit-checkout",
  doc: "Check out a branch or commit.",
  run: () => {
    const cur = currentBranch();
    const target = readBranch("Checkout", [...localBranches().filter((b) => b !== cur), ...remoteBranches()]);
    const local = remoteBranches().includes(target) && !localBranches().includes(target.replace(/^[^/]+\//, "")) ? ["-b", target.replace(/^[^/]+\//, ""), "--track", target] : [target];
    runGit(["checkout", ...local]);
  },
});

const branchCreateCheckout = ember.defineCommand({
  name: "magit-branch-and-checkout",
  doc: "Create a branch starting at a commit and check it out.",
  run: () => {
    const start = readBranch("Create and checkout branch starting at", [...localBranches(), ...remoteBranches()], currentBranch());
    const name = ember.readString("Name for new branch: ");
    if (name === "") ember.userError("No name given");
    runGit(["checkout", "-b", name, start]);
  },
});

const branchCreate = ember.defineCommand({
  name: "magit-branch-create",
  doc: "Create a branch starting at a commit, without checking it out.",
  run: () => {
    const start = readBranch("Create branch starting at", [...localBranches(), ...remoteBranches()], currentBranch());
    const name = ember.readString("Name for new branch: ");
    if (name === "") ember.userError("No name given");
    runGit(["branch", name, start]);
  },
});

const branchDelete = ember.defineCommand({
  name: "magit-branch-delete",
  doc: "Delete a branch; one not merged is deleted only if confirmed.",
  run: () => {
    const name = readBranch("Delete branch", localBranches().filter((b) => b !== currentBranch()));
    if (!runGit(["branch", "-d", name]) && ember.yOrNP(`Delete unmerged branch ${name}? `)) runGit(["branch", "-D", name]);
  },
});

const branchRename = ember.defineCommand({
  name: "magit-branch-rename",
  doc: "Rename a branch.",
  run: () => {
    const old = readBranch("Rename branch", localBranches(), currentBranch());
    const name = ember.readString(`Rename branch '${old}' to: `);
    if (name === "") ember.userError("No name given");
    runGit(["branch", "-m", old, name]);
  },
});

const branchMenu = transientDefinePrefix("magit-branch", {
  doc: "Add, configure or remove a branch.",
  groups: [
    {
      items: [
        { description: "Checkout", items: [["b", "branch/revision", branchCheckout], ["c", "new branch", branchCreateCheckout]] },
        { description: "Create", items: [["n", "new branch", branchCreate]] },
        { description: "Do", items: [["m", "rename", branchRename], ["k", "delete", branchDelete]] },
      ],
    },
  ],
});

// Pushing, pulling and fetching, after magit-push.el, magit-pull.el and magit-fetch.el.

const remotes = (): string[] => gitLines(["remote"]);

/** The upstream of the current branch, asking for one to set if there is none, as magit-push-current-to-upstream does. */
function ensureUpstream(verb: string): [string, string, boolean] {
  const branch = currentBranch();
  if (!branch) ember.userError("No branch is checked out");
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

const pushUpstream = ember.defineCommand({
  name: "magit-push-current-to-upstream",
  doc: "Push the current branch to its upstream, setting one first if there is none.",
  run: () => {
    const branch = currentBranch()!;
    const [remote, target, set] = ensureUpstream("push");
    runGitAsync(["push", "-v", ...pushArgs(), ...(set ? ["--set-upstream"] : []), remote, `${branch}:refs/heads/${target}`], `Pushing to ${remote}/${target}`);
  },
});

const pushPushRemote = ember.defineCommand({
  name: "magit-push-current-to-pushremote",
  doc: "Push the current branch to its push remote, by default the upstream's remote.",
  run: () => {
    const branch = currentBranch();
    if (!branch) ember.userError("No branch is checked out");
    const remote = gitString(["config", `branch.${branch}.pushRemote`]) ?? gitString(["config", "remote.pushDefault"]) ?? upstreamOf(branch)?.split("/")[0] ?? remotes()[0];
    if (!remote) ember.userError("No remote to push to");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${branch}`], `Pushing to ${remote}/${branch}`);
  },
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
        ["-t", "Include all tags", "--tags"],
      ],
    },
    {
      items: [
        {
          description: () => `Push ${currentBranch() ?? "HEAD"} to`,
          items: [
            ["p", "pushRemote", pushPushRemote],
            ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, setting it", pushUpstream],
          ],
        },
      ],
    },
  ],
});

const pullUpstream = ember.defineCommand({
  name: "magit-pull-from-upstream",
  doc: "Pull from the upstream of the current branch, setting one first if there is none.",
  run: () => {
    const [remote, target, set] = ensureUpstream("pull");
    if (set) gitOutput(["branch", `--set-upstream-to=${remote}/${target}`]);
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, target], `Pulling from ${remote}/${target}`);
  },
});

const pullMenu = transientDefinePrefix("magit-pull", {
  doc: "Pull from another repository.",
  groups: [
    { description: "Arguments", items: [["-f", "Fast-forward only", "--ff-only"], ["-r", "Rebase local commits", "--rebase"], ["-A", "Autostash", "--autostash"]] },
    { items: [{ description: () => `Pull into ${currentBranch() ?? "HEAD"} from`, items: [["p", "pushRemote", pullUpstream], ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, setting it", pullUpstream]] }] },
  ],
});

const fetchAll = ember.defineCommand({ name: "magit-fetch-all", doc: "Fetch from all remotes.", run: () => runGitAsync(["fetch", "--all", ...transientArgs("magit-fetch")], "Fetching all remotes") });
const fetchUpstream = ember.defineCommand({
  name: "magit-fetch-from-upstream",
  doc: "Fetch from the remote of the current branch's upstream.",
  run: () => {
    const remote = upstreamOf(currentBranch())?.split("/")[0] ?? remotes()[0];
    if (!remote) ember.userError("No remote to fetch from");
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});

const fetchMenu = transientDefinePrefix("magit-fetch", {
  doc: "Fetch from another repository.",
  groups: [
    { description: "Arguments", items: [["-p", "Prune deleted branches", "--prune"], ["-t", "Fetch all tags", "--tags"]] },
    { items: [{ description: "Fetch from", items: [["p", "pushRemote", fetchUpstream], ["u", "upstream", fetchUpstream], ["a", "all remotes", fetchAll]] }] },
  ],
});

// Merging, resetting and stashing.

const mergeCommand = ember.defineCommand({
  name: "magit-merge-plain",
  doc: "Merge a branch into the current one.",
  run: () => void runGit(["merge", ...transientArgs("magit-merge"), readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()])]),
});
const mergeMenu = transientDefinePrefix("magit-merge", {
  doc: "Merge branches.",
  groups: [
    { description: "Arguments", items: [["-f", "Fast-forward only", "--ff-only"], ["-n", "No fast-forward", "--no-ff"]] },
    { description: "Actions", items: [["m", "Merge", mergeCommand]] },
  ],
});

const resetCommand = (mode: string, doc: string) =>
  ember.defineCommand({
    name: `magit-reset-${mode}`,
    doc,
    run: () => {
      const s = currentSection();
      const def = s?.type === "commit" ? String(s.value) : "HEAD";
      runGit(["reset", `--${mode}`, readBranch(`${mode[0].toUpperCase()}${mode.slice(1)} reset ${currentBranch() ?? "HEAD"} to`, [...localBranches(), ...remoteBranches()], def)]);
    },
  });
const resetMenu = transientDefinePrefix("magit-reset", {
  doc: "Reset the current branch.",
  groups: [
    {
      description: "Reset",
      items: [
        ["m", "mixed    (HEAD and index)", resetCommand("mixed", "Reset HEAD and the index to a commit, keeping the working tree.")],
        ["s", "soft     (HEAD only)", resetCommand("soft", "Reset HEAD to a commit, keeping the index and working tree.")],
        ["h", "hard     (HEAD, index and files)", resetCommand("hard", "Reset HEAD, the index and the working tree to a commit.")],
      ],
    },
  ],
});

/** The stash at point, or one read. */
function stashAt(prompt: string): string {
  const s = currentSection();
  if (s?.type === "stash") return String(s.value);
  const list = gitLines(["stash", "list", "--format=%gd"]);
  if (list.length === 0) ember.userError("No stashes");
  return ember.completingRead(`${prompt} (default ${list[0]}): `, list, { default: list[0], requireMatch: true });
}

const stashBoth = ember.defineCommand({
  name: "magit-stash-both",
  doc: "Stash the changes in the index and the working tree, with a message.",
  run: () => {
    const msg = ember.readString(`Stash message (default: On ${currentBranch() ?? "HEAD"}: ...): `);
    runGit(["stash", "push", ...transientArgs("magit-stash"), ...(msg ? ["-m", msg] : [])]);
  },
});
const stashApply = ember.defineCommand({ name: "magit-stash-apply", doc: "Apply a stash to the working tree.", run: () => void runGit(["stash", "apply", stashAt("Apply stash")]) });
const stashPop = ember.defineCommand({ name: "magit-stash-pop", doc: "Apply a stash and remove it.", run: () => void runGit(["stash", "pop", stashAt("Pop stash")]) });
const stashDrop = ember.defineCommand({
  name: "magit-stash-drop",
  doc: "Remove a stash.",
  run: () => {
    const s = stashAt("Drop stash");
    if (ember.yOrNP(`Drop ${s}? `)) runGit(["stash", "drop", s]);
  },
});
const stashMenu = transientDefinePrefix("magit-stash", {
  doc: "Stash uncommitted changes.",
  groups: [
    { description: "Arguments", items: [["-u", "Also save untracked files", "--include-untracked"], ["-a", "Also save untracked and ignored files", "--all"]] },
    {
      items: [
        { description: "Stash", items: [["z", "both", stashBoth]] },
        { description: "Use", items: [["a", "Apply", stashApply], ["p", "Pop", stashPop], ["k", "Drop", stashDrop]] },
      ],
    },
  ],
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

const logCurrent = ember.defineCommand({
  name: "magit-log-current",
  doc: "Show the log of the current branch.",
  run: () => {
    const dir = repo();
    const args = transientArgs("magit-log");
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, "HEAD"]));
    ember.gotoChar(0);
  },
});

const logAll = ember.defineCommand({
  name: "magit-log-all",
  doc: "Show the log of all references and HEAD.",
  run: () => {
    const dir = repo();
    const args = transientArgs("magit-log");
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, "--all"]));
    ember.gotoChar(0);
  },
});

const logOther = ember.defineCommand({
  name: "magit-log-other",
  doc: "Show the log of a branch or commit read.",
  run: () => {
    const dir = repo();
    const rev = readBranch("Log rev,s", [...localBranches(), ...remoteBranches()], currentBranch());
    const args = transientArgs("magit-log");
    setupBuffer(`magit-log: ${repoName(dir)}`, magitLogMode, "log", () => insertLog([...args, rev]));
    ember.gotoChar(0);
  },
});

const logMenu = transientDefinePrefix("magit-log", {
  doc: "Show a commit or reference log.",
  groups: [
    {
      description: "Commit limiting",
      items: [["-n", "Limit number of commits", "-n", { class: "option", prompt: "Limit to N commits: " }], ["-m", "Omit merges", "--no-merges"], ["=a", "Author", "--author=", { prompt: "Author: " }]],
    },
    { items: [{ description: "Log", items: [["l", "current", logCurrent], ["o", "other", logOther], ["a", "all references", logAll]] }] },
  ],
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
        ember.insert(`${rest.join("\n").replace(/\n+$/, "")}\n\n`);
      });
      insertFiles(parseDiff(diff), "commit");
    });
  });
  ember.gotoChar(0);
}

const diffDwim = ember.defineCommand({
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
    ember.gotoChar(0);
  },
});
const diffStaged = ember.defineCommand({
  name: "magit-diff-staged",
  doc: "Show the changes between the index and HEAD.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(gitOutput(["diff", "--cached", "--no-prefix", "-p"]).output), "commit")));
    ember.gotoChar(0);
  },
});
const diffUnstaged = ember.defineCommand({
  name: "magit-diff-unstaged",
  doc: "Show the changes between the working tree and the index.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-diff: ${repoName(dir)}`, magitDiffMode, "diff", () => insertRoot("diff", () => insertFiles(parseDiff(gitOutput(["diff", "--no-prefix", "-p"]).output), "commit")));
    ember.gotoChar(0);
  },
});
const diffMenu = transientDefinePrefix("magit-diff", {
  doc: "Show changes between different versions.",
  groups: [
    { description: "Actions", items: [["d", "Dwim", diffDwim], ["s", "Staged", diffStaged], ["u", "Unstaged", diffUnstaged]] },
  ],
});

// The process buffer.

const processBuffer = ember.defineCommand({
  name: "magit-process-buffer",
  doc: "Show the git commands Magit ran and their output.",
  run: () => {
    const dir = repo();
    setupBuffer(`magit-process: ${repoName(dir)}`, magitProcessMode, "process", () =>
      insertRoot("processbuf", () => {
        for (const p of processLog.filter((x) => x.dir === dir)) {
          insertSection("process", p.args.join(" "), true, () => {
            insertHeading(face(`${p.exit < 0 ? "run" : String(p.exit).padStart(3)} `, p.exit === 0 ? "magit-process-ok" : "magit-process-ng"), face(`git ${p.args.join(" ")}`, "magit-section-heading"), "\n");
            if (p.output) ember.insert(p.output.endsWith("\n") ? p.output : `${p.output}\n`);
          });
        }
      }),
    );
    const last = sections()?.root.children.at(-1);
    if (last) {
      show(last);
      ember.gotoChar(last.start);
    }
  },
});

// The dispatch menu and the keys.

const dispatch = transientDefinePrefix("magit-dispatch", {
  doc: "Invoke a Magit command from a list of available commands.",
  groups: [
    {
      description: "Transient and dwim commands",
      items: [
        {
          items: [
            ["b", "Branch", "magit-branch"],
            ["c", "Commit", "magit-commit"],
            ["d", "Diff", "magit-diff"],
            ["f", "Fetch", "magit-fetch"],
            ["F", "Pull", "magit-pull"],
          ],
        },
        {
          items: [
            ["l", "Log", "magit-log"],
            ["m", "Merge", "magit-merge"],
            ["P", "Push", "magit-push"],
            ["X", "Reset", "magit-reset"],
            ["z", "Stash", "magit-stash"],
          ],
        },
      ],
    },
    {
      items: [
        {
          description: "Applying changes",
          items: [
            ["s", "Stage", magitStage],
            ["u", "Unstage", magitUnstage],
            ["k", "Discard", magitDiscard],
            ["S", "Stage all", stageModified],
            ["U", "Unstage all", unstageAll],
          ],
        },
        {
          description: "Essential commands",
          padKeys: 4,
          items: [
            ["g", "       refresh current buffer", refreshCommand],
            ["q", "       quit window", "quit-window"],
            ["$", "       show process buffer", processBuffer],
          ],
        },
      ],
    },
  ] as Group[],
});

const bindings: [string, ember.DefinedCommand | string][] = [
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
  ["x", resetMenu],
  ["z", stashMenu],
  ["l", logMenu],
  ["d", diffMenu],
  ["h", dispatch],
  ["?", dispatch],
  ["q", "quit-window"],
];
for (const [key, command] of bindings) ember.defineKey("magit-mode-map", key, command as ember.DefinedCommand);

ember.bindKey("C-x g", magitStatus);
ember.bindKey("C-x M-g", dispatch);

void sectionAt;
