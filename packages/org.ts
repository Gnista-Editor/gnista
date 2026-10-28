// Org mode, after Emacs's org.el, with the parts of org-list.el and ol.el
// that editing notes needs: headings that fold with TAB and S-TAB, structure
// editing with M-RET and the M-arrow keys, TODO states, priorities, tags,
// plain lists with checkboxes, timestamps and links. Tables are in
// org-table.ts.
//
// Org text is styled as it comes into view, by a function on
// jit-lock-functions, as Emacs's font-lock styles it. Folding hides text with
// overlays, as Emacs's org does with org-fold-core-style set to overlays:
// "outline" for subtrees, "org-hide-drawer" for drawers and
// "org-hide-block" for blocks. A link's brackets and target are hidden by
// an "org-link" text property, so [[https://gnu.org][GNU]] shows as GNU.

// Variables

const variables: [string, string, ember.Value][] = [
  [
    "org-todo-keywords",
    'The TODO states headings cycle through, in order: states before "|" are not done, those after it are. ' +
      "Without a \"|\", the last state is the done one. A #+TODO: line in a file gives that file its own.",
    ["TODO", "|", "DONE"],
  ],
  [
    "org-startup-folded",
    'How much of a file org-mode shows when it starts: "showeverything", "showall" (drawers folded), ' +
      '"content" (all headings) or "overview" (top headings). A #+STARTUP: line in the file says otherwise.',
    "showeverything",
  ],
  ["org-startup-truncated", "Whether org-mode turns on truncate-lines, so long lines run off the window.", true],
  [
    "org-tags-column",
    "Where tags go on a heading line: a negative column aligns their end there, a positive one their start.",
    -77,
  ],
  [
    "org-cycle-separator-lines",
    "How many empty lines before a heading keep one of them showing when the subtree above it is folded.",
    2,
  ],
  [
    "org-support-shift-select",
    "Whether Shift with an arrow key selects text where it has no Org meaning. When off, it is an error there.",
    false,
  ],
  ["org-M-RET-may-split-line", "Whether M-RET in the middle of a line splits it, the rest going to the new heading or item.", true],
  [
    "org-log-done",
    'What marking a heading done records: false for nothing, "time" for a CLOSED: timestamp under it.',
    false,
  ],
  ["org-priority-highest", "The highest priority, a capital letter.", "A"],
  ["org-priority-lowest", "The lowest priority, a capital letter.", "C"],
  ["org-priority-default", "The priority S-<up> and S-<down> start from, and that headings without one count as.", "B"],
  ["org-link-descriptive", "Whether links show only their description, hiding the brackets and target.", true],
  ["org-fontify-done-headline", "Whether the text of a done heading gets the face org-headline-done.", true],
  [
    "org-time-stamp-rounding-minutes",
    "Minutes are rounded to the first of these when a time is inserted, and S-<up> and S-<down> change them by the second.",
    [0, 5],
  ],
];
for (const [name, doc, value] of variables) ember.defineVariable({ name, doc, value });

for (const [name, doc] of [
  ["org-cycle-subtree-status", "What TAB last did to a heading: \"folded\", \"children\" or \"subtree\"."],
  ["org-cycle-global-status", "What S-TAB last did: \"overview\", \"contents\" or \"all\"."],
  ["org--todo-sets", "The buffer's TODO state sequences: each a list of the states not done and the states done."],
]) {
  ember.defineVariable({ name, doc, value: null, local: true });
}

{
  const alist = ember.variable("auto-mode-alist");
  if (Array.isArray(alist)) ember.setDefault("auto-mode-alist", [["\\.org$", "org-mode"], ...alist]);
}

// Faces

const faces: [string, string, ember.FaceAttributes][] = [
  ["org-todo", "TODO states that are not done.", { foreground: "bad", bold: true }],
  ["org-done", "Done TODO states, such as DONE.", { foreground: "good", bold: true }],
  ["org-headline-done", "The text of a heading that is done.", { foreground: "muted" }],
  ["org-priority", "Priority cookies, such as [#A].", { inherit: "font-lock-keyword-face" }],
  ["org-tag", "Tags at the end of a heading.", { bold: true }],
  ["org-link", "Links.", { inherit: "link" }],
  ["org-date", "Timestamps.", { foreground: "accent-ink", underline: true }],
  ["org-special-keyword", "Keywords such as SCHEDULED: and property names.", { inherit: "font-lock-keyword-face" }],
  ["org-property-value", "Property values.", {}],
  ["org-drawer", "Drawer lines, such as :PROPERTIES: and :END:.", { foreground: "accent-ink" }],
  ["org-table", "Tables.", { foreground: "accent-ink" }],
  ["org-checkbox", "Checkboxes, such as [ ] and [X].", { inherit: "bold" }],
  ["org-checkbox-statistics-todo", "Checkbox counts, such as [1/3], with boxes left to tick.", { inherit: "org-todo" }],
  ["org-checkbox-statistics-done", "Checkbox counts with every box ticked.", { inherit: "org-done" }],
  ["org-list-dt", "The term of a description list item, before ::.", { bold: true }],
  ["org-meta-line", "Lines such as #+STARTUP:.", { inherit: "font-lock-comment-face" }],
  ["org-document-title", "The title from #+TITLE:.", { foreground: "accent-ink", bold: true }],
  ["org-document-info", "Values of #+AUTHOR:, #+DATE: and #+EMAIL:.", { foreground: "accent-ink" }],
  ["org-document-info-keyword", "Keywords such as #+TITLE:.", { inherit: "shadow" }],
  ["org-block", "The text in blocks, such as #+begin_src.", { inherit: "shadow" }],
  ["org-block-begin-line", "The line starting a block.", { inherit: "org-meta-line" }],
  ["org-block-end-line", "The line ending a block.", { inherit: "org-meta-line" }],
  ["org-quote", "The text in quote blocks.", { inherit: "org-block", italic: true }],
  ["org-verse", "The text in verse blocks.", { inherit: "org-block" }],
  ["org-code", "~Code~.", { inherit: "shadow" }],
  ["org-verbatim", "=Verbatim= text.", { inherit: "shadow" }],
  ["org-strike-through", "+Struck through+ text.", { strike: true }],
  ["org-footnote", "Footnotes, such as [fn:1].", { foreground: "accent-ink", underline: true }],
  ["org-target", "Link targets, such as <<target>>.", { underline: true }],
];
for (const [name, doc, attributes] of faces) ember.defineFace({ name, doc, attributes });
for (let i = 1; i <= 8; i++) {
  ember.defineFace({ name: `org-level-${i}`, doc: `Level ${i} headings, and deeper levels in turn.`, attributes: { inherit: `outline-${i}` } });
}

// Text and positions. Positions count characters; JavaScript strings count
// UTF-16 units, which differ for emoji.

function charCount(s: string): number {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length;
}

/** The position of index `i` of a line's text. */
function at(line: number, text: string, i: number): number {
  return ember.lineStart(line) + charCount(text.slice(0, i));
}

/** The index in a line's text of a position on it. */
function indexOf(line: number, text: string, pos: number): number {
  const n = pos - ember.lineStart(line);
  if (!/[\uD800-\uDFFF]/.test(text)) return n;
  return Array.from(text).slice(0, n).join("").length;
}

function lineAt(pos = ember.point()): number {
  return ember.lineOf(pos);
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

function indentation(text: string): number {
  return (/^[ \t]*/.exec(text)?.[0] ?? "").replace(/\t/g, "        ").length;
}

/** Replaces text and puts point back where it was, moved along with the text around it. */
function replaceText(start: number, end: number, text: string): void {
  let p = ember.point();
  const delta = charCount(text) - (end - start);
  // As a marker would: text inserted at point goes after it.
  if (p > end || (p === end && start < end)) p += delta;
  else if (p > start) p = Math.min(p, start + charCount(text));
  ember.deleteRegion(start, end);
  ember.gotoChar(start);
  ember.insert(text);
  ember.gotoChar(p);
}

function shiftSelectError(): never {
  throw new Error("To use shift-selection with Org mode, customize \u2018org-support-shift-select\u2019");
}

// TODO states

interface TodoSet {
  todo: string[];
  done: string[];
}

/** Reads a list of states such as TODO NEXT | DONE, dropping fast-access keys like (t). */
function todoSetFrom(words: string[]): TodoSet | undefined {
  const names = words.map((w) => w.replace(/\(.*\)$/, "")).filter((w) => w !== "");
  if (names.length === 0) return undefined;
  const bar = names.indexOf("|");
  if (bar >= 0) return { todo: names.slice(0, bar), done: names.slice(bar + 1) };
  return names.length === 1 ? { todo: [], done: names } : { todo: names.slice(0, -1), done: names.slice(-1) };
}

/** The buffer's TODO sequences: from #+TODO: lines, else org-todo-keywords. */
function readTodoSets(): TodoSet[] {
  const sets: TodoSet[] = [];
  for (let line = 0; line < ember.lineCount(); line++) {
    const m = /^#\+(?:TODO|SEQ_TODO|TYP_TODO):(.*)$/i.exec(ember.lineText(line));
    const set = m ? todoSetFrom(m[1].trim().split(/\s+/)) : undefined;
    if (set) sets.push(set);
  }
  if (sets.length === 0) {
    const value = ember.variable("org-todo-keywords");
    const lists = Array.isArray(value) && value.every(Array.isArray) ? (value as ember.Value[][]) : [value as ember.Value[]];
    for (const list of lists) {
      const set = Array.isArray(list) ? todoSetFrom(list.map(String)) : undefined;
      if (set) sets.push(set);
    }
  }
  return sets;
}

function todoSets(): TodoSet[] {
  const value = ember.variable("org--todo-sets");
  if (!Array.isArray(value)) return readTodoSets();
  return (value as string[][][]).map(([todo, done]) => ({ todo, done }));
}

function storeTodoSets(): void {
  ember.setVariable("org--todo-sets", readTodoSets().map((s) => [s.todo, s.done]));
}

function allKeywords(): string[] {
  return todoSets().flatMap((s) => [...s.todo, ...s.done]);
}

function isDone(keyword: string | undefined): boolean {
  return keyword !== undefined && todoSets().some((s) => s.done.includes(keyword));
}

// Headings

interface Heading {
  line: number;
  start: number;
  /** The end of the heading line, before its newline. */
  end: number;
  level: number;
  todo?: string;
  todoAt?: number;
  priority?: string;
  priorityAt?: number;
  /** Where the title starts, after the stars, state and priority. */
  titleAt: number;
  title: string;
  tags: string[];
  /** Where the tags start, if there are any. */
  tagsAt?: number;
}

const TAGS = /[ \t](:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u;

function parseHeading(line: number, keywords = allKeywords()): Heading | undefined {
  const text = ember.lineText(line);
  const stars = /^(\*+) /.exec(text);
  if (!stars) return undefined;
  let i = stars[0].length;
  while (text[i] === " ") i++;
  const h: Heading = {
    line,
    start: ember.lineStart(line),
    end: ember.lineEnd(line),
    level: stars[1].length,
    titleAt: 0,
    title: "",
    tags: [],
  };
  for (const kw of [...keywords].sort((a, b) => b.length - a.length)) {
    if (text.startsWith(kw, i) && (i + kw.length === text.length || text[i + kw.length] === " ")) {
      h.todo = kw;
      h.todoAt = at(line, text, i);
      i += kw.length;
      while (text[i] === " ") i++;
      break;
    }
  }
  const priority = /^\[#([A-Z0-9])\](?= |$)/.exec(text.slice(i));
  if (priority) {
    h.priority = priority[1];
    h.priorityAt = at(line, text, i);
    i += priority[0].length;
    while (text[i] === " ") i++;
  }
  let titleEnd = text.length;
  const tags = TAGS.exec(text);
  if (tags && tags.index + 1 >= stars[0].length - 1) {
    h.tags = tags[1].split(":").filter((t) => t !== "");
    h.tagsAt = at(line, text, tags.index + 1);
    titleEnd = tags.index;
  }
  i = Math.min(i, Math.max(titleEnd, stars[0].length));
  h.titleAt = at(line, text, i);
  h.title = text.slice(i, Math.max(i, titleEnd)).trimEnd();
  return h;
}

function isHeadingLine(text: string): boolean {
  return /^\*+ /.test(text);
}

function headings(): Heading[] {
  const keywords = allKeywords();
  const found: Heading[] = [];
  for (let line = 0; line < ember.lineCount(); line++) {
    if (ember.lineText(line).startsWith("*")) {
      const h = parseHeading(line, keywords);
      if (h) found.push(h);
    }
  }
  return found;
}

/** The heading whose entry a line is in: the nearest heading at or above it. */
function headingIndex(all: Heading[], line: number): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < all.length && all[i].line <= line; i++) found = i;
  return found;
}

/** The heading point is under, or Org's error. */
function backToHeading(): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) {
    throw new Error(`Before first headline at position ${ember.point() + 1} in buffer ${ember.bufferName()}`);
  }
  return [all, i];
}

