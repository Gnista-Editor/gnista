// Org-roam, after org-roam 2 (https://github.com/org-roam/org-roam): notes
// as Org files in org-roam-directory, each file and each heading with an
// ID a node, linked by [[id:...]] links. org-roam-node-find visits a node
// by its title or makes it, org-roam-node-insert links to one,
// org-roam-capture adds to one, and org-roam-buffer-toggle shows the
// backlinks of the node at point beside it.
//
// Org-roam keeps its nodes and links in an SQLite database; Ember keeps them
// in org-roam-db-location as JSON, reading again only the files changed
// since, which org-roam-db-autosync-mode keeps up to date as files are saved.
//
// Copyright © 2020-2025 Jethro Kuan <jethrokuan95@gmail.com>
// Ported to Ember in 2026.
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation; either version 3, or (at your option) any later
// version.

import { insertHeading, insertRoot, insertSection, magitSectionMode, currentSection, sections } from "magit-section";
import { orgIdGoto, orgIdUuid } from "org-id";
import { PerBuffer, truthy } from "subr";

ember.defineVariable({ name: "org-roam-directory", doc: "The directory of Org-roam's notes, searched recursively.", value: "~/org-roam/" });
ember.defineVariable({
  name: "org-roam-db-location",
  doc: "The file Org-roam keeps its index of nodes and links in, as JSON in Ember.",
  // Nil, kept only in memory, without a user-emacs-directory, as in tests.
  value: (() => {
    const dir = ember.variable("user-emacs-directory");
    return typeof dir === "string" ? ember.expandFileName("org-roam.json", dir) : null;
  })(),
});
ember.defineVariable({ name: "org-roam-file-extensions", doc: "The extensions of the files that are notes.", value: ["org"] });
ember.defineVariable({ name: "org-roam-file-exclude-regexp", doc: "A regexp of the files, relative to org-roam-directory, that are not notes.", value: ["data/"] });
ember.defineVariable({ name: "org-roam-node-display-template", doc: 'How a node shows when reading one: ${title}, ${tags:10}, ${file}, ${olp} and the rest, each with a width or * for the rest.', value: "${title}" });
ember.defineVariable({ name: "org-roam-db-update-on-save", doc: "Whether saving a note updates the index.", value: true });
ember.defineVariable({
  name: "org-roam-capture-templates",
  doc: 'Templates for new notes: [key, description, type, template, target], the target ["file+head", file, head] as org-roam-capture-templates\' :target.',
  value: [["d", "default", "plain", "%?", ["file+head", "%<%Y%m%d%H%M%S>-${slug}.org", "#+title: ${title}\n"]]],
});
ember.defineHook("org-roam-capture-new-node-hook", "Functions called in the capture buffer of a new node.");
ember.defineHook("org-roam-find-file-hook", "Functions called in a note's buffer when it is visited.");

ember.defineFace({ name: "org-roam-title", doc: "Face for Org-roam titles.", attributes: { weight: "bold" } });
ember.defineFace({ name: "org-roam-olp", doc: "Face for the outline paths of nodes in the Org-roam buffer.", attributes: { inherit: "shadow" } });
ember.defineFace({ name: "org-roam-header-line", doc: "Face for the header line of the Org-roam buffer.", attributes: { extend: true, inherit: "magit-section-heading" } });
ember.defineFace({ name: "org-roam-preview-region", doc: "Face for the preview region in the Org-roam buffer.", attributes: { inherit: "bold" } });

/** A node: a file or a heading with an ID, as org-roam-node. */
export interface Node {
  id: string;
  file: string;
  level: number;
  /** Where its heading is, as a line, 0 for a file. */
  line: number;
  title: string;
  olp: string[];
  aliases: string[];
  tags: string[];
  refs: string[];
  todo?: string;
}

/** A link from one node to another, where it is, and the outline it is under. */
export interface Link {
  source: string;
  dest: string;
  line: number;
  outline: string[];
}

interface FileEntry {
  mtime: number;
  nodes: Node[];
  links: Link[];
}

/** The index, as org-roam's database: each file's nodes and links. */
let db: { version: 1; files: { [file: string]: FileEntry } } | undefined;
let nodesById = new Map<string, Node>();
let backlinks = new Map<string, Link[]>();

const directory = (): string => ember.fileNameAsDirectory(ember.expandFileName(String(ember.variable("org-roam-directory") ?? "~/org-roam/")));

