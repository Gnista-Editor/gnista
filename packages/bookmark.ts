// Bookmarks, after Emacs's bookmark.el: C-x r m names the place in a file,
// C-x r b goes back to it, even after the file changed around it, and
// C-x r l lists them. They are saved in Emacs's own format, in the file
// bookmark-default-file names, so Emacs and Ember share them.

import { PerBuffer } from "subr";

ember.defineVariable({ name: "bookmark-search-size", doc: "How many characters of text on each side a bookmark keeps, to find its place again after edits.", value: 16 });
ember.defineVariable({ name: "bookmark-save-flag", doc: "When bookmarks are saved: t on quitting, a number after that many changes, nil never.", value: 1 });
ember.defineVariable({ name: "bookmark-default-file", doc: "The file bookmarks are saved in, or nil for bookmarks under user-emacs-directory.", value: null });

/** A bookmark: its name and where it is, as bookmark.el's records hold them. */
interface Bookmark {
  name: string;
  filename?: string;
  front?: string;
  rear?: string;
  position: number;
}

/** The bookmarks, newest first, as bookmark-alist; undefined until the file is read. */
let alist: Bookmark[] | undefined;
let changes = 0;
/** The bookmark used last in each buffer, as bookmark-current-bookmark. */
const current = new PerBuffer<string>();

function bookmarkFile(): string | undefined {
  const own = ember.variable("bookmark-default-file");
  if (typeof own === "string") return ember.expandFileName(own);
  const dir = ember.variable("user-emacs-directory");
  return typeof dir === "string" ? ember.expandFileName("bookmarks", dir) : undefined;
}

// --- Emacs's bookmark file: a Lisp list, read and written ---------------------

type Sexp = string | number | { symbol: string } | Sexp[] | { car: Sexp; cdr: Sexp };

/** Reads the Lisp data a bookmark file holds: lists, dotted pairs, strings, numbers and symbols. */
function readSexp(text: string): Sexp | undefined {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] === ";") while (i < text.length && text[i] !== "\n") i++;
      else return;
    }
  };
  const read = (): Sexp => {
    skip();
    const c = text[i];
    if (c === "(") {
      i++;
      const items: Sexp[] = [];
      for (;;) {
        skip();
        if (text[i] === ")") {
          i++;
          return items;
        }
        if (text[i] === "." && /[\s(]/.test(text[i + 1] ?? "")) {
          i++;
          const cdr = read();
          skip();
          if (text[i] === ")") i++;
          return items.length === 1 ? { car: items[0]!, cdr } : [...items.slice(0, -1), { car: items.at(-1)!, cdr }];
        }
        if (i >= text.length) return items;
        items.push(read());
      }
    }
    if (c === '"') {
      i++;
      let s = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++;
          const e = text[i];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "\n" ? "" : (e ?? "");
        } else {
          s += text[i];
        }
        i++;
      }
      i++;
      return s;
    }
    let atom = "";
    while (i < text.length && !/[\s()";]/.test(text[i]!)) atom += text[i++];
    return /^-?\d+(\.\d+)?$/.test(atom) ? Number(atom) : { symbol: atom };
  };
  skip();
  return i < text.length ? read() : undefined;
}

/** A Lisp string, as prin1 writes one. */
const lispString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The bookmark file's text, as bookmark-write-file writes it. */
function writeText(list: Bookmark[]): string {
  const entry = (b: Bookmark) => {
    const fields = [
      b.filename !== undefined ? ` (filename . ${lispString(b.filename)})` : undefined,
      ` (front-context-string${b.front === undefined ? " . nil" : ` . ${lispString(b.front)}`})`,
      ` (rear-context-string${b.rear === undefined ? " . nil" : ` . ${lispString(b.rear)}`})`,
      ` (position . ${b.position + 1})`,
    ].filter((f) => f !== undefined);
    return `(${lispString(b.name)}\n${fields.join("\n")})`;
  };
  return `;;;; Emacs Bookmark Format Version 1;;;; -*- coding: utf-8-emacs; mode: lisp-data -*-\n;;; This format is meant to be slightly human-readable;\n;;; nevertheless, you probably don't want to edit it.\n;;; -*- End Of Bookmark File Format Version Stamp -*-\n(${list.map(entry).join("\n")}\n)\n`;
}