/** The heading on point's line, if it is a heading line. */
function headingHere(): [Heading[], number] | undefined {
  if (!isHeadingLine(ember.lineText(lineAt()))) return undefined;
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : [all, i];
}

/** The next heading after `i` at its level or higher, if any. */
function nextSameOrHigher(all: Heading[], i: number): Heading | undefined {
  return all.slice(i + 1).find((h) => h.level <= all[i].level);
}

/**
 * Where folding a heading's text ends, given the heading after it: before
 * that heading's newline, or at the end of the buffer. With
 * org-cycle-separator-lines or more empty lines before the next heading,
 * the last of them stays showing.
 */
function foldEnd(h: Heading, next: Heading | undefined): number {
  if (next === undefined) return ember.bufferSize();
  let blank = 0;
  for (let l = next.line - 1; l > h.line && isBlank(ember.lineText(l)); l--) blank++;
  const keep = Number(ember.variable("org-cycle-separator-lines") ?? 2);
  if (keep > 0 && blank >= keep) return Math.max(h.end, ember.lineStart(next.line - 1) - 1);
  return Math.max(h.end, next.start - 1);
}

function subtreeEnd(all: Heading[], i: number): number {
  return foldEnd(all[i], nextSameOrHigher(all, i));
}

/** Where a heading's own text ends, before its first subheading. */
function entryEnd(all: Heading[], i: number): number {
  return foldEnd(all[i], all[i + 1]);
}

/** Where a subtree's text starts and ends for moving or killing it: whole lines. */
function subtreeRegion(all: Heading[], i: number): [number, number] {
  const next = nextSameOrHigher(all, i);
  return [all[i].start, next ? next.start : ember.bufferSize()];
}

// Folding

function hideOverlay(start: number, end: number, spec: string): void {
  ember.makeOverlay(start, end, { invisible: spec, evaporate: true });
}

/**
 * Hides or shows the text from start up to end, as Emacs's org-fold-region
 * does: overlays hiding it with `spec` are removed, cut back where they
 * reach outside it, and a new one hides it.
 */
function flag(start: number, end: number, hide: boolean, spec = "outline"): void {
  for (const id of ember.overlaysIn(start, end)) {
    if (ember.overlayGet(id, "invisible") !== spec) continue;
    const [from, to] = [ember.overlayStart(id) ?? start, ember.overlayEnd(id) ?? end];
    ember.deleteOverlay(id);
    if (from < start) hideOverlay(from, start, spec);
    if (to > end) hideOverlay(end, to, spec);
  }
  if (hide && end > start) hideOverlay(start, end, spec);
}

function folded(pos: number, spec = "outline"): boolean {
  return ember.overlaysAt(pos).some((id) => ember.overlayGet(id, "invisible") === spec);
}

/** Shows a heading's text and its children's headings, with their subtrees folded. */
function showChildren(all: Heading[], i: number): boolean {
  const end = subtreeEnd(all, i);
  flag(all[i].end, end, false);
  const inside = all.slice(i + 1).filter((h) => h.start <= end);
  const level = Math.min(...inside.map((h) => h.level), Infinity);
  for (const child of inside) {
    if (child.level === level) flag(child.end, subtreeEnd(all, all.indexOf(child)), true);
  }
  return inside.length > 0;
}

function cycleHeading(all: Heading[], i: number): void {
  const h = all[i];
  const eos = subtreeEnd(all, i);
  if (eos <= h.end || isBlank(ember.bufferText(h.end, eos))) {
    ember.message("EMPTY ENTRY");
    ember.setVariable("org-cycle-subtree-status", null);
    return;
  }
  const again = ember.lastCommand() === ember.thisCommand();
  const status = ember.variable("org-cycle-subtree-status");
  if (folded(h.end)) {
    if (showChildren(all, i)) {
      ember.message("CHILDREN");
      ember.setVariable("org-cycle-subtree-status", "children");
      return;
    }
    // With no children to show, it goes straight to the whole subtree.
  } else if (!(again && status === "children")) {
    flag(h.end, eos, true);
    ember.message("FOLDED");
    ember.setVariable("org-cycle-subtree-status", "folded");
    return;
  }
  flag(h.end, eos, false);
  ember.message("SUBTREE");
  ember.setVariable("org-cycle-subtree-status", "subtree");
}

/** Shows only headings up to a level, as overview and #+STARTUP: show2levels do. */
function showLevels(levels: number): void {
  const all = headings();
  flag(0, ember.bufferSize(), false);
  const shown = all.filter((h) => h.level <= levels);
  shown.forEach((h, k) => {
    const end = foldEnd(h, shown[k + 1]);
    // A heading with nothing under it keeps its newline showing.
    if (!isBlank(ember.bufferText(h.end, end))) flag(h.end, end, true);
  });
}

function overview(): void {
  const all = headings();
  if (all.length > 0) showLevels(all[0].level);
}

function contents(): void {
  showLevels(Infinity);
}

function globalCycle(): void {
  const again = ember.lastCommand() === ember.thisCommand();
  const status = ember.variable("org-cycle-global-status");
  if (again && status === "overview") {
    contents();
    ember.message("CONTENTS...done");
    ember.setVariable("org-cycle-global-status", "contents");
  } else if (again && status === "contents") {
    flag(0, ember.bufferSize(), false);
    ember.message("SHOW ALL");
    ember.setVariable("org-cycle-global-status", "all");
  } else {
    overview();
    ember.message("OVERVIEW");
    ember.setVariable("org-cycle-global-status", "overview");
  }
}

const DRAWER = /^[ \t]*:([\w-]+):[ \t]*$/;
const BLOCK_BEGIN = /^[ \t]*#\+begin_(\S+)/i;
const BLOCK_END = /^[ \t]*#\+end_(\S+)/i;

/** The lines a drawer or block starting at a line runs to, or undefined if it is not closed. */
function closingLine(line: number): number | undefined {
  const text = ember.lineText(line);
  const block = BLOCK_BEGIN.exec(text);
  for (let l = line + 1; l < ember.lineCount(); l++) {
    const t = ember.lineText(l);
    if (block ? BLOCK_END.test(t) : /^[ \t]*:END:[ \t]*$/i.test(t)) return l;
    if (isHeadingLine(t)) return undefined;
  }
  return undefined;
}

/** Folds or unfolds the drawer or block starting at a line, showing its first line. */
function toggleDrawerOrBlock(line: number, hide?: boolean): boolean {
  const close = closingLine(line);
  if (close === undefined) return false;
  const spec = BLOCK_BEGIN.test(ember.lineText(line)) ? "org-hide-block" : "org-hide-drawer";
  const start = ember.lineEnd(line);
  flag(start, ember.lineEnd(close), hide ?? !folded(start, spec), spec);
  return true;
}