/** Whether FILE is a note: under the directory, with an extension of org-roam-file-extensions, not excluded, as org-roam-file-p. */
export function orgRoamFileP(file: string | undefined): boolean {
  if (!file) return false;
  const full = ember.expandFileName(file);
  const dir = directory();
  if (!full.startsWith(dir)) return false;
  const exts = ember.variable("org-roam-file-extensions");
  const ext = full.replace(/.*\./, "");
  if (Array.isArray(exts) && !exts.includes(ext)) return false;
  const base = full.replace(/.*\//, "");
  if (base.startsWith(".#") || base.endsWith("~") || base.startsWith("#")) return false;
  const rel = full.slice(dir.length);
  const exclude = ember.variable("org-roam-file-exclude-regexp");
  for (const r of Array.isArray(exclude) ? exclude : typeof exclude === "string" ? [exclude] : []) {
    if (ember.stringMatch(String(r), rel) !== undefined) return false;
  }
  return true;
}

// Reading a note, as org-roam-db-update-file does with org-element.

const HEADING = /^(\*+)[ \t]+(?:(TODO|DONE|NEXT|WAITING|HOLD|CANCELLED|CANCELED)[ \t]+)?(?:\[#.\][ \t]+)?(.*?)(?:[ \t]+(:[\p{L}\p{N}_@#%:]+:))?[ \t]*$/u;
const LINK = /\[\[id:([^\]\s]+)\](?:\[[^\]]*\])?\]/g;

/** The words of a property such as ROAM_ALIASES, quoted ones kept whole, as split-string-and-unquote. */
function splitQuoted(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return out;
}

const tagsOf = (s: string | undefined): string[] => (s ? s.split(/[: ]+/).filter((t) => t !== "") : []);
const linkText = (s: string): string => s.replace(/\[\[[^\]]*\]\[([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1");

/** The nodes and links of a note's TEXT, as org-roam's file, heading and link indexers find them. */
export function parseNote(file: string, text: string): { nodes: Node[]; links: Link[] } {
  const lines = text.split("\n");
  const nodes: Node[] = [];
  const links: Link[] = [];
  let fileNode: Node | undefined;
  let fileTags: string[] = [];
  let title: string | undefined;
  const stack: { level: number; title: string; tags: string[]; node?: Node }[] = [];
  /** The properties of the drawer starting on line I, and the line after it. */
  const drawer = (i: number): [Map<string, string>, number] | undefined => {
    if (i >= lines.length || !/^[ \t]*:PROPERTIES:[ \t]*$/i.test(lines[i])) return undefined;
    const props = new Map<string, string>();
    for (let l = i + 1; l < lines.length; l++) {
      if (/^[ \t]*:END:[ \t]*$/i.test(lines[l])) return [props, l + 1];
      const m = /^[ \t]*:([^:\s]+):[ \t]*(.*?)[ \t]*$/.exec(lines[l]);
      if (!m) return undefined;
      props.set(m[1].toUpperCase(), m[2]);
    }
    return undefined;
  };
  let i = 0;
  // The file's own drawer and keywords, before its first heading.
  let fileProps: Map<string, string> | undefined;
  for (; i < lines.length && !HEADING.test(lines[i]); i++) {
    const d = !fileProps ? drawer(i) : undefined;
    if (d) {
      fileProps = d[0];
      i = d[1] - 1;
      continue;
    }
    const kw = /^#\+(\w+):[ \t]*(.*?)[ \t]*$/i.exec(lines[i]);
    if (kw?.[1].toLowerCase() === "title") title = title === undefined ? kw[2] : `${title} ${kw[2]}`;
    else if (kw?.[1].toLowerCase() === "filetags") fileTags = tagsOf(kw[2]);
  }
  const fileId = fileProps?.get("ID");
  if (fileId && fileProps!.get("ROAM_EXCLUDE") !== "t") {
    fileNode = {
      id: fileId,
      file,
      level: 0,
      line: 0,
      title: title ?? file.replace(/.*\//, "").replace(/\.[^.]*$/, ""),
      olp: [],
      aliases: splitQuoted(fileProps!.get("ROAM_ALIASES") ?? ""),
      tags: fileTags,
      refs: splitQuoted(fileProps!.get("ROAM_REFS") ?? ""),
    };
    nodes.push(fileNode);
  }
  // Links before the first heading belong to the file's node.
  const scanLinks = (from: number, to: number) => {
    for (let l = from; l < to; l++) {
      const owner = [...stack].reverse().find((s) => s.node)?.node ?? fileNode;
      if (!owner) continue;
      for (const m of lines[l].matchAll(LINK)) links.push({ source: owner.id, dest: m[1], line: l, outline: stack.map((s) => s.title) });
    }
  };
  scanLinks(0, i);
  while (i < lines.length) {
    const m = HEADING.exec(lines[i]);
    if (!m) {
      const owner = [...stack].reverse().find((s) => s.node)?.node ?? fileNode;
      if (owner) for (const lm of lines[i].matchAll(LINK)) links.push({ source: owner.id, dest: lm[1], line: i, outline: stack.map((s) => s.title) });
      i++;
      continue;
    }
    const level = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const headTitle = linkText(m[3]);
    const ownTags = tagsOf(m[4]);
    let next = i + 1;
    if (next < lines.length && /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/.test(lines[next])) next++;
    const d = drawer(next);
    const id = d?.[0].get("ID");
    const inherited = [...fileTags, ...stack.flatMap((s) => s.tags)];
    let node: Node | undefined;
    if (id && d![0].get("ROAM_EXCLUDE") !== "t") {
      node = {
        id,
        file,
        level,
        line: i,
        title: headTitle,
        olp: stack.map((s) => s.title),
        aliases: splitQuoted(d![0].get("ROAM_ALIASES") ?? ""),
        tags: [...new Set([...inherited, ...ownTags])],
        refs: splitQuoted(d![0].get("ROAM_REFS") ?? ""),
        todo: m[2],
      };
      nodes.push(node);
    }
    stack.push({ level, title: headTitle, tags: ownTags, node });
    for (const lm of lines[i].matchAll(LINK)) {
      const owner = node ?? [...stack].reverse().find((s) => s.node)?.node ?? fileNode;
      if (owner) links.push({ source: owner.id, dest: lm[1], line: i, outline: stack.slice(0, -1).map((s) => s.title) });
    }
    i = d ? d[1] : i + 1;
  }
  return { nodes, links };
}

// The index.

function indexAll(): void {
  nodesById = new Map();
  backlinks = new Map();
  for (const entry of Object.values(db!.files)) {
    for (const n of entry.nodes) nodesById.set(n.id, n);
    for (const l of entry.links) {
      if (!backlinks.has(l.dest)) backlinks.set(l.dest, []);
      backlinks.get(l.dest)!.push(l);
    }
  }
}

function loadDb(): void {
  if (db) return;
  const file = ember.variable("org-roam-db-location");
  try {
    db = typeof file === "string" && ember.fileExists(file) ? JSON.parse(ember.readTextFile(file)) : undefined;
  } catch {
    db = undefined;
  }
  if (!db || db.version !== 1) db = { version: 1, files: {} };
  indexAll();
}

function saveDb(): void {
  const file = ember.variable("org-roam-db-location");
  if (typeof file !== "string") return;
  const dir = file.replace(/[^/]*$/, "");
  if (dir && !ember.fileExists(dir)) ember.makeDirectory(dir, { parents: true });
  ember.writeTextFile(file, JSON.stringify(db));
}

/** The notes under the directory, recursively, as org-roam-list-files. */
function listFiles(): string[] {
  const dir = directory();
  if (!ember.fileExists(dir)) return [];
  const r = ember.callProcess(["find", dir, "-type", "f"]);
  // Hidden files and directories under the directory are left out, as org-roam-list-files does.
  return r.output.split("\n").filter((f) => f !== "" && !f.slice(dir.length).split("/").some((part) => part.startsWith(".")) && orgRoamFileP(f));
}

/** Indexes FILE from TEXT, or from disk, as org-roam-db-update-file. */
function updateFile(file: string, text?: string, mtime?: number): void {
  loadDb();
  const full = ember.expandFileName(file);
  const body = text ?? ember.readTextFile(full);
  const { nodes, links } = parseNote(full, body);
  db!.files[full] = { mtime: mtime ?? ember.fileAttributes(full)?.modified ?? Date.now(), nodes, links };
}

/** Brings the index up to date with the notes on disk, reading only those changed, as org-roam-db-sync; FORCE reads them all. */
export function orgRoamDbSync(force = false): void {
  loadDb();
  const files = listFiles();
  const seen = new Set(files);
  let changed = false;
  for (const f of Object.keys(db!.files)) {
    if (!seen.has(f)) {
      delete db!.files[f];
      changed = true;
    }
  }
  for (const f of files) {
    const mtime = ember.fileAttributes(f)?.modified ?? 0;
    if (force || db!.files[f]?.mtime !== mtime) {
      updateFile(f, undefined, mtime);
      changed = true;
    }
  }
  indexAll();
  if (changed) saveDb();
}

ember.defineCommand({
  name: "org-roam-db-sync",
  doc: "Bring the index of nodes and links up to date with the notes; with a prefix argument, read every note again.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: ember.Value) => {
    orgRoamDbSync(truthy(force));
    ember.message(`Org-roam: ${nodesById.size} nodes`);
  },
});
ember.defalias("org-roam-db-build-cache", "org-roam-db-sync");

/** Indexes a note as it is saved, as org-roam-db-autosync--setup-update-on-save-h. */
function onSave(): void {
  if (!truthy(ember.variable("org-roam-db-update-on-save"))) return;
  const file = ember.bufferFileName();
  if (!orgRoamFileP(file)) return;
  updateFile(file!, ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax()));
  indexAll();
  saveDb();
  refreshRoamBuffer(true);
}

ember.defineMinorMode({
  name: "org-roam-db-autosync-mode",
  global: true,
  doc: "Keep the index up to date: bring it up to date now, and index each note as it is saved.",
  onChange: (enabled) => {
    if (enabled) {
      orgRoamDbSync();
      ember.addHook("after-save-hook", onSave);
      ember.addHook("post-command-hook", followPoint);
    } else {
      ember.removeHook("after-save-hook", onSave);
      ember.removeHook("post-command-hook", followPoint);
    }
  },
});
ember.defun("org-roam-setup", () => ember.call("org-roam-db-autosync-mode" as ember.CommandName));
ember.defineCommand({ name: "org-roam-db-autosync-enable", doc: "Turn org-roam-db-autosync-mode on.", run: () => ember.call("org-roam-db-autosync-mode" as ember.CommandName) });

/** Every node, the index brought up to date first if it never was. */
export function allNodes(): Node[] {
  if (!db) orgRoamDbSync();
  return [...nodesById.values()];
}

export const nodeFromId = (id: string): Node | undefined => (allNodes(), nodesById.get(id));

/** The node at point: the innermost heading with an ID, or the file's, as org-roam-node-at-point. */
export function nodeAtPoint(): Node | undefined {
  const file = ember.bufferFileName();
  if (!file) return undefined;
  const text = ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax());
  const { nodes } = parseNote(ember.expandFileName(file), text);
  const line = ember.lineOf(ember.point());
  let best: Node | undefined;
  for (const n of nodes) {
    if (n.level === 0) best ??= n;
    else if (n.line <= line) {
      // A heading node holds the lines up to the next heading of its level or above.
      const next = nodes.find((m) => m.level > 0 && m.line > n.line && m.level <= n.level);
      const lines = text.split("\n");
      let end = lines.length;
      for (let l = n.line + 1; l < lines.length; l++) {
        const h = /^(\*+)\s/.exec(lines[l]);
        if (h && h[1].length <= n.level) {
          end = l;
          break;
        }
      }
      if (line < end && (!next || line < next.line || next.level > n.level)) best = n;
    }
  }
  return best;
}

// Reading a node, as org-roam-node-read.

/** A node as the display template shows it, as org-roam-node--format-entry. */
function formatNode(n: Node, title = n.title, width = 80): string {
  const template = String(ember.variable("org-roam-node-display-template") ?? "${title}");
  const field = (name: string): string => {
    switch (name) {
      case "title":
        return title;
      case "tags":
        return n.tags.map((t) => `#${t}`).join(" ");
      case "file":
        return n.file.startsWith(directory()) ? n.file.slice(directory().length) : n.file;
      case "olp":
        return n.olp.join(" > ");
      case "todo":
        return n.todo ?? "";
      case "aliases":
        return n.aliases.join(" ");
      case "level":
        return String(n.level);
      default:
        return "";
    }
  };
  const fixed = [...template.matchAll(/\$\{(\w+)(?::(\d+))?\}/g)].reduce((w, m) => w + (m[2] ? Number(m[2]) : 0), 0);
  const literal = template.replace(/\$\{[^}]*\}/g, "").length;
  return template.replace(/\$\{(\w+)(?::(\*|\d+))?\}/g, (_all, name: string, w?: string) => {
    const v = field(name);
    if (!w) return v;
    const n2 = w === "*" ? Math.max(1, width - fixed - literal) : Number(w);
    return v.length > n2 ? v.slice(0, n2) : v.padEnd(n2);
  });
}

/** The nodes as candidates, by how each shows, most recently changed first, as org-roam-node-read--completions. */
export function nodeCandidates(filter?: (n: Node) => boolean): Map<string, Node> {
  const nodes = allNodes().filter((n) => !filter || filter(n));
  const mtime = (n: Node) => db!.files[n.file]?.mtime ?? 0;
  nodes.sort((a, b) => mtime(b) - mtime(a));
  const byCandidate = new Map<string, Node>();
  for (const n of nodes) {
    for (const t of [n.title, ...n.aliases]) {
      let cand = formatNode(n, t);
      while (byCandidate.has(cand)) cand += "\u200b";
      byCandidate.set(cand, n);
    }
  }
  return byCandidate;
}

/** Reads a node, as org-roam-node-read, which a package such as consult-org-roam advises to read its own way. */
export function readNode(prompt = "Node: ", initial?: string, filter?: (n: Node) => boolean): Node | string {
  return ember.funcall("org-roam-node-read", initial ?? null, filter ?? null, prompt) as Node | string;
}

ember.defun("org-roam-node-read", (initial: string | null, filter: ((n: Node) => boolean) | null, prompt?: string) =>
  readNodeDefault(prompt ?? "Node: ", initial ?? undefined, filter ?? undefined),
);

/** Reads a node by its title or alias, most recently changed first, giving the node or the title typed for a new one. */
function readNodeDefault(prompt = "Node: ", initial?: string, filter?: (n: Node) => boolean): Node | string {
  const byCandidate = nodeCandidates(filter);
  const candidates = [...byCandidate.keys()];
  const answer = ember.completingRead(prompt, candidates, { initial, category: "org-roam-node", history: "org-roam-node-history" });
  return byCandidate.get(answer) ?? answer.trim();
}
ember.defineVariable({ name: "org-roam-node-history", doc: "Nodes read before.", value: [] });

/** Visits a node: its file, at its heading, as org-roam-node-visit. */
export function visitNode(n: Node, otherWindow = false): void {
  ember.call(otherWindow ? "find-file-other-window" : "find-file", n.file);
  if (n.level === 0) ember.gotoChar(0);
  else orgIdGoto(n.id);
  ember.runHooks("org-roam-find-file-hook");
}

// Capturing, after org-roam-capture.el.

/** A title as a file name part, as org-roam-node-slug: letters and digits, the rest underscores, lower case. */
export function slug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u0331]/g, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]/gu, "_")
    .replace(/__*/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/** The time in FORMAT, for the %<...> of a template, as format-time-string. */
function formatTime(format: string, d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const codes: { [c: string]: () => string } = {
    Y: () => String(d.getFullYear()),
    m: () => pad(d.getMonth() + 1),
    d: () => pad(d.getDate()),
    H: () => pad(d.getHours()),
    M: () => pad(d.getMinutes()),
    S: () => pad(d.getSeconds()),
    y: () => pad(d.getFullYear() % 100),
    a: () => days[d.getDay()].slice(0, 3),
    A: () => days[d.getDay()],
    b: () => months[d.getMonth()].slice(0, 3),
    B: () => months[d.getMonth()],
    F: () => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    s: () => String(Math.floor(d.getTime() / 1000)),
    "%": () => "%",
  };
  return format.replace(/%(.)/g, (all, c: string) => codes[c]?.() ?? all);
}

/** A template's text with ${title}, ${slug}, ${id} and %<time> filled in, and where %? leaves point. */
function expand(template: string, vars: { [k: string]: string }): { text: string; point?: number } {
  let text = template.replace(/\$\{(\w+)\}/g, (all, k: string) => vars[k] ?? all).replace(/%<([^>]*)>/g, (_a, f: string) => formatTime(f));
  text = text.replace(/%U/g, `[${formatTime("%F %a %H:%M")}]`).replace(/%u/g, `[${formatTime("%F %a")}]`).replace(/%T/g, `<${formatTime("%F %a %H:%M")}>`).replace(/%t/g, `<${formatTime("%F %a")}>`);
  const at = text.indexOf("%?");
  if (at >= 0) text = text.slice(0, at) + text.slice(at + 2);
  return { text, point: at >= 0 ? [...text.slice(0, at)].length : undefined };
}

/** What each capture buffer is for, to finish or abort it. */
const captures = new PerBuffer<{ node: { id: string; title: string }; file: string; fresh: boolean; then?: (node: { id: string; title: string }) => void; window: number }>();

/** Chooses a capture template, by its key if there are several, as org-capture-select-template. */
function chooseTemplate(): ember.Value[] {
  const templates = ember.variable("org-roam-capture-templates");
  const list = Array.isArray(templates) ? (templates as ember.Value[][]) : [];
  if (list.length === 0) ember.userError("No capture templates");
  if (list.length === 1) return list[0];
  const label = (t: ember.Value[]) => `${String(t[0])} ${String(t[1])}`;
  const key = ember.completingRead("Template: ", list.map(label), { requireMatch: true });
  return list.find((t) => label(t) === key)!;
}

/**
 * Captures to a node: a new note for TITLE from a template, or under an
 * existing node, in a capture buffer that C-c C-c finishes and C-c C-k
 * aborts; THEN is called with the node once finished, as org-roam-capture-.
 */
export function capture(target: Node | string, then?: (node: { id: string; title: string }) => void): void {
  const window = ember.selectedWindow();
  const template = chooseTemplate();
  const body = String(template[3] ?? "%?");
  const targetSpec = Array.isArray(template[4]) ? (template[4] as string[]) : undefined;
  if (typeof target !== "string") {
    // An existing node: the template goes at the end of its entry.
    ember.call("find-file", target.file);
    if (target.level === 0) ember.gotoChar(ember.pointMax());
    else {
      orgIdGoto(target.id);
      const level = target.level;
      let l = ember.lineOf(ember.point()) + 1;
      for (; l < ember.lineCount(); l++) {
        const h = /^(\*+)\s/.exec(ember.lineText(l));
        if (h && h[1].length <= level) break;
      }
      ember.gotoChar(l < ember.lineCount() ? ember.lineStart(l) : ember.pointMax());
    }
    const { text, point } = expand(body, { title: target.title, slug: slug(target.title), id: target.id });
    const start = ember.point();
    if (start > 0 && ember.charAfter(start - 1) !== "\n") ember.insert("\n");
    const at = ember.point();
    ember.insert(text);
    ember.gotoChar(at + (point ?? [...text].length));
    captures.set(ember.currentBuffer(), { node: target, file: target.file, fresh: false, then, window });
    ember.callWithPrefix(1, captureMode);
    return;
  }
  const title = target;
  const id = orgIdUuid();
  const vars = { title, slug: slug(title), id };
  const spec = targetSpec ?? ["file+head", "%<%Y%m%d%H%M%S>-${slug}.org", "#+title: ${title}\n"];
  const fileName = expand(String(spec[1]), vars).text;
  const file = ember.expandFileName(fileName, directory());
  const head = spec[0] === "file+head" ? expand(String(spec[2] ?? ""), vars).text : "";
  if (!ember.fileExists(directory())) ember.makeDirectory(directory(), { parents: true });
  ember.call("find-file", file);
  const fresh = ember.bufferSize() === 0;
  const prefix = fresh ? `:PROPERTIES:\n:ID:       ${id}\n:END:\n${head}` : "";
  ember.gotoChar(ember.pointMax());
  ember.insert(prefix);
  const { text, point } = expand(body, vars);
  const at = ember.point();
  ember.insert(text);
  ember.gotoChar(at + (point ?? [...text].length));
  captures.set(ember.currentBuffer(), { node: { id, title }, file, fresh, then, window });
  ember.callWithPrefix(1, captureMode);
  ember.runHooks("org-roam-capture-new-node-hook");
}

// Org's own C-c C-c and C-c C-k finish and abort org-roam's captures too, as
// org-roam captures through org-capture; other captures are left to Org.
ember.adviceAdd("org-capture-finalize", "before-until", () => {
  const c = captures.get(ember.currentBuffer());
  if (!c) return undefined;
  ember.call("save-buffer");
  const buffer = ember.bufferName();
  ember.callWithPrefix(-1, captureMode);
  captures.delete(ember.currentBuffer());
  ember.call("bury-buffer");
  if (ember.windowList().includes(c.window)) ember.selectWindow(c.window);
  if (c.fresh) ember.call("kill-buffer", buffer);
  c.then?.(c.node);
  return true;
});

ember.adviceAdd("org-capture-kill", "before-until", () => {
  const c = captures.get(ember.currentBuffer());
  if (!c) return undefined;
  captures.delete(ember.currentBuffer());
  ember.setBufferModified(false);
  const buffer = ember.bufferName();
  if (c.fresh) {
    ember.call("kill-buffer", buffer);
    if (ember.fileExists(c.file)) ember.deleteFile(c.file);
  } else {
    ember.call("revert-buffer");
  }
  if (ember.windowList().includes(c.window)) ember.selectWindow(c.window);
  ember.message("Capture aborted");
  return true;
});

const captureMode = ember.defineMinorMode({
  name: "org-roam-capture-mode",
  lighter: " Cap",
  doc: "In a capture buffer: C-c C-c finishes, C-c C-k aborts.",
  bindings: { "C-c C-c": "org-capture-finalize", "C-c C-k": "org-capture-kill" },
  onChange: (enabled) => {
    ember.makeLocalVariable("header-line-format");
    ember.setVariable("header-line-format", enabled ? "Capture buffer.  Finish ‘C-c C-c’, abort ‘C-c C-k’." : null);
  },
});

// The commands.

ember.defineCommand({
  name: "org-roam-node-find",
  doc: "Visit a node chosen by its title, or make a note of the title typed, as org-roam-node-find. With a prefix argument, in another window.",
  params: [{ name: "other", kind: "prefix" }],
  run: (other: ember.Value) => {
    const chosen = readNode("Node: ");
    if (typeof chosen === "string") {
      if (chosen === "") ember.userError("No title given");
      capture(chosen);
    } else visitNode(chosen, truthy(other));
  },
});

/** Inserts a link to NODE, with DESCRIPTION, as org-roam-node-insert does. */
function insertLink(node: { id: string; title: string }, description?: string): void {
  ember.insert(`[[id:${node.id}][${description || node.title}]]`);
}

ember.defineCommand({
  name: "org-roam-node-insert",
  doc: "Insert a link to a node chosen by its title, or to a new note of the title typed; an active region is the link's text and the title to look for.",
  run: () => {
    const buffer = ember.currentBuffer();
    let region: [number, number] | undefined;
    const mark = ember.mark();
    if (ember.regionActive() && mark !== undefined) region = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
    const regionText = region ? ember.bufferSubstringNoProperties(region[0], region[1]) : undefined;
    const marker = ember.makeMarker(region ? region[0] : ember.point());
    const chosen = readNode("Node: ", regionText);
    const put = (node: { id: string; title: string }) => {
      ember.withCurrentBuffer(buffer, () => {
        if (region) ember.deleteRegion(region[0], region[1]);
        ember.gotoChar(ember.markerPosition(marker) ?? ember.point());
        insertLink(node, regionText);
        ember.deleteMarker(marker);
      });
    };
    if (typeof chosen === "string") {
      if (chosen === "") ember.userError("No title given");
      capture(chosen, put);
    } else put(chosen);
  },
});

ember.defineCommand({
  name: "org-roam-capture",
  doc: "Add to a node chosen by its title, or make a note of the title typed, from a capture template.",
  run: () => {
    const chosen = readNode("Node: ");
    if (chosen === "") ember.userError("No title given");
    capture(chosen);
  },
});

ember.defineCommand({
  name: "org-roam-node-random",
  doc: "Visit a node chosen at random.",
  run: () => {
    const all = allNodes();
    if (all.length === 0) ember.userError("No nodes");
    visitNode(all[Math.floor(Math.random() * all.length)]);
  },
});

/** Changes a list property of the node at point, as org-roam-property-add and -remove do for tags, aliases and refs. */
function editListProperty(property: "ROAM_ALIASES" | "ROAM_REFS", add: boolean): void {
  const node = nodeAtPoint();
  if (!node) ember.userError("No node at point");
  const current = property === "ROAM_ALIASES" ? node.aliases : node.refs;
  const value = add ? ember.readString(property === "ROAM_ALIASES" ? "Alias: " : "Ref: ") : ember.completingRead("Remove: ", current, { requireMatch: true });
  const next = add ? [...current, value] : current.filter((v) => v !== value);
  const quoted = next.map((v) => (/\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v)).join(" ");
  ember.saveExcursion(() => {
    orgIdGoto(node.id);
    if (node.level === 0) setFileProperty(property, quoted);
    else ember.call("org-set-property", property, quoted);
  });
}

/** Sets a property of the file's own drawer at the top, as org-roam-property-add does for a file node. */
function setFileProperty(name: string, value: string): void {
  for (let l = 1; l < ember.lineCount(); l++) {
    const text = ember.lineText(l);
    if (/^[ \t]*:END:/i.test(text)) {
      ember.gotoChar(ember.lineStart(l));
      ember.insert(`:${name}: ${value}\n`);
      return;
    }
    if (new RegExp(`^[ \\t]*:${name}:`, "i").test(text)) {
      ember.deleteRegion(ember.lineStart(l), ember.lineEnd(l));
      ember.gotoChar(ember.lineStart(l));
      ember.insert(`:${name}: ${value}`);
      return;
    }
  }
}

ember.defineCommand({ name: "org-roam-alias-add", doc: "Add an alias to the node at point.", run: () => editListProperty("ROAM_ALIASES", true) });
ember.defineCommand({ name: "org-roam-alias-remove", doc: "Remove an alias of the node at point.", run: () => editListProperty("ROAM_ALIASES", false) });
ember.defineCommand({ name: "org-roam-ref-add", doc: "Add a ref to the node at point.", run: () => editListProperty("ROAM_REFS", true) });
ember.defineCommand({ name: "org-roam-ref-remove", doc: "Remove a ref of the node at point.", run: () => editListProperty("ROAM_REFS", false) });

ember.defineCommand({
  name: "org-roam-tag-add",
  doc: "Add tags to the node at point: the file's #+filetags, or the heading's tags.",
  run: () => {
    const node = nodeAtPoint();
    if (!node) ember.userError("No node at point");
    const known = [...new Set(allNodes().flatMap((n) => n.tags))];
    const tag = ember.completingRead("Tag: ", known);
    if (tag === "") return;
    ember.saveExcursion(() => {
      if (node.level === 0) {
        let line = -1;
        for (let l = 0; l < ember.lineCount(); l++) if (/^#\+filetags:/i.test(ember.lineText(l))) line = l;
        if (line >= 0) {
          const old = tagsOf(ember.lineText(line).replace(/^#\+filetags:\s*/i, ""));
          ember.deleteRegion(ember.lineStart(line), ember.lineEnd(line));
          ember.gotoChar(ember.lineStart(line));
          ember.insert(`#+filetags: :${[...old, tag].join(":")}:`);
        } else {
          let l = 0;
          while (l < ember.lineCount() && /^(?:#\+|:)/.test(ember.lineText(l))) l++;
          ember.gotoChar(ember.lineStart(Math.min(l, ember.lineCount() - 1)));
          ember.insert(`#+filetags: :${tag}:\n`);
        }
      } else {
        orgIdGoto(node.id);
        ember.call("org-set-tags" as ember.CommandName, [...node.tags.filter((t) => !node.tags.includes(t) || true), tag].join(":"));
      }
    });
  },
});

// The Org-roam buffer, after org-roam-mode.el: the node at point's backlinks.

const ROAM_BUFFER = "*org-roam*";
/** The node the Org-roam buffer shows. */
let shownNode: Node | undefined;

/** The paragraph a link is in, for the preview, as org-roam-preview-default-function finds it. */
function preview(file: string, line: number): string {
  const lines = (ember.bufferList().some((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === file)
    ? ember.withCurrentBuffer(ember.bufferList().find((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === file)!, () => ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax()))
    : ember.readTextFile(file)
  ).split("\n");
  let a = line;
  let b = line;
  while (a > 0 && lines[a - 1].trim() !== "" && !/^\*+\s/.test(lines[a - 1]) && !/^[ \t]*:END:/i.test(lines[a - 1])) a--;
  while (b + 1 < lines.length && lines[b + 1].trim() !== "" && !/^\*+\s/.test(lines[b + 1])) b++;
  return lines.slice(a, b + 1).join("\n");
}

/** Draws the Org-roam buffer for NODE: its title and backlinks, each with its preview, as org-roam-buffer-render-contents. */
function render(node: Node): void {
  ember.letBind({ "inhibit-read-only": true }, () => {
    ember.makeLocalVariable("header-line-format");
    ember.setVariable("header-line-format", ember.propertize(node.title, { face: "org-roam-header-line" }));
    insertRoot("org-roam", () => {
      const links = (backlinks.get(node.id) ?? []).filter((l) => l.source !== node.id);
      if (links.length > 0) {
        insertSection("org-roam-backlinks", undefined, false, () => {
          insertHeading(ember.propertize("Backlinks:", { face: "magit-section-heading" }), "\n");
          const sorted = [...links].sort((x, y) => (nodesById.get(x.source)?.title ?? "").localeCompare(nodesById.get(y.source)?.title ?? ""));
          for (const l of sorted) {
            const source = nodesById.get(l.source);
            if (!source) continue;
            insertSection("org-roam-node-section", source.id, false, () => {
              insertHeading(ember.propertize(source.title, { face: "org-roam-title" }), " (", ember.propertize(l.outline.length > 0 ? l.outline.join(" > ") : "Top", { face: "org-roam-olp" }), ")", "\n");
              insertSection("org-roam-preview-section", { file: source.file, line: l.line }, false, () => {
                ember.insert(`${preview(source.file, l.line)}\n\n`);
              });
            });
          }
          ember.insert("\n");
        });
      }
      const refs = node.refs;
      if (refs.length > 0) {
        const reflinks = refs.flatMap((r) => backlinks.get(r) ?? []);
        if (reflinks.length > 0) {
          insertSection("org-roam-reflinks", undefined, false, () => {
            insertHeading(ember.propertize("Reflinks:", { face: "magit-section-heading" }), "\n");
            for (const l of reflinks) {
              const source = nodesById.get(l.source);
              if (source) insertSection("org-roam-node-section", source.id, false, () => insertHeading(ember.propertize(source.title, { face: "org-roam-title" }), "\n"));
            }
            ember.insert("\n");
          });
        }
      }
    });
    ember.gotoChar(0);
  });
}

const roamMode = ember.defineMajorMode({
  name: "org-roam-mode",
  modeName: "Org-roam",
  parent: magitSectionMode,
  doc: "The mode of the Org-roam buffer: the backlinks of a node, each with its text; RET visits one.",
});

const visitThing = ember.defineCommand({
  name: "org-roam-visit-thing",
  doc: "Visit the node, or the place of the preview, at point.",
  run: () => {
    const s = currentSection();
    if (!s) ember.userError("Nothing to visit");
    if (s.type === "org-roam-preview-section") {
      const { file, line } = s.value as { file: string; line: number };
      ember.call("other-window");
      ember.call("find-file", file);
      ember.gotoChar(ember.lineStart(line));
      return;
    }
    const node = nodeFromId(String(s.value));
    if (node) {
      ember.call("other-window");
      visitNode(node);
    }
  },
});
ember.defineKey("org-roam-mode-map", "RET", visitThing);
ember.defineKey("org-roam-mode-map", "<mouse-1>", visitThing);

/** Shows NODE in the Org-roam buffer. */
function showInRoamBuffer(node: Node): void {
  shownNode = node;
  ember.getBufferCreate(ROAM_BUFFER);
  ember.withCurrentBuffer(ROAM_BUFFER, () => {
    if (ember.variable("major-mode") !== "org-roam-mode") ember.call(roamMode);
    render(node);
  });
}

/** Shows the node at point in the Org-roam buffer, if it shows and the node changed, as org-roam-buffer--redisplay-h. */
function refreshRoamBuffer(force = false): void {
  if (!ember.windowList().some((w) => ember.windowBuffer(w) === ROAM_BUFFER)) return;
  if (!orgRoamFileP(ember.bufferFileName())) return;
  const node = nodeAtPoint();
  if (node && (force || node.id !== shownNode?.id)) showInRoamBuffer(node);
}
const followPoint = () => refreshRoamBuffer(false);

ember.defineCommand({
  name: "org-roam-buffer-toggle",
  doc: "Show the backlinks of the node at point in a window beside it, or hide them.",
  run: () => {
    const w = ember.windowList().find((x) => ember.windowBuffer(x) === ROAM_BUFFER);
    if (w !== undefined) {
      ember.deleteWindow(w);
      return;
    }
    const node = nodeAtPoint();
    if (!node) ember.userError("No node at point");
    allNodes();
    showInRoamBuffer(node);
    const selected = ember.selectedWindow();
    const side = ember.splitWindow(selected, "right", -Math.max(30, Math.trunc((ember.windowSize(selected)?.width ?? 80) / 3)));
    ember.setWindowBuffer(side, ROAM_BUFFER);
    ember.selectWindow(selected);
    ember.addHook("post-command-hook", followPoint);
  },
});

ember.defineCommand({
  name: "org-roam-buffer-display-dedicated",
  doc: "Show the backlinks of a node chosen, in a buffer of their own that does not follow point.",
  run: () => {
    const chosen = readNode("Node: ");
    if (typeof chosen === "string") ember.userError("No such node");
    const name = `*org-roam: ${chosen.title}*`;
    ember.getBufferCreate(name);
    ember.withCurrentBuffer(name, () => {
      ember.call(roamMode);
      render(chosen);
    });
    ember.call("display-buffer", name);
  },
});

ember.defineCommand({
  name: "org-roam-graph",
  doc: "Draw the nodes and their links with Graphviz's dot, as an SVG, and show it.",
  run: () => {
    const all = allNodes();
    const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
    const lines = ["digraph \"org-roam\" {", "  node [shape=underline];"];
    for (const n of all) lines.push(`  "${n.id}" [label="${esc(n.title)}"];`);
    for (const ls of backlinks.values()) for (const l of ls) if (nodesById.has(l.dest)) lines.push(`  "${l.source}" -> "${l.dest}";`);
    lines.push("}");
    const dot = ember.makeTempFile("org-roam", { suffix: ".dot", text: lines.join("\n") });
    const svg = dot.replace(/\.dot$/, ".svg");
    const r = ember.callProcess(["dot", "-Tsvg", "-o", svg, dot]);
    if (r.exit !== 0) ember.userError(`Graphviz failed: ${r.output.trim() || "is dot installed?"}`);
    ember.call("find-file", svg);
  },
});

/** The backlinks of a node, for packages such as consult-org-roam. */
export const backlinksOf = (id: string): Link[] => (allNodes(), backlinks.get(id) ?? []);
/** The links of a node to others, for packages such as consult-org-roam. */
export const forwardLinksOf = (id: string): Link[] => {
  const n = nodeFromId(id);
  if (!n) return [];
  return (db!.files[n.file]?.links ?? []).filter((l) => l.source === id);
};

// org-roam knows where every ID of its directory is, so id: links find them, as org-roam-id.el advises org-id-find.
ember.adviceAdd("org-id-find", "before-until", (id: string) => {
  const n = nodeFromId(id);
  if (!n) return undefined;
  const text = ember.bufferList().find((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === n.file);
  if (n.level === 0) return [n.file, 0];
  const content = text ? ember.withCurrentBuffer(text, () => ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax())) : ember.readTextFile(n.file);
  const m = new RegExp(`^[ \\t]*:ID:[ \\t]+${n.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "im").exec(content);
  return m ? [n.file, [...content.slice(0, m.index)].length] : [n.file, 0];
});

void sections;