/** The bookmarks in a file's text. */
function parse(text: string): Bookmark[] {
  const data = readSexp(text.replace(/^;;;;.*$/gm, ""));
  if (!Array.isArray(data)) return [];
  const out: Bookmark[] = [];
  for (const item of data) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const b: Bookmark = { name: item[0], position: 0 };
    for (const field of item.slice(1)) {
      if (Array.isArray(field) || typeof field !== "object" || !("car" in field)) continue;
      const key = typeof field.car === "object" && "symbol" in field.car ? field.car.symbol : undefined;
      const value = field.cdr;
      if (key === "filename" && typeof value === "string") b.filename = value;
      else if (key === "front-context-string" && typeof value === "string") b.front = value;
      else if (key === "rear-context-string" && typeof value === "string") b.rear = value;
      else if (key === "position" && typeof value === "number") b.position = value - 1;
    }
    out.push(b);
  }
  return out;
}

/** The bookmarks, read from the file the first time, as bookmark-maybe-load-default-file. */
function bookmarks(): Bookmark[] {
  if (alist !== undefined) return alist;
  const file = bookmarkFile();
  alist = file !== undefined && ember.fileReadableP(file) ? parse(ember.readTextFile(file) ?? "") : [];
  return alist;
}

/** Saves the bookmarks to their file, as bookmark-save does. */
function save(): void {
  const file = bookmarkFile();
  if (file === undefined) return;
  ember.writeTextFile(file, writeText(bookmarks()));
  changes = 0;
  ember.message(`Saving bookmarks to file ${file}...done`);
}

/** Notes a change, saving when bookmark-save-flag says, as bookmark-time-to-save-p. */
function changed(): void {
  changes++;
  const flag = ember.variable("bookmark-save-flag");
  if (typeof flag === "number" && changes >= flag) save();
}

ember.addHook("kill-emacs-hook", () => {
  if (changes > 0 && ember.variable("bookmark-save-flag") === true) save();
});

/** A bookmark by name, or an error, as bookmark-get-bookmark. */
function find(name: string): Bookmark {
  const b = bookmarks().find((x) => x.name === name);
  if (b === undefined) ember.userError(`Invalid bookmark ${name}`);
  return b!;
}

/** Reads a bookmark's name with completion, as bookmark-completing-read. */
async function readBookmark(prompt: string): Promise<string> {
  const names = bookmarks().map((b) => b.name);
  if (names.length === 0) ember.userError("No bookmarks exist");
  const def = current.get(ember.bufferName()) ?? names[0];
  const answer = await ember.completingRead(`${prompt} (default ${def}): `, names, { requireMatch: true, history: "bookmark-history", default: def });
  return answer === "" ? def! : answer;
}

ember.defineVariable({ name: "bookmark-history", doc: "Bookmark names answered at prompts, newest first.", value: [] });