function hideAllDrawers(): void {
  for (let line = 0; line < ember.lineCount(); line++) {
    const m = DRAWER.exec(ember.lineText(line));
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

/** Folds the buffer as org-startup-folded or a #+STARTUP: line says. */
function startupVisibility(): void {
  let how = String(ember.variable("org-startup-folded") ?? "showeverything");
  for (let line = 0; line < ember.lineCount(); line++) {
    const m = /^#\+STARTUP:(.*)$/i.exec(ember.lineText(line));
    for (const word of m ? m[1].trim().split(/\s+/) : []) {
      if (/^(overview|fold|content|showall|nofold|showeverything|show[2-5]levels)$/.test(word)) how = word;
    }
  }
  if (how === "showeverything") return;
  if (how === "overview" || how === "fold") overview();
  else if (how === "content") contents();
  else if (/^show[2-5]levels$/.test(how)) showLevels(Number(how[4]));
  hideAllDrawers();
}

// Plain lists

interface Item {
  line: number;
  start: number;
  indent: number;
  bullet: string;
  bulletAt: number;
  /** Where the item's text starts, after the bullet and its spaces. */
  contentAt: number;
  /** The column the item's text starts at, which its later lines line up with. */
  contentColumn: number;
  checkbox?: string;
  checkboxAt?: number;
}

const ITEM = /^([ \t]*)([-+*]|\d+[.)])([ \t]+|$)/;

function parseItem(line: number): Item | undefined {
  if (line < 0 || line >= ember.lineCount()) return undefined;
  const text = ember.lineText(line);
  const m = ITEM.exec(text);
  if (!m || (m[1] === "" && m[2] === "*")) return undefined;
  const contentIndex = m[0].length;
  const item: Item = {
    line,
    start: ember.lineStart(line),
    indent: indentation(text),
    bullet: m[2],
    bulletAt: at(line, text, m[1].length),
    contentAt: at(line, text, contentIndex),
    contentColumn: indentation(m[1]) + m[2].length + Math.max(1, m[3].length),
  };
  const box = /^\[([ X-])\](?=[ \t]|$)/.exec(text.slice(contentIndex));
  if (box) {
    item.checkbox = box[1];
    item.checkboxAt = at(line, text, contentIndex);
  }
  return item;
}

/** The last line of an item: its own text and the items under it, up to a line no deeper than it. */
function itemLastLine(item: Item): number {
  let last = item.line;
  let blanks = 0;
  for (let l = item.line + 1; l < ember.lineCount(); l++) {
    const text = ember.lineText(l);
    if (isBlank(text)) {
      if (++blanks >= 2) break;
      continue;
    }
    blanks = 0;
    if (isHeadingLine(text) || indentation(text) <= item.indent) break;
    last = l;
  }
  return last;
}

/** The innermost item a line is part of. */
function itemAtLine(line: number): Item | undefined {
  for (let l = line; l >= 0; l--) {
    const text = ember.lineText(l);
    if (isHeadingLine(text)) return undefined;
    const item = parseItem(l);
    if (item && itemLastLine(item) >= line && (l === line || isBlank(ember.lineText(line)) || indentation(ember.lineText(line)) > item.indent)) {
      return item;
    }
    if (!isBlank(text) && indentation(text) === 0 && !item) return undefined;
  }
  return undefined;
}

/** The item on point's line, if the line starts one. */
function itemHere(): Item | undefined {
  return parseItem(lineAt());
}

function previousSibling(item: Item): Item | undefined {
  for (let l = item.line - 1; l >= 0; l--) {
    const text = ember.lineText(l);
    if (isBlank(text)) continue;
    if (isHeadingLine(text)) return undefined;
    const other = parseItem(l);
    const depth = indentation(text);
    if (depth < item.indent) return undefined;
    if (depth === item.indent) return other && itemLastLine(other) >= item.line - 1 ? other : undefined;
  }
  return undefined;
}

function nextSibling(item: Item): Item | undefined {
  let l = itemLastLine(item) + 1;
  while (l < ember.lineCount() && isBlank(ember.lineText(l)) && l - itemLastLine(item) < 2) l++;
  const other = parseItem(l);
  return other && other.indent === item.indent ? other : undefined;
}

function parentItem(item: Item): Item | undefined {
  for (let l = item.line - 1; l >= 0; l--) {
    const text = ember.lineText(l);
    if (isHeadingLine(text)) return undefined;
    if (isBlank(text)) continue;
    if (indentation(text) < item.indent) {
      const parent = parseItem(l);
      return parent && itemLastLine(parent) >= item.line ? parent : undefined;
    }
  }
  return undefined;
}

/** The items directly under an item. */
function childItems(item: Item): Item[] {
  const last = itemLastLine(item);
  const inside: Item[] = [];
  for (let l = item.line + 1; l <= last; l++) {
    const child = parseItem(l);
    if (child) inside.push(child);
  }
  const level = Math.min(...inside.map((c) => c.indent), Infinity);
  return inside.filter((c) => c.indent === level);
}

/** Every item of the list an item is in, in order. */
function listItems(item: Item): Item[] {
  let first = item;
  for (let prev = previousSibling(first); prev; prev = previousSibling(first)) first = prev;
  const items = [first];
  for (let next = nextSibling(first); next; next = nextSibling(next)) items.push(next);
  return items;
}

/** Where an item's last line ends. */
function itemEnd(item: Item): number {
  return ember.lineEnd(itemLastLine(item));
}

function ordered(bullet: string): boolean {
  return /^\d/.test(bullet);
}

/** Numbers an ordered list's items 1, 2, 3, keeping their style of . or ). */
function renumber(item: Item): void {
  const items = listItems(item);
  if (!ordered(items[0].bullet)) return;
  items.forEach((it, k) => {
    const fresh = parseItem(it.line) ?? it;
    const bullet = `${k + 1}${fresh.bullet.slice(-1)}`;
    if (bullet !== fresh.bullet) replaceText(fresh.bulletAt, fresh.bulletAt + fresh.bullet.length, bullet);
  });
}

/** The bullets S-<right> cycles through: "*" is not allowed at the left margin, where it would make a heading. */
function bulletCycle(item: Item): string[] {
  return ["-", "+", "*", "1.", "1)"].filter((b) => b !== "*" || item.indent > 0);
}

function cycleBullet(direction: number): void {
  const item = itemAtLine(lineAt());
  if (!item) throw new Error("Not in an item");
  const choices = bulletCycle(item);
  const current = ordered(item.bullet) ? `1${item.bullet.slice(-1)}` : item.bullet;
  const k = choices.indexOf(current);
  const next = choices[(((k < 0 ? 0 : k + direction) % choices.length) + choices.length) % choices.length];
  listItems(item).forEach((it, n) => {
    const fresh = parseItem(it.line) ?? it;
    const bullet = ordered(next) ? `${n + 1}${next.slice(-1)}` : next;
    replaceText(fresh.bulletAt, fresh.bulletAt + fresh.bullet.length, bullet);
  });
}

// Checkboxes and statistics cookies

const COOKIE = /\[(\d*\/\d*|\d*%)\]/g;
const HAS_COOKIE = /\[(\d*\/\d*|\d*%)\]/;

function setCheckbox(item: Item, state: string): void {
  if (item.checkboxAt === undefined) return;
  replaceText(item.checkboxAt + 1, item.checkboxAt + 2, state);
}

/** Counts checked boxes among items: [checked, total]. */
function countBoxes(items: Item[]): [number, number] {
  const boxed = items.filter((it) => it.checkbox !== undefined);
  return [boxed.filter((it) => it.checkbox === "X").length, boxed.length];
}

/** Rewrites the statistics cookies on a line, such as [/] or [50%], for a count. */
function writeCookies(line: number, done: number, total: number): void {
  const text = ember.lineText(line);
  const matches = [...text.matchAll(COOKIE)].reverse();
  for (const m of matches) {
    const percent = m[1].endsWith("%");
    const value = percent ? `[${total === 0 ? 0 : Math.floor((100 * done) / total)}%]` : `[${done}/${total}]`;
    const start = at(line, text, m.index ?? 0);
    replaceText(start, start + charCount(m[0]), value);
  }
}

/** The items at the top of an entry's lists, from its heading line up to the next heading. */
function topItems(all: Heading[], i: number): Item[] {
  const endLine = i + 1 < all.length ? all[i + 1].line : ember.lineCount();
  const items: Item[] = [];
  for (let l = all[i].line + 1; l < endLine; l++) {
    const item = parseItem(l);
    if (item) items.push(item);
  }
  const level = Math.min(...items.map((it) => it.indent), Infinity);
  return items.filter((it) => it.indent === level);
}

/**
 * Brings checkboxes and cookies up to date after a box changed: a parent
 * item's box shows [X] when all its children are ticked and [-] when some
 * are, and cookies on parent items and the heading count their boxes.
 */
function updateStatistics(line: number): void {
  for (let item = itemAtLine(line); item; ) {
    const parent = parentItem(item);
    if (!parent) break;
    const fresh = parseItem(parent.line) ?? parent;
    const [done, total] = countBoxes(childItems(fresh));
    if (total > 0) {
      if (fresh.checkbox !== undefined) setCheckbox(fresh, done === total ? "X" : done === 0 ? " " : "-");
      writeCookies(fresh.line, done, total);
    }
    item = parseItem(parent.line);
  }
  const all = headings();
  const i = headingIndex(all, line);
  if (i !== undefined && HAS_COOKIE.test(ember.lineText(all[i].line))) updateHeadingCookies(all, i);
}

/** Counts a heading's checkboxes, or else its children's TODO states, into its cookies. */
function updateHeadingCookies(all: Heading[], i: number): void {
  let [done, total] = countBoxes(topItems(all, i));
  if (total === 0) {
    const end = subtreeEnd(all, i);
    const children = all.slice(i + 1).filter((h) => h.start <= end);
    const level = Math.min(...children.map((h) => h.level), Infinity);
    const states = children.filter((h) => h.level === level && h.todo !== undefined);
    done = states.filter((h) => isDone(h.todo)).length;
    total = states.length;
  }
  writeCookies(all[i].line, done, total);
}

function toggleCheckbox(item: Item): void {
  setCheckbox(item, item.checkbox === " " ? "X" : " ");
  updateStatistics(item.line);
}

// Fontifying

/** Puts a face on a stretch, ahead of the faces already there. */
function face(start: number, end: number, name: string): void {
  if (end > start) ember.addFaceTextProperty(start, end, name);
}

function hide(start: number, end: number): void {
  if (end > start) ember.putTextProperty(start, end, "invisible", "org-link");
}

const LINK = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([^\n]+?)\])?\]/g;
const PLAIN_LINK = /(?:^|(?<=[\s(]))(?:https?|ftp|mailto|file|news|doi):[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g;
const ANGLE_LINK = /<(?:https?|ftp|mailto|file|news|doi):[^>\n]*>/g;
const TIMESTAMP = /[<[]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[>\]](?:--[<[]\d{4}-\d{2}-\d{2}(?: [^\]>\n]*?)?[>\]])?/g;
const EMPHASIS = /(^|[-\s('"{])(([*/_=~+])([^\s]|[^\s].*?[^\s])\3)(?=[-\s.,:!?;'")}[]|$)/g;
const EMPHASIS_FACES: { [marker: string]: string } = {
  "*": "bold",
  "/": "italic",
  _: "underline",
  "=": "org-verbatim",
  "~": "org-code",
  "+": "org-strike-through",
};

/** Styles links, timestamps, emphasis, cookies and footnotes in part of a line. */
function fontifyObjects(line: number, text: string, from: number, to = text.length): void {
  // Matched from `from`, so the stars of a heading cannot start an emphasis.
  const part = text.slice(from, to);
  const pos = (i: number) => at(line, text, i + from);
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);
  for (const m of part.matchAll(LINK)) {
    const i = m.index ?? 0;
    const end = i + m[0].length;
    taken.push([i, end]);
    face(pos(i), pos(end), "org-link");
    if (ember.variable("org-link-descriptive") === true) {
      if (m[2] !== undefined) {
        const desc = i + 2 + m[1].length + 2;
        hide(pos(i), pos(desc));
        hide(pos(desc + m[2].length), pos(end));
      } else {
        hide(pos(i), pos(i + 2));
        hide(pos(end - 2), pos(end));
      }
    }
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of part.matchAll(re)) {
      const i = m.index ?? 0;
      const end = i + m[0].length;
      if (overlaps(i, end)) continue;
      taken.push([i, end]);
      face(pos(i), pos(end), "org-link");
    }
  }
  for (const m of part.matchAll(TIMESTAMP)) {
    const i = m.index ?? 0;
    if (!overlaps(i, i + m[0].length)) face(pos(i), pos(i + m[0].length), "org-date");
  }
  for (const m of part.matchAll(COOKIE)) {
    const i = m.index ?? 0;
    const [a, b] = m[1].endsWith("%") ? [m[1] === "100%" ? 1 : 0, 1] : m[1].split("/").map(Number);
    face(pos(i), pos(i + m[0].length), b > 0 && a === b ? "org-checkbox-statistics-done" : "org-checkbox-statistics-todo");
  }
  for (const m of part.matchAll(/\[fn:[^\]\s]*\]/g)) {
    const i = m.index ?? 0;
    face(pos(i), pos(i + m[0].length), "org-footnote");
  }
  for (const m of part.matchAll(/<<[^<>\n]+>>/g)) {
    const i = m.index ?? 0;
    if (!overlaps(i, i + m[0].length)) face(pos(i), pos(i + m[0].length), "org-target");
  }
  for (const m of part.matchAll(EMPHASIS)) {
    const i = (m.index ?? 0) + m[1].length;
    const end = i + m[2].length;
    if (overlaps(i, end)) continue;
    face(pos(i), pos(end), EMPHASIS_FACES[m[3]]);
  }
}

function fontifyHeading(h: Heading, text: string): void {
  ember.putTextProperty(h.start, h.end, "face", `org-level-${((h.level - 1) % 8) + 1}`);
  if (h.todo !== undefined && h.todoAt !== undefined) {
    const done = isDone(h.todo);
    if (done && ember.variable("org-fontify-done-headline") === true) face(h.todoAt, h.end, "org-headline-done");
    face(h.todoAt, h.todoAt + charCount(h.todo), done ? "org-done" : "org-todo");
  }
  if (h.priorityAt !== undefined) face(h.priorityAt, h.priorityAt + 4, "org-priority");
  if (h.tagsAt !== undefined) face(h.tagsAt, h.end, "org-tag");
  const titleIndex = indexOf(h.line, text, h.titleAt);
  const tagsIndex = h.tagsAt === undefined ? text.length : indexOf(h.line, text, h.tagsAt);
  fontifyObjects(h.line, text, titleIndex, tagsIndex);
}

/** The block a line is inside, by looking back for its #+begin_ line. */
function blockBefore(line: number): string | undefined {
  for (let l = line - 1; l >= 0; l--) {
    const text = ember.lineText(l);
    if (BLOCK_END.test(text)) return undefined;
    const begin = BLOCK_BEGIN.exec(text);
    if (begin) return begin[1].toLowerCase();
    if (isHeadingLine(text)) return undefined;
  }
  return undefined;
}

const KEYWORD = /^([ \t]*#\+(\w+):)(.*)$/;

/** Fontifies whole lines from start to end, for jit-lock-functions. */
function fontify(start: number, end: number): void {
  if (ember.variable("major-mode") !== "org-mode") return;
  const first = ember.lineOf(start);
  const from = ember.lineStart(first);
  ember.removeTextProperty(from, end, "face");
  ember.removeTextProperty(from, end, "invisible");
  const keywords = allKeywords();
  let block = blockBefore(first);
  for (let line = first; line < ember.lineCount() && ember.lineStart(line) < Math.max(end, from + 1); line++) {
    const text = ember.lineText(line);
    const ls = ember.lineStart(line);
    const le = ember.lineEnd(line);
    if (block !== undefined) {
      if (BLOCK_END.test(text)) {
        face(ls, le, "org-block-end-line");
        block = undefined;
      } else {
        face(ls, le, block === "quote" ? "org-quote" : block === "verse" ? "org-verse" : "org-block");
      }
      continue;
    }
    const begin = BLOCK_BEGIN.exec(text);
    if (begin) {
      face(ls, le, "org-block-begin-line");
      block = begin[1].toLowerCase();
      continue;
    }
    const heading = text.startsWith("*") ? parseHeading(line, keywords) : undefined;
    if (heading) {
      fontifyHeading(heading, text);
      continue;
    }
    const keyword = KEYWORD.exec(text);
    if (keyword) {
      const name = keyword[2].toUpperCase();
      const keyEnd = ls + charCount(keyword[1]);
      if (name === "TITLE") {
        face(ls, keyEnd, "org-document-info-keyword");
        face(keyEnd, le, "org-document-title");
      } else if (name === "AUTHOR" || name === "DATE" || name === "EMAIL") {
        face(ls, keyEnd, "org-document-info-keyword");
        face(keyEnd, le, "org-document-info");
      } else {
        face(ls, le, "org-meta-line");
      }
      continue;
    }
    if (/^[ \t]*#( |$)/.test(text)) {
      face(ls, le, "font-lock-comment-face");
      continue;
    }
    if (/^[ \t]*\|/.test(text)) {
      face(ls + indentation(text), le, "org-table");
      continue;
    }
    if (DRAWER.test(text)) {
      face(ls + indentation(text), le, "org-drawer");
      continue;
    }
    const property = /^([ \t]*:[\w-]+\+?:)([ \t].*)?$/.exec(text);
    if (property) {
      const keyEnd = ls + charCount(property[1]);
      face(ls + indentation(text), keyEnd, "org-special-keyword");
      face(keyEnd, le, "org-property-value");
      continue;
    }
    for (const m of text.matchAll(/(?:^|[ \t])((?:SCHEDULED|DEADLINE|CLOSED):)/g)) {
      const i = (m.index ?? 0) + m[0].length - m[1].length;
      face(at(line, text, i), at(line, text, i + m[1].length), "org-special-keyword");
    }
    const item = parseItem(line);
    let objectsFrom = 0;
    if (item) {
      if (item.checkboxAt !== undefined) face(item.checkboxAt, item.checkboxAt + 3, "org-checkbox");
      const term = /^(.*?)[ \t]+::(?:[ \t]|$)/.exec(text.slice(indexOf(line, text, item.contentAt)));
      if (term && !ordered(item.bullet)) {
        const termStart = item.checkboxAt !== undefined ? item.checkboxAt + 4 : item.contentAt;
        face(termStart, item.contentAt + charCount(term[1]), "org-list-dt");
      }
      objectsFrom = indexOf(line, text, item.contentAt);
    }
    const footnote = /^\[fn:[^\]\s]+\]/.exec(text);
    if (footnote) face(ls, ls + footnote[0].length, "org-footnote");
    fontifyObjects(line, text, objectsFrom);
  }
}

// Indentation

/** The column org-indent-line gives a line, or undefined to leave it be. */
function expectedIndentation(line: number): number | undefined {
  const text = ember.lineText(line);
  if (isHeadingLine(text) || blockBefore(line) !== undefined) return undefined;
  let prev = line - 1;
  while (prev >= 0 && isBlank(ember.lineText(prev))) prev--;
  if (prev < 0 || isHeadingLine(ember.lineText(prev))) return 0;
  const item = itemAtLine(prev);
  if (item && (isBlank(text) || indentation(text) > item.indent) && parseItem(line) === undefined) {
    return item.contentColumn;
  }
  return indentation(ember.lineText(prev));
}

/** Indents a line as org-indent-line does, keeping point in the text or after the indentation. */
function indentLine(line: number): void {
  const want = expectedIndentation(line);
  if (want === undefined) return;
  const text = ember.lineText(line);
  const ls = ember.lineStart(line);
  const current = charCount(/^[ \t]*/.exec(text)?.[0] ?? "");
  const p = ember.point();
  const inIndentation = p - ls <= current && lineAt(p) === line;
  if (indentation(text) !== want || text.slice(0, current).includes("\t")) {
    replaceText(ls, ls + current, " ".repeat(want));
  }
  if (inIndentation) ember.gotoChar(ls + want);
}

// Commands: visibility

const cycle = ember.defineCommand({
  name: "org-cycle",
  doc:
    "TAB in Org: fold and unfold.\n\n" +
    "On a heading, cycle its subtree: folded, then its text and its children's headings, then everything. " +
    "On a list item with items under it, the same for the item. On a drawer or block line, fold or unfold it. " +
    "In a table, move to the next field. Anywhere else, indent the line. " +
    "With C-u, cycle the whole buffer as S-TAB does.",
  run: () => {
    const prefix = ember.prefixArg();
    if (Array.isArray(prefix) && prefix[0] === 4) {
      globalCycle();
      return;
    }
    const line = lineAt();
    const text = ember.lineText(line);
    if (/^[ \t]*\|/.test(text)) {
      ember.call("org-table-next-field");
      return;
    }
    const here = headingHere();
    if (here) {
      cycleHeading(...here);
      return;
    }
    if ((DRAWER.test(text) && !/^[ \t]*:END:/i.test(text)) || BLOCK_BEGIN.test(text)) {
      if (toggleDrawerOrBlock(line)) return;
    }
    const item = itemHere();
    if (item && itemLastLine(item) > item.line) {
      cycleItem(item);
      return;
    }
    indentLine(line);
  },
});

function cycleItem(item: Item): void {
  const eol = ember.lineEnd(item.line);
  const end = itemEnd(item);
  const again = ember.lastCommand() === ember.thisCommand();
  if (folded(eol)) {
    flag(eol, end, false);
    const children = childItems(item);
    for (const child of children) flag(ember.lineEnd(child.line), itemEnd(child), true);
    if (children.some((c) => itemLastLine(c) > c.line)) {
      ember.message("CHILDREN");
      ember.setVariable("org-cycle-subtree-status", "children");
      return;
    }
  } else if (!(again && ember.variable("org-cycle-subtree-status") === "children")) {
    flag(eol, end, true);
    ember.message("FOLDED");
    ember.setVariable("org-cycle-subtree-status", "folded");
    return;
  }
  flag(eol, end, false);
  ember.message("SUBTREE");
  ember.setVariable("org-cycle-subtree-status", "subtree");
}

const shiftTab = ember.defineCommand({
  name: "org-shifttab",
  doc:
    "S-TAB in Org: cycle the whole buffer between its top headings, all its headings and everything.\n\n" +
    "In a table, move to the previous field. With a number as prefix argument, show that many levels of headings.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) {
      ember.call("org-table-previous-field");
      return;
    }
    const prefix = ember.prefixArg();
    if (typeof prefix === "number") {
      showLevels(prefix);
      ember.message(`Content view to level: ${prefix}`);
      return;
    }
    globalCycle();
  },
});

ember.defineCommand({
  name: "org-global-cycle",
  doc: "Cycle the whole buffer: top headings only, then all headings, then everything.",
  run: () => globalCycle(),
});

ember.defineCommand({
  name: "org-overview",
  doc: "Show only the top headings.",
  run: () => overview(),
});

ember.defineCommand({
  name: "org-content",
  doc: "Show all headings, hiding the text under them.",
  run: () => contents(),
});

ember.defineCommand({
  name: "org-show-all",
  doc: "Show everything, drawers and blocks included.",
  run: () => {
    for (const spec of ["outline", "org-hide-drawer", "org-hide-block"]) flag(0, ember.bufferSize(), false, spec);
  },
});

ember.defineCommand({
  name: "org-indent-line",
  doc: "Indent the line: text under a heading to the left margin, a list item's lines to its text, others as the line before.",
  run: () => indentLine(lineAt()),
});

const orgReturn = ember.defineCommand({
  name: "org-return",
  doc: "RET in Org: in a table, move to the next row; elsewhere start a new line, indented as org-indent-line does.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) {
      ember.call("org-table-next-row");
      return;
    }
    for (let n = Math.max(1, ember.prefixNumericValue()); n > 0; n--) ember.insert("\n");
    indentLine(lineAt());
  },
});

// Commands: moving between headings

ember.defineCommand({
  name: "org-end-of-line",
  doc: "Move to the end of the line, staying on a folded heading's line rather than going past its hidden text.",
  run: () => {
    const n = ember.prefixNumericValue();
    if (n !== 1) ember.callWithPrefix(n - 1, "next-line");
    ember.gotoChar(ember.lineEnd(lineAt()));
  },
});

function visible(h: Heading): boolean {
  return h.start === 0 || !ember.invisibleAt(h.start - 1);
}

const nextHeading = ember.defineCommand({
  name: "org-next-visible-heading",
  doc: "Move to the next heading that is not hidden, or to the end of the buffer.",
  run: () => {
    for (let n = ember.prefixNumericValue(); n > 0; n--) {
      const line = lineAt();
      const next = headings().find((h) => h.line > line && visible(h));
      ember.gotoChar(next ? next.start : ember.bufferSize());
    }
  },
});

const previousHeading = ember.defineCommand({
  name: "org-previous-visible-heading",
  doc: "Move to the previous heading that is not hidden, or to the start of the buffer.",
  run: () => {
    for (let n = ember.prefixNumericValue(); n > 0; n--) {
      const from = ember.lineStart(lineAt());
      const prev = headings()
        .filter((h) => h.start < from && visible(h))
        .at(-1);
      ember.gotoChar(prev ? prev.start : 0);
    }
  },
});

/** The sibling `by` headings on from heading i, skipping deeper ones, if any. */
function sibling(all: Heading[], i: number, by: number): number | undefined {
  const level = all[i].level;
  for (let j = i + by; j >= 0 && j < all.length; j += by) {
    if (all[j].level < level) return undefined;
    if (all[j].level === level) return j;
  }
  return undefined;
}

const forwardSameLevel = ember.defineCommand({
  name: "org-forward-heading-same-level",
  doc: "Move to the next heading at the same level, under the same parent.",
  run: () => {
    const [all, i] = backToHeading();
    const j = sibling(all, i, 1);
    ember.gotoChar(j === undefined ? all[i].start : all[j].start);
  },
});

const backwardSameLevel = ember.defineCommand({
  name: "org-backward-heading-same-level",
  doc: "Move to the previous heading at the same level, under the same parent.",
  run: () => {
    const [all, i] = backToHeading();
    const j = all[i].line === lineAt() ? sibling(all, i, -1) : i;
    ember.gotoChar(j === undefined ? all[i].start : all[j].start);
  },
});

const markSubtree = ember.defineCommand({
  name: "org-mark-subtree",
  doc: "Make the region the subtree point is in: point at its heading, the mark at its end.",
  run: () => {
    const [all, i] = backToHeading();
    const [start, end] = subtreeRegion(all, i);
    ember.gotoChar(start);
    ember.setMark(end);
    ember.activateMark();
  },
});

// Commands: inserting headings and items

function blankLineAt(line: number): boolean {
  return line < ember.lineCount() && ember.lineText(line) === "";
}

/** Inserts a heading as org-insert-heading does, leaving point after its stars. */
function insertHeading(todo: boolean, respectContent: boolean): void {
  const all = headings();
  const line = lineAt();
  const i = headingIndex(all, line);
  const stars = "*".repeat(i === undefined ? 1 : all[i].level);
  const keyword = todo ? (todoSets()[0]?.todo[0] ?? todoSets()[0]?.done[0] ?? "TODO") + " " : "";
  const head = `${stars} ${keyword}`;
  const p = ember.point();
  if (respectContent && i !== undefined) {
    const end = subtreeEnd(all, i);
    flag(all[i].end, end, false);
    ember.gotoChar(end);
    if (end === ember.bufferSize() && (end === 0 || ember.bufferText(end - 1, end) === "\n")) {
      ember.insert(`${head}\n`);
      ember.gotoChar(end + charCount(head));
    } else ember.insert(`\n${head}`);
    return;
  }
  const ls = ember.lineStart(line);
  const le = ember.lineEnd(line);
  const split = ember.variable("org-M-RET-may-split-line") === true;
  if (i !== undefined && all[i].line === line) {
    const h = all[i];
    if (p === ls) {
      ember.insert(`${head}\n`);
      ember.gotoChar(ls + charCount(head));
      return;
    }
    const wasFolded = folded(h.end);
    if (wasFolded) flag(h.end, subtreeEnd(all, i), false);
    if (split && p < le) {
      const rest = ember.deleteRegion(p, le);
      ember.gotoChar(p);
      ember.insert(`\n${head}${rest}`);
    } else {
      ember.gotoChar(le);
      ember.insert(`\n${head}`);
    }
    if (wasFolded) {
      const after = ember.point();
      const fresh = headings();
      const j = headingIndex(fresh, lineAt());
      if (j !== undefined) showChildren(fresh, j);
      ember.gotoChar(after);
    }
    return;
  }
  if (blankLineAt(line)) {
    ember.gotoChar(ls);
    ember.insert(head);
  } else if (p === ls) {
    ember.insert(`${head}\n`);
    ember.gotoChar(ls + charCount(head));
  } else if (split || p === le) {
    ember.insert(`\n${head}`);
  } else {
    ember.gotoChar(le);
    ember.insert(`\n${head}`);
  }
}

/** Inserts an item after the one at point, as org-insert-item does. */
function insertItem(item: Item, checkbox: boolean): void {
  const p = ember.point();
  const indent = " ".repeat(item.indent);
  const box = checkbox ? "[ ] " : "";
  const bullet = ordered(item.bullet) ? item.bullet : item.bullet;
  const head = `${indent}${bullet} ${box}`;
  const ls = ember.lineStart(item.line);
  const le = ember.lineEnd(item.line);
  if (p <= item.bulletAt && p >= ls) {
    ember.gotoChar(ls);
    ember.insert(`${head}\n`);
    ember.gotoChar(ls + charCount(head));
  } else if (p < le && ember.variable("org-M-RET-may-split-line") === true) {
    // The rest of the line goes to the new item, without the spaces before it.
    const rest = ember.deleteRegion(p, le).trimStart();
    ember.gotoChar(p);
    ember.insert(`\n${head}`);
    const after = ember.point();
    ember.insert(rest);
    ember.gotoChar(after);
  } else {
    ember.gotoChar(le);
    ember.insert(`\n${head}`);
  }
  const fresh = parseItem(lineAt());
  if (fresh) renumber(fresh);
  const now = parseItem(lineAt());
  if (now) ember.gotoChar(now.contentAt + (checkbox ? 4 : 0));
}