ember.defineCommand({
  name: "bookmark-set",
  doc:
    "Name the place point is at in this file, to go back to with C-x r b. The default name is the file's.\n\n" +
    "A bookmark of the same name is replaced; with a prefix argument, the new one goes in front of it instead.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: ember.PrefixArg) => {
    const file = ember.bufferFileName();
    const def = current.get(ember.bufferName()) ?? (file !== undefined ? file.replace(/.*\//, "") : ember.bufferName());
    const answer = await ember.readString(`Set bookmark (default ${def}): `, { history: "bookmark-history" });
    const name = answer === "" ? def : answer;
    const size = Number(ember.variable("bookmark-search-size") ?? 16);
    const p = ember.point();
    const b: Bookmark = {
      name,
      filename: file === undefined ? undefined : ember.abbreviateFileName(file),
      front: ember.pointMax() - p >= size ? ember.bufferSubstringNoProperties(p, p + size) : undefined,
      rear: p - ember.pointMin() >= size ? ember.bufferSubstringNoProperties(p - size, p) : undefined,
      position: p,
    };
    const list = bookmarks();
    if (arg === null) {
      const i = list.findIndex((x) => x.name === name);
      if (i >= 0) list.splice(i, 1);
    }
    list.unshift(b);
    current.set(ember.bufferName(), name);
    changed();
  },
});

/** Goes to a bookmark's place: its file, at its context or else its position, as bookmark-default-handler. */
export function jumpTo(name: string, how: "switch-to-buffer" | "switch-to-buffer-other-window"): void {
  const b = find(name);
  if (b.filename === undefined || !ember.fileReadableP(ember.expandFileName(b.filename))) {
    ember.signal("bookmark-error-no-filename", `Bookmark ${name} has no file it can read`, [b.filename ?? null]);
  }
  const buffer = ember.findFileNoselect(ember.expandFileName(b.filename!));
  ember.call(how, buffer);
  ember.gotoChar(Math.min(b.position, ember.pointMax()));
  // Its text first, then the text before it, so a change around it is followed.
  if (b.front !== undefined) {
    const m = ember.search(b.front, { bound: ember.pointMax(), caseFold: false });
    if (m !== undefined) ember.gotoChar(m.start);
  }
  if (b.rear !== undefined) {
    const m = ember.search(b.rear, { backward: true, bound: ember.pointMin(), caseFold: false });
    if (m !== undefined) ember.gotoChar(m.end);
  }
  current.set(ember.bufferName(), name);
}

ember.defineCommand({
  name: "bookmark-jump",
  doc: "Go to a bookmark's place, in its file.",
  run: async () => jumpTo(await readBookmark("Jump to bookmark"), "switch-to-buffer"),
});

ember.defineCommand({
  name: "bookmark-jump-other-window",
  doc: "Go to a bookmark's place, in its file, in another window.",
  run: async () => jumpTo(await readBookmark("Jump to bookmark (in another window)"), "switch-to-buffer-other-window"),
});

ember.defineCommand({
  name: "bookmark-delete",
  doc: "Forget a bookmark.",
  run: async () => {
    const name = await readBookmark("Delete bookmark");
    const list = bookmarks();
    list.splice(list.findIndex((b) => b.name === name), 1);
    changed();
  },
});

ember.defineCommand({
  name: "bookmark-rename",
  doc: "Give a bookmark another name.",
  run: async () => {
    const old = await readBookmark("Old bookmark name");
    const name = await ember.readString(`Rename "${old}" to: `, { history: "bookmark-history" });
    find(old).name = name;
    changed();
  },
});

ember.defineCommand({ name: "bookmark-save", doc: "Save the bookmarks to their file.", run: () => save() });

ember.defineCommand({
  name: "bookmark-insert",
  doc: "Insert the text of the file a bookmark is in, leaving the mark after it.",
  run: async () => {
    const b = find(await readBookmark("Insert bookmark contents"));
    if (b.filename === undefined) ember.userError("That bookmark has no file");
    const text = ember.readTextFile(ember.expandFileName(b.filename!)) ?? "";
    const p = ember.point();
    ember.insert(text);
    ember.pushMark(ember.point());
    ember.gotoChar(p);
  },
});

// The bookmark list, C-x r l, after bookmark-bmenu-list.

const BMENU = "*Bookmark List*";
const deletions = new Set<string>();

function bmenuRefresh(): void {
  ember.withCurrentBuffer(BMENU, () => {
    const line = ember.lineOf(ember.point());
    ember.letBind({ "inhibit-read-only": true }, () => {
      ember.deleteRegion(ember.pointMin(), ember.pointMax());
      ember.insert(ember.propertize(`  ${"Bookmark Name".padEnd(30)} File`, { face: "bold" }) + "\n");
      for (const b of [...bookmarks()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
        const start = ember.point();
        ember.insert(`${deletions.has(b.name) ? "D" : " "} ${b.name.padEnd(30)} ${b.filename ?? ""}`.trimEnd());
        ember.putTextProperty(start, ember.point(), "bookmark-name-prop", b.name);
        ember.insert("\n");
      }
    });
    ember.gotoChar(ember.lineStart(Math.min(Math.max(1, line), Math.max(1, ember.lineCount() - 2))));
    ember.setBufferModified(false);
  });
}

function bmenuBookmark(): string {
  const name = ember.getTextProperty(ember.lineBeginningPosition(), "bookmark-name-prop");
  if (typeof name !== "string") ember.userError("No bookmark on this line");
  return name as string;
}

const bmenuNext = (n: number) => {
  const line = Math.max(1, Math.min(ember.lineCount() - 2, ember.lineOf(ember.point()) + n));
  ember.gotoChar(ember.lineStart(line));
};

ember.defineCommand({
  name: "bookmark-bmenu-list",
  doc: "List the bookmarks in *Bookmark List*: RET goes to one, d marks it to be deleted and x deletes those marked.",
  run: () => {
    ember.getBufferCreate(BMENU);
    ember.withCurrentBuffer(BMENU, () => {
      if (ember.variable("major-mode") !== "bookmark-bmenu-mode") ember.call("bookmark-bmenu-mode");
    });
    deletions.clear();
    bmenuRefresh();
    ember.call("switch-to-buffer", BMENU);
  },
});

for (const [name, doc, run] of [
  ["bookmark-bmenu-this-window", "Go to this line's bookmark in this window.", () => jumpTo(bmenuBookmark(), "switch-to-buffer")],
  ["bookmark-bmenu-other-window", "Go to this line's bookmark in another window.", () => jumpTo(bmenuBookmark(), "switch-to-buffer-other-window")],
  ["bookmark-bmenu-delete", "Mark this line's bookmark to be deleted by x, and move down.", () => {
    deletions.add(bmenuBookmark());
    bmenuRefresh();
    bmenuNext(1);
  }],
  ["bookmark-bmenu-unmark", "Take the mark off this line's bookmark, and move down.", () => {
    deletions.delete(bmenuBookmark());
    bmenuRefresh();
    bmenuNext(1);
  }],
  ["bookmark-bmenu-execute-deletions", "Delete the bookmarks marked with d.", () => {
    if (deletions.size === 0) return;
    alist = bookmarks().filter((b) => !deletions.has(b.name));
    deletions.clear();
    changed();
    bmenuRefresh();
  }],
  ["bookmark-bmenu-next-line", "Move to the next bookmark.", () => bmenuNext(1)],
  ["bookmark-bmenu-previous-line", "Move to the bookmark before.", () => bmenuNext(-1)],
  ["bookmark-bmenu-revert", "List the bookmarks again.", () => bmenuRefresh()],
] as const) {
  ember.defineCommand({ name, doc, run });
}

ember.defineMajorMode({
  name: "bookmark-bmenu-mode",
  modeName: "Bookmark Menu",
  doc: "The mode of *Bookmark List*: RET goes to a bookmark, o in another window, d marks it to be deleted, x deletes, g lists again, q quits.",
  bindings: {
    RET: "bookmark-bmenu-this-window",
    f: "bookmark-bmenu-this-window",
    o: "bookmark-bmenu-other-window",
    d: "bookmark-bmenu-delete",
    k: "bookmark-bmenu-delete",
    u: "bookmark-bmenu-unmark",
    x: "bookmark-bmenu-execute-deletions",
    n: "bookmark-bmenu-next-line",
    p: "bookmark-bmenu-previous-line",
    g: "bookmark-bmenu-revert",
    s: "bookmark-save",
    q: "quit-window",
  } as Record<string, ember.CommandName>,
  setup: () => {
    ember.setVariable("truncate-lines", true);
    ember.setReadOnly(true);
  },
});

for (const [keys, command] of [
  ["C-x r m", "bookmark-set"],
  ["C-x r b", "bookmark-jump"],
  ["C-x r l", "bookmark-bmenu-list"],
  ["C-x 4 r", "bookmark-jump-other-window"],
] as const) {
  ember.bindKey(keys, command);
}