const metaReturn = ember.defineCommand({
  name: "org-meta-return",
  doc:
    "M-RET in Org: insert a heading at the level of the one point is under, or an item in a list.\n\n" +
    "At the start of a line it goes before it; in the middle, the rest of the line goes to the new heading " +
    "(org-M-RET-may-split-line); at the end, after it.",
  run: () => {
    const item = itemAtLine(lineAt());
    if (item && !isHeadingLine(ember.lineText(lineAt()))) insertItem(item, false);
    else insertHeading(false, false);
  },
});

ember.defineCommand({
  name: "org-insert-heading",
  doc: "Insert a heading at the level of the one point is under. See org-meta-return.",
  run: () => insertHeading(false, false),
});

const respectContent = ember.defineCommand({
  name: "org-insert-heading-respect-content",
  doc: "Insert a heading after the subtree point is in, at its level.",
  run: () => insertHeading(false, true),
});

const todoHeading = ember.defineCommand({
  name: "org-insert-todo-heading",
  doc: "Insert a heading with the first TODO state, as M-RET does; in a list, an item with a checkbox.",
  run: () => {
    const item = itemAtLine(lineAt());
    if (item && !isHeadingLine(ember.lineText(lineAt()))) insertItem(item, true);
    else insertHeading(true, false);
  },
});

const todoHeadingRespectContent = ember.defineCommand({
  name: "org-insert-todo-heading-respect-content",
  doc: "Insert a heading with the first TODO state after the subtree point is in.",
  run: () => insertHeading(true, true),
});

ember.defineCommand({
  name: "org-insert-item",
  doc: "Insert an item in the list point is in, after the item point is in.",
  run: () => {
    const item = itemAtLine(lineAt());
    if (!item) throw new Error("Not in an item");
    insertItem(item, false);
  },
});

// Commands: promoting, demoting and moving

function changeLevel(h: Heading, by: number): void {
  if (h.level + by < 1) throw new Error("Cannot promote to level 0.  UNDO to recover if necessary");
  const p = ember.point();
  const stars = "*".repeat(h.level + by);
  ember.deleteRegion(h.start, h.start + h.level);
  ember.gotoChar(h.start);
  ember.insert(stars);
  ember.gotoChar(p > h.start + Math.min(h.level, h.level + by) ? Math.max(h.start, p + by) : p);
  if (h.tags.length > 0) alignTags(h.line);
}

function changeSubtreeLevel(by: number): void {
  const [all, i] = backToHeading();
  const end = subtreeRegion(all, i)[1];
  const inside = all.filter((h, k) => k >= i && h.start < end);
  if (inside.some((h) => h.level + by < 1)) throw new Error("Cannot promote to level 0.  UNDO to recover if necessary");
  for (const h of [...inside].reverse()) changeLevel(parseHeading(h.line) ?? h, by);
}

function headingsInRegion(): Heading[] | undefined {
  if (!ember.regionActive()) return undefined;
  const mark = ember.mark() ?? ember.point();
  const [from, to] = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
  const inside = headings().filter((h) => h.start >= ember.lineStart(lineAt(from)) && h.start < to);
  return inside.length > 0 ? inside : undefined;
}

ember.defineCommand({
  name: "org-do-promote",
  doc: "Make the heading point is on one level higher: one star fewer.",
  run: () => {
    const region = headingsInRegion();
    if (region) {
      for (const h of [...region].reverse()) changeLevel(parseHeading(h.line) ?? h, -1);
      return;
    }
    const [all, i] = backToHeading();
    changeLevel(all[i], -1);
  },
});

ember.defineCommand({
  name: "org-do-demote",
  doc: "Make the heading point is on one level lower: one star more.",
  run: () => {
    const region = headingsInRegion();
    if (region) {
      for (const h of [...region].reverse()) changeLevel(parseHeading(h.line) ?? h, 1);
      return;
    }
    const [all, i] = backToHeading();
    changeLevel(all[i], 1);
  },
});

ember.defineCommand({
  name: "org-promote-subtree",
  doc: "Make the subtree point is in one level higher.",
  run: () => changeSubtreeLevel(-1),
});

ember.defineCommand({
  name: "org-demote-subtree",
  doc: "Make the subtree point is in one level lower.",
  run: () => changeSubtreeLevel(1),
});

/** Ensures the buffer ends with a newline, so whole lines can move. */
function endWithNewline(): void {
  const size = ember.bufferSize();
  if (size > 0 && ember.bufferText(size - 1, size) !== "\n") {
    const p = ember.point();
    ember.gotoChar(size);
    ember.insert("\n");
    ember.gotoChar(p);
  }
}

/**
 * Moves the text from start to end so it begins at `to`, which is outside
 * it, keeping point's offset into it and folding it again if it was.
 */
function moveText(start: number, end: number, to: number, refold?: (start: number) => void): void {
  const offset = ember.point() - start;
  const text = ember.deleteRegion(start, end);
  const target = to > start ? to - (end - start) : to;
  ember.gotoChar(target);
  ember.insert(text);
  ember.gotoChar(target + offset);
  refold?.(target);
}

function moveSubtree(by: number): void {
  endWithNewline();
  const [all, i] = backToHeading();
  const j = sibling(all, i, by);
  if (j === undefined) throw new Error("Cannot move past superior level or buffer limit");
  const [start, end] = subtreeRegion(all, i);
  const wasFolded = folded(all[i].end);
  const to = by > 0 ? subtreeRegion(all, j)[1] : all[j].start;
  moveText(start, end, to, (at) => {
    if (!wasFolded) return;
    const fresh = headings();
    const k = headingIndex(fresh, lineAt(at));
    if (k !== undefined) flag(fresh[k].end, subtreeEnd(fresh, k), true);
  });
}

ember.defineCommand({
  name: "org-move-subtree-up",
  doc: "Swap the subtree point is in with the one before it at the same level.",
  run: () => moveSubtree(-1),
});

ember.defineCommand({
  name: "org-move-subtree-down",
  doc: "Swap the subtree point is in with the one after it at the same level.",
  run: () => moveSubtree(1),
});

/** Changes the indentation of lines, keeping point with the text. */
function reindentLines(first: number, last: number, by: number): void {
  for (let l = first; l <= last; l++) {
    const text = ember.lineText(l);
    if (isBlank(text)) continue;
    const ls = ember.lineStart(l);
    const current = charCount(/^[ \t]*/.exec(text)?.[0] ?? "");
    replaceText(ls, ls + current, " ".repeat(Math.max(0, indentation(text) + by)));
  }
}

function indentItem(direction: number, tree: boolean): void {
  const item = itemHere();
  if (!item) throw new Error("Not at an item");
  const children = childItems(item);
  const last = tree ? itemLastLine(item) : children.length > 0 ? children[0].line - 1 : itemLastLine(item);
  if (direction > 0) {
    const prev = previousSibling(item);
    if (!prev) {
      if (!tree || parentItem(item)) throw new Error("At first item: use S-M-<left/right> to move the whole list");
      const list = listItems(item);
      reindentLines(list[0].line, itemLastLine(list.at(-1) ?? item), 2);
      return;
    }
    reindentLines(item.line, last, prev.contentColumn - item.indent);
  } else {
    if (!tree && children.length > 0) throw new Error("Cannot outdent an item without its children");
    const parent = parentItem(item);
    if (!parent && item.indent === 0) throw new Error("Cannot outdent beyond margin");
    reindentLines(item.line, last, (parent ? parent.indent : 0) - item.indent);
  }
}

ember.defineCommand({
  name: "org-indent-item",
  doc: "Make the item point is on a child of the item before it.",
  run: () => indentItem(1, false),
});
ember.defineCommand({
  name: "org-outdent-item",
  doc: "Make the item point is on a sibling of its parent.",
  run: () => indentItem(-1, false),
});
ember.defineCommand({
  name: "org-indent-item-tree",
  doc: "Make the item point is on, with the items under it, a child of the item before it.",
  run: () => indentItem(1, true),
});
ember.defineCommand({
  name: "org-outdent-item-tree",
  doc: "Make the item point is on, with the items under it, a sibling of its parent.",
  run: () => indentItem(-1, true),
});

function moveItem(by: number): void {
  endWithNewline();
  const item = itemHere();
  if (!item) throw new Error("Not at an item");
  const other = by > 0 ? nextSibling(item) : previousSibling(item);
  if (!other) throw new Error(`Cannot move this item further ${by > 0 ? "down" : "up"}`);
  const start = item.start;
  const end = Math.min(itemEnd(item) + 1, ember.bufferSize());
  const to = by > 0 ? Math.min(itemEnd(other) + 1, ember.bufferSize()) : other.start;
  moveText(start, end, to);
  const moved = parseItem(lineAt());
  if (moved) renumber(moved);
}

ember.defineCommand({
  name: "org-move-item-up",
  doc: "Swap the item point is on with the one before it.",
  run: () => moveItem(-1),
});
ember.defineCommand({
  name: "org-move-item-down",
  doc: "Swap the item point is on with the one after it.",
  run: () => moveItem(1),
});

ember.defineCommand({
  name: "org-previous-item",
  doc: "Move to the item before the one point is in.",
  run: () => {
    const item = itemAtLine(lineAt());
    const prev = item && previousSibling(item);
    if (!prev) throw new Error("On first item");
    ember.gotoChar(prev.start);
  },
});

ember.defineCommand({
  name: "org-next-item",
  doc: "Move to the item after the one point is in.",
  run: () => {
    const item = itemAtLine(lineAt());
    const next = item && nextSibling(item);
    if (!next) throw new Error("On last item");
    ember.gotoChar(next.start);
  },
});

ember.defineCommand({
  name: "org-cycle-list-bullet",
  doc: "Change the bullets of the list point is in to the next kind: -, +, *, 1. and 1).",
  run: () => cycleBullet(1),
});

// Subtrees and the kill ring

function copySubtree(cut: boolean): void {
  const [all, i] = backToHeading();
  const [start, end] = subtreeRegion(all, i);
  const mark = ember.mark() ?? null;
  ember.setMark(end);
  ember.gotoChar(start);
  ember.call(cut ? "kill-region" : "kill-ring-save");
  ember.setMark(mark === null ? null : Math.min(mark, ember.bufferSize()));
}

ember.defineCommand({
  name: "org-cut-subtree",
  doc: "Kill the subtree point is in, so C-c C-x C-y or C-y can put it back.",
  run: () => copySubtree(true),
});

ember.defineCommand({
  name: "org-copy-subtree",
  doc: "Copy the subtree point is in to the kill ring.",
  run: () => copySubtree(false),
});

ember.defineCommand({
  name: "org-paste-subtree",
  doc: "Yank a subtree, changing its levels to fit under the heading point is under, as a sibling.",
  run: () => {
    const text = ember.currentKill();
    if (text === undefined) throw new Error("Kill ring is empty");
    const top = /^(\*+) /m.exec(text);
    const all = headings();
    const i = headingIndex(all, lineAt());
    const by = top && i !== undefined ? all[i].level - top[1].length : 0;
    const fixed = by === 0 ? text : text.replace(/^(\*+) /gm, (_, stars: string) => `${"*".repeat(Math.max(1, stars.length + by))} `);
    const line = lineAt();
    const at = i !== undefined ? subtreeRegion(all, i)[1] : ember.lineStart(line);
    endWithNewline();
    ember.gotoChar(at);
    ember.insert(fixed.endsWith("\n") ? fixed : `${fixed}\n`);
    ember.gotoChar(at);
  },
});

// Commands: TODO states, priorities and tags

/** Changes a heading's TODO state, keeping point in place relative to the text around it. */
function setTodo(h: Heading, state: string | undefined): void {
  if (h.todo !== undefined && h.todoAt !== undefined) {
    const end = h.todoAt + charCount(h.todo);
    if (state === undefined) {
      const after = ember.bufferText(end, end + 1) === " " ? end + 1 : end;
      replaceText(h.todoAt, after, "");
    } else {
      replaceText(h.todoAt, end, state);
    }
  } else if (state !== undefined) {
    const at = h.start + h.level + 1;
    const rest = ember.bufferText(at, h.end);
    replaceText(at, at, rest === "" ? state : `${state} `);
  }
}

/** The state after one in a direction, wrapping round through no state. */
function nextState(current: string | undefined, direction: number): string | undefined {
  const sets = todoSets();
  if (sets.length === 0) return undefined;
  if (current === undefined) {
    const set = sets[0];
    const states = [...set.todo, ...set.done];
    return direction > 0 ? states[0] : states.at(-1);
  }
  const set = sets.find((s) => s.todo.includes(current) || s.done.includes(current)) ?? sets[0];
  const states = [...set.todo, ...set.done];
  const k = states.indexOf(current) + direction;
  return k >= 0 && k < states.length ? states[k] : undefined;
}

function todo(direction: number, state?: string): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const before = h.todo;
  let next = state === undefined ? nextState(before, direction) : state === "" ? undefined : state;
  if (next !== undefined && isDone(next) && !isDone(before)) {
    const repeated = repeatEntry(h);
    if (repeated) next = before !== undefined && !isDone(before) ? before : todoSets()[0]?.todo[0];
  }
  setTodo(h, next);
  const fresh = parseHeading(h.line);
  if (fresh && fresh.tags.length > 0) alignTags(h.line);
  if (ember.variable("org-log-done") === "time") {
    if (isDone(next) && !isDone(before)) setPlanning(h.line, "CLOSED", `[${formatTimestamp(today(true), true)}]`);
    else if (!isDone(next) && isDone(before)) setPlanning(h.line, "CLOSED", undefined);
  }
  const parent = all.slice(0, i).reverse().find((p) => p.level < h.level);
  if (parent) {
    const fresh = headings();
    const k = fresh.findIndex((x) => x.line === parent.line);
    if (k >= 0 && HAS_COOKIE.test(ember.lineText(parent.line))) updateHeadingCookies(fresh, k);
  }
}

const todoCommand = ember.defineCommand({
  name: "org-todo",
  doc:
    "Change the TODO state of the heading point is under to the next one: none, TODO, DONE and back to none.\n\n" +
    "The states are org-todo-keywords, or a #+TODO: line's. Marking an entry done whose SCHEDULED or DEADLINE " +
    "date repeats, such as <2026-10-28 Wed +1w>, moves the date on and keeps it to do.",
  run: () => todo(1),
});

ember.defineCommand({
  name: "org-todo-set",
  doc: "Set the TODO state of the heading point is under, or remove it with an empty state.",
  params: [{ name: "state", prompt: "TODO state: " }],
  run: (state) => todo(1, state),
});

function priority(direction: number): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const highest = String(ember.variable("org-priority-highest") ?? "A").charCodeAt(0);
  const lowest = String(ember.variable("org-priority-lowest") ?? "C").charCodeAt(0);
  const fallback = String(ember.variable("org-priority-default") ?? "B");
  let next: string | undefined;
  if (h.priority === undefined) next = fallback;
  else {
    const code = h.priority.charCodeAt(0) - direction;
    next = code < highest || code > lowest ? undefined : String.fromCharCode(code);
  }
  if (h.priorityAt !== undefined) {
    const end = h.priorityAt + 4;
    if (next === undefined) replaceText(h.priorityAt, ember.bufferText(end, end + 1) === " " ? end + 1 : end, "");
    else replaceText(h.priorityAt, end, `[#${next}]`);
  } else {
    const at = h.todoAt !== undefined ? h.todoAt + charCount(h.todo ?? "") + 1 : h.start + h.level + 1;
    const rest = ember.bufferText(Math.min(at, h.end), h.end);
    if (at > h.end) replaceText(h.end, h.end, ` [#${next}]`);
    else replaceText(at, at, rest === "" ? `[#${next}]` : `[#${next}] `);
  }
  if (h.tags.length > 0) alignTags(h.line);
}

ember.defineCommand({
  name: "org-priority-up",
  doc: "Raise the priority of the heading point is under: none starts at the default, and above the highest is none.",
  run: () => priority(1),
});

ember.defineCommand({
  name: "org-priority-down",
  doc: "Lower the priority of the heading point is under: none starts at the default, and below the lowest is none.",
  run: () => priority(-1),
});

ember.defineCommand({
  name: "org-priority",
  doc: "Set the priority of the heading point is under to a letter, or remove it with SPC or an empty answer.",
  params: [{ name: "priority", prompt: "Priority A-C, SPC to remove: " }],
  run: (answer) => {
    const [all, i] = backToHeading();
    const h = all[i];
    const letter = answer.trim().toUpperCase();
    if (h.priorityAt !== undefined) {
      const end = h.priorityAt + 4;
      replaceText(h.priorityAt, letter === "" ? (ember.bufferText(end, end + 1) === " " ? end + 1 : end) : end, letter === "" ? "" : `[#${letter}]`);
    } else if (letter !== "") {
      const at = h.todoAt !== undefined ? h.todoAt + charCount(h.todo ?? "") + 1 : h.start + h.level + 1;
      replaceText(Math.min(at, h.end), Math.min(at, h.end), at > h.end ? ` [#${letter}]` : `[#${letter}] `);
    }
  },
});

/** Puts a heading's tags at org-tags-column, or a space after the title if it is too long. */
function alignTags(line: number): void {
  const h = parseHeading(line);
  if (!h || h.tagsAt === undefined) return;
  const text = ember.lineText(line);
  const tags = `:${h.tags.join(":")}:`;
  const before = text.slice(0, indexOf(line, text, h.tagsAt)).trimEnd();
  const column = Number(ember.variable("org-tags-column") ?? -77);
  const width = ember.stringWidth(before);
  const pad = column < 0 ? Math.max(1, -column - width - ember.stringWidth(tags)) : Math.max(1, column - width);
  const start = ember.lineStart(line) + charCount(before);
  replaceText(start, ember.lineEnd(line), " ".repeat(pad) + tags);
}

function setTags(tags: string[]): void {
  const [all, i] = backToHeading();
  const h = all[i];
  if (h.tagsAt !== undefined) {
    const text = ember.lineText(h.line);
    const before = text.slice(0, indexOf(h.line, text, h.tagsAt)).trimEnd();
    replaceText(h.start + charCount(before), h.end, "");
  }
  if (tags.length === 0) return;
  const end = ember.lineEnd(h.line);
  replaceText(end, end, ` :${tags.join(":")}:`);
  alignTags(h.line);
}

const setTagsCommand = ember.defineCommand({
  name: "org-set-tags-command",
  doc: "Set the tags of the heading point is under, written as :work:home: or work home; empty removes them.",
  params: [{ name: "tags", prompt: "Tags: ", history: "org-tags-history" }],
  run: (answer) => setTags(answer.split(/[:\s,]+/).filter((t) => t !== "")),
});

ember.defineVariable({ name: "org-tags-history", doc: "Tags answered to org-set-tags-command, newest first.", value: [] });

ember.defineCommand({
  name: "org-align-tags",
  doc: "Put the tags of the heading point is under at org-tags-column; with a prefix argument, every heading's.",
  run: () => {
    if (ember.prefixArg() !== null) {
      for (const h of headings()) if (h.tags.length > 0) alignTags(h.line);
      return;
    }
    const [all, i] = backToHeading();
    alignTags(all[i].line);
  },
});

// Timestamps

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface DateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

function today(withTime = false): DateTime {
  const now = new Date();
  const d: DateTime = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  if (withTime) {
    d.hour = now.getHours();
    d.minute = now.getMinutes();
  }
  return d;
}

/** A date with its fields carried over, as Emacs's encode-time does: 31 February is 3 March. */
function normalize(d: DateTime): DateTime {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour ?? 0, d.minute ?? 0));
  const out: DateTime = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
  if (d.hour !== undefined) {
    out.hour = t.getUTCHours();
    out.minute = t.getUTCMinutes();
  }
  return out;
}

function weekday(d: DateTime): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

const two = (n: number) => String(n).padStart(2, "0");

/** A timestamp's text without its brackets: 2026-10-28 Wed, or with a time 2026-10-28 Wed 10:00. */
function formatTimestamp(d: DateTime, withTime = d.hour !== undefined): string {
  const date = `${d.year}-${two(d.month)}-${two(d.day)} ${DAYS[weekday(d)]}`;
  return withTime && d.hour !== undefined ? `${date} ${two(d.hour)}:${two(d.minute ?? 0)}` : date;
}

interface Timestamp {
  start: number;
  end: number;
  active: boolean;
  date: DateTime;
  /** What follows the date and time inside the brackets, such as a repeater " +1w". */
  rest: string;
  /** An end time, as in 10:00-11:00. */
  endTime?: [number, number];
  /** Where each part is, as offsets from the start, for S-<up> to know what to change. */
  dayNameEnd: number;
  hourAt?: number;
  minuteAt?: number;
}

const TS = /([<[])(\d{4})-(\d{2})-(\d{2})((?: +[^\]+0-9>\r\n -]+)?)((?: +(\d{1,2}):(\d{2}))?)((?:-(\d{1,2}):(\d{2}))?)([^\]>\n]*)([>\]])/g;

function timestampsOn(line: number): Timestamp[] {
  const text = ember.lineText(line);
  const found: Timestamp[] = [];
  for (const m of text.matchAll(TS)) {
    const i = m.index ?? 0;
    const date: DateTime = { year: Number(m[2]), month: Number(m[3]), day: Number(m[4]) };
    const ts: Timestamp = {
      start: at(line, text, i),
      end: at(line, text, i + m[0].length),
      active: m[1] === "<",
      date,
      rest: m[12],
      dayNameEnd: 11 + m[5].length,
    };
    if (m[7] !== undefined) {
      date.hour = Number(m[7]);
      date.minute = Number(m[8]);
      ts.hourAt = ts.dayNameEnd + (m[6].length - m[6].trimStart().length);
      ts.minuteAt = ts.hourAt + m[7].length + 1;
    }
    if (m[10] !== undefined) ts.endTime = [Number(m[10]), Number(m[11])];
    found.push(ts);
  }
  return found;
}

/** The timestamp point is on or just after, if any. */
function timestampHere(): Timestamp | undefined {
  const p = ember.point();
  return timestampsOn(lineAt()).find((ts) => ts.start <= p && p <= ts.end);
}

function timestampText(ts: Timestamp): string {
  const [open, close] = ts.active ? ["<", ">"] : ["[", "]"];
  let end = "";
  if (ts.endTime) end = `-${two(ts.endTime[0])}:${two(ts.endTime[1])}`;
  return `${open}${formatTimestamp(ts.date)}${end}${ts.rest}${close}`;
}

/** What S-<up> changes, by where point is in a timestamp, as Org's org-at-timestamp-p says. */
function timestampField(ts: Timestamp, p: number): string {
  const rel = p - ts.start;
  const len = ts.end - ts.start;
  const within = (from: number, to: number) => rel >= from && rel <= to;
  if (rel === 0 || rel === len - 1) return "bracket";
  if (within(1, 5)) return "year";
  if (within(6, 8)) return "month";
  if (ts.hourAt !== undefined && within(ts.hourAt, ts.hourAt + 2)) return "hour";
  if (ts.minuteAt !== undefined && within(ts.minuteAt, ts.minuteAt + 2)) return "minute";
  return "day";
}

function changeTimestamp(n: number, what?: string): void {
  const ts = timestampHere();
  if (!ts) throw new Error("Not at a timestamp");
  const p = ember.point();
  const field = what ?? timestampField(ts, p);
  if (field === "bracket") {
    ts.active = !ts.active;
  } else {
    const d = { ...ts.date };
    const step = Number((ember.variable("org-time-stamp-rounding-minutes") as number[] | null)?.[1] ?? 5) || 1;
    const before = (d.hour ?? 0) * 60 + (d.minute ?? 0);
    if (field === "year") d.year += n;
    else if (field === "month") d.month += n;
    else if (field === "day") d.day += n;
    else if (field === "hour") d.hour = (d.hour ?? 0) + n;
    else if (field === "minute") d.minute = Math.round(((d.minute ?? 0) + n * step) / step) * step;
    ts.date = normalize(d);
    if (ts.endTime && (field === "hour" || field === "minute")) {
      const delta = (ts.date.hour ?? 0) * 60 + (ts.date.minute ?? 0) - before;
      const endMinutes = (((ts.endTime[0] * 60 + ts.endTime[1] + delta) % 1440) + 1440) % 1440;
      ts.endTime = [Math.floor(endMinutes / 60), endMinutes % 60];
    }
  }
  ember.deleteRegion(ts.start, ts.end);
  ember.gotoChar(ts.start);
  ember.insert(timestampText(ts));
  ember.gotoChar(Math.min(p, ember.lineEnd(lineAt(ts.start))));
}

for (const [name, n, what, doc] of [
  ["org-timestamp-up", 1, undefined, "Change the part of the timestamp point is on, the year, month, day, hour or minute, one step later."],
  ["org-timestamp-down", -1, undefined, "Change the part of the timestamp point is on one step earlier."],
  ["org-timestamp-up-day", 1, "day", "Move the timestamp point is on a day later."],
  ["org-timestamp-down-day", -1, "day", "Move the timestamp point is on a day earlier."],
] as [string, number, string | undefined, string][]) {
  ember.defineCommand({ name, doc, run: () => changeTimestamp(n * ember.prefixNumericValue(), what) });
}

/**
 * Reads a date as Org's date prompt does, mostly: empty for today; +3 or -2
 * days from today, or +2w, +1m, +1y; 2026-11-03, 11-03 or 3 for the next such
 * date; a weekday such as fri for the next one; and a time such as 10:30.
 */
function parseDate(input: string, withTime = false): DateTime {
  let text = input.trim().toLowerCase();
  const base = today();
  let time: [number, number] | undefined;
  const clock = /(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/.exec(text);
  if (clock) {
    time = [Number(clock[1]), Number(clock[2])];
    text = text.replace(clock[0], " ").trim();
  }
  let d: DateTime;
  let m: RegExpExecArray | null;
  if (text === "" || text === ".") d = base;
  else if ((m = /^([+-])(\d+)([dwmy]?)$/.exec(text))) {
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    const unit = m[3] || "d";
    d = normalize({
      year: base.year + (unit === "y" ? n : 0),
      month: base.month + (unit === "m" ? n : 0),
      day: base.day + (unit === "d" ? n : unit === "w" ? 7 * n : 0),
    });
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) {
    d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  } else if ((m = /^(\d{1,2})-(\d{1,2})$/.exec(text))) {
    d = { year: base.year, month: Number(m[1]), day: Number(m[2]) };
    if (d.month < base.month || (d.month === base.month && d.day < base.day)) d.year += 1;
  } else if ((m = /^(\d{1,2})$/.exec(text))) {
    d = { year: base.year, month: base.month, day: Number(m[1]) };
    if (d.day < base.day) d = normalize({ ...d, month: d.month + 1 });
  } else {
    const k = DAY_NAMES.findIndex((name) => text.length >= 2 && name.startsWith(text));
    if (k < 0) throw new Error(`Cannot read a date from "${input}"`);
    d = normalize({ ...base, day: base.day + ((k - weekday(base) + 7) % 7) });
  }
  if (time) {
    d.hour = time[0];
    d.minute = time[1];
  } else if (withTime) {
    const now = today(true);
    const step = Number((ember.variable("org-time-stamp-rounding-minutes") as number[] | null)?.[0] ?? 0) || 1;
    d.hour = now.hour;
    d.minute = Math.round((now.minute ?? 0) / step) * step;
    d = normalize(d);
  }
  return d;
}

function insertTimestamp(input: string, active: boolean): void {
  const withTime = Array.isArray(ember.prefixArg());
  const date = parseDate(input, withTime);
  const text = active ? `<${formatTimestamp(date)}>` : `[${formatTimestamp(date)}]`;
  const ts = timestampHere();
  if (ts) {
    ember.deleteRegion(ts.start, ts.end);
    ember.gotoChar(ts.start);
  }
  ember.insert(text);
}

const timestamp = ember.defineCommand({
  name: "org-timestamp",
  doc:
    "Insert an active timestamp, such as <2026-10-28 Wed>, for a date read in the minibuffer; on a timestamp, change it.\n\n" +
    "Empty is today; +3 is three days on, and +2w, +1m and +1y work too; fri is the next Friday; " +
    "2026-11-03, 11-03 and 3 are the next such date; add a time as 10:30. With C-u, the time now goes in too.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => insertTimestamp(input, true),
});

const inactiveTimestamp = ember.defineCommand({
  name: "org-timestamp-inactive",
  doc: "Insert an inactive timestamp, such as [2026-10-28 Wed], which the agenda leaves out. See org-timestamp.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => insertTimestamp(input, false),
});

ember.defineVariable({ name: "org-read-date-history", doc: "Dates answered to Org's date prompt, newest first.", value: [] });

/** Sets or, with undefined, removes a planning keyword's timestamp on the line after a heading. */
function setPlanning(headingLine: number, keyword: string, ts: string | undefined): void {
  const next = headingLine + 1;
  const planning = next < ember.lineCount() && /^[ \t]*(SCHEDULED|DEADLINE|CLOSED):/.test(ember.lineText(next));
  if (!planning) {
    if (ts === undefined) return;
    const end = ember.lineEnd(headingLine);
    replaceText(end, end, `\n${keyword}: ${ts}`);
    return;
  }
  const text = ember.lineText(next);
  const re = new RegExp(`${keyword}: *[<[][^>\\]\\n]*[>\\]]`);
  let updated: string;
  if (re.test(text)) updated = ts === undefined ? text.replace(re, "") : text.replace(re, `${keyword}: ${ts}`);
  else updated = ts === undefined ? text : `${text.trimEnd()} ${keyword}: ${ts}`;
  updated = updated.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");
  const ls = ember.lineStart(next);
  if (updated === "") replaceText(ls - 1, ember.lineEnd(next), "");
  else replaceText(ls, ember.lineEnd(next), updated);
}

function plan(keyword: string, input: string): void {
  const [all, i] = backToHeading();
  if (Array.isArray(ember.prefixArg())) {
    setPlanning(all[i].line, keyword, undefined);
    ember.message(`Item is no longer ${keyword === "DEADLINE" ? "due" : "scheduled"}.`);
    return;
  }
  const date = parseDate(input);
  setPlanning(all[i].line, keyword, `<${formatTimestamp(date)}>`);
}

const schedule = ember.defineCommand({
  name: "org-schedule",
  doc: "Schedule the heading point is under for a date read as org-timestamp reads it. With C-u, unschedule it.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => plan("SCHEDULED", input),
});

const deadline = ember.defineCommand({
  name: "org-deadline",
  doc: "Give the heading point is under a deadline, read as org-timestamp reads it. With C-u, remove it.",
  params: [{ name: "date", prompt: "Date: ", history: "org-read-date-history" }],
  run: (input) => plan("DEADLINE", input),
});

/**
 * Moves an entry's repeating SCHEDULED and DEADLINE dates on, as marking it
 * done does: +1w adds a week, ++1w adds weeks until the date is in the
 * future, .+1w is a week from today. Returns whether any repeated.
 */
function repeatEntry(h: Heading): boolean {
  const line = h.line + 1;
  if (line >= ember.lineCount() || !/^[ \t]*(SCHEDULED|DEADLINE):/.test(ember.lineText(line))) return false;
  let repeated = false;
  for (const ts of timestampsOn(line).reverse()) {
    const m = /(\.\+|\+\+|\+)(\d+)([hdwmy])/.exec(ts.rest);
    if (!m) continue;
    repeated = true;
    const n = Number(m[2]);
    const add = (d: DateTime): DateTime =>
      normalize({
        ...d,
        year: d.year + (m[3] === "y" ? n : 0),
        month: d.month + (m[3] === "m" ? n : 0),
        day: d.day + (m[3] === "d" ? n : m[3] === "w" ? 7 * n : 0),
        hour: d.hour === undefined ? undefined : d.hour + (m[3] === "h" ? n : 0),
      });
    const now = today();
    const key = (d: DateTime) => d.year * 10000 + d.month * 100 + d.day;
    if (m[1] === ".+") ts.date = add({ ...now, hour: ts.date.hour, minute: ts.date.minute });
    else {
      ts.date = add(ts.date);
      if (m[1] === "++") while (key(ts.date) <= key(now)) ts.date = add(ts.date);
    }
    replaceText(ts.start, ts.end, timestampText(ts));
  }
  if (repeated) ember.message(`Entry repeats: ${ember.lineText(line).trim()}`);
  return repeated;
}

// Links

interface Link {
  start: number;
  end: number;
  path: string;
  description?: string;
}

/** The link point is on: a bracket link, an angle link or a plain one. */
function linkHere(): Link | undefined {
  const line = lineAt();
  const text = ember.lineText(line);
  const p = ember.point();
  for (const m of text.matchAll(LINK)) {
    const start = at(line, text, m.index ?? 0);
    const end = at(line, text, (m.index ?? 0) + m[0].length);
    if (start <= p && p < end) return { start, end, path: m[1].replace(/\\([[\]\\])/g, "$1"), description: m[2] };
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of text.matchAll(re)) {
      const start = at(line, text, m.index ?? 0);
      const end = at(line, text, (m.index ?? 0) + m[0].length);
      if (start <= p && p < end) return { start, end, path: m[0].replace(/^<|>$/g, "") };
    }
  }
  return undefined;
}

/** The title Org matches a heading link against: without its state, priority, cookies or tags. */
function bareTitle(h: Heading): string {
  return h.title.replace(new RegExp(COOKIE.source, "g"), "").replace(/\s+/g, " ").trim();
}

function searchHeading(title: string): Heading | undefined {
  const want = title.replace(/\s+/g, " ").trim();
  return headings().find((h) => bareTitle(h) === want);
}

/** Follows a link within the buffer: *Heading, #custom-id, a <<target>> or a heading's title. */
function searchInBuffer(path: string): number {
  if (path.startsWith("*")) {
    const h = searchHeading(path.slice(1));
    if (!h) throw new Error(`No match for fuzzy expression: ${path}`);
    return h.start;
  }
  if (path.startsWith("#")) {
    const id = path.slice(1);
    const found = ember.search(`^[ \\t]*:CUSTOM_ID:[ \\t]+${id.replace(/[.*+?^$[\]\\]/g, "\\$&")}[ \\t]*$`, { from: 0, regexp: true });
    if (!found) throw new Error(`No match for custom ID: ${id}`);
    const all = headings();
    const i = headingIndex(all, lineAt(found.start));
    return i === undefined ? found.start : all[i].start;
  }
  if (/^\d+$/.test(path)) return ember.lineStart(Math.min(Number(path) - 1, ember.lineCount() - 1));
  const target = ember.search(`<<${path}>>`, { from: 0 });
  if (target) return target.start;
  const h = searchHeading(path);
  if (h) return h.start;
  throw new Error(`No match for fuzzy expression: ${path}`);
}

function jump(pos: number): void {
  ember.pushMark(ember.point());
  ember.gotoChar(pos);
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i !== undefined && folded(Math.max(0, all[i].start - 1))) {
    // Show the headings above it, as org-fold-show-context does.
    for (const h of all.slice(0, i + 1)) {
      if (h.start <= pos) flag(h.end, entryEnd(all, all.indexOf(h)), false);
    }
  }
}

function openLink(link: Link): void {
  const path = link.path;
  const file = /^file:(.*)$/.exec(path)?.[1] ?? (/^(?:\/|~\/|\.\.?\/)/.test(path) ? path : undefined);
  if (file !== undefined) {
    const [name, search] = file.split("::");
    const dir = (ember.bufferFileName() ?? "").replace(/[^/]*$/, "");
    const full = /^[/~]/.test(name) ? name : dir + name;
    ember.call("find-file", full);
    if (search) {
      if (/^\d+$/.test(search)) ember.gotoChar(ember.lineStart(Number(search) - 1));
      else jump(searchInBuffer(search));
    }
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^(id|file):/.test(path)) {
    throw new Error(`Ember cannot open ${path.split(":")[0]} links yet: ${path}`);
  }
  jump(searchInBuffer(path));
}

const openAtPoint = ember.defineCommand({
  name: "org-open-at-point",
  doc:
    "Follow the link point is on: [[*Heading]], [[#custom-id]], [[target]] and [[Heading]] within the buffer, " +
    "and file links such as [[file:notes.org::*Heading]] in another buffer.",
  run: () => {
    const link = linkHere();
    if (!link) throw new Error("No link found");
    openLink(link);
  },
});

const insertLink = ember.defineCommand({
  name: "org-insert-link",
  doc: "Insert a link as [[link][description]], or [[link]] without a description; on a link, replace it.",
  params: [
    { name: "link", prompt: "Link: ", history: "org-link-history" },
    { name: "description", prompt: "Description: " },
  ],
  run: (target, description) => {
    if (target.trim() === "") throw new Error("No link given");
    const escaped = target.trim().replace(/([[\]])/g, "\\$1");
    const text = description.trim() === "" ? `[[${escaped}]]` : `[[${escaped}][${description.trim()}]]`;
    const link = linkHere();
    if (link) {
      ember.deleteRegion(link.start, link.end);
      ember.gotoChar(link.start);
    }
    ember.insert(text);
  },
});

ember.defineVariable({ name: "org-link-history", doc: "Links answered to org-insert-link, newest first.", value: [] });

const mouseFollow = ember.defineCommand({
  name: "org-mouse-follow-link",
  doc: "Move point where the mouse was clicked, and follow the link there if there is one, as mouse-1 does on Org links.",
  run: () => {
    ember.call("mouse-set-point");
    if (ember.variable("major-mode") !== "org-mode") return;
    const link = linkHere();
    if (link) openLink(link);
  },
});

// Commands that depend on where point is, as Org's keys do

const metaLeft = ember.defineCommand({
  name: "org-metaleft",
  doc: "M-<left> in Org: promote a heading, outdent an item, move a table column left, or move back a word.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-column-left");
    else if (headingsInRegion() || headingHere()) ember.call("org-do-promote");
    else if (itemHere()) ember.call("org-outdent-item");
    else ember.callWithPrefix(ember.prefixArg(), "backward-word");
  },
});

const metaRight = ember.defineCommand({
  name: "org-metaright",
  doc: "M-<right> in Org: demote a heading, indent an item, move a table column right, or move forward a word.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-column-right");
    else if (headingsInRegion() || headingHere()) ember.call("org-do-demote");
    else if (itemHere()) ember.call("org-indent-item");
    else ember.callWithPrefix(ember.prefixArg(), "forward-word");
  },
});

const metaUp = ember.defineCommand({
  name: "org-metaup",
  doc: "M-<up> in Org: move a subtree, an item or a table row up past the one before it.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-row-up");
    else if (headingHere()) ember.call("org-move-subtree-up");
    else if (itemHere()) ember.call("org-move-item-up");
    else throw new Error("Not on a heading, an item or a table row");
  },
});

const metaDown = ember.defineCommand({
  name: "org-metadown",
  doc: "M-<down> in Org: move a subtree, an item or a table row down past the one after it.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-row-down");
    else if (headingHere()) ember.call("org-move-subtree-down");
    else if (itemHere()) ember.call("org-move-item-down");
    else throw new Error("Not on a heading, an item or a table row");
  },
});

const shiftMetaLeft = ember.defineCommand({
  name: "org-shiftmetaleft",
  doc: "M-S-<left> in Org: promote a subtree, outdent an item with its children, or delete a table column.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-delete-column");
    else if (headingHere()) ember.call("org-promote-subtree");
    else if (itemHere()) ember.call("org-outdent-item-tree");
    else throw new Error("Not on a heading, an item or a table");
  },
});

const shiftMetaRight = ember.defineCommand({
  name: "org-shiftmetaright",
  doc: "M-S-<right> in Org: demote a subtree, indent an item with its children, or insert a table column.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-insert-column");
    else if (headingHere()) ember.call("org-demote-subtree");
    else if (itemHere()) ember.call("org-indent-item-tree");
    else throw new Error("Not on a heading, an item or a table");
  },
});

const shiftMetaUp = ember.defineCommand({
  name: "org-shiftmetaup",
  doc: "M-S-<up> in Org: delete the table row point is on.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-kill-row");
    else throw new Error("Not in a table");
  },
});

const shiftMetaDown = ember.defineCommand({
  name: "org-shiftmetadown",
  doc: "M-S-<down> in Org: insert a table row above the one point is on.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-insert-row");
    else throw new Error("Not in a table");
  },
});

const shiftUp = ember.defineCommand({
  name: "org-shiftup",
  doc: "S-<up> in Org: make a timestamp later, raise a heading's priority, or move to the previous item.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-up");
    else if (headingHere()) ember.call("org-priority-up");
    else if (itemHere()) ember.call("org-previous-item");
    else shiftSelectError();
  },
});

const shiftDown = ember.defineCommand({
  name: "org-shiftdown",
  doc: "S-<down> in Org: make a timestamp earlier, lower a heading's priority, or move to the next item.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-down");
    else if (headingHere()) ember.call("org-priority-down");
    else if (itemHere()) ember.call("org-next-item");
    else shiftSelectError();
  },
});

const shiftRight = ember.defineCommand({
  name: "org-shiftright",
  doc: "S-<right> in Org: move a timestamp a day on, change a heading to its next TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-up-day");
    else if (headingHere()) todo(1);
    else if (itemAtLine(lineAt())) cycleBullet(1);
    else shiftSelectError();
  },
});

const shiftLeft = ember.defineCommand({
  name: "org-shiftleft",
  doc: "S-<left> in Org: move a timestamp a day back, change a heading to its previous TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-down-day");
    else if (headingHere()) todo(-1);
    else if (itemAtLine(lineAt())) cycleBullet(-1);
    else shiftSelectError();
  },
});

const ctrlCCtrlC = ember.defineCommand({
  name: "org-ctrl-c-ctrl-c",
  doc:
    "C-c C-c in Org: tick or untick a checkbox, align a table, update a statistics cookie, set a heading's tags, " +
    "or re-read the buffer's #+ settings on a #+ line.",
  run: () => {
    const line = lineAt();
    const text = ember.lineText(line);
    if (/^[ \t]*\|/.test(text)) {
      ember.call("org-table-align");
      return;
    }
    if (/^#\+/.test(text)) {
      storeTodoSets();
      ember.call("font-lock-flush");
      ember.message("Local setup has been refreshed");
      return;
    }
    const here = headingHere();
    if (here) {
      const p = ember.point();
      const onCookie = [...text.matchAll(COOKIE)].some((m) => {
        const start = at(line, text, m.index ?? 0);
        return start <= p && p <= start + m[0].length;
      });
      if (onCookie) updateHeadingCookies(...here);
      else ember.callInteractively("org-set-tags-command");
      return;
    }
    const item = itemAtLine(line);
    if (item) {
      if (item.checkbox !== undefined) toggleCheckbox(item);
      else updateStatistics(item.line);
      return;
    }
    throw new Error("\u2018C-c C-c\u2019 can do nothing useful here");
  },
});

ember.defineCommand({
  name: "org-toggle-checkbox",
  doc: "Tick or untick the checkbox of the item point is in. With C-u, add a checkbox to it, or remove its checkbox.",
  run: () => {
    const item = itemAtLine(lineAt());
    if (!item) throw new Error("Not in an item");
    if (Array.isArray(ember.prefixArg())) {
      if (item.checkboxAt !== undefined) replaceText(item.checkboxAt, item.checkboxAt + 4, "");
      else replaceText(item.contentAt, item.contentAt, "[ ] ");
      updateStatistics(item.line);
      return;
    }
    if (item.checkbox !== undefined) toggleCheckbox(item);
  },
});

ember.defineCommand({
  name: "org-update-statistics-cookies",
  doc: "Bring the statistics cookies of the heading point is under, such as [1/3], up to date.",
  run: () => {
    const [all, i] = backToHeading();
    updateHeadingCookies(all, i);
  },
});

const ctrlCMinus = ember.defineCommand({
  name: "org-ctrl-c-minus",
  doc: "C-c - in Org: insert a table rule, change a list's bullets, or turn the line into an item.",
  run: () => {
    const line = lineAt();
    const text = ember.lineText(line);
    if (/^[ \t]*\|/.test(text)) ember.callWithPrefix(ember.prefixArg(), "org-table-insert-hline");
    else if (parseItem(line)) cycleBullet(1);
    else ember.call("org-toggle-item");
  },
});

ember.defineCommand({
  name: "org-toggle-item",
  doc: "Turn the line, or each line of the region, into a list item, or a heading into one.",
  run: () => {
    const line = lineAt();
    const text = ember.lineText(line);
    const ls = ember.lineStart(line);
    const stars = /^\*+ +/.exec(text);
    if (stars) replaceText(ls, ls + stars[0].length, "- ");
    else if (parseItem(line)) {
      const item = parseItem(line) as Item;
      replaceText(item.bulletAt, item.contentAt, "");
    } else {
      const indent = charCount(/^[ \t]*/.exec(text)?.[0] ?? "");
      replaceText(ls + indent, ls + indent, "- ");
    }
  },
});

const toggleHeading = ember.defineCommand({
  name: "org-toggle-heading",
  doc: "Turn the line into a heading, or a heading into plain text; an item becomes a heading.",
  run: () => {
    const line = lineAt();
    const text = ember.lineText(line);
    const ls = ember.lineStart(line);
    const stars = /^\*+ +/.exec(text);
    if (stars) {
      replaceText(ls, ls + stars[0].length, "");
      return;
    }
    const all = headings();
    const i = headingIndex(all, line);
    const level = i === undefined ? 1 : all[i].level + 1;
    const item = parseItem(line);
    const from = item ? item.bulletAt - (item.bulletAt - ls) : ls;
    const to = item ? item.contentAt : ls + charCount(/^[ \t]*/.exec(text)?.[0] ?? "");
    replaceText(from, to, `${"*".repeat(level === 1 || i === undefined ? 1 : level)} `);
  },
});

// The mode

const keys: { [keys: string]: ember.CommandName | ember.DefinedCommand } = {
  TAB: cycle,
  "S-TAB": shiftTab,
  RET: orgReturn,
  "M-RET": metaReturn,
  "C-RET": respectContent,
  "M-S-RET": todoHeading,
  "C-S-RET": todoHeadingRespectContent,
  "M-<left>": metaLeft,
  "M-<right>": metaRight,
  "M-<up>": metaUp,
  "M-<down>": metaDown,
  "M-S-<left>": shiftMetaLeft,
  "M-S-<right>": shiftMetaRight,
  "M-S-<up>": shiftMetaUp,
  "M-S-<down>": shiftMetaDown,
  "S-<up>": shiftUp,
  "S-<down>": shiftDown,
  "S-<left>": shiftLeft,
  "S-<right>": shiftRight,
  "C-c C-t": todoCommand,
  "C-c ,": "org-priority",
  "C-c C-q": setTagsCommand,
  "C-c C-c": ctrlCCtrlC,
  "C-c C-x C-b": "org-toggle-checkbox",
  "C-c C-l": insertLink,
  "C-c C-o": openAtPoint,
  "C-c .": timestamp,
  "C-c !": inactiveTimestamp,
  "C-c C-s": schedule,
  "C-c C-d": deadline,
  "C-c C-n": nextHeading,
  "C-c C-p": previousHeading,
  "C-c C-f": forwardSameLevel,
  "C-c C-b": backwardSameLevel,
  "C-c C-u": "outline-up-heading",
  "C-c *": toggleHeading,
  "C-c -": ctrlCMinus,
  "C-c @": markSubtree,
  "C-c |": "org-table-create-or-convert-from-region",
  "C-c SPC": "org-table-blank-field",
  "C-c C-x C-w": "org-cut-subtree",
  "C-c C-x M-w": "org-copy-subtree",
  "C-c C-x C-y": "org-paste-subtree",
  "<mouse-1>": mouseFollow,
};

ember.defineMajorMode({
  name: "org-mode",
  modeName: "Org",
  parent: "outline-mode",
  doc:
    "The major mode for Org files: notes, plans and lists organised under headings that start with stars.\n\n" +
    "TAB on a heading folds and unfolds it, and S-TAB the whole buffer. M-RET adds a heading or an item, " +
    "M-<left> and M-<right> promote and demote, and M-<up> and M-<down> move a subtree. C-c C-t and S-<right> " +
    "change a heading's TODO state, S-<up> its priority, and C-c C-q its tags. C-c C-c ticks a checkbox. " +
    "C-c . inserts a timestamp, which S-<up> and S-<down> change, and C-c C-s schedules. C-c C-l inserts a " +
    "link and C-c C-o follows it. Lines starting with | are tables: TAB moves between fields and aligns them.",
  bindings: keys,
  setup: () => {
    ember.setVariable("outline-regexp", "\\*+ ");
    ember.addToInvisibilitySpec("org-hide-drawer", { ellipsis: true });
    ember.addToInvisibilitySpec("org-hide-block", { ellipsis: true });
    ember.addToInvisibilitySpec("org-link");
    storeTodoSets();
    if (ember.variable("org-startup-truncated") === true) ember.setVariable("truncate-lines", true);
    ember.addHook("jit-lock-functions", fontify, { local: true });
    startupVisibility();
  },
});

ember.remapCommand("org-mode-map", "self-insert-command", "org-self-insert-command");
ember.remapCommand("org-mode-map", "delete-backward-char", "org-delete-backward-char");
ember.remapCommand("org-mode-map", "delete-char", "org-delete-char");
ember.remapCommand("org-mode-map", "move-end-of-line", "org-end-of-line");
