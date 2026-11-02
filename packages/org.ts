// Org mode, after Emacs's org.el, with the parts of org-list.el and ol.el
// that editing notes needs: headings that fold with TAB and S-TAB, structure
// editing with M-RET and the M-arrow keys, TODO states, priorities, tags,
// plain lists with checkboxes, timestamps and links. Tables are in
// org-table.ts, the agenda in org-agenda.ts and capture in org-capture.ts,
// as Org splits them; they import what they share from here, as Org's
// files require org.
//
// Org text is styled as it comes into view, by a function on
// jit-lock-functions, as Emacs's font-lock styles it. Folding hides text with
// overlays, as Emacs's org does with org-fold-core-style set to overlays:
// "outline" for subtrees, "org-hide-drawer" for drawers and
// "org-hide-block" for blocks. A link's brackets and target are hidden by
// an "org-link" text property, so [[https://gnu.org][GNU]] shows as GNU.

import { type Marker, allMatches, dropMarker, edDelete, edInsert, marker, markers, placeMarkers } from "org-macs";
import { charCount } from "subr";

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
  [
    "org-fold-catch-invisible-edits",
    'What typing or deleting next to folded text does: "smart" unfolds it and goes ahead where the edit is ' +
      'predictable, and otherwise stops so it can be repeated with the text showing; "show" unfolds and goes ahead, ' +
      '"show-and-error" unfolds and stops, "error" stops, and false allows the edit.',
    "smart",
  ],
  ["org-M-RET-may-split-line", "Whether M-RET in the middle of a line splits it, the rest going to the new heading or item.", true],
  [
    "org-loop-over-headlines-in-active-region",
    "Whether commands such as C-c C-t act on every heading in the active region.",
    true,
  ],
  [
    "org-log-repeat",
    'What marking a repeating task done records: "time" for a LAST_REPEAT property and a note of the change, false for nothing.',
    "time",
  ],
  [
    "org-log-done",
    'What marking a heading done records: false for nothing, "time" for a CLOSED: timestamp under it.',
    false,
  ],
  ["org-priority-highest", "The highest priority, a capital letter.", "A"],
  ["org-priority-lowest", "The lowest priority, a capital letter.", "C"],
  ["org-priority-default", "The priority S-<up> and S-<down> start from, and that headings without one count as.", "B"],
  ["org-link-descriptive", "Whether links show only their description, hiding the brackets and target.", true],
  [
    "org-indirect-buffer-display",
    'Where C-c C-x b shows the indirect buffer it makes: "current-window", "other-window", "new-frame" each time, ' +
      'or "dedicated-frame", one frame used again.',
    "other-window",
  ],
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
  if (Array.isArray(alist)) ember.setDefault("auto-mode-alist", [["\\.org\\'", "org-mode"], ...alist]);
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


/**
 * Whether the region is active and not empty, as org-region-active-p says
 * after use-region-p: an empty region does not count.
 */
function orgRegionActive(): boolean {
  const mark = ember.mark();
  return ember.regionActive() && mark !== undefined && mark !== ember.point();
}


/** The position of index `i` of a line's text. */
export function at(line: number, text: string, i: number): number {
  return ember.lineStart(line) + charCount(text.slice(0, i));
}

/** The index in a line's text of a position on it. */
function indexOf(line: number, text: string, pos: number): number {
  const n = pos - ember.lineStart(line);
  if (!/[\uD800-\uDFFF]/.test(text)) return n;
  return Array.from(text).slice(0, n).join("").length;
}

/**
 * Moves point `n` lines, as Emacs's forward-line does, and returns how many
 * lines it fell short. A non-empty last line counts as one moved over.
 */
function forwardLine(n: number): number {
  const start = ember.point();
  const line = ember.lineOf(start);
  const last = ember.lineCount() - 1;
  if (n <= 0) {
    ember.gotoChar(ember.lineStart(Math.max(0, line + n)));
    return Math.min(0, line + n);
  }
  if (line + n <= last) {
    ember.gotoChar(ember.lineStart(line + n));
    return 0;
  }
  ember.gotoChar(ember.bufferSize());
  let shortfall = n - (last - line);
  if (ember.point() !== start && ember.bufferText(ember.point() - 1, ember.point()) !== "\n") shortfall--;
  return shortfall;
}

export function lineAt(pos = ember.point()): number {
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
  const saved: [Marker, number][] = markers.map((m) => {
    const x = m.pos;
    return [m, x > end || (x === end && end > start) ? x + delta : x > start ? start : x];
  });
  // As a marker would: text inserted at point goes after it.
  if (p > end || (p === end && start < end)) p += delta;
  else if (p > start) p = Math.min(p, start + charCount(text));
  ember.deleteRegion(start, end);
  ember.gotoChar(start);
  ember.insert(text);
  placeMarkers(saved);
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

/** The whole buffer's #+KEYWORD: lines, found in one pass. */
function keywordLines(): [number, number, string][] {
  return ember.saveRestriction(() => {
    ember.widen();
    return ember.matchingLines("^#\\+", { caseFold: true });
  });
}

/** The buffer's TODO sequences: from #+TODO: lines, else org-todo-keywords. */
function readTodoSets(): TodoSet[] {
  const sets: TodoSet[] = [];
  for (const [, , text] of keywordLines()) {
    const m = /^#\+(?:TODO|SEQ_TODO|TYP_TODO):(.*)$/i.exec(text);
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

export function allKeywords(): string[] {
  return todoSets().flatMap((s) => [...s.todo, ...s.done]);
}

export function isDone(keyword: string | undefined): boolean {
  return keyword !== undefined && todoSets().some((s) => s.done.includes(keyword));
}

// Headings

export interface Heading {
  /** The index's epoch its positions are up to date with, for the index's own use. */
  synced?: number;
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

/**
 * A heading line, if `line` is one. `text` is the line's text and `sorted`
 * the TODO keywords, longest first, when the caller has them already, as
 * headings() does for every heading in the buffer.
 */
export function parseHeading(line: number, keywords = allKeywords(), text = ember.lineText(line), sorted?: string[]): Heading | undefined {
  const h = parseHeadingText(text, keywords, sorted);
  return h && placeHeading(h, line, ember.lineStart(line));
}

/** A heading parsed from its line's text, its positions counted from the line's start. */
function parseHeadingText(text: string, keywords: string[], sorted?: string[]): Heading | undefined {
  const stars = /^(\*+) /.exec(text);
  if (!stars) return undefined;
  let i = stars[0].length;
  while (text[i] === " ") i++;
  const line = 0;
  const start = 0;
  const at = (_line: number, text: string, i: number): number => start + charCount(text.slice(0, i));
  const h: Heading = {
    line,
    start,
    end: start + charCount(text),
    level: stars[1].length,
    titleAt: 0,
    title: "",
    tags: [],
  };
  for (const kw of sorted ?? [...keywords].sort((a, b) => b.length - a.length)) {
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

/** A heading parsed from its text, put at its line and the line's start. */
function placeHeading(h: Heading, line: number, start: number): Heading {
  const placed: Heading = { ...h, line, start, end: start + h.end, titleAt: start + h.titleAt, tags: [...h.tags] };
  if (h.todoAt !== undefined) placed.todoAt = start + h.todoAt;
  if (h.priorityAt !== undefined) placed.priorityAt = start + h.priorityAt;
  if (h.tagsAt !== undefined) placed.tagsAt = start + h.tagsAt;
  return placed;
}

function isHeadingLine(text: string): boolean {
  return /^\*+ /.test(text);
}

/**
 * Heading lines already parsed, by their text, for the TODO keywords
 * `parsedFor`: a change leaves most headings as they were, so only new or
 * changed ones are parsed again.
 */
const parsed = new Map<string, Readonly<Heading> | null>();
let parsedFor = "";

/**
 * A buffer's headings, the whole buffer's, kept up to date as it changes,
 * as Org's element cache follows changes: after an edit only the lines it
 * touched are looked at again, and the headings after it move only when
 * asked for, as Org's cache shifts its elements lazily
 * (org-element--cache-shift-positions). Each change leaves a shift for
 * the headings from an index on; a heading read through the index is moved
 * by the shifts newer than it, in place, as a cached element is, and
 * headings() moves them all.
 */
interface HeadingIndex {
  /** The buffer's modified tick and size when the index was last up to date. */
  tick: number;
  size: number;
  keywords: string;
  all: Heading[];
  /** The shifts not yet applied to every heading they cover, oldest first. */
  pending: Shift[];
  /** Counts the changes followed: a shift, and a heading made or moved, carries the epoch it is from. */
  epoch: number;
  /** Whether headings() has given out `all`, which is then copied before it changes. */
  shared: boolean;
  /** The headings in the accessible portion, for a narrowing. */
  view?: { min: number; max: number; tick: number; headings: readonly Heading[] };
}

/** Moves the headings from index `from` on by `chars` characters and `lines` lines, those older than `epoch`. */
interface Shift {
  from: number;
  chars: number;
  lines: number;
  epoch: number;
}

/** Past so many shifts, they are applied to every heading, as each read looks at them all. */
const MAX_PENDING = 32;

const headingIndexes = new Map<string, HeadingIndex>();

/** The current buffer's index's key: its id, which outlives a rename, and a buffer killed and made again does not share. */
const indexKey = (): string => String(ember.currentBuffer().id);

/** The changes to each indexed buffer since its index was last brought up to date, as after-change-functions gives them. */
const headingChanges = new Map<string, [number, number, number][]>();

/** Records a change to an Org buffer, for headings() to follow it. */
function headingsAfterChange(beg: number, end: number, oldLen: number): void {
  const name = indexKey();
  if (!headingIndexes.has(name)) return;
  const list = headingChanges.get(name);
  if (list) list.push([beg, end, oldLen]);
  else headingChanges.set(name, [[beg, end, oldLen]]);
}

/** The heading lines from `start` up to `end`, parsed, in the whole buffer, up to date at `epoch`. */
function scanHeadings(keywords: string[], sorted: string[], start?: number, end?: number, epoch = 0): Heading[] {
  const found: Heading[] = [];
  // The heading lines in one pass in the editor, rather than a call per
  // line or the whole text copied here: much the faster in a large buffer.
  const lines = ember.saveRestriction(() => {
    ember.widen();
    return ember.matchingLines("^\\*+ ", { caseFold: false, start, end });
  });
  for (const [line, lineStart, text] of lines) {
    let h = parsed.get(text);
    if (h === undefined) {
      h = parseHeadingText(text, keywords, sorted) ?? null;
      parsed.set(text, h);
    }
    if (h) {
      const placed = placeHeading(h, line, lineStart);
      placed.synced = epoch;
      found.push(placed);
    }
  }
  return found;
}

/** Moves a heading by `chars` characters and `lines` lines, in place. */
function shiftHeading(h: Heading, chars: number, lines: number): void {
  h.line += lines;
  if (chars === 0) return;
  h.start += chars;
  h.end += chars;
  h.titleAt += chars;
  if (h.todoAt !== undefined) h.todoAt += chars;
  if (h.priorityAt !== undefined) h.priorityAt += chars;
  if (h.tagsAt !== undefined) h.tagsAt += chars;
}

/** How far the pending shifts move heading `k` of `index`: characters, then lines. */
function pendingAt(index: HeadingIndex, k: number): [number, number] {
  const synced = index.all[k].synced ?? 0;
  let chars = 0;
  let lines = 0;
  for (const s of index.pending) {
    if (s.from <= k && s.epoch > synced) {
      chars += s.chars;
      lines += s.lines;
    }
  }
  return [chars, lines];
}

/** Where heading `k` of `index` starts, its pending shifts counted. */
function startAt(index: HeadingIndex, k: number): number {
  return index.all[k].start + pendingAt(index, k)[0];
}

/** Heading `k` of `index`, moved by the shifts pending for it. */
function syncHeading(index: HeadingIndex, k: number): Heading {
  const h = index.all[k];
  if (index.pending.length === 0 || (h.synced ?? 0) >= index.epoch) return h;
  const [chars, lines] = pendingAt(index, k);
  if (chars !== 0 || lines !== 0) shiftHeading(h, chars, lines);
  h.synced = index.epoch;
  return h;
}

/** Applies every pending shift, in one pass over the headings they cover. */
function syncAll(index: HeadingIndex): void {
  const pending = index.pending;
  if (pending.length === 0) return;
  const sorted = [...pending].sort((x, y) => x.from - y.from);
  // A heading older than every shift is moved by all of those at or before
  // it, summed as the pass goes; the few read since are counted alone.
  const oldest = Math.min(...pending.map((s) => s.epoch));
  const hs = index.all;
  let chars = 0;
  let lines = 0;
  let s = 0;
  for (let k = sorted[0].from; k < hs.length; k++) {
    while (s < sorted.length && sorted[s].from <= k) {
      chars += sorted[s].chars;
      lines += sorted[s++].lines;
    }
    const h = hs[k];
    if ((h.synced ?? 0) < oldest) {
      if (chars !== 0 || lines !== 0) shiftHeading(h, chars, lines);
    } else if ((h.synced ?? 0) < index.epoch) {
      const [c, l] = pendingAt(index, k);
      if (c !== 0 || l !== 0) shiftHeading(h, c, l);
    }
  }
  // Each shift to come is newer than every heading, so none needs its epoch set.
  index.pending = [];
}

/**
 * Removes headings `i` up to `j` from the index and puts `found` in their
 * place, keeping each shift on the headings it covered.
 */
function replaceHeadings(index: HeadingIndex, i: number, j: number, found: Heading[]): void {
  if (j === i && found.length === 0) return;
  index.all.splice(i, j - i, ...found);
  for (const s of index.pending) if (s.from >= i) s.from = Math.max(i, s.from - (j - i)) + found.length;
}

/**
 * Brings an index up to date with the changes since, or returns false
 * when they cannot be followed, as when an edit ran no change hooks.
 */
function followChanges(index: HeadingIndex, changes: [number, number, number][], keywords: string[], sorted: string[]): boolean {
  // Past so many, finding every heading again is the quicker.
  if (changes.length > 16) return false;
  // Changes made without the hooks, which the sizes would not account for.
  const grown = changes.reduce((sum, [beg, end, oldLen]) => sum + (end - beg) - oldLen, 0);
  if (index.size + grown !== ember.bufferSize()) return false;
  // A caller may still hold the array.
  if (index.shared) {
    index.all = index.all.slice();
    index.shared = false;
  }
  const epoch = ++index.epoch;
  const hs = index.all;
  // The first heading whose line ends at or after `pos`, by halving, as the
  // headings stay in order however far they moved.
  const firstEndingFrom = (pos: number): number => {
    let [lo, hi] = [0, hs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid].end + pendingAt(index, mid)[0] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Where each heading's line may have moved from, by the change it follows.
  const dirty: [number, number][] = [];
  for (const [beg, end, oldLen] of changes) {
    const oldEnd = beg + oldLen;
    const chars = end - beg - oldLen;
    // Headings whose line the change touched go, to be found again.
    const i = firstEndingFrom(beg);
    let j = i;
    while (j < hs.length && startAt(index, j) <= oldEnd) j++;
    replaceHeadings(index, i, j, []);
    if (chars !== 0 && i < hs.length) index.pending.push({ from: i, chars, lines: 0, epoch });
    for (const r of dirty) {
      if (r[0] > oldEnd) {
        r[0] += chars;
        r[1] += chars;
      } else if (r[1] >= beg) {
        r[1] = Math.max(r[0], r[1] >= oldEnd ? r[1] + chars : end, end);
      }
    }
    dirty.push([beg, end]);
  }
  // Line numbers, which the changes' positions do not give: the headings
  // between one change and the next moved by as many lines as the first of
  // them did, so one lookup does for each such stretch, and a shift holds
  // the difference from the stretch before.
  const bounds = dirty.map((r) => r[1]).sort((x, y) => x - y);
  const stretches: [number, number][] = [];
  let k = firstEndingFrom(Math.min(...dirty.map((r) => r[0])));
  for (const bound of [...bounds, Infinity]) {
    if (k >= hs.length) break;
    if (startAt(index, k) > bound) continue;
    const [chars, lines] = pendingAt(index, k);
    stretches.push([k, ember.lineOf(hs[k].start + chars) - (hs[k].line + lines)]);
    // The first heading past this bound starts the next stretch.
    let [lo, hi] = [k, hs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startAt(index, mid) <= bound) lo = mid + 1;
      else hi = mid;
    }
    k = lo;
  }
  let before = 0;
  for (const [from, lines] of stretches) {
    if (lines !== before) index.pending.push({ from, chars: 0, lines: lines - before, epoch });
    before = lines;
  }
  // The lines the changes touched, looked at again.
  for (const [from, to] of mergeRanges(dirty)) {
    const start = ember.lineStart(ember.lineOf(Math.min(from, ember.bufferSize())));
    const stop = ember.lineEnd(ember.lineOf(Math.min(to, ember.bufferSize())));
    const found = scanHeadings(keywords, sorted, start, stop, epoch);
    let [lo, hi] = [0, hs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startAt(index, mid) < start) lo = mid + 1;
      else hi = mid;
    }
    let j = lo;
    while (j < hs.length && startAt(index, j) <= stop) j++;
    replaceHeadings(index, lo, j, found);
  }
  if (index.pending.length > MAX_PENDING) syncAll(index);
  return true;
}

/** Ranges sorted and joined where they meet or overlap. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.map((r): [number, number] => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/**
 * Whether the current buffer's heading index, as its changes left it,
 * agrees with finding every heading again: nil if so, else where they
 * first differ, as Org's org-element--cache-self-verify checks its cache.
 */
ember.defun("org--headings-verify", (only?: number) => {
  // With an index, only that heading, read as the element parser reads
  // one, leaving the shifts pending for the rest.
  const kept = typeof only === "number" ? headingsAsRead() : headings();
  const keywords = allKeywords();
  const fresh = scanHeadings(keywords, [...keywords].sort((a, b) => b.length - a.length)).filter((h) => h.start >= ember.pointMin() && h.start < ember.pointMax());
  const show = (h?: Heading) => (h === undefined ? "none" : JSON.stringify(h, (key, value) => (key === "synced" ? undefined : value)));
  if (typeof only === "number") {
    if (kept.length !== fresh.length) return `${kept.length} headings kept, ${fresh.length} found`;
    const i = only % Math.max(1, fresh.length);
    return show(kept[i]) === show(fresh[i]) ? null : `heading ${i}: kept ${show(kept[i])}, found ${show(fresh[i])}`;
  }
  for (let i = 0; i < Math.max(kept.length, fresh.length); i++) {
    if (show(kept[i]) !== show(fresh[i])) return `heading ${i}: kept ${show(kept[i])}, found ${show(fresh[i])}`;
  }
  return null;
});

/** The current buffer's index, brought up to date with its changes, its shifts perhaps still pending. */
function currentIndex(): HeadingIndex {
  const keywords = allKeywords();
  const keywordsKey = keywords.join(" ");
  if (keywordsKey !== parsedFor || parsed.size > 100_000) {
    parsed.clear();
    parsedFor = keywordsKey;
  }
  const name = indexKey();
  const tick = ember.bufferModifiedTick();
  let index = headingIndexes.get(name);
  if (!index || index.keywords !== keywordsKey || index.tick !== tick) {
    const sorted = [...keywords].sort((a, b) => b.length - a.length);
    const changes = headingChanges.get(name);
    headingChanges.delete(name);
    const followed = index !== undefined && index.keywords === keywordsKey && changes !== undefined && followChanges(index, changes, keywords, sorted);
    if (!followed) {
      index = { tick, size: ember.bufferSize(), keywords: keywordsKey, all: scanHeadings(keywords, sorted), pending: [], epoch: 0, shared: false };
      headingIndexes.set(name, index);
    }
    index!.tick = tick;
    index!.size = ember.bufferSize();
    index!.view = undefined;
  }
  return index!;
}

/**
 * The buffer's headings, top to bottom, in its accessible portion, as Org's
 * searches find them. Kept up to date as the buffer changes, since the
 * commands and the element parser ask for them many times per key; shared,
 * so not to be changed, and moved in place by later edits once asked for
 * again, as Org's cached elements are.
 */
export function headings(): Heading[] {
  const index = currentIndex();
  syncAll(index);
  index.shared = true;
  const [min, max] = [ember.pointMin(), ember.pointMax()];
  if (min === 0 && max === ember.bufferSize()) return index.all;
  if (index.view?.min !== min || index.view.max !== max) {
    index.view = { min, max, tick: index.tick, headings: index.all.filter((h) => h.start >= min && h.start < max) };
  }
  return index.view.headings as Heading[];
}

/**
 * The headings as headings() gives them, for a caller that reads only a
 * few, as the element parser does: each is moved by the shifts pending for
 * it as it is read, rather than all of them first. Narrowed, it is
 * headings() itself.
 */
function headingsAsRead(): Heading[] {
  const index = currentIndex();
  if (ember.pointMin() !== 0 || ember.pointMax() !== ember.bufferSize()) return headings();
  // Not marked shared: the parser reads it and lets it go before any edit.
  if (index.pending.length === 0) return index.all;
  return new Proxy(index.all, {
    get(target, key, receiver) {
      if (typeof key === "string") {
        const k = Number(key);
        if (Number.isInteger(k) && k >= 0 && k < target.length) return syncHeading(index, k);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/** The heading whose entry a line is in: the nearest heading at or above it. */
function headingIndex(all: Heading[], line: number): number | undefined {
  // By halving, as the headings are in order.
  let [lo, hi] = [0, all.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].line <= line) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lo - 1 : undefined;
}

/**
 * The heading point is under, or Org's error, which reports the start of
 * point's line, counting from 1. With `move`, point goes there before the
 * error, as when a command calls org-back-to-heading outside
 * save-excursion.
 */
function backToHeading(move = false): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) {
    const bol = ember.lineStart(lineAt());
    if (move) ember.gotoChar(bol);
    throw new Error(`Before first headline at position ${bol + 1} in buffer ${ember.bufferName()}`);
  }
  return [all, i];
}

/**
 * The heading org-back-to-heading finds without invisible-ok: the one on
 * point's line or above it, or the nearest heading above that which shows.
 */
function visibleHeadingIndex(all: Heading[], line: number): number | undefined {
  const i = headingIndex(all, line);
  if (i === undefined) return undefined;
  for (const a of [i, ...ancestors(all, i)]) if (!ember.invisibleAt(all[a].start)) return a;
  return i;
}

/** The heading on point's line, if it is a heading line. */
function headingHere(): [Heading[], number] | undefined {
  if (!isHeadingLine(ember.lineText(lineAt()))) return undefined;
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : [all, i];
}

/** The next heading after `i` at its level or higher, if any. */
/** The index of the first heading starting at or after `pos`, by halving. */
function firstHeadingFrom(all: Heading[], pos: number): number {
  let [lo, hi] = [0, all.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The index of the heading starting at `pos`, or -1, by halving. */
function headingStartingAt(all: Heading[], pos: number): number {
  const i = firstHeadingFrom(all, pos);
  return all[i]?.start === pos ? i : -1;
}

/** The first heading from index `from` on that `test` accepts, without copying those after it. */
function findFrom(all: Heading[], from: number, test: (h: Heading) => boolean): Heading | undefined {
  for (let k = from; k < all.length; k++) if (test(all[k])) return all[k];
  return undefined;
}

function nextSameOrHigher(all: Heading[], i: number): Heading | undefined {
  const level = all[i].level;
  for (let j = i + 1; j < all.length; j++) if (all[j].level <= level) return all[j];
  return undefined;
}

/**
 * Where a heading's subtree ends for folding: before the newline of the
 * next heading at its level or higher, or at the end of the buffer, as
 * org-fold-subtree takes it.
 */
function subtreeEnd(all: Heading[], i: number): number {
  const next = nextSameOrHigher(all, i);
  return next ? next.start - 1 : ember.pointMax();
}

/** Where a heading's entry ends for showing it: at the next heading, as org-fold-show-entry takes it. */
export function entryEnd(all: Heading[], i: number): number {
  return all[i + 1]?.start ?? ember.pointMax();
}

/**
 * Where a subtree's text starts and ends for moving or killing it: whole
 * lines, up to the end of the accessible portion if the buffer is narrowed.
 */
export function subtreeRegion(all: Heading[], i: number): [number, number] {
  const next = nextSameOrHigher(all, i);
  return [all[i].start, next ? next.start : ember.pointMax()];
}

// Folding, after org-fold.el and org-cycle.el

function hideOverlay(start: number, end: number, spec: string): void {
  // Text inserted at either end goes outside, as with org-fold-core's
  // overlays, which advance at the front only.
  ember.makeOverlay(start, end, { invisible: spec, evaporate: true }, { frontAdvance: true });
}

/**
 * Hides or shows the text from start up to end, as Emacs's org-fold-region
 * does: overlays hiding it with `spec` are removed, cut back where they
 * reach outside it, and a new one hides it.
 */
function flag(start: number, end: number, hide: boolean, spec = "outline"): void {
  // Positions outside the buffer are brought inside, as make-overlay does,
  // so folds that reached past an item, restored relative to its new
  // place, are cut short rather than failing.
  start = Math.min(Math.max(start, 0), ember.bufferSize());
  end = Math.min(Math.max(end, start), ember.bufferSize());
  for (const id of ember.overlaysIn(start, end)) {
    if (ember.overlayGet(id, "invisible") !== spec) continue;
    const [from, to] = [ember.overlayStart(id) ?? start, ember.overlayEnd(id) ?? end];
    ember.deleteOverlay(id);
    if (from < start) hideOverlay(from, start, spec);
    if (to > end) hideOverlay(end, to, spec);
  }
  if (hide && end > start) hideOverlay(start, end, spec);
}

const FOLD_SPECS = ["outline", "org-hide-drawer", "org-hide-block"];

/** Whether a heading, drawer or block fold hides the character at pos, or one with `spec` if given. */
function folded(pos: number, spec?: string): boolean {
  return ember.overlaysAt(pos).some((id) => {
    const value = ember.overlayGet(id, "invisible");
    return spec === undefined ? FOLD_SPECS.includes(String(value)) : value === spec;
  });
}

/** Shows a heading's own line, as org-fold-heading does. */
function showHeadingLine(h: Heading): void {
  flag(Math.max(0, h.start - 1), h.end, false);
}

/** Shows a heading's line and its text up to the next heading, as org-fold-show-entry does. */
function showEntry(all: Heading[], i: number): void {
  flag(Math.max(0, all[i].start - 1), entryEnd(all, i), false);
}

/**
 * Shows the heading lines of a heading's children, as org-fold-show-children
 * does: the shallowest headings under it, and any as deep as the first one
 * if that is deeper. Returns whether it has any.
 */
function showChildren(all: Heading[], i: number): boolean {
  const parent = all[i].level;
  const next = nextSameOrHigher(all, i);
  const end = next ? next.start : ember.bufferSize();
  showHeadingLine(all[i]);
  let min = Infinity;
  let max = Infinity;
  let any = false;
  for (let k = i + 1; k < all.length; k++) {
    const h = all[k];
    if (h.start >= end) break;
    if (h.level > max) continue;
    if (h.level < min) {
      min = h.level;
      max = Math.max(min, parent + 1);
    }
    showHeadingLine(h);
    any = true;
  }
  return any;
}

/** The headings above heading i, nearest first. */
function ancestors(all: Heading[], i: number): number[] {
  const found: number[] = [];
  let level = all[i].level;
  // No heading is above a top-level one.
  for (let j = i - 1; j >= 0 && level > 1; j--) {
    if (all[j].level < level) {
      found.push(j);
      level = all[j].level;
    }
  }
  return found;
}

/**
 * Shows blank lines before headings and at the end of the buffer after a
 * change of folding, as org-cycle-show-empty-lines does from org-cycle-hook.
 * `state` is the new state, and for "folded" and "children" the lines are
 * those of the subtree point is in.
 */
/**
 * Where the blank lines before headings are, as showEmptyLines' search
 * finds them for one or two separator lines, from the heading index and
 * the lines matchingLines finds in one pass in the editor: for each, from
 * the end of the line before the last blank one to the space after the
 * stars. Undefined where the search must be done on the text, as for
 * other counts or a range starting partway through a line.
 */
function separatorLines(range: [number, number], k: number): [number, number][] | undefined {
  if ((k !== 1 && k !== 2) || ember.lineStart(lineAt(range[0])) !== range[0]) return undefined;
  const all = headings();
  const headingOn = (line: number): Heading | undefined => {
    let [lo, hi] = [0, all.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].line < line) lo = mid + 1;
      else hi = mid;
    }
    return all[lo]?.line === line ? all[lo] : undefined;
  };
  const pattern = k === 2 ? "^[ \t]*\n[ \t]*\n\\*+ " : "^[ \t]*\n\\*+ ";
  const found: [number, number][] = [];
  for (const [line, start, text] of ember.matchingLines(pattern, { caseFold: false, start: range[0], end: range[1] })) {
    const h = headingOn(line + k);
    if (!h) continue;
    // From the newline before the last blank line: for one separator line, the one before it.
    const b = k === 2 ? start + charCount(text) : start - 1;
    if (b >= range[0]) found.push([b, h.start + h.level]);
  }
  return found;
}

function showEmptyLines(state: string, narrowed?: [number, number]): void {
  const n = Number(ember.variable("org-cycle-separator-lines") ?? 2);
  let range: [number, number] | undefined;
  if (["overview", "contents", "t"].includes(state)) range = narrowed ?? [0, ember.bufferSize()];
  else if (state === "children" || state === "folded") {
    const all = headings();
    const i = headingIndex(all, lineAt());
    const next = i === undefined ? undefined : nextSameOrHigher(all, i);
    const to = next ? (next.line + 1 < ember.lineCount() ? ember.lineStart(next.line + 1) : ember.bufferSize()) : ember.bufferSize();
    range = [ember.point(), to];
  }
  if (n !== 0 && range) {
    const k = Math.abs(n);
    const fast = separatorLines(range, k);
    const re =
      k === 1
        ? /(\n[ \t]*\n\*+) /g
        : k === 2
          ? /^[ \t]*(\n[ \t]*\n\*+) /gm
          : new RegExp(`^(?:[ \\t]*\\n){${k - 2}}[ \\t]*(\\n[ \\t]*\\n\\*+) `, "gm");
    const text = fast ? "" : ember.bufferText(range[0], range[1]);
    const shown: [number, number][] = fast?.filter(([, e]) => !ember.invisibleAt(e)) ?? [];
    // Characters counted on from the last match, not from the start each time.
    let [counted, chars] = [0, 0];
    for (let m = fast ? null : re.exec(text); m; m = re.exec(text)) {
      const at = m.index + m[0].length - 1;
      chars += charCount(text.slice(counted, at));
      counted = at;
      const e = range[0] + chars;
      const b = e - charCount(m[1]);
      if (!ember.invisibleAt(e)) shown.push([b, e]);
    }
    for (const [b, e] of shown) {
      if (n >= 0) flag(b, e, false);
      else {
        // A negative count shows all the blank lines.
        let l = lineAt(b);
        while (l > 0 && isBlank(ember.lineText(l))) l--;
        flag(ember.lineEnd(l), e, false);
      }
    }
  }
  // Never hide empty lines at the end of the file.
  const size = narrowed ? narrowed[1] : ember.bufferSize();
  const all = headings();
  const lastAt = firstHeadingFrom(all, size) - 1;
  const last = lastAt >= 0 && all[lastAt].start >= (narrowed?.[0] ?? 0) ? all[lastAt] : undefined;
  const eoh = last ? last.end : ember.lineEnd(lineAt(narrowed?.[0] ?? 0));
  if (eoh < size && /^[ \t\n]+$/.test(ember.bufferText(eoh, size))) flag(eoh, size, false);
}

/** Where the text hidden from the line after `line` ends, as org-cycle-internal-local finds it. */
function endOfHidden(line: number): number {
  const size = ember.bufferSize();
  let p = line + 1 < ember.lineCount() ? ember.lineStart(line + 1) : size;
  while (p < size && folded(p - 1)) {
    while (p < size && folded(p) === folded(p - 1)) p++;
    if (p < size && p === ember.lineEnd(lineAt(p))) p = lineAt(p) + 1 < ember.lineCount() ? ember.lineStart(lineAt(p) + 1) : size;
  }
  return p;
}

/** Cycles a heading's subtree, as org-cycle-internal-local does. */
/**
 * Cycles heading i's subtree, as org-cycle-internal-local does. Org works
 * out the subtree from the heading that shows, but shows the children view
 * around point, which may be on a hidden heading `at` below it.
 */
function cycleHeading(all: Heading[], i: number, at = i): void {
  const h = all[i];
  const eoh = h.end;
  const eos = subtreeEnd(all, i);
  const hasChildren = all[i + 1] !== undefined && all[i + 1].level > h.level;
  const eol = endOfHidden(h.line);
  const again = ember.lastCommand() === ember.thisCommand();
  const status = ember.variable("org-cycle-subtree-status");
  let skipped = false;
  /** Shows the heading after the subtree if it is hidden. */
  const showFollowing = (): void => {
    const next = findFrom(all, i + 1, (x) => x.start > eos);
    if (next && ember.invisibleAt(next.start)) showHeadingLine(next);
  };
  if (eos === eoh) {
    ember.message("EMPTY ENTRY");
    ember.setVariable("org-cycle-subtree-status", null);
    showFollowing();
    return;
  }
  const hiddenInOneLine = eol >= eos || /^\s*$/.test(ember.bufferText(eol, eos));
  if (hiddenInOneLine && !hasChildren) skipped = true;
  if (hiddenInOneLine && hasChildren) {
    showEntry(all, at);
    showChildren(all, at);
    showHeadingLine(all[at]);
    for (const a of ancestors(all, at)) {
      showHeadingLine(all[a]);
      showChildren(all, a);
    }
    ember.message("CHILDREN");
    const next = findFrom(all, i + 1, (x) => x.start > eos);
    if (next && next.start < ember.bufferSize() && ember.invisibleAt(next.start)) showHeadingLine(next);
    ember.setVariable("org-cycle-subtree-status", "children");
    showEmptyLines("children");
  } else if (skipped || (again && status === "children")) {
    flag(eoh, eos, false);
    ember.message(skipped ? "SUBTREE (NO CHILDREN)" : "SUBTREE");
    ember.setVariable("org-cycle-subtree-status", "subtree");
    showEmptyLines("subtree");
  } else {
    flag(eoh, eos, true);
    ember.message("FOLDED");
    ember.setVariable("org-cycle-subtree-status", "folded");
    showEmptyLines("folded");
  }
}

/** Hides the drawers before the first heading, as overview and contents do. */
function hideTopDrawers(): void {
  const first = headings()[0];
  const end = first ? first.line : ember.lineCount();
  // From the start of the accessible portion, as org-cycle-hide-drawers.
  for (let line = lineAt(ember.pointMin()); line < end; line++) {
    const m = DRAWER.exec(ember.lineText(line));
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

/** Shows only the top-level headings, as org-cycle-overview does. */
function overview(): void {
  hideTopDrawers();
  const all = headings();
  if (all.length === 0) return;
  let last = all[0].end;
  let level = all[0].level;
  for (const h of all.slice(1)) {
    if (h.level > level) continue;
    flag(last, h.start - 1, true);
    last = h.end;
    level = h.level;
  }
  // Up to the end of the accessible portion, where Org's search stops.
  flag(last, ember.pointMax(), true);
}

/** Shows the headings up to a level, or all of them, as org-cycle-content does. */
function showLevels(levels: number): void {
  flag(ember.pointMin(), ember.pointMax(), false);
  hideTopDrawers();
  let last = ember.pointMax();
  for (const h of [...headings()].reverse()) {
    if (h.level > levels) continue;
    flag(h.end, last, true);
    last = Math.max(0, h.start - 1);
  }
}

function contents(): void {
  showLevels(Infinity);
}

/** Cycles the whole buffer, as org-cycle-internal-global does. */
function globalCycle(): void {
  const again = ember.lastCommand() === ember.thisCommand();
  const status = ember.variable("org-cycle-global-status");
  if (again && status === "overview") {
    contents();
    ember.message("CONTENTS...done");
    ember.setVariable("org-cycle-global-status", "contents");
    showEmptyLines("contents");
  } else if (again && status === "contents") {
    flag(0, ember.bufferSize(), false);
    flag(0, ember.bufferSize(), false, "org-hide-block");
    ember.message("SHOW ALL");
    ember.setVariable("org-cycle-global-status", "all");
    showEmptyLines("all");
  } else {
    overview();
    ember.message("OVERVIEW");
    ember.setVariable("org-cycle-global-status", "overview");
    showEmptyLines("overview");
  }
}

/**
 * Shows what is around a position: its entry, any fold it is in, and the
 * next heading, as org-fold-show-set-visibility does for `local`.
 */
function showAround(pos: number): void {
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i === undefined) flag(0, all[0]?.start ?? ember.bufferSize(), false);
  else showEntry(all, i);
  if (ember.invisibleAt(pos)) {
    for (const id of ember.overlaysAt(pos)) {
      const spec = String(ember.overlayGet(id, "invisible"));
      if (FOLD_SPECS.includes(spec)) flag(ember.overlayStart(id) ?? pos, ember.overlayEnd(id) ?? pos, false, spec);
    }
  }
  if (i !== undefined) {
    const next = all.find((h) => h.start > pos);
    if (next) showHeadingLine(next);
  }
}

/**
 * Stops an edit next to folded text, or unfolds it first, as
 * org-fold-check-before-invisible-edit does. `kind` is "insert", "delete"
 * or "delete-backward".
 */
function checkBeforeInvisibleEdit(kind: string): void {
  const mode = ember.variable("org-fold-catch-invisible-edits");
  const p = ember.point();
  if (!mode || !(ember.invisibleAt(p) || ember.invisibleAt(Math.max(0, p - 1)))) return;
  const atPoint = folded(p);
  const beforePoint = p > 0 && folded(p - 1);
  if (!atPoint && !beforePoint) return;
  if (mode === "error") throw new Error("Editing in invisible areas is prohibited, make them visible first");
  showAround(p);
  if (beforePoint) showAround(p - 1);
  const predictable = atPoint && !beforePoint && (kind === "insert" || kind === "delete-backward");
  if (mode === "show" || (mode === "smart" && predictable)) ember.message("Unfolding invisible region around point before editing");
  else throw new Error("Edit in invisible region aborted, repeat to confirm with text visible");
}

/** The commands checked before they edit next to folded text, as in org-fold-catch-invisible-edits-commands. */
const INVISIBLE_EDIT_COMMANDS: { [command: string]: string } = {
  "org-self-insert-command": "insert",
  "org-delete-backward-char": "delete-backward",
  "org-delete-char": "delete",
  "org-meta-return": "insert",
  "org-return": "insert",
};

/** Checks the command being run, if it is one of those, as Org's advice on them does. */
function checkInvisibleEditMaybe(): void {
  const kind = INVISIBLE_EDIT_COMMANDS[ember.thisCommand() ?? ""];
  if (kind) checkBeforeInvisibleEdit(kind);
}

ember.defineCommand({
  name: "org-fold-check-before-invisible-edit-maybe",
  doc: "Stop or unfold before an edit next to folded text, if the running command is one Org checks.",
  run: () => checkInvisibleEditMaybe(),
});

/**
 * Unfolds folds near a change that no longer match what they hide, as
 * Org's fragile folding specs do from after-change-functions: a subtree
 * fold must follow a heading or item line and never hides a top-level
 * heading, and a drawer or block fold must still run from its first line
 * to its last.
 */
function foldsAfterChange(beg: number, end: number): void {
  fixFoldsAround(beg, end);
}

/** Whether edits skip the fold checks, as org-fold-core-ignore-modifications makes them. */
let foldChecksOff = false;

/** Runs body with no fold checks after its edits, as Org's org-fold-core-ignore-modifications does. */
function withoutFoldChecks<T>(body: () => T): T {
  const was = foldChecksOff;
  foldChecksOff = true;
  try {
    return body();
  } finally {
    foldChecksOff = was;
  }
}

/** Checks the folds near a change, as org-fold-core--fix-folded-region does after each one. */
function fixFoldsAround(from: number, to: number): void {
  if (foldChecksOff) return;
  const a = ember.lineStart(Math.max(0, lineAt(from) - 1));
  const b = lineStartOrEnd(lineAt(to) + 2);
  for (const id of ember.overlaysIn(a, b)) checkFold(id);
}

/** Unfolds a fold that no longer matches what it hides. */
/**
 * Shows a line from the newline before it, as org-fold--reveal-headline-at-point
 * does. Blank lines after it would show too, but Org compares their end
 * with what skip-chars-forward returns after org-end-of-subtree, a count
 * of characters, so they rarely do.
 */
function revealHeadlineAt(line: number): void {
  const size = ember.bufferSize();
  const blank = /[\n\t\r ]/;
  const endl = ember.lineEnd(line);
  let q = endl;
  while (q < size && blank.test(ember.bufferText(q, q + 1))) q++;
  const all = headings();
  const i = headingIndex(all, line);
  let skipped = -1;
  if (i !== undefined) {
    let e = nextSameOrHigher(all, i)?.start ?? size;
    for (let k = 0; k < 2 && e > 0 && /[\n\r]/.test(ember.bufferText(e - 1, e)); k++) e--;
    skipped = 0;
    while (e + skipped < size && blank.test(ember.bufferText(e + skipped, e + skipped + 1))) skipped++;
  }
  flag(Math.max(0, ember.lineStart(line) - 1), q + 1 === skipped ? q : endl, false);
}

function checkFold(id: number): void {
  const spec = String(ember.overlayGet(id, "invisible"));
  if (!FOLD_SPECS.includes(spec)) return;
  let start = ember.overlayStart(id);
  let end = ember.overlayEnd(id);
  if (start === undefined || end === undefined) return;
  // Folds that touch make one region, as Org's text-property folds do.
  const ids = [id];
  for (let grew = true; grew; ) {
    grew = false;
    const near: number[] = ember.overlaysIn(Math.max(0, start - 1), Math.min(ember.bufferSize(), end + 1));
    for (const other of near) {
      if (ids.includes(other) || ember.overlayGet(other, "invisible") !== spec) continue;
      const s0: number = ember.overlayStart(other) ?? start;
      const e0: number = ember.overlayEnd(other) ?? end;
      if (e0 < start || s0 > end) continue;
      ids.push(other);
      [start, end] = [Math.min(start, s0), Math.max(end, e0)];
      grew = true;
    }
  }
  const size = ember.bufferSize();
  // Org's checks step back from the fold's start, which fails there.
  if (start === 0) throw new Error("Beginning of buffer");
  const before = lineAt(Math.max(0, start - 1));
  const opener = ember.lineText(before);
  const lastLine = lineAt(end);
  let valid: boolean;
  if (spec === "outline") {
    // The line before the fold shows whole, as org-fold--reveal-outline-maybe
    // makes sure first, unless it is folded itself.
    const openerStart = ember.lineStart(before);
    if (!folded(openerStart, "outline")) {
      revealHeadlineAt(before);
      start = Math.max(start, ember.lineEnd(before));
    }
    valid = start > 0 && (ITEM_RE.test(opener) || /^\*+ /.test(opener));
    if (valid) {
      // A top-level heading is never hidden, nor one partly hidden at the end.
      for (let l = before + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
        if (/^\* /.test(ember.lineText(l))) revealHeadlineAt(l);
      }
      // The heading on the line where the fold ends shows.
      if (isHeadingLine(ember.lineText(lastLine)) && !folded(ember.lineStart(lastLine), "outline")) revealHeadlineAt(lastLine);
    }
  } else {
    const block = /^[ \t]*#\+begin(?::|_(\S+))/i.exec(opener);
    const close =
      spec === "org-hide-drawer"
        ? /^[ \t]*:END:[ \t]*$/i
        : new RegExp(`^[ \\t]*#\\+end${block?.[1] ? `_${block[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$` : ":?[ \\t]*$"}`, "i");
    valid = start > 0 && (spec === "org-hide-drawer" ? DRAWER_RE.test(opener) : block !== null) && close.test(ember.lineText(lastLine));
    for (let l = before + 1; valid && l < lastLine; l++) {
      if (close.test(ember.lineText(l)) || isHeadingLine(ember.lineText(l))) valid = false;
    }
  }
  if (!valid) revealAfterCommand(start, end);
}

/**
 * Regions to show once the command is over, each held by an overlay that
 * hides nothing, so it moves with the text as Org's markers do.
 */
let delayedReveals: number[] = [];

/**
 * Shows a region, every kind of fold in it, once the command is over, as
 * org-fold-core--region-delayed does: Org's fragility checks run from
 * after-change-functions, and commands may assume those leave what shows
 * alone.
 */
function revealAfterCommand(start: number, end: number): void {
  delayedReveals.push(ember.makeOverlay(start, end));
}

ember.addHook("post-command-hook", () => {
  const ids = delayedReveals;
  delayedReveals = [];
  for (const id of ids) {
    const [start, end] = [ember.overlayStart(id), ember.overlayEnd(id)];
    ember.deleteOverlay(id);
    if (start === undefined || end === undefined || start >= end) continue;
    for (const spec of FOLD_SPECS) flag(start, end, false, spec);
  }
});

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

/** The line opening the drawer or block a closing line ends, if it is one. */
function openerOf(line: number): number | undefined {
  const text = ember.lineText(line);
  const end = BLOCK_END.exec(text);
  if (!end && !/^[ \t]*:END:[ \t]*$/i.test(text)) return undefined;
  for (let l = line - 1; l >= 0; l--) {
    const t = ember.lineText(l);
    if (isHeadingLine(t)) return undefined;
    if (end ? BLOCK_BEGIN.test(t) : DRAWER.test(t) && !/^[ \t]*:END:/i.test(t)) return closingLine(l) === line ? l : undefined;
    if (!end && /^[ \t]*:END:/i.test(t)) return undefined;
  }
  return undefined;
}

/** Folds the drawers whose first lines are from a line up to a position, as org-fold--hide-drawers does. */
function hideDrawersIn(fromLine: number, to: number): void {
  for (let line = fromLine; line < ember.lineCount() && ember.lineStart(line) < to; line++) {
    const m = DRAWER.exec(ember.lineText(line));
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

function hideAllDrawers(): void {
  // The lines of the accessible portion that can open a drawer, found in one pass.
  const lines = ember.matchingLines("^[ \t]*:[-_[:alnum:]]+:[ \t]*$", { caseFold: false });
  for (const [line, , text] of lines) {
    const m = DRAWER.exec(text);
    if (m && m[1].toUpperCase() !== "END") toggleDrawerOrBlock(line, true);
  }
}

/** Folds the buffer as org-startup-folded or a #+STARTUP: line says. */
function startupVisibility(): void {
  let how = String(ember.variable("org-startup-folded") ?? "showeverything");
  for (const [, , text] of keywordLines()) {
    const m = /^#\+STARTUP:(.*)$/i.exec(text);
    for (const word of m ? m[1].trim().split(/\s+/) : []) {
      if (/^(overview|fold|content|showall|nofold|showeverything|show[2-5]levels)$/.test(word)) how = word;
    }
  }
  if (how === "showeverything") return;
  if (how === "overview" || how === "fold") overview();
  else if (how === "content") contents();
  else if (/^show[2-5]levels$/.test(how)) showLevels(Number(how[4]));
  hideAllDrawers();
  showEmptyLines("t");
}

// Plain lists, after org-list.el. A list is read into a structure, an
// array of its items with their indentation, bullet, counter, checkbox,
// description tag and end, which commands change and then write back,
// fixing bullets, indentation and checkboxes across the whole list as
// org-list-write-struct does.

interface ListItem {
  /** Where the item's line starts. */
  pos: number;
  ind: number;
  /** The bullet with the spaces after it, such as "- " or "1. ". */
  bullet: string;
  counter?: string;
  checkbox?: string;
  tag?: string;
  /** Where the item ends: the start of the line after its last, or of the next item. */
  end: number;
}

type Struct = ListItem[];
type Alist = Map<number, number | undefined>;

/** org-item-re, at the start of a line. */
const ITEM_RE = /^(?:[ \t]*(?:[-+]|\d+[.)])|[ \t]+\*)(?:[ \t]+|$)/;
const DRAWER_RE = /^[ \t]*:((?:\w|[-_])+):[ \t]*$/;
const LIST_FORBIDDEN_BLOCKS = ["example", "verse", "src", "export"];

/** The column a line's text starts at, counting tabs to tab stops, as org-current-text-indentation does. */
function textIndentation(text: string): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col = (Math.floor(col / 8) + 1) * 8;
    else break;
  }
  return col;
}

/** The whitespace that indents to a column, with tabs if indent-tabs-mode is on. */
function indentString(col: number, from = 0): string {
  // As indent-to does, a column at or before where it starts adds nothing.
  if (col <= from) return "";
  if (ember.variable("indent-tabs-mode") === true) {
    const width = Number(ember.variable("tab-width") ?? 8);
    let s = "";
    let c = from;
    while (Math.floor(c / width) < Math.floor(col / width)) {
      s += "\t";
      c = (Math.floor(c / width) + 1) * width;
    }
    return s + " ".repeat(col - c);
  }
  return " ".repeat(Math.max(0, col - from));
}

function lineStartOrEnd(line: number): number {
  return line < ember.lineCount() ? ember.lineStart(line) : ember.bufferSize();
}


/**
 * Replaces text as replace-match does: markers inside it go to its start,
 * and those at its end or after move with the text after it.
 */
function edReplace(from: number, to: number, text: string): void {
  const n = charCount(text);
  const delta = n - (to - from);
  const mark = ember.mark();
  const saved: [Marker, number][] = markers.map((m) => [m, m.pos]);
  // One change, as replace-match is, so folds are checked once, after it.
  const checks = !foldChecksOff;
  withoutFoldChecks(() => {
    ember.deleteRegion(from, to);
    ember.gotoChar(from);
    ember.insert(text);
  });
  const moved = (x: number): number => (x >= to ? x + delta : x > from ? from : x);
  placeMarkers(saved.map(([m, p]) => [m, moved(p)]));
  if (mark !== undefined) ember.setMark(moved(mark));
  if (checks) fixFoldsAround(from, from + n);
}

/** Sets a line's indentation, as indent-line-to does: only the difference is inserted or deleted. */
function indentLineTo(line: number, col: number): void {
  const ls = ember.lineStart(line);
  const ws = /^[ \t]*/.exec(ember.lineText(line))?.[0] ?? "";
  const end = ls + charCount(ws);
  const cur = textIndentation(ws);
  const width = Number(ember.variable("tab-width") ?? 8);
  if (cur < col) {
    let from = cur;
    let at = end;
    if (col - Math.floor(cur / width) * width >= width) {
      const spaces = / *$/.exec(ws)?.[0].length ?? 0;
      edDelete(end - spaces, end);
      at = end - spaces;
      from = textIndentation(ws.slice(0, ws.length - spaces));
    }
    edInsert(at, indentString(col, from));
  } else if (cur > col) {
    // move-to-column with force: a tab it lands inside becomes spaces.
    let c = 0;
    let i = 0;
    while (i < ws.length) {
      const next = ws[i] === "\t" ? (Math.floor(c / 8) + 1) * 8 : c + 1;
      if (next > col) {
        if (c < col) {
          edDelete(ls + i, ls + i + 1);
          edInsert(ls + i, " ".repeat(next - c));
          edDelete(ls + i + (col - c), ls + charCount(/^[ \t]*/.exec(ember.lineText(line))?.[0] ?? ""));
          return;
        }
        break;
      }
      c = next;
      i++;
    }
    edDelete(ls + i, end);
  }
}

/**
 * The region lists are read in around a line, and what it is, as
 * org-list-context finds it: the section between headings, or a drawer or
 * block inside it. Lists are not recognized in example, verse, source and
 * export blocks.
 */
function listContext(line: number): { up: number; down: number; type?: string } {
  const pos = ember.lineStart(line);
  const all = headings();
  const h = headingIndex(all, line);
  let up = h === undefined ? 0 : all[h].start;
  let down = all.find((x) => x.start > pos)?.start ?? ember.bufferSize();
  let type: string | undefined;
  const text = ember.lineText(line);
  const upLine = lineAt(up);
  const downLine = lineAt(down);
  if (!DRAWER_RE.test(text) && !/^[ \t]*:END:/i.test(text)) {
    let beg: number | undefined;
    for (let l = line - 1; l >= upLine && ember.lineStart(l) >= up; l--) {
      if (DRAWER_RE.test(ember.lineText(l))) {
        beg = l;
        break;
      }
    }
    if (beg !== undefined) {
      let end = down;
      for (let l = beg; l <= downLine && l < ember.lineCount(); l++) {
        if (ember.lineStart(l) >= down) break;
        if (/^[ \t]*:END:/i.test(ember.lineText(l))) {
          end = ember.lineStart(l) - 1;
          break;
        }
      }
      if (end >= pos) [up, down, type] = [ember.lineStart(beg + 1), end, "drawer"];
    }
  }
  const BLOCK = /^[ \t]*#\+(begin|end)_/i;
  if (!BLOCK.test(ember.lineText(line))) {
    let beg: number | undefined;
    for (let l = line - 1; l >= 0 && ember.lineStart(l) >= up; l--) {
      if (BLOCK.test(ember.lineText(l))) {
        beg = l;
        break;
      }
    }
    const open = beg === undefined ? null : /^[ \t]*#\+begin_(\S+)/i.exec(ember.lineText(beg));
    if (beg !== undefined && open) {
      let end = down;
      let closes = false;
      for (let l = beg + 1; l < ember.lineCount() && ember.lineStart(l) < down; l++) {
        const m = BLOCK.exec(ember.lineText(l));
        if (m) {
          end = ember.lineStart(l) - 1;
          closes = m[1].toLowerCase() === "end";
          break;
        }
      }
      if (end >= pos && closes) {
        [up, down] = [ember.lineStart(beg + 1), end];
        type = LIST_FORBIDDEN_BLOCKS.includes(open[1].toLowerCase()) ? "invalid" : "block";
      }
    }
  }
  return { up, down, type };
}

/** Whether a line and the one after it are blank, which ends a list (org-list-end-re). */
function atListEnd(line: number): boolean {
  return line + 1 < ember.lineCount() && isBlank(ember.lineText(line)) && isBlank(ember.lineText(line + 1));
}

/** Whether a line starts an item: org-at-item-p for that line. */
function itemLine(line: number): boolean {
  if (line < 0 || line >= ember.lineCount()) return false;
  if (!ITEM_RE.test(ember.lineText(line))) return false;
  return listContext(line).type !== "invalid";
}

/** The start of the item a line is in, if any, as org-in-item-p finds it. */
function inItem(line: number): number | undefined {
  const ctx = listContext(line);
  if (ctx.type === "invalid") return undefined;
  if (ITEM_RE.test(ember.lineText(line))) return ember.lineStart(line);
  let indRef = isBlank(ember.lineText(line)) ? 10000 : textIndentation(ember.lineText(line));
  let l = line;
  // Between the two blank lines that end a list, start from the first.
  if (l > 0 && atListEnd(l - 1)) l -= 2;
  else if (atListEnd(l)) l -= 1;
  for (;;) {
    if (l < 0) return undefined;
    const text = ember.lineText(l);
    const ind = textIndentation(text);
    if (ITEM_RE.test(text) && ind < indRef) return ember.lineStart(l);
    if (ember.lineStart(l) <= ctx.up) return undefined;
    if (atListEnd(l)) return undefined;
    if (/^[ \t]*#\+end_/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && ember.lineStart(k) >= ctx.up && !/^[ \t]*#\+begin_/i.test(ember.lineText(k))) k--;
      if (k >= 0 && ember.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (/^[ \t]*:END:/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && ember.lineStart(k) >= ctx.up && !DRAWER_RE.test(ember.lineText(k))) k--;
      if (k >= 0 && ember.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (isBlank(text)) {
      l--;
      continue;
    }
    if (ind === 0) return undefined;
    if (ind < indRef) indRef = ind;
    l--;
  }
}

/** Where the parts of an item's first line are, as org-list-full-item-re's groups find them. */
interface ItemParts {
  bulletAt: number;
  bullet: string;
  counter?: string;
  /** Just after the counter's closing bracket. */
  counterEnd?: number;
  checkbox?: string;
  boxAt?: number;
  tag?: string;
  tagAt?: number;
  tagEnd?: number;
  /** Where the whole match ends: after the bullet, counter, checkbox and tag. */
  matchEnd: number;
}

function itemParts(line: number): ItemParts | undefined {
  const text = ember.lineText(line);
  const base = ember.lineStart(line);
  const pos = (i: number): number => base + charCount(text.slice(0, i));
  const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
  let i = ws.length;
  const b = /^(?:[-+*]|(?:\d+|[A-Za-z])[.)])(?:[ \t]+|$)/.exec(text.slice(i));
  if (!b) return undefined;
  const parts: ItemParts = { bulletAt: pos(i), bullet: b[0], matchEnd: 0 };
  i += b[0].length;
  const c = /^\[@(?:start:)?(\d+|[A-Za-z])\][ \t]*/.exec(text.slice(i));
  if (c) {
    parts.counter = c[1];
    parts.counterEnd = pos(i + c[0].indexOf("]") + 1);
    i += c[0].length;
  }
  const x = /^(\[[ X-]\])(?:[ \t]+|$)/.exec(text.slice(i));
  if (x) {
    parts.checkbox = x[1];
    parts.boxAt = pos(i);
    i += x[0].length;
  }
  const d = /^(.*)[ \t]+::(?:[ \t]+|$)/.exec(text.slice(i));
  if (d) {
    parts.tag = d[1];
    parts.tagAt = pos(i);
    parts.tagEnd = pos(i + d[1].length);
    i += d[0].length;
  }
  parts.matchEnd = pos(i);
  return parts;
}

function readItem(line: number, ind: number): ListItem {
  const m = itemParts(line);
  const bullet = m?.bullet ?? "";
  return {
    pos: ember.lineStart(line),
    ind,
    bullet,
    counter: m?.counter,
    checkbox: m?.checkbox,
    tag: /[-+*]/.test(bullet) ? m?.tag : undefined,
    end: 0,
  };
}

/** The structure of the list the item on a line is in, as org-list-struct reads it. */
function listStruct(line: number, ctx: { up: number; down: number; type?: string } = listContext(line)): Struct {
  let textMinInd = 10000;
  let begCell: [number, number] = [ember.lineStart(line), textIndentation(ember.lineText(line))];
  let itmLst: Struct = [];
  const endLst: [number, number][] = [];
  const fromBeg = (): Struct => {
    const k = itmLst.findIndex((e) => e.pos === begCell[0]);
    return k < 0 ? [] : itmLst.slice(k);
  };
  // 1. Up from the item to the start of the list.
  for (let l = line; ; ) {
    const pos = ember.lineStart(l);
    const text = ember.lineText(l);
    const ind = textIndentation(text);
    if (pos <= ctx.up) {
      if (!ITEM_RE.test(text)) itmLst = fromBeg();
      else {
        begCell = [pos, ind];
        itmLst.unshift(readItem(l, ind));
      }
      break;
    }
    if (atListEnd(l)) {
      itmLst = fromBeg();
      break;
    }
    if (ITEM_RE.test(text)) {
      itmLst.unshift(readItem(l, ind));
      endLst.unshift([ind, pos]);
      if (ind < textMinInd) begCell = [pos, ind];
      l--;
      continue;
    }
    if (/^[ \t]*#\+end_/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && ember.lineStart(k) >= ctx.up && !/^[ \t]*#\+begin_/i.test(ember.lineText(k))) k--;
      if (k >= 0 && ember.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (/^[ \t]*:END:/i.test(text)) {
      let k = l - 1;
      while (k >= 0 && ember.lineStart(k) >= ctx.up && !DRAWER_RE.test(ember.lineText(k))) k--;
      if (k >= 0 && ember.lineStart(k) >= ctx.up) {
        l = k;
        continue;
      }
    }
    if (isBlank(text)) {
      l--;
      continue;
    }
    if (ind === 0) {
      itmLst = fromBeg();
      break;
    }
    if (ind < textMinInd) textMinInd = ind;
    endLst.unshift([ind, pos]);
    l--;
  }
  // 2. Down from the item to the end of the list.
  const itmLst2: Struct = [];
  const endLst2: [number, number][] = [];
  const endBeforeBlank = (pos: number): number => {
    let q = pos;
    while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
    return Math.min(ember.lineEnd(lineAt(q)) + 1, ctx.down);
  };
  for (let l = line; ; ) {
    const pos = lineStartOrEnd(l);
    if (pos >= ctx.down) {
      endLst2.unshift([0, endBeforeBlank(pos)]);
      break;
    }
    const text = ember.lineText(l);
    const ind = textIndentation(text);
    if (atListEnd(l)) {
      endLst2.unshift([0, pos]);
      break;
    }
    if (ITEM_RE.test(text)) {
      itmLst2.unshift(readItem(l, ind));
      endLst2.unshift([ind, pos]);
      l++;
      continue;
    }
    if (isBlank(text)) {
      l++;
      continue;
    }
    if (ind <= begCell[1]) {
      endLst2.unshift([0, endBeforeBlank(pos)]);
      break;
    }
    if (itmLst2.length > 0 && ind <= itmLst2[0].ind) endLst2.unshift([ind, pos]);
    if (/^[ \t]*#\+begin_/i.test(text)) {
      let k = l + 1;
      while (k < ember.lineCount() && lineStartOrEnd(k) < ctx.down && !/^[ \t]*#\+end_/i.test(ember.lineText(k))) k++;
      if (k < ember.lineCount() && lineStartOrEnd(k) < ctx.down) l = k;
    } else if (DRAWER_RE.test(text)) {
      let k = l + 1;
      while (k < ember.lineCount() && lineStartOrEnd(k) < ctx.down && !/^[ \t]*:END:/i.test(ember.lineText(k))) k++;
      if (k < ember.lineCount() && lineStartOrEnd(k) < ctx.down) l = k;
    }
    l++;
  }
  const struct = [...itmLst, ...itmLst2.reverse().slice(1)];
  assocEnd(struct, [...endLst, ...endLst2.reverse().slice(1)]);
  return struct;
}

/** Gives each item its end from candidate (indentation, position) ends, as org-list-struct-assoc-end does. */
function assocEnd(struct: Struct, endList: [number, number][]): void {
  let endings = endList;
  for (const e of struct) {
    while (endings.length > 0 && endings[0][1] <= e.pos) endings = endings.slice(1);
    e.end = endings.find(([ind]) => ind <= e.ind)?.[1] ?? e.end;
  }
}

function getItem(struct: Struct, pos: number): ListItem {
  const e = struct.find((x) => x.pos === pos);
  if (!e) throw new Error(`No item at ${pos}`);
  return e;
}

function prevsAlist(struct: Struct): Alist {
  // The first entry for a position wins, as assq finds it.
  const out: Alist = new Map();
  for (const e of struct) if (!out.has(e.pos)) out.set(e.pos, struct.find((x) => x.end === e.pos)?.pos);
  return out;
}

function parentsAlist(struct: Struct): Alist {
  let indToOri: [number, number | undefined][] = [[struct[0].ind, undefined]];
  const prevPos = [struct[0].pos];
  // A structure Org has just edited can hold two items at one position;
  // assq finds the first, so the first one's entry is kept here too.
  const out: Alist = new Map([[struct[0].pos, undefined]]);
  const set = out.set.bind(out);
  out.set = (key: number, value: number | undefined) => (out.has(key) ? out : set(key, value));
  for (const item of struct.slice(1)) {
    const prevInd = indToOri[0][0];
    prevPos.unshift(item.pos);
    if (prevInd > item.ind) {
      let k = indToOri.findIndex((e) => e[0] === item.ind);
      if (k < 0) k = indToOri.findIndex((e) => e[0] < item.ind);
      indToOri = k >= 0 ? indToOri.slice(k) : [[item.ind, undefined]];
      out.set(item.pos, indToOri[0][1]);
    } else if (prevInd < item.ind) {
      indToOri.unshift([item.ind, prevPos[1]]);
      out.set(item.pos, prevPos[1]);
    } else out.set(item.pos, indToOri[0][1]);
  }
  return out;
}

function nextItem(item: number, prevs: Alist): number | undefined {
  for (const [pos, prev] of prevs) if (prev === item) return pos;
  return undefined;
}

function prevItem(item: number, prevs: Alist): number | undefined {
  return prevs.get(item);
}

function itemEndBeforeBlank(struct: Struct, item: number): number {
  let q = getItem(struct, item).end;
  while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
  return ember.lineEnd(lineAt(q));
}

function hasChild(struct: Struct, item: number): number | undefined {
  const k = struct.findIndex((e) => e.pos === item);
  const next = struct[k + 1];
  return next && struct[k].ind < next.ind ? next.pos : undefined;
}

function subtreeItems(struct: Struct, item: number): number[] {
  const e = getItem(struct, item);
  return struct.filter((x) => x.pos > item && x.pos < e.end).map((x) => x.pos);
}

function allItems(item: number, prevs: Alist): number[] {
  const before: number[] = [];
  for (let p = prevItem(item, prevs); p !== undefined; p = prevItem(p, prevs)) before.unshift(p);
  const after: number[] = [];
  for (let n = nextItem(item, prevs); n !== undefined; n = nextItem(n, prevs)) after.push(n);
  return [...before, item, ...after];
}

function children(item: number, parents: Alist): number[] {
  return [...parents].filter(([, parent]) => parent === item).map(([pos]) => pos);
}

function bottomPoint(struct: Struct): number {
  return Math.max(...struct.map((e) => e.end));
}

function firstItem(item: number, prevs: Alist): number {
  let first = item;
  for (let p = prevItem(first, prevs); p !== undefined; p = prevItem(first, prevs)) first = p;
  return first;
}

function lastItem(item: number, prevs: Alist): number {
  let last = item;
  for (let n = nextItem(last, prevs); n !== undefined; n = nextItem(last, prevs)) last = n;
  return last;
}

function copyStruct(struct: Struct): Struct {
  return struct.map((e) => ({ ...e }));
}

function sameItem(a: ListItem | undefined, b: ListItem | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.pos === b.pos &&
    a.ind === b.ind &&
    a.bullet === b.bullet &&
    a.counter === b.counter &&
    a.checkbox === b.checkbox &&
    a.tag === b.tag &&
    a.end === b.end
  );
}

function sameStruct(a: Struct, b: Struct): boolean {
  return a.length === b.length && a.every((e, k) => sameItem(e, b[k]));
}

/** A bullet with one space after it, as org-list-bullet-string makes it. */
function bulletString(bullet: string): string {
  const m = /\S+([ \t]*)/.exec(bullet);
  if (!m) return bullet;
  const at = (m.index ?? 0) + m[0].length - m[1].length;
  return bullet.slice(0, at) + " " + bullet.slice(at + m[1].length);
}

function incBulletMaybe(bullet: string): string {
  const n = /\d+/.exec(bullet);
  if (n) return bullet.replace(/\d+/, String(Number(n[0]) + 1));
  const a = /[A-Za-z]/.exec(bullet);
  if (a) return bullet.replace(/[A-Za-z]/, String.fromCharCode(a[0].charCodeAt(0) + 1));
  return bullet;
}

/** Numbers ordered lists from 1 or their counters, and gives items their list's bullet, as org-list-struct-fix-bul does. */
function fixBul(struct: Struct, prevs: Alist): void {
  for (const e of struct) {
    const prev = prevItem(e.pos, prevs);
    const prevBul = prev === undefined ? undefined : getItem(struct, prev).bullet;
    const { counter, bullet } = e;
    let fixed: string;
    if (prevBul !== undefined && counter && /[a-zA-Z]/.test(counter) && /[a-zA-Z]/.test(prevBul)) {
      fixed = prevBul.replace(/[a-zA-Z]/, /[a-z]/.test(prevBul) ? counter.toLowerCase() : counter.toUpperCase());
    } else if (prevBul !== undefined && counter && /\d+/.test(counter) && /\d+/.test(prevBul)) {
      fixed = prevBul.replace(/\d+/, counter);
    } else if (prevBul !== undefined) {
      fixed = incBulletMaybe(prevBul);
    } else if (counter && /\d+/.test(counter) && /\d+/.test(bullet)) {
      fixed = bullet.replace(/\d+/, counter);
    } else if (/\d+|[A-Za-z]/.test(bullet)) {
      fixed = bullet.replace(/\d+|[A-Za-z]/, "1");
    } else fixed = bullet;
    e.bullet = bulletString(fixed);
  }
}

/** Indents items under their parents' text, or as the first item, as org-list-struct-fix-ind does. */
function fixInd(struct: Struct, parents: Alist, bulletSize?: number): void {
  const topInd = struct[0].ind;
  // By position, as Org goes, setting the first item there, as assq finds it.
  for (const { pos } of struct.slice(1)) {
    const e = getItem(struct, pos);
    const parent = parents.get(e.pos);
    if (parent === undefined) e.ind = topInd;
    else {
      const p = getItem(struct, parent);
      e.ind = (bulletSize ?? charCount(p.bullet)) + p.ind;
    }
  }
}

/** Gives parents with checkboxes the state of their children's, as org-list-struct-fix-box does. */
function fixBox(struct: Struct, parents: Alist): void {
  const parentList: number[] = [];
  for (const e of struct) {
    const parent = parents.get(e.pos);
    if (parent !== undefined && getItem(struct, parent).checkbox && !parentList.includes(parent)) parentList.unshift(parent);
  }
  parentList.sort((a, b) => getItem(struct, b).ind - getItem(struct, a).ind);
  for (const item of parentList) {
    const boxes = children(item, parents).map((c) => getItem(struct, c).checkbox);
    const e = getItem(struct, item);
    if (boxes.includes("[ ]") && boxes.includes("[X]")) e.checkbox = "[-]";
    else if (boxes.includes("[-]")) e.checkbox = "[-]";
    else if (boxes.includes("[X]")) e.checkbox = "[X]";
    else if (boxes.includes("[ ]")) e.checkbox = "[ ]";
  }
}

/** Works out items' ends again after their indentation changed, as org-list-struct-fix-item-end does. */
function fixItemEnd(struct: Struct): void {
  const endList: [number, number][] = [];
  const accEnd: [number, number][] = [];
  for (const e of struct) {
    if (!struct.some((x) => x.pos === e.end)) {
      const up = accEnd.find(([end]) => end > e.end)?.[1];
      endList.unshift([up !== undefined ? getItem(struct, up).ind + 2 : 0, e.end]);
    }
    endList.unshift([e.ind, e.pos]);
    accEnd.unshift([e.end, e.pos]);
  }
  endList.sort((a, b) => a[1] - b[1]);
  assocEnd(struct, endList);
}

/** Writes the differences between a structure and the old one to the buffer, as org-list-struct-apply-struct does. */
function applyStruct(struct: Struct, old: Struct): void {
  const origin = marker(ember.point());
  const shiftBodyInd = (end: number, beg: number, delta: number): void => {
    let q = end;
    while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
    let l = lineAt(q);
    while (ember.lineStart(l) > beg || (ember.lineStart(l) === beg && !ITEM_RE.test(ember.lineText(l)))) {
      const text = ember.lineText(l);
      if (/^[ \t]*\S/.test(text)) indentLineTo(l, textIndentation(text) + delta);
      if (l === 0) break;
      l--;
    }
  };
  const modifyItem = (item: number): void => {
    const e = getItem(struct, item);
    const line = lineAt(item);
    const newBul = bulletString(e.bullet);
    const reindent = (): void => {
      if (e.ind !== textIndentation(ember.lineText(line))) {
        const ls = ember.lineStart(line);
        const ws = /^[ \t]*/.exec(ember.lineText(line))?.[0] ?? "";
        edDelete(ls, ls + charCount(ws));
        edInsert(ls, indentString(e.ind));
      }
    };
    // Org's structure can hold a position partway along a line, which its
    // anchored regexp then fails to match: only the indentation, worked out
    // from the line's start, changes.
    if (item !== ember.lineStart(line)) {
      reindent();
      return;
    }
    let m = itemParts(line);
    if (!m) return;
    if (getItem(old, item).bullet !== newBul) {
      const bulletEnd = m.bulletAt + charCount(m.bullet);
      let keep = "";
      if (m.bulletAt <= origin.pos && origin.pos <= bulletEnd) {
        keep = /^[ \t]+/.exec(ember.bufferText(origin.pos, ember.lineEnd(line)))?.[0] ?? "";
      }
      edDelete(m.bulletAt, bulletEnd);
      edInsert(m.bulletAt, newBul, true);
      edInsert(m.bulletAt + charCount(newBul), keep);
    }
    m = itemParts(line);
    if (!m) return;
    if (m.checkbox === e.checkbox) {
      // The checkbox is right.
    } else if (m.checkbox !== undefined && e.checkbox !== undefined && m.boxAt !== undefined) {
      edReplace(m.boxAt, m.boxAt + 3, e.checkbox);
    } else if (m.checkbox !== undefined) {
      // The box goes, with the spaces before it.
      const text = ember.lineText(line);
      for (let k = 0; k < text.length; k++) {
        const box = /^[ \t]*\[[ X-]\]/.exec(text.slice(k));
        if (box) {
          const start = item + charCount(text.slice(0, k));
          edDelete(start, start + charCount(box[0]));
          break;
        }
      }
    } else if (e.checkbox !== undefined) {
      const at = m.counterEnd ?? m.bulletAt + charCount(m.bullet);
      edInsert(at, e.checkbox + (m.counterEnd !== undefined ? "" : " "));
    }
    reindent();
  };
  const endList: [number, number | undefined][] = [];
  let accEnd: [number, number][] = [];
  const itmShift = new Map<number, number>();
  for (const { pos } of old) {
    // Looked up by position, as Org does with assq, so two items at one
    // position both read the first.
    const now = getItem(struct, pos);
    const was = getItem(old, pos);
    itmShift.set(pos, now.ind + charCount(now.bullet) - (was.ind + charCount(was.bullet)));
    if (!old.some((x) => x.pos === was.end)) {
      const up = accEnd.find(([end]) => end > was.end)?.[1];
      endList.unshift([was.end, up]);
    }
    accEnd.unshift([was.end, pos]);
  }
  // Only the ends that are not at items are made unique, as in Org.
  const allEnds = [...old.map((e) => e.pos), ...new Set(endList.map(([end]) => end))].sort((a, b) => a - b);
  accEnd = accEnd.reverse();
  const sliced: [number, number, number][] = [];
  while (allEnds.length > 1) {
    const up = allEnds.shift() as number;
    const down = allEnds[0];
    let delta: number;
    if (struct.some((x) => x.pos === up)) delta = itmShift.get(up) ?? 0;
    else {
      const child = accEnd.find(([end]) => end === up)?.[1];
      const ind = child === undefined ? 0 : getItem(struct, child).ind;
      let minInd = Infinity;
      for (let l = lineAt(up); l < ember.lineCount() && ember.lineStart(l) < down; l++) {
        const text = ember.lineText(l);
        if (isBlank(text)) continue;
        minInd = Math.min(minInd, textIndentation(text));
        const block = /^#\+BEGIN(:|_\S+)/i.exec(text);
        if (block) {
          const close = new RegExp(`^[ \\t]*#\\+END${block[1].replace(/[^\w:]/g, "")}[ \\t]*$`, "i");
          for (let k = l + 1; k < ember.lineCount() && ember.lineStart(k) < down; k++) {
            if (close.test(ember.lineText(k))) {
              l = k;
              break;
            }
          }
        } else if (DRAWER_RE.test(text)) {
          for (let k = l + 1; k < ember.lineCount() && ember.lineStart(k) < down; k++) {
            if (/^[ \t]*:END:[ \t]*$/i.test(ember.lineText(k))) {
              l = k;
              break;
            }
          }
        }
      }
      delta = minInd === Infinity ? 0 : ind - minInd;
    }
    sliced.unshift([down, up, delta]);
  }
  for (const [down, up, delta] of sliced) {
    if (delta !== 0) shiftBodyInd(down, up, delta);
    const cell = struct.find((x) => x.pos === up);
    if (cell && !sameItem(cell, old.find((x) => x.pos === up))) modifyItem(up);
  }
  ember.gotoChar(origin.pos);
  dropMarker(origin);
}

/** Fixes a list's bullets, indentation and checkboxes and writes it back, as org-list-write-struct does. */
function writeStruct(struct: Struct, parents: Alist, old?: Struct): Struct {
  const reference = old ?? copyStruct(struct);
  fixInd(struct, parents, 2);
  fixItemEnd(struct);
  const prevs = prevsAlist(struct);
  fixBul(struct, prevs);
  fixInd(struct, parents);
  fixBox(struct, parents);
  applyStruct(struct, reference);
  return struct;
}

/** Swaps two items of a sub-list, leaving their blank lines where they were, as org-list-swap-items does. */
function swapItems(begA: number, begB: number, struct: Struct): Struct {
  return withoutFoldChecks(() => swapItemsChecked(begA, begB, struct));
}

function swapItemsChecked(begA: number, begB: number, struct: Struct): Struct {
  const p = marker(ember.point());
  const endANoBlank = itemEndBeforeBlank(struct, begA);
  const endBNoBlank = itemEndBeforeBlank(struct, begB);
  const endA = getItem(struct, begA).end;
  const endB = getItem(struct, begB).end;
  const sizeA = endANoBlank - begA;
  const sizeB = endBNoBlank - begB;
  const bodyA = ember.bufferText(begA, endANoBlank);
  const bodyB = ember.bufferText(begB, endBNoBlank);
  const between = ember.bufferText(endANoBlank, begB);
  const subA = [begA, ...subtreeItems(struct, begA)];
  const subB = [begB, ...subtreeItems(struct, begB)];
  // Folds inside the items move with them.
  const folds = (from: number, to: number): [number, number, string][] =>
    ember
      .overlaysIn(from, to)
      .filter((id) => FOLD_SPECS.includes(String(ember.overlayGet(id, "invisible"))))
      .map((id) => [(ember.overlayStart(id) ?? from) - from, (ember.overlayEnd(id) ?? from) - from, String(ember.overlayGet(id, "invisible"))]);
  const foldsA = folds(begA, endA);
  const foldsB = folds(begB, endB);
  for (const spec of FOLD_SPECS) flag(begA, endBNoBlank, false, spec);
  edDelete(begA, endBNoBlank);
  edInsert(begA, bodyB + between + bodyA);
  for (const [s, e, spec] of foldsB) flag(begA + s, begA + e, true, spec);
  const at = begA + sizeB + charCount(between);
  for (const [s, e, spec] of foldsA) flag(at + s, at + e, true, spec);
  for (const e of struct) {
    const { pos, end } = e;
    if (pos < begA) continue;
    if (subA.includes(pos)) {
      e.pos = pos + (endBNoBlank - endANoBlank);
      e.end = end === endA ? endB : end + (endBNoBlank - endANoBlank);
    } else if (subB.includes(pos)) {
      e.pos = pos + begA - begB;
      e.end = end === endB ? begA + sizeB + (endA - endANoBlank) : end + (begA - begB);
    } else if (pos < begB) {
      e.pos = pos + (sizeB - sizeA);
      e.end = end + (sizeB - sizeA);
    }
  }
  struct.sort((a, b) => a.pos - b.pos);
  ember.gotoChar(p.pos);
  dropMarker(p);
  return struct;
}

/** How many blank lines go between items when one is inserted, as org-list-separating-blank-lines-number guesses. */
function separatingBlankLines(pos: number, item: number, struct: Struct, prevs: Alist): number {
  const countBlanks = (at: number): number => {
    const bol = ember.lineStart(lineAt(at));
    let q = bol;
    while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
    const after = lineStartOrEnd(lineAt(q) + 1);
    const [a, b] = [Math.min(bol, after), Math.max(bol, after)];
    return (ember.bufferText(a, b).match(/\n/g) ?? []).length;
  };
  const next = nextItem(item, prevs);
  if (next !== undefined) return countBlanks(next);
  if (prevItem(item, prevs) !== undefined) return countBlanks(item);
  if (pos > itemEndBeforeBlank(struct, item)) {
    const blanks = countBlanks(pos);
    if (blanks > 0) return blanks;
  }
  const top = lineAt(struct[0].pos);
  const limit = itemEndBeforeBlank(struct, item);
  for (let l = top; l < ember.lineCount() && ember.lineStart(l) <= limit; l++) {
    if (/^[ \t]*$/.test(ember.lineText(l)) && ember.lineEnd(l) <= limit) return 1;
  }
  return 0;
}

/**
 * Inserts an item at pos, before the item there if pos is before its text,
 * as org-list-insert-item does, leaving point at the new item's start.
 */
function insertItemStruct(pos: number, struct: Struct, prevs: Alist, checkbox: boolean, afterBullet = ""): Struct {
  let item: number | undefined;
  for (const e of struct) {
    if (e.pos > pos) break;
    if (e.end < pos) continue;
    item = e.pos;
  }
  if (item === undefined) item = struct[struct.length - 1].pos;
  const it = getItem(struct, item);
  const itemEnd = it.end;
  const itemEndNoBlank = itemEndBeforeBlank(struct, item);
  const parts = itemParts(lineAt(item));
  // Before the text after the bullet, checkbox and tag, the new item goes before this one.
  let bodyStart = parts?.matchEnd ?? item;
  if (parts?.tagAt !== undefined && parts.tagEnd !== undefined) {
    if (/[.)]/.test(parts.bullet)) bodyStart = parts.tagAt;
    else {
      bodyStart = parts.tagEnd;
      while (/[ \t]/.test(ember.bufferText(bodyStart, bodyStart + 1))) bodyStart++;
    }
  }
  const beforep = pos <= bodyStart;
  const split = ember.variable("org-M-RET-may-split-line") !== false;
  const blankNb = separatingBlankLines(pos, item, struct, prevs);
  const { ind } = it;
  const tab = Number(ember.variable("tab-width") ?? 8);
  const indSize = ember.variable("indent-tabs-mode") === true ? Math.floor(ind / tab) + (ind % tab) : ind;
  const bullet = bulletString(it.bullet);
  const box = checkbox ? "[ ]" : undefined;
  let textCut: string | undefined;
  if (!beforep && split) {
    let q = pos;
    if (itemEnd < pos) {
      edDelete(itemEnd - 1, ember.lineEnd(lineAt(pos)));
      q = itemEnd - 1;
    }
    while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
    let after = q;
    while (after < ember.bufferSize() && /[ \t]/.test(ember.bufferText(after, after + 1))) after++;
    pos = after;
    textCut = edDelete(q, Math.max(q, itemEndNoBlank));
  }
  const body = bullet + (box ? `${box} ` : "") + afterBullet + (textCut === undefined ? "" : textCut.replace(/^[ \t]+/, ""));
  const sep = "\n".repeat(blankNb + 1);
  const itemSize = indSize + charCount(body) + charCount(sep);
  const sizeOffset = itemSize - charCount(textCut ?? "");
  edInsert(item, indentString(ind) + body + sep);
  for (const e of struct) {
    const { pos: p, end } = e;
    if (p < item) {
      if (end > item) e.end = end + sizeOffset;
    } else if (p === item && !beforep && split) {
      e.pos = p + itemSize;
      e.end = end + sizeOffset;
    } else if (split && !beforep && p >= pos && p <= itemEndNoBlank) {
      const offset = pos - item - ind - charCount(bullet) - charCount(afterBullet);
      e.pos = p - offset;
      e.end = end - offset;
    } else {
      e.pos = p + sizeOffset;
      e.end = end + sizeOffset;
    }
  }
  struct.push({ pos: item, ind, bullet, checkbox: box, end: item + itemSize });
  struct.sort((a, b) => a.pos - b.pos);
  if (beforep) ember.gotoChar(item);
  else {
    struct = swapItems(item, item + itemSize, struct);
    ember.gotoChar(nextItem(item, prevsAlist(struct)) ?? item);
  }
  return struct;
}

/** The parents items between start and end get when outdented, as org-list-struct-outdent works them out. */
function structOutdent(start: number, end: number, struct: Struct, parents: Alist): Alist {
  const acc = new Map<number, number | undefined>();
  const out: Alist = new Map();
  for (const [item, parent] of parents) {
    if (item < start) out.set(item, parent);
    else if (item >= end) out.set(item, parent !== undefined && acc.has(parent) ? acc.get(parent) : parent);
    else if (parent === undefined) throw new Error("Cannot outdent top-level items");
    else if (parent >= start) {
      acc.set(parent, item);
      out.set(item, parent);
    } else {
      acc.set(parent, item);
      out.set(item, parents.get(parent));
    }
  }
  void struct;
  return out;
}

/** The parents items between start and end get when indented, as org-list-struct-indent works them out. */
function structIndent(start: number, end: number, struct: Struct, parents: Alist, prevs: Alist): Alist {
  const acc = new Map<number, number | undefined>();
  const out: Alist = new Map();
  for (const [item, parent] of parents) {
    if (item < start) out.set(item, parent);
    else if (item >= end) out.set(item, parent !== undefined && acc.has(parent) ? acc.get(parent) : parent);
    else {
      const prev = prevItem(item, prevs);
      if (prev === undefined && (parent === undefined || parent < start)) throw new Error("Cannot indent the first item of a list");
      let now: number | undefined;
      if (prev === undefined) now = parent;
      else if (prev < start) now = prev;
      else now = acc.get(prev);
      acc.set(item, now);
      out.set(item, now);
    }
  }
  void struct;
  return out;
}

/** Where the last M-S-<left> or M-S-<right> began and ended, so repeating it moves the same items, as Org's markers keep them. */
const lastIndentBegin = marker(0);
const lastIndentEnd = marker(0);

/**
 * Indents (arg > 0) or outdents an item, with its children unless
 * noSubtree, or the items in the region, as org-list-indent-item-generic
 * does. At the first item, the whole list moves.
 */
function indentItemGeneric(arg: number, noSubtree: boolean, struct: Struct): void {
  const saved = marker(ember.point());
  const region = orgRegionActive() && ember.mark() !== undefined;
  const mark = ember.mark() ?? ember.point();
  const [rbeg, rend] = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
  const top = struct[0].pos;
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const bol = ember.lineStart(lineAt());
  let special = false;
  if (!region && top === bol) {
    if (noSubtree) throw new Error("At first item: use S-M-<left/right> to move the whole list");
    special = true;
  }
  const shiftMeta = ["org-shiftmetaright", "org-shiftmetaleft"];
  if (!(shiftMeta.includes(ember.lastCommand() ?? "") && shiftMeta.includes(ember.thisCommand() ?? ""))) {
    lastIndentBegin.pos = region ? rbeg : bol;
    lastIndentEnd.pos = region ? rend : special ? bottomPoint(struct) : noSubtree ? bol + 1 : getItem(struct, bol).end;
  }
  const beg = lastIndentBegin.pos;
  const end = lastIndentEnd.pos;
  try {
    // As Org binds deactivate-mark to nil, a region stays active.
    ember.keepMarkActive(() => {
      if (special) {
        const offset = arg < 0 ? -1 : 1;
        const first = struct.find((e) => e.pos === beg) ?? struct[0];
        const old = copyStruct(struct);
        if (first.ind + offset < 0) throw new Error("Cannot outdent beyond margin");
        if (first.ind + offset === 0 && first.bullet.includes("*")) first.bullet = bulletString("-");
        for (const e of struct) e.ind += offset;
        fixBul(struct, prevs);
        applyStruct(struct, old);
      } else if (
        arg < 0 &&
        ((noSubtree && !region && hasChild(struct, beg) !== undefined) ||
          hasChild(struct, [...struct].reverse().find((e) => e.pos < end)?.pos ?? beg) !== undefined)
      ) {
        throw new Error("Cannot outdent an item without its children");
      } else {
        const old = copyStruct(struct);
        const newParents = arg < 0 ? structOutdent(beg, end, struct, parents) : structIndent(beg, end, struct, parents, prevs);
        writeStruct(struct, newParents, old);
        updateCheckboxCount();
      }
    });
  } finally {
    ember.gotoChar(saved.pos);
    dropMarker(saved);
  }
}

/** The item point's line starts, for commands that need one, or an error. */
function structAtItem(error = "Not at an item"): Struct {
  if (!itemLine(lineAt())) throw new Error(error);
  return listStruct(lineAt());
}

function indentItemCommand(arg: number, noSubtree: boolean): void {
  const region = orgRegionActive() && ember.mark() !== undefined;
  const regionStart = region ? Math.min(ember.mark() ?? 0, ember.point()) : 0;
  if (itemLine(lineAt()) || (region && itemLine(lineAt(regionStart)))) {
    const struct = listStruct(region ? lineAt(regionStart) : lineAt());
    indentItemGeneric(arg, noSubtree, struct);
  } else if (region) throw new Error("Region not starting at an item");
  else throw new Error("Not at an item");
}

let tabIndState: [number, string] | undefined;

/**
 * Cycles an empty item's indentation, as org-cycle-item-indentation does
 * for TAB: in, then out a level at a time, then back where it was.
 * Returns whether it applied.
 */
function cycleItemIndentation(): boolean {
  const line = lineAt();
  if (!itemLine(line)) return false;
  const struct = listStruct(line);
  const item = ember.lineStart(line);
  const { ind } = getItem(struct, item);
  const again = ember.lastCommand() === "org-cycle-item-indentation";
  const parts = itemParts(line);
  let end = getItem(struct, item).end;
  while (end > 0 && /[ \t\n]/.test(ember.bufferText(end - 1, end))) end--;
  if (!(again || (parts && parts.matchEnd >= end))) return false;
  ember.setThisCommand("org-cycle-item-indentation");
  const prevs = prevsAlist(struct);
  const parents = parentsAlist(struct);
  if (again && tabIndState) {
    const [oldInd, oldBul] = tabIndState;
    const allowOutdent = (s: Struct, pv: Alist, pa: Alist): boolean =>
      nextItem(item, pv) === undefined && hasChild(s, item) === undefined && pa.get(item) !== undefined;
    if (ind > oldInd && prevItem(item, prevs) !== undefined) indentItemGeneric(1, true, struct);
    else if (ind < oldInd && allowOutdent(struct, prevs, parents)) indentItemGeneric(-1, true, struct);
    else {
      edDelete(item, ember.lineEnd(line));
      edInsert(item, indentString(oldInd) + oldBul + " ");
      ember.gotoChar(ember.lineEnd(line));
      const fresh = listStruct(line);
      const freshParents = parentsAlist(fresh);
      if (ind > oldInd && allowOutdent(fresh, prevsAlist(fresh), freshParents)) indentItemGeneric(-1, true, fresh);
      else {
        writeStruct(fresh, freshParents);
        ember.setThisCommand("identity" as ember.CommandName);
      }
    }
    return true;
  }
  tabIndState = [ind, ember.lineText(line).trim()];
  if (prevItem(item, prevs) !== undefined) indentItemGeneric(1, true, struct);
  else if (nextItem(item, prevs) === undefined && parents.get(item) !== undefined) indentItemGeneric(-1, true, struct);
  else {
    ember.setThisCommand("identity" as ember.CommandName);
    throw new Error("Cannot move item");
  }
  return true;
}

/** Changes the bullets of the list at point, as org-cycle-list-bullet does. `which` is a bullet, "previous", or undefined for the next. */
function cycleListBullet(which?: string): void {
  if (!itemLine(lineAt())) throw new Error("Not at an item");
  const origin = marker(ember.point());
  const line = lineAt();
  const bol = ember.lineStart(line);
  const struct = listStruct(line);
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const listBeg = firstItem(bol, prevs);
  const here = getItem(struct, bol);
  const offset = origin.pos - (bol + here.ind);
  const offset2 = origin.pos - (bol + here.ind + charCount(here.bullet));
  const bullet = getItem(struct, listBeg).bullet;
  const current = /\./.test(bullet) ? "1." : /\)/.test(bullet) ? "1)" : bullet.trim();
  const description = itemParts(line)?.tag !== undefined;
  const choices = ["-", "+", ...(/^\S/.test(ember.lineText(line)) ? [] : ["*"]), ...(description ? [] : ["1.", "1)"])];
  const k = choices.indexOf(current);
  const index = k < 0 ? choices.length : k;
  const get = (i: number): string => choices[((i % choices.length) + choices.length) % choices.length];
  const next = which !== undefined && choices.includes(which) ? which : which === "previous" ? get(index - 1) : get(index + 1);
  const old = copyStruct(struct);
  getItem(struct, listBeg).bullet = bulletString(next);
  fixBul(struct, prevs);
  fixInd(struct, parents);
  ember.gotoChar(bol);
  applyStruct(struct, old);
  const fresh = listStruct(lineAt(origin.pos));
  const at = ember.lineStart(lineAt(origin.pos));
  const item = fresh.find((e) => e.pos === at);
  if (item && offset2 >= 0) ember.gotoChar(at + item.ind + charCount(item.bullet) + offset2);
  else if (item && offset >= 0) ember.gotoChar(at + item.ind + offset);
  else ember.gotoChar(origin.pos);
  dropMarker(origin);
}

/** Inserts an item, with a checkbox if asked, as org-insert-item does. Returns whether point was in an item. */
function insertListItem(checkbox: boolean): boolean {
  const start = inItem(lineAt());
  if (start === undefined || ember.invisibleAt(start)) return false;
  const pos = ember.point();
  let struct = listStruct(lineAt(start));
  const prevs = prevsAlist(struct);
  const first = getItem(struct, firstItem(start, prevs));
  const description = !/[0-9A-Za-z]/.test(first.bullet) && first.tag !== undefined;
  struct = insertItemStruct(pos, struct, prevs, checkbox, description ? " :: " : "");
  writeStruct(struct, parentsAlist(struct));
  if (checkbox) updateCheckboxCount();
  const line = lineAt();
  ember.gotoChar(ember.lineStart(line));
  const parts = itemParts(line);
  if (parts) ember.gotoChar(parts.matchEnd);
  if (description) ember.gotoChar(ember.point() - 1);
  return true;
}

function moveItemDown(): void {
  if (!itemLine(lineAt())) throw new Error("Not at an item");
  const col = ember.point() - ember.lineStart(lineAt());
  const item = ember.lineStart(lineAt());
  let struct = listStruct(lineAt());
  const next = nextItem(item, prevsAlist(struct));
  if (next === undefined) throw new Error("Cannot move this item further down");
  struct = swapItems(item, next, struct);
  ember.gotoChar(nextItem(item, prevsAlist(struct)) ?? item);
  writeStruct(struct, parentsAlist(struct));
  moveToColumn(col);
}

function moveItemUp(): void {
  if (!itemLine(lineAt())) throw new Error("Not at an item");
  const col = ember.point() - ember.lineStart(lineAt());
  const item = ember.lineStart(lineAt());
  let struct = listStruct(lineAt());
  const prev = prevItem(item, prevsAlist(struct));
  if (prev === undefined) throw new Error("Cannot move this item further up");
  struct = swapItems(prev, item, struct);
  writeStruct(struct, parentsAlist(struct));
  moveToColumn(col);
}

function previousItem(): void {
  const item = inItem(lineAt());
  if (item === undefined) throw new Error("Not in an item");
  ember.gotoChar(item);
  const prev = prevItem(item, prevsAlist(listStruct(lineAt(item))));
  if (prev === undefined) throw new Error("On first item");
  ember.gotoChar(prev);
}

function nextListItem(): void {
  const item = inItem(lineAt());
  if (item === undefined) throw new Error("Not in an item");
  ember.gotoChar(item);
  const next = nextItem(item, prevsAlist(listStruct(lineAt(item))));
  if (next === undefined) throw new Error("On last item");
  ember.gotoChar(next);
}

/**
 * Ticks or unticks the checkbox on point's item line, or the first one
 * under a heading or in the region and the rest like it, as
 * org-toggle-checkbox does. With C-u, adds or removes checkboxes.
 */
function toggleCheckbox(arg: ember.PrefixArg): void {
  const saved = marker(ember.point());
  const presence = Array.isArray(arg) && arg[0] === 4;
  try {
    let limUp: number;
    let limDown: Marker;
    let single = false;
    const firstItemFrom = (from: number, limit: number): number | undefined => {
      for (let l = lineAt(from); l < ember.lineCount() && ember.lineStart(l) < limit; l++) {
        if (ember.lineStart(l) >= from && itemLine(l)) return ember.lineStart(l);
      }
      return undefined;
    };
    if (orgRegionActive() && ember.mark() !== undefined) {
      const [rb, re] = [Math.min(ember.mark() ?? 0, ember.point()), Math.max(ember.mark() ?? 0, ember.point())];
      const found = firstItemFrom(ember.lineStart(lineAt(rb)), re);
      if (found === undefined) throw new Error("No item in region");
      limUp = found;
      limDown = marker(re);
    } else if (parseHeading(lineAt())) {
      const all = headings();
      const i = headingIndex(all, lineAt()) as number;
      const limit = all[i + 1]?.start ?? ember.bufferSize();
      const found = firstItemFrom(endOfMetaData(all[i], true), limit);
      if (found === undefined) throw new Error("No item in subtree");
      limUp = found;
      limDown = marker(limit);
    } else if (itemLine(lineAt())) {
      single = true;
      limUp = ember.lineStart(lineAt());
      limDown = marker(ember.lineEnd(lineAt()));
    } else throw new Error("Not at an item or heading, and no active region");
    void single;
    // As org-at-item-checkbox-p sees it: a box needs blanks after it.
    const parts = itemParts(lineAt(limUp));
    const box = parts?.boxAt !== undefined && /^[ \t]/.test(ember.bufferText(parts.boxAt + 3, parts.boxAt + 4)) ? parts.checkbox : undefined;
    const ref = Array.isArray(arg) && arg[0] === 16 ? "[-]" : presence ? (box ? undefined : "[ ]") : box === "[X]" ? "[ ]" : "[X]";
    let at = limUp;
    while (at < limDown.pos) {
      const found = firstItemFrom(at, limDown.pos);
      if (found === undefined) break;
      const struct = listStruct(lineAt(found));
      const old = copyStruct(struct);
      const parents = parentsAlist(struct);
      const bottom = marker(bottomPoint(struct));
      for (const e of struct) {
        if (e.pos < limUp || e.pos > limDown.pos) continue;
        if (e.checkbox !== undefined || presence) e.checkbox = ref;
      }
      fixBox(struct, parents);
      applyStruct(struct, old);
      at = bottom.pos;
      dropMarker(bottom);
    }
    dropMarker(limDown);
  } finally {
    ember.gotoChar(saved.pos);
    dropMarker(saved);
  }
  updateCheckboxCount();
}

/**
 * Where a heading's planning line and property drawer end, as
 * org-end-of-meta-data does: with `full`, clock lines, blank lines and the
 * logbook too, and with `true` any drawer.
 */
function endOfMetaData(h: Heading, full: boolean | "logbook" = false): number {
  let l = h.line + 1;
  if (l < ember.lineCount() && PLANNING.test(ember.lineText(l))) l++;
  const close = propertyDrawerEnd(l);
  if (close !== undefined) l = close + 1;
  if (full && !(l < ember.lineCount() && isHeadingLine(ember.lineText(l)))) {
    while (l < ember.lineCount()) {
      const text = ember.lineText(l);
      if (/^[ \t]*$/.test(text) || /^[ \t]*CLOCK:/.test(text)) {
        if (l === ember.lineCount() - 1) return ember.bufferSize();
        l++;
      } else if (/^[ \t]*:LOGBOOK:[ \t]*$/i.test(text) || (full === true && DRAWER_RE.test(text))) {
        const e = drawerEnd(l, ember.bufferSize());
        if (e === undefined) break;
        l = e + 1;
      } else break;
    }
  }
  return lineStartOrEnd(l);
}

/** The closing line of a property drawer starting at a line, as org-property-drawer-re matches one. */
function propertyDrawerEnd(line: number): number | undefined {
  if (line >= ember.lineCount() || !/^[ \t]*:PROPERTIES:[ \t]*$/i.test(ember.lineText(line))) return undefined;
  for (let l = line + 1; l < ember.lineCount(); l++) {
    const text = ember.lineText(l);
    if (/^[ \t]*:END:[ \t]*$/i.test(text)) return l;
    if (!/^[ \t]*:\S+:(?:[ \t].*)?[ \t]*$/.test(text)) return undefined;
  }
  return undefined;
}

/**
 * Sets a property in a heading's property drawer, adding the drawer after
 * its planning line, folded, if there is none, as org-entry-put does.
 */
function entryPut(headingLine: number, property: string, value: string): void {
  withoutFoldChecks(() => {
    let line = headingLine + 1;
    if (line < ember.lineCount() && PLANNING.test(ember.lineText(line))) line++;
    if (propertyDrawerEnd(line) === undefined) {
      let at = lineStartOrEnd(line);
      if (at === ember.lineStart(lineAt(at)) && at > 0 && (line < ember.lineCount() || ember.bufferText(at - 1, at) === "\n")) at--;
      const begin = at === 0 ? 0 : at + 1;
      ember.gotoChar(at);
      if (at > 0) edInsert(at, "\n");
      edInsert(ember.point(), ":PROPERTIES:\n:END:");
      const endPos = ember.point();
      hideOverlay(ember.lineEnd(lineAt(endPos) - 1), endPos, "org-hide-drawer");
      if (endPos === ember.bufferSize() || begin === 0) edInsert(endPos, "\n");
      line = lineAt(begin);
    }
    const close = propertyDrawerEnd(line) as number;
    const re = new RegExp(`^[ \\t]*:${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "i");
    let at: number | undefined;
    for (let l = line + 1; l < close; l++) {
      if (re.test(ember.lineText(l))) {
        at = ember.lineStart(l);
        edDelete(at, ember.lineEnd(l));
        break;
      }
    }
    if (at === undefined) {
      at = ember.lineStart(close);
      edInsert(at, "\n");
    }
    edInsert(at, `:${property}: ${value}`);
    // As org-entry-put ends with org-indent-line, which aligns a property's value.
    alignNodeProperty(lineAt(at));
  });
}

/** A property's value in a heading's property drawer, as org-entry-get reads it, ignoring case. */
function entryGet(headingLine: number, property: string): string | undefined {
  let line = headingLine + 1;
  if (line < ember.lineCount() && PLANNING.test(ember.lineText(line))) line++;
  const close = propertyDrawerEnd(line);
  if (close === undefined) return undefined;
  const re = new RegExp(`^[ \\t]*:${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(?:[ \\t]+(.*?))?[ \\t]*$`, "i");
  for (let l = line + 1; l < close; l++) {
    const m = re.exec(ember.lineText(l));
    if (m) return m[1] ?? "";
  }
  return undefined;
}

/** The properties Org works out itself, which org-entry-put cannot set, as org-special-properties lists them. */
const SPECIAL_PROPERTIES = [
  "ALLTAGS", "BLOCKED", "CLOCKSUM", "CLOCKSUM_T", "CLOSED", "FILE", "ITEM", "TAGS", "TIMESTAMP", "TIMESTAMP_IA",
];

/** The heading whose entry point is in, as org-back-to-heading with invisible-ok finds it. */
function entryHeading(): Heading | undefined {
  const all = headings();
  const i = headingIndex(all, lineAt());
  return i === undefined ? undefined : all[i];
}

const setProperty = ember.defineCommand({
  name: "org-set-property",
  doc: "In the current entry, set a property to a value, adding a property drawer if there is none.",
  params: [
    { name: "property", kind: "string", prompt: "Property: " },
    { name: "value", kind: "string", prompt: "Value: " },
  ],
  run: (property, value) => {
    if (property === "" || /\s/.test(property)) throw new Error(`Invalid property name: "${property}"`);
    const h = entryHeading();
    if (!h) throw new Error("Before first headline at position 1 in buffer " + ember.bufferName());
    const upper = property.toUpperCase();
    if (upper === "TODO") {
      if (value !== "" && !allKeywords().includes(value)) throw new Error(`"${value}" is not a valid TODO state`);
      setTodo(h, value === "" ? undefined : value);
      return;
    }
    if (SPECIAL_PROPERTIES.includes(upper)) throw new Error(`The ${property} property cannot be set with \`org-entry-put'`);
    if (entryGet(h.line, property) === value) return;
    const p = marker(ember.point());
    entryPut(h.line, property, value);
    ember.gotoChar(p.pos);
    dropMarker(p);
  },
});

ember.defineCommand({
  name: "org-delete-property",
  doc: "In the current entry, delete a property, and the property drawer with it if that leaves it empty.",
  params: [{ name: "property", kind: "string", prompt: "Property: " }],
  run: (property) => {
    const h = entryHeading();
    if (!h) throw new Error("Before first headline at position 1 in buffer " + ember.bufferName());
    let line = h.line + 1;
    if (line < ember.lineCount() && PLANNING.test(ember.lineText(line))) line++;
    const close = propertyDrawerEnd(line);
    if (close === undefined) {
      ember.message("No property to delete in this entry");
      return;
    }
    const p = marker(ember.point());
    // The property and its accumulated form, PROPERTY+, as org-entry-delete removes them.
    const re = new RegExp(`^[ \\t]*:${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+?:`, "i");
    let end = close;
    for (let l = line + 1; l < end; ) {
      if (re.test(ember.lineText(l))) {
        edDelete(ember.lineStart(l), ember.lineStart(l + 1));
        end--;
      } else l++;
    }
    // An emptied drawer goes altogether.
    if (end === line + 1) edDelete(ember.lineStart(line), lineStartOrEnd(line + 2));
    ember.gotoChar(p.pos);
    dropMarker(p);
    ember.message(`Property "${property}" deleted`);
  },
});

ember.defineCommand({
  name: "org--insert-named-drawer",
  doc: "Insert a drawer of the name given at point, with point inside it, as org-insert-drawer does without a prefix argument.",
  params: [{ name: "drawer", kind: "string", prompt: "Drawer: " }],
  run: (drawer) => {
    if (!/^[\w-]+$/.test(drawer)) throw new Error("Invalid drawer name");
    if (ember.point() !== ember.lineStart(lineAt())) ember.insert("\n");
    ember.insert(`:${drawer}:\n\n:END:\n`);
    ember.gotoChar(ember.lineStart(lineAt() - 2));
  },
});

const insertDrawer = ember.defineCommand({
  name: "org-insert-drawer",
  doc:
    "Insert a drawer at point, asking for its name, with point inside it.\n\n" +
    "With a prefix argument, insert the entry's property drawer instead.",
  run: () => {
    if (ember.prefixArg() === null) {
      // The name is asked for only without a prefix argument, as Org's interactive form does.
      ember.callInteractively("org--insert-named-drawer");
      return;
    }
    {
      const h = entryHeading();
      if (!h) throw new Error("Before first headline at position 1 in buffer " + ember.bufferName());
      let line = h.line + 1;
      if (line < ember.lineCount() && PLANNING.test(ember.lineText(line))) line++;
      if (propertyDrawerEnd(line) === undefined) {
        // An empty drawer made and opened, with a line inside it, as
        // org-insert-property-drawer and org-insert-drawer leave it.
        entryPut(h.line, "X", "");
        const close = propertyDrawerEnd(line) as number;
        edDelete(ember.lineStart(close - 1), ember.lineStart(close));
      }
      const close = propertyDrawerEnd(line) as number;
      flag(ember.lineEnd(line), ember.lineStart(close), false, "org-hide-drawer");
      ember.gotoChar(ember.lineStart(close));
      if (close === line + 1) {
        ember.insert("\n");
        ember.gotoChar(ember.point() - 1);
      }
    }
  },
});

// Refiling, as org-refile.el does with its default targets.

/**
 * Where org-refile can file a subtree: as org-refile-targets of nil gives
 * them, the buffer's top-level headings that have a title, by their titles.
 */
function refileTargets(): { name: string; heading: Heading }[] {
  return ember.saveRestriction(() => {
    ember.widen();
    return headings()
      .filter((h) => h.level === 1 && h.title !== "")
      .map((h) => ({ name: h.title, heading: h }));
  });
}

/**
 * Files the subtree at point under a target heading, as its last child, as
 * org-refile does: copied there with org-paste-subtree, then deleted where
 * it was, unless `keep`.
 */
function refile(target: string, keep: boolean): void {
  const h = entryHeading();
  if (!h) throw new Error(`Before first headline at position ${ember.lineStart(lineAt()) + 1} in buffer ${ember.bufferName()}`);
  const t = refileTargets().find((x) => x.name === target);
  if (!t) throw new Error("Invalid target location");
  const all = headings();
  const i = all.findIndex((x) => x.start === h.start);
  const [start, end] = subtreeRegion(all, i);
  if (t.heading.start >= start && t.heading.start < end) throw new Error("Cannot refile to position inside the tree or region");
  const origin = ember.point();
  copySubtree(false, 1, false);
  const ti = all.findIndex((x) => x.start === t.heading.start);
  // After the target's subtree, at its next sibling or the end.
  const at = subtreeRegion(all, ti)[1];
  const before = ember.bufferSize();
  ember.gotoChar(at);
  if (ember.point() !== ember.lineStart(lineAt())) ember.call("newline");
  pasteSubtree(Math.max(1, t.heading.level + 1) as ember.PrefixArg);
  ember.popKill();
  // Back to the subtree where it was, after what was pasted before it.
  const moved = at <= start ? ember.bufferSize() - before : 0;
  ember.gotoChar(origin + moved);
  if (!keep) {
    edDelete(start + moved, end + moved);
    ember.gotoChar(start + moved);
  }
  const file = ember.bufferFileName() ?? ember.bufferName();
  ember.message(`${keep ? "Copy" : "Refile"} to "${t.name}" in file ${file}: done`);
}

ember.defineCommand({
  name: "org--refile-to",
  doc: "File the subtree at point under the target heading given, as org-refile does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Refile subtree to: " }],
  run: (target) => refile(target, false),
});

ember.defineCommand({
  name: "org--refile-copy-to",
  doc: "Copy the subtree at point under the target heading given, as org-refile-copy does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Copy subtree to: " }],
  run: (target) => refile(target, true),
});

ember.defineCommand({
  name: "org--refile-goto",
  doc: "Go to the refile target given, as org-refile with C-u does.",
  params: [{ name: "target", kind: "string", prompt: "Goto: " }],
  run: (target) => {
    const t = refileTargets().find((x) => x.name === target);
    if (!t) throw new Error("Invalid target location");
    ember.gotoChar(t.heading.start);
  },
});

const refileCommand = ember.defineCommand({
  name: "org-refile",
  doc:
    "Move the subtree at point under another heading, asking which: one of the buffer's top-level headings.\n\n" +
    "It goes in as that heading's last child. With C-u, go to the heading instead.",
  run: () => {
    const goto = Array.isArray(ember.prefixArg());
    if (!goto && !entryHeading()) {
      throw new Error(`Before first headline at position ${ember.lineStart(lineAt()) + 1} in buffer ${ember.bufferName()}`);
    }
    ember.callInteractively(goto ? "org--refile-goto" : "org--refile-to");
  },
});

const refileCopyCommand = ember.defineCommand({
  name: "org-refile-copy",
  doc: "Copy the subtree at point under another heading, asking which, as org-refile does but keeping the original.",
  run: () => {
    if (!entryHeading()) {
      throw new Error(`Before first headline at position ${ember.lineStart(lineAt()) + 1} in buffer ${ember.bufferName()}`);
    }
    ember.callInteractively("org--refile-copy-to");
  },
});

// Narrowing, as org.el's org-narrow-to-subtree and its kin.

const narrowToSubtree = ember.defineCommand({
  name: "org-narrow-to-subtree",
  doc: "Narrow the buffer to the current subtree: the heading point is under and everything below it.",
  run: () => {
    const all = headings();
    const i = headingIndex(all, lineAt());
    if (i === undefined || all[i].start < ember.pointMin()) throw new Error("Before first heading");
    const end = subtreeRegion(all, i)[1];
    // The subtree's last newline stays outside, and an existing narrowing is not widened.
    ember.narrowToRegion(all[i].start, Math.min(ember.pointMax(), end === ember.pointMax() ? end : end - 1));
  },
});

// Subtrees in indirect buffers, as org.el's org-tree-to-indirect-buffer.

/** The buffer the last C-c C-x b made, which the next one kills, as org-last-indirect-buffer. */
let lastIndirectBuffer: ember.Buffer | undefined;
/** The frame "dedicated-frame" shows indirect buffers in, as org-indirect-dedicated-frame. */
let indirectDedicatedFrame: number | undefined;

/** An indirect buffer of `buffer`'s base, named after it and `heading`, as org-get-indirect-buffer. */
function getIndirectBuffer(buffer: ember.Buffer, heading?: string): ember.Buffer {
  const base = ember.bufferBaseBuffer(buffer) ?? buffer;
  const name = ember.generateNewBufferName(`${base.name}${heading === undefined ? "" : `::${heading}`}`);
  return ember.makeIndirectBuffer(base, name, true);
}

/** The window showing `buffer`, if one does. */
function bufferWindow(buffer: ember.Buffer): number | undefined {
  return buffer.live ? ember.windowList().find((w) => ember.windowBuffer(w) === buffer.name) : undefined;
}

const treeToIndirectBuffer = ember.defineCommand({
  name: "org-tree-to-indirect-buffer",
  doc:
    "Show the current subtree in an indirect buffer of its own, narrowed to it: the same text, folded apart.\n\n" +
    "A numeric prefix argument takes the subtree of the heading at that level above, or that many levels up " +
    "if negative. Unless org-indirect-buffer-display is new-frame, the indirect buffer the command made last " +
    "is killed first; with C-u it is kept.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const cbuf = ember.currentBuffer();
    const cwin = ember.selectedWindow();
    const pos = ember.point();
    const display = String(ember.variable("org-indirect-buffer-display"));
    const lastWindow = lastIndirectBuffer && bufferWindow(lastIndirectBuffer);
    const [all, found] = backToHeading();
    let i = found;
    if (typeof arg === "number") {
      const level = arg < 0 ? all[i].level + arg : arg;
      // Up to the heading at that level, as org-up-heading-safe climbs.
      while (all[i].level > level) {
        let parent = i - 1;
        while (parent >= 0 && all[parent].level >= all[i].level) parent--;
        if (parent < 0) break;
        i = parent;
      }
    }
    const h = all[i];
    const heading = [h.todo, h.priority === undefined ? undefined : `[#${h.priority}]`, h.title].filter((x) => x).join(" ");
    const beg = h.start;
    let end = subtreeRegion(all, i)[1];
    // Up to the next heading's line, not its start, as org-end-of-subtree leaves it.
    if (end < ember.pointMax()) end--;
    if (lastIndirectBuffer?.live && display !== "new-frame" && arg === null) ember.call("kill-buffer", lastIndirectBuffer.name ?? "");
    const ibuf = getIndirectBuffer(cbuf, heading);
    lastIndirectBuffer = ibuf;
    if (display === "new-frame" || (arg !== null && display === "dedicated-frame")) {
      ember.makeFrame(ibuf);
    } else if (display === "dedicated-frame") {
      if (indirectDedicatedFrame === undefined || !ember.frameList().includes(indirectDedicatedFrame)) {
        indirectDedicatedFrame = ember.makeFrame(ibuf);
      } else {
        ember.selectFrame(indirectDedicatedFrame);
        ember.setWindowBuffer(undefined, ibuf);
      }
    } else if (display === "current-window") {
      ember.setWindowBuffer(undefined, ibuf);
    } else if (display === "other-window") {
      if (lastWindow !== undefined && ember.windowList().includes(lastWindow)) {
        ember.setWindowBuffer(lastWindow, ibuf);
        ember.selectWindow(lastWindow);
      } else {
        ember.call("pop-to-buffer", ibuf.name ?? "");
      }
    } else {
      throw new Error("Invalid value");
    }
    ember.withCurrentBuffer(ibuf, () => {
      ember.narrowToRegion(beg, end);
      ember.call("org-show-all");
      ember.gotoChar(pos);
    });
    if (ember.windowList().includes(cwin)) ember.selectWindow(cwin);
  },
});

ember.defineCommand({
  name: "org-toggle-narrow-to-subtree",
  doc: "Narrow to the current subtree, or widen if the buffer is narrowed.",
  run: () => {
    if (ember.bufferNarrowedP()) {
      ember.widen();
      ember.message("Buffer widen");
    } else {
      ember.call("org-narrow-to-subtree");
      ember.message("Buffer narrowed to current subtree");
    }
  },
});

const narrowToElement = ember.defineCommand({
  name: "org-narrow-to-element",
  doc: "Narrow the buffer to the element at point: a heading's subtree, a greater element's contents, or the element.",
  run: () => {
    const e = elementAt(ember.point());
    if (!e) throw new Error("No element at point");
    if (e.type !== "headline" && GREATER_ELEMENTS.includes(e.type) && e.contentsBegin !== undefined) {
      ember.narrowToRegion(e.contentsBegin, e.contentsEnd ?? e.end);
    } else {
      ember.narrowToRegion(e.begin, e.end);
    }
  },
});

const narrowToBlock = ember.defineCommand({
  name: "org-narrow-to-block",
  doc: "Narrow the buffer to the block at point.",
  run: () => {
    const e = elementAt(ember.point());
    if (!e || !e.type.includes("block")) throw new Error("Not in a block");
    ember.call("org-narrow-to-element");
  },
});

/** Where notes about state changes go in a heading's entry, as org-log-beginning finds it. */
function logBeginning(h: Heading): number {
  const endpos = endOfMetaData(h);
  let p = endpos;
  while (p < ember.bufferSize() && /[ \t\n]/.test(ember.bufferText(p, p + 1))) p++;
  p = ember.lineStart(lineAt(p));
  if (p < endpos) p = endpos;
  return p === ember.lineStart(lineAt(p)) ? p : lineStartOrEnd(lineAt(p) + 1);
}

/** Adds a note about a state change to a heading's entry, as org-store-log-note does for a repeating task. */
function storeStateNote(headingLine: number, state: string, previous: string | undefined): void {
  const h = parseHeading(headingLine);
  if (!h) return;
  const p = marker(ember.point());
  withoutFoldChecks(() => {
    let at = logBeginning(h);
    if (at !== ember.lineStart(lineAt(at))) {
      edInsert(at, "\n");
      at++;
    } else if (/^[ \t]*\S/.test(ember.bufferText(at, ember.lineEnd(lineAt(at))))) {
      edInsert(at, "\n");
    }
    const pad = (x: string): string => x.padEnd(12, " ");
    const time = `[${formatTimestamp(today(true), true)}]`;
    const note = `State ${pad(`"${state}"`)} from ${pad(previous === undefined ? "" : `"${previous}"`)} ${time}`;
    ember.gotoChar(at);
    indentLine(lineAt(at));
    edInsert(ember.point(), `- ${note}`);
  });
  ember.gotoChar(p.pos);
  dropMarker(p);
}

const COOKIE = /\[(\d*\/\d*|\d*%)\]/g;
const HAS_COOKIE = /\[(\d*\/\d*|\d*%)\]/;

/**
 * Brings the checkbox statistics cookies of point's section up to date, as
 * org-update-checkbox-count does: a cookie in an item counts its children's
 * boxes, one elsewhere the top items of the section's lists.
 */
function updateCheckboxCount(): void {
  const saved = marker(ember.point());
  try {
    const all = headings();
    const p = ember.point();
    // From the heading before point, as outline-previous-heading finds it:
    // searching back, so a heading's own stars must end before point.
    const previousHeading = (pos: number) => all.filter((h) => h.start + h.level + 1 <= pos).at(-1)?.start ?? 0;
    const nextHeading = (pos: number) => all.find((h) => h.start > pos)?.start ?? ember.bufferSize();
    const start = previousHeading(p);
    const end = nextHeading(p);
    const cookies: { start: number; end: number; percent: boolean; count: [number, number] }[] = [];
    const countIn = (from: number, to: number, item: number | undefined): [number, number] => {
      let on = 0;
      let total = 0;
      for (let l = lineAt(from); l < ember.lineCount() && ember.lineStart(l) < to; l++) {
        if (ember.lineStart(l) < from) continue;
        if (!/^[ \t]*(?:[-+*]|(?:\d+|[A-Za-z])[.)])[ \t]+(?:\[@(?:start:)?(?:\d+|[A-Za-z])\][ \t]*)?\[[- X]\]/.test(ember.lineText(l))) continue;
        if (!itemLine(l)) continue;
        const s = listStruct(l);
        const items = item !== undefined ? children(item, parentsAlist(s)) : allItems(s[0].pos, prevsAlist(s));
        for (const e of items) {
          const box = getItem(s, e).checkbox;
          if (box === undefined) continue;
          total++;
          if (box === "[X]") on++;
        }
        l = lineAt(Math.min(bottomPoint(s), to)) - 1;
        if (bottomPoint(s) >= to) break;
      }
      return [on, total];
    };
    for (let l = lineAt(start); l < ember.lineCount() && ember.lineStart(l) < end; l++) {
      const text = ember.lineText(l);
      for (const m of allMatches(COOKIE, text)) {
        const cs = ember.lineStart(l) + charCount(text.slice(0, m.index ?? 0));
        if (cs < start || cs >= end) continue;
        const container = inItem(l);
        let count: [number, number];
        if (container !== undefined && !isHeadingLine(text)) {
          const s = listStruct(lineAt(container));
          count = countIn(container, getItem(s, container).end, container);
        } else {
          // A cookie elsewhere counts the boxes in its own section.
          const from = previousHeading(cs + charCount(m[0]));
          count = countIn(from, nextHeading(from), undefined);
        }
        cookies.push({ start: cs, end: cs + charCount(m[0]), percent: m[1].endsWith("%"), count });
      }
    }
    for (const c of cookies.reverse()) {
      const [on, total] = c.count;
      const value = c.percent ? `[${Math.floor((100 * on) / Math.max(1, total))}%]` : `[${on}/${total}]`;
      withoutFoldChecks(() => {
        edInsert(c.start, value);
        edDelete(c.start + charCount(value), c.end + charCount(value));
      });
      const h = parseHeading(lineAt(c.start));
      if (h && h.tagsAt !== undefined) alignTags(h.line);
    }
  } finally {
    ember.gotoChar(saved.pos);
    dropMarker(saved);
  }
}

/** Rewrites the statistics cookies on a line, such as [/] or [50%], for a count. */
function writeCookies(line: number, done: number, total: number): void {
  // As org-update-parent-todo-statistics does, a cookie that changes gets
  // the new text inserted before it and the old deleted after, so point
  // inside it ends up after the new one.
  const pt = marker(ember.point());
  const count = allMatches(COOKIE, ember.lineText(line)).length;
  for (let k = 0; k < count; k++) {
    const text = ember.lineText(line);
    const m = allMatches(COOKIE, text)[k];
    if (!m) break;
    const percent = m[1].endsWith("%");
    const value = percent ? `[${total === 0 ? 0 : Math.floor((100 * done) / total)}%]` : `[${done}/${total}]`;
    if (value === m[0]) continue;
    const start = at(line, text, m.index ?? 0);
    edInsert(start, value);
    edDelete(start + charCount(value), start + charCount(value) + charCount(m[0]));
    // org-fix-tags-on-the-fly, with org-auto-align-tags on.
    if (parseHeading(line)?.tagsAt !== undefined) alignTagsAway(line);
  }
  ember.gotoChar(pt.pos);
  dropMarker(pt);
}

/**
 * Brings a heading's statistics cookies up to date, as
 * org-update-statistics-cookies does there: from checkboxes if its text has
 * any, else from its children's TODO states, else as if complete.
 */
function updateHeadingCookies(all: Heading[], i: number): void {
  const h = all[i];
  const end = all[i + 1]?.start ?? ember.bufferSize();
  let boxes = false;
  for (let l = h.line + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
    if (/^[ \t]*([-+*]|[0-9]+[.)]) \[[- X]\]/.test(ember.lineText(l))) boxes = true;
  }
  if (boxes) {
    const p = ember.point();
    ember.gotoChar(h.end);
    updateCheckboxCount();
    ember.gotoChar(p);
    return;
  }
  const next = all[i + 1];
  if (next && next.level > h.level) {
    const sub = subtreeRegion(all, i)[1];
    const states: Heading[] = [];
    for (let k = i + 1; k < all.length && all[k].start < sub; k++) if (all[k].level === next.level && all[k].todo !== undefined) states.push(all[k]);
    writeCookies(h.line, states.filter((x) => isDone(x.todo)).length, states.length);
  } else {
    const text = ember.lineText(h.line);
    for (const m of allMatches(COOKIE, text).reverse()) {
      const start = at(h.line, text, m.index ?? 0);
      replaceText(start, start + charCount(m[0]), m[1].endsWith("%") ? "[100%]" : "[0/0]");
    }
  }
}

/** Folds or shows an item, as org-list-set-item-visibility does. */
function setItemVisibility(item: number, struct: Struct, view: "folded" | "children" | "subtree"): void {
  if (view === "folded") flag(ember.lineEnd(lineAt(item)), itemEndBeforeBlank(struct, item), true);
  else if (view === "subtree") flag(item, getItem(struct, item).end, false);
  else {
    setItemVisibility(item, struct, "subtree");
    for (const child of children(item, parentsAlist(struct))) setItemVisibility(child, struct, "folded");
  }
}

// Items as the fontifier and indentation see them: the first line's parts.

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

/** The innermost item a line is part of, as org-in-item-p finds it. */
function itemAtLine(line: number): Item | undefined {
  const start = inItem(line);
  return start === undefined ? undefined : parseItem(lineAt(start));
}

/** The item on point's line, if the line starts one. */
function itemHere(): Item | undefined {
  return itemLine(lineAt()) ? parseItem(lineAt()) : undefined;
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
  for (const m of allMatches(LINK, part)) {
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
    for (const m of allMatches(re, part)) {
      const i = m.index ?? 0;
      const end = i + m[0].length;
      if (overlaps(i, end)) continue;
      taken.push([i, end]);
      face(pos(i), pos(end), "org-link");
    }
  }
  for (const m of allMatches(TIMESTAMP, part)) {
    const i = m.index ?? 0;
    if (!overlaps(i, i + m[0].length)) face(pos(i), pos(i + m[0].length), "org-date");
  }
  for (const m of allMatches(COOKIE, part)) {
    const i = m.index ?? 0;
    const [a, b] = m[1].endsWith("%") ? [m[1] === "100%" ? 1 : 0, 1] : m[1].split("/").map(Number);
    face(pos(i), pos(i + m[0].length), b > 0 && a === b ? "org-checkbox-statistics-done" : "org-checkbox-statistics-todo");
  }
  for (const m of allMatches(/\[fn:[^\]\s]*\]/g, part)) {
    const i = m.index ?? 0;
    face(pos(i), pos(i + m[0].length), "org-footnote");
  }
  for (const m of allMatches(/<<[^<>\n]+>>/g, part)) {
    const i = m.index ?? 0;
    if (!overlaps(i, i + m[0].length)) face(pos(i), pos(i + m[0].length), "org-target");
  }
  for (const m of allMatches(EMPHASIS, part)) {
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
  if (!ember.derivedModeP("org-mode")) return;
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
      // Links, timestamps and the like are styled in tables too, as Org's font-lock does everywhere.
      fontifyObjects(line, text, 0);
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
    for (const m of allMatches(/(?:^|[ \t])((?:SCHEDULED|DEADLINE|CLOSED):)/g, text)) {
      const i = (m.index ?? 0) + m[0].length - m[1].length;
      face(at(line, text, i), at(line, text, i + m[1].length), "org-special-keyword");
    }
    const item = parseItem(line);
    let objectsFrom = 0;
    if (item) {
      if (item.checkboxAt !== undefined) face(item.checkboxAt, item.checkboxAt + 3, "org-checkbox");
      const term = /^(.*?)[ \t]+::(?:[ \t]|$)/.exec(text.slice(indexOf(line, text, item.contentAt)));
      if (term && !/^\d/.test(item.bullet)) {
        const termStart = item.checkboxAt !== undefined ? item.checkboxAt + 4 : item.contentAt;
        face(termStart, item.contentAt + charCount(term[1]), "org-list-dt");
      }
      objectsFrom = indexOf(line, text, item.contentAt);
    }
    const footnote = /^\[fn:[^\]\s]+\]/.exec(text);
    if (footnote) face(ls, ls + footnote[0].length, "org-footnote");
    fontifyObjects(line, text, objectsFrom);
  }
  fontifyLinksAcrossLines(from, Math.min(Math.max(end, from + 1), ember.bufferSize()));
}

/**
 * Styles the bracket links between two positions that hold a newline,
 * which Org's link regexp allows and its font-lock matches across lines.
 */
function fontifyLinksAcrossLines(start: number, end: number): void {
  // A line beyond each end too, as Org's font-lock extends its region for
  // these, so fontifying one line still finds a link it shares with the next.
  const from = ember.lineStart(Math.max(0, lineAt(start) - 1));
  const to = lineStartOrEnd(lineAt(Math.max(start, end - 1)) + 2);
  const text = ember.bufferText(from, to);
  if (!text.includes("\n")) return;
  const linkRe = /\[\[((?:[^\][\\]|\\.)+)\](?:\[([^]+?)\])?\]/g;
  for (const m of allMatches(linkRe, text)) {
    if (!m[0].includes("\n")) continue;
    const linkStart = from + charCount(text.slice(0, m.index ?? 0));
    if (linkStart >= end || linkStart + charCount(m[0]) <= start) continue;
    const pos = (k: number): number => linkStart + charCount(m[0].slice(0, k));
    // A link stays within its paragraph: no line it goes on to may start an element.
    const lines = m[0].split("\n").length - 1;
    const first = lineAt(linkStart);
    let within = true;
    for (let l = first + 1; l <= first + lines; l++) if (startsElement(l, ember.bufferSize())) within = false;
    if (!within) continue;
    face(linkStart, pos(m[0].length), "org-link");
    if (ember.variable("org-link-descriptive") !== true) continue;
    if (m[2] !== undefined) {
      const desc = 2 + m[1].length + 2;
      hide(linkStart, pos(desc));
      hide(pos(desc + m[2].length), pos(m[0].length));
    } else {
      hide(linkStart, pos(2));
      hide(pos(m[0].length - 2), pos(m[0].length));
    }
  }
}

// Indentation

/** The column an item's text starts at, after its bullet, as org-list-item-body-column says. */
function listBodyColumn(pos: number): number {
  const text = ember.lineText(lineAt(pos));
  const m = /^[ \t]*(\S+)/.exec(text);
  return m ? ember.stringWidth(m[0].replace(/\t/g, "        ")) + 1 : 0;
}

const GREATER_ELEMENTS = ["center-block", "drawer", "headline", "item", "plain-list", "property-drawer", "quote-block", "section", "special-block", "table"];

/** The column Org expects a line to start at, given the element it is in, as org--get-expected-indentation works it out. */
function expectedIndent(el: Elem | undefined, contentsp: boolean, line: number): number {
  const type = el?.type;
  const indentOf = (pos: number): number => textIndentation(ember.lineText(lineAt(pos)));
  if (contentsp) {
    if (type === "section") return expectedIndent(el?.parent, true, line);
    if (type === undefined || type === "headline") return 0;
    if (type === "item" || type === "plain-list") return listBodyColumn((el as Elem).begin);
    return indentOf((el as Elem).begin);
  }
  if (!el || type === "headline" || type === "org-data") return isBlank(ember.lineText(line)) ? expectedIndent(el, true, line) : 0;
  const bol = ember.lineStart(line);
  const start = el.begin;
  if (bol < start) return expectedIndent(el.parent, true, line);
  if (bol === start) {
    if (start === 0) return 0;
    let previous = elementAt(start - 1);
    for (let parent = previous; parent && parent.end <= start; parent = parent.parent) previous = parent;
    if (!previous || previous.type === "org-data") return 0;
    if (previous.end > start) return expectedIndent(previous, true, line);
    if (previous.begin === ember.lineStart(lineAt(previous.begin))) return indentOf(previous.begin);
    return expectedIndent(previous.parent, true, line);
  }
  let q = bol;
  while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
  if (type === "plain-list" && lineAt(bol) - lineAt(q) > 2) return indentOf(start);
  if (ember.lineStart(lineAt(q)) < start) return expectedIndent(el.parent, true, line);
  if (ember.lineStart(lineAt(q)) === start) return expectedIndent(el, true, line);
  if (GREATER_ELEMENTS.includes(type ?? "") && el.contentsEnd !== undefined && el.contentsEnd <= bol) {
    if (type === "item" || type === "plain-list") {
      const last = elementAt(q);
      return expectedIndent(last, last?.type === "item", line);
    }
    return indentOf(start);
  }
  return indentOf(q);
}

/** Indents a line as org-indent-line does, keeping point in the text or after the indentation. */
function indentLine(line: number): void {
  const text = ember.lineText(line);
  const ls = ember.lineStart(line);
  const block = elementAt(ls);
  if (block?.type === "src-block" && line > lineAt(block.begin) && line < lineAt(endBeforeBlank(block))) {
    // Org hands the line to the language's mode, which Ember lacks, then
    // gives an empty line the block's content indentation.
    if (!preservesIndentation(block) && text === "" && ember.point() === ls) {
      const ind = textIndentation(ember.lineText(lineAt(block.begin))) + Number(ember.variable("org-edit-src-content-indentation") ?? 2);
      indentLineTo(line, ind);
      ember.gotoChar(ember.lineEnd(line));
    }
    return;
  }
  if (isHeadingLine(text) || blockBefore(line) !== undefined) return;
  const el = elementAt(ls);
  if (el && (el.type === "plain-list" || el.type === "item") && el.begin === ls) return;
  const want = expectedIndent(el, false, line);
  const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
  const p = ember.point();
  if (lineAt(p) === line && p - ls <= charCount(ws)) {
    indentLineTo(line, want);
    ember.gotoChar(ls + charCount(/^[ \t]*/.exec(ember.lineText(line))?.[0] ?? ""));
  } else {
    const m = marker(p);
    indentLineTo(line, want);
    ember.gotoChar(m.pos);
    dropMarker(m);
  }
  if (el?.type === "node-property") {
    const column = ember.stringWidth(ember.bufferText(ls, ember.point()).replace(/\t/g, "        "));
    alignNodeProperty(line);
    moveToColumn(column);
  }
}

/** Moves point to a column on its line, or to the line's end, as move-to-column does. */
function moveToColumn(column: number): void {
  const line = lineAt();
  let p = ember.lineStart(line);
  let c = 0;
  for (const ch of ember.lineText(line)) {
    if (c >= column) break;
    c = ch === "\t" ? (Math.floor(c / 8) + 1) * 8 : c + ember.stringWidth(ch);
    p++;
  }
  ember.gotoChar(p);
}

/** A node property line's parts, as org-property-re matches them: indentation, :KEY:, and value. */
const PROPERTY_RE = /^([ \t]*)(:(\S+):)(?:()$|[ \t]+(.*?))([ \t]*)$/;

/** Aligns the node property on a line by org-property-format ("%-10s %s"), as org--align-node-property does. */
function alignNodeProperty(line: number): void {
  const text = ember.lineText(line);
  const m = PROPERTY_RE.exec(text);
  if (!m) return;
  const key = m[2];
  const formatted = `${key}${" ".repeat(Math.max(0, 10 - ember.stringWidth(key)))} ${m[5] ?? ""}`;
  const replacement = m[1] + formatted.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
  const ls = ember.lineStart(line);
  // Deleted and inserted again rather than replaced, so markers in the line go to its start.
  const checks = !foldChecksOff;
  withoutFoldChecks(() => {
    edDelete(ls, ls + charCount(text));
    edInsert(ls, replacement);
  });
  if (checks) fixFoldsAround(ls, ls + charCount(replacement));
}

/** Changes the indentation of the lines from start to end by offset, as indent-rigidly does. */
function indentRigidly(start: number, end: number, offset: number): void {
  const endM = marker(end);
  for (let line = lineAt(start); line < ember.lineCount() && ember.lineStart(line) < endM.pos; line++) {
    const text = ember.lineText(line);
    const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
    const ls = ember.lineStart(line);
    if (ws.length === text.length) edDelete(ls, ls + charCount(ws));
    else {
      const added = indentString(Math.max(0, textIndentation(text) + offset));
      edInsert(ls, added);
      edDelete(ls + charCount(added), ls + charCount(added) + charCount(ws));
    }
  }
  dropMarker(endM);
}

/** Indents the non-blank lines from start to end, each element as a whole, as org-indent-region does. */
function orgIndentRegion(start: number, end: number): void {
  const endM = marker(end);
  const size = (): number => ember.bufferSize();
  let p = start;
  while (p < size() && /[ \r\t\n]/.test(ember.bufferText(p, p + 1))) p++;
  if (p < size()) p = ember.lineStart(lineAt(p));
  // Gives lines up to pos the indentation ind, leaving p after pos.
  const indentTo = (ind: number, pos: number): void => {
    const limit = marker(pos);
    while (p < limit.pos) {
      const line = lineAt(p);
      if (!/^[ \t]*$/.test(ember.lineText(line))) indentLineTo(line, ind);
      p = lineStartOrEnd(line + 1);
      if (line + 1 >= ember.lineCount()) p = size();
    }
    dropMarker(limit);
  };
  while (p < endM.pos) {
    const line = lineAt(p);
    const el = isHeadingLine(ember.lineText(line)) ? undefined : elementAt(p);
    if (!el) {
      p = line + 1 < ember.lineCount() ? ember.lineStart(line + 1) : size();
      continue;
    }
    const type = el.type;
    const elementEnd = marker(el.end);
    const ind = expectedIndent(el, false, line);
    if (type === "export-block" || (type === "example-block" && !preservesIndentation(el))) {
      // Indented as a whole, keeping the lines' indentation relative to each other.
      const offset = ind - textIndentation(ember.lineText(lineAt(p)));
      if (offset !== 0) indentRigidly(el.begin, el.end, offset);
      p = elementEnd.pos;
    } else if (type === "src-block" || type === "example-block") {
      // The lines between the block's first and last are left alone: Org
      // hands a source block's to its language's mode, which Ember lacks.
      const lastLine = lineAt(endBeforeBlank(el));
      indentTo(ind, Math.min(lineStartOrEnd(lineAt(el.begin) + 1), endM.pos));
      p = Math.max(p, Math.min(ember.lineStart(lastLine), endM.pos));
      if (p < endM.pos) indentTo(ind, Math.min(elementEnd.pos, endM.pos));
    } else if (["paragraph", "table", "table-row"].includes(type) || el.contentsBegin === undefined) {
      if (type === "node-property") {
        const pm = marker(p);
        alignNodeProperty(lineAt(p));
        p = ember.lineStart(lineAt(pm.pos));
        dropMarker(pm);
      }
      indentTo(ind, Math.min(elementEnd.pos, endM.pos));
    } else {
      let cb = el.contentsBegin;
      if (type === "item" || type === "plain-list") {
        let q = ember.lineEnd(lineAt(el.begin));
        while (q < size() && /[ \r\t\n]/.test(ember.bufferText(q, q + 1))) q++;
        cb = q >= size() ? q : ember.lineStart(lineAt(q));
      }
      const cbeg = marker(cb);
      const cend = marker(el.contentsEnd ?? el.end, true);
      if (type === "plain-list") {
        const offset = ind - textIndentation(ember.lineText(lineAt(p)));
        if (offset !== 0) indentRigidly(el.begin, elementEnd.pos, offset);
        p = cbeg.pos;
      } else if (type === "item") p = cbeg.pos;
      else indentTo(ind, Math.min(cbeg.pos, endM.pos));
      if (p < endM.pos) {
        if (type !== "verse-block") orgIndentRegion(p, Math.min(cend.pos, endM.pos));
        p = Math.min(cend.pos, endM.pos);
        if (p < endM.pos) indentTo(ind, Math.min(elementEnd.pos, endM.pos));
      }
      dropMarker(cbeg);
      dropMarker(cend);
    }
    dropMarker(elementEnd);
  }
  dropMarker(endM);
}

ember.defineVariable({
  name: "org-edit-src-content-indentation",
  doc: "How far the lines of a source block are indented past its #+begin_src line.",
  value: 2,
});

/** Whether an example block keeps its lines' indentation, with its -i switch or org-src-preserve-indentation. */
function preservesIndentation(el: Elem): boolean {
  return ember.variable("org-src-preserve-indentation") === true || /\s-i(\s|$)/.test(ember.lineText(lineAt(el.begin)));
}

const BLOCK_TYPES = ["comment-block", "center-block", "example-block", "export-block", "quote-block", "special-block", "src-block", "verse-block"];

/** Whether point's line opens a block that is closed, as org-at-block-p checks with org-block-regexp. */
function atBlock(): boolean {
  const line = lineAt();
  const m = /^[ \t]*#\+begin_?([^ \n]+)/i.exec(ember.lineText(line));
  if (!m) return false;
  const close = new RegExp(`^[ \\t]*#\\+end_?${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "i");
  for (let l = line + 1; l < ember.lineCount(); l++) if (close.test(ember.lineText(l))) return true;
  return false;
}

ember.defineCommand({
  name: "org-indent-block",
  doc: "Indent the block at point.\nSignal an error when not at a block.",
  run: () => {
    const el = elementAt(ember.point());
    if (!el || !BLOCK_TYPES.includes(el.type)) throw new Error("Not at a block");
    const pt = marker(ember.point());
    orgIndentRegion(el.begin, el.end);
    ember.gotoChar(pt.pos);
    dropMarker(pt);
    ember.message("Block at point indented");
  },
});

ember.defineCommand({
  name: "org-indent-drawer",
  doc: "Indent the drawer at point.\nSignal an error when not at a drawer.",
  run: () => {
    const el = elementAt(ember.point());
    if (el?.type !== "drawer" && el?.type !== "property-drawer") throw new Error("Not at a drawer");
    const pt = marker(ember.point());
    orgIndentRegion(el.begin, el.end);
    ember.gotoChar(pt.pos);
    dropMarker(pt);
    ember.message("Drawer at point indented");
  },
});

// Commands: visibility

const cycle = ember.defineCommand({
  name: "org-cycle",
  doc:
    "TAB in Org: fold and unfold.\n\n" +
    "On a heading, cycle its subtree: folded, then its text and its children's headings, then everything. " +
    "On a list item with items under it, the same for the item. On a drawer or block line, fold or unfold it. " +
    "In a table, move to the next field. Anywhere else, indent the line. " +
    "With C-u, cycle the whole buffer as S-TAB does.",
  run: () => orgCycle(ember.prefixArg()),
});

/** TAB in Org, as org-cycle does with prefix argument arg. */
function orgCycle(arg: ember.PrefixArg): void {
  {
    if (cycleLevel() || cycleItemIndentation()) return;
    if (Array.isArray(arg) && arg[0] === 4) {
      globalCycle();
      return;
    }
    if (Array.isArray(arg) && arg[0] === 16) {
      ember.setVariable("org-cycle-global-status", null);
      startupVisibility();
      ember.message("Startup visibility, plus VISIBILITY properties");
      return;
    }
    if (Array.isArray(arg) && arg[0] === 64) {
      for (const spec of FOLD_SPECS) flag(0, ember.bufferSize(), false, spec);
      ember.message("Entire buffer visible, including drawers");
      return;
    }
    const line = lineAt();
    const text = ember.lineText(line);
    if ((DRAWER.test(text) && !/^[ \t]*:END:/i.test(text)) || BLOCK_BEGIN.test(text)) {
      if (toggleDrawerOrBlock(line)) {
        // As org-fold--hide-wrapper-toggle does, point is left where it shows.
        if (ember.point() > 0 && ember.invisibleAt(ember.point() - 1)) ember.gotoChar(ember.lineStart(line));
        return;
      }
    }
    // On the closing line too, as org-fold--hide-wrapper-toggle allows.
    const opener = openerOf(line);
    if (opener !== undefined && toggleDrawerOrBlock(opener)) {
      if (ember.point() > 0 && ember.invisibleAt(ember.point() - 1)) ember.gotoChar(ember.lineStart(opener));
      return;
    }
    if (/^[ \t]*[|+]/.test(text) && /^[ \t]*\|/.test(text)) {
      ember.call("org-table-justify-field-maybe");
      ember.call("org-table-next-field");
      return;
    }
    const here = headingHere();
    if (here) {
      // On a hidden heading, the one cycled is the nearest that shows above,
      // as org-back-to-heading finds it.
      const [all, at] = here;
      let i = at;
      while (i > 0 && ember.invisibleAt(all[i].start)) i--;
      cycleHeading(all, i, at);
      return;
    }
    if (itemLine(line)) {
      cycleItem(line);
      return;
    }
    // TAB as indent-for-tab-command does: the region if it is active, then
    // the mark goes, as indent-region sets deactivate-mark.
    if (orgRegionActive()) {
      const mark = ember.mark() as number;
      const pt = marker(ember.point());
      orgIndentRegion(Math.min(mark, ember.point()), Math.max(mark, ember.point()));
      ember.gotoChar(pt.pos);
      dropMarker(pt);
      ember.deactivateMark();
      return;
    }
    indentLine(line);
  }
}

/** Cycles an item's visibility, as org-cycle-internal-local does for items. */
function cycleItem(line: number): void {
  const struct = listStruct(line);
  const item = ember.lineStart(line);
  const eoh = ember.lineEnd(line);
  const eos = itemEndBeforeBlank(struct, item);
  const hasChildren = hasChild(struct, item) !== undefined;
  const eol = endOfHidden(line);
  const again = ember.lastCommand() === ember.thisCommand();
  const status = ember.variable("org-cycle-subtree-status");
  const all = headings();
  const inSection = headingIndex(all, line) !== undefined;
  const showFollowing = (): void => {
    const next = all.find((h) => h.start > eos);
    if (next && next.start < ember.bufferSize() && ember.invisibleAt(next.start)) showHeadingLine(next);
  };
  if (eos === eoh) {
    ember.message("EMPTY ENTRY");
    ember.setVariable("org-cycle-subtree-status", null);
    showFollowing();
    return;
  }
  const hiddenInOneLine = eol >= eos || /^\s*$/.test(ember.bufferText(eol, eos));
  const skipped = hiddenInOneLine && !hasChildren;
  if (hiddenInOneLine && hasChildren) {
    setItemVisibility(item, struct, "children");
    ember.message("CHILDREN");
    showFollowing();
    ember.setVariable("org-cycle-subtree-status", "children");
    if (inSection) showEmptyLines("children");
  } else if (skipped || (again && status === "children")) {
    flag(eoh, eos, false);
    ember.message(skipped ? "SUBTREE (NO CHILDREN)" : "SUBTREE");
    ember.setVariable("org-cycle-subtree-status", "subtree");
    if (inSection) showEmptyLines("subtree");
  } else {
    flag(eoh, eos, true);
    ember.message("FOLDED");
    ember.setVariable("org-cycle-subtree-status", "folded");
    if (inSection) showEmptyLines("folded");
  }
}

/**
 * Changes the level of an empty heading point is at the end of, as
 * org-cycle-level does for TAB: to a child of the heading above, then up
 * the levels, then back. Returns whether it applied.
 */
function cycleLevel(): boolean {
  const line = lineAt();
  const h = parseHeading(line);
  if (!h || !/^[ \t]*$/.test(ember.bufferText(ember.point(), h.end))) return false;
  const rest = ember.lineText(line).slice(h.level);
  const keywords = allKeywords().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const m = new RegExp(`^(?: +(?:${keywords}))?(?: +(.*?))?[ \t]*$`).exec(rest);
  if (!m || m[1] !== "") return false;
  ember.setThisCommand("org-cycle-level");
  const cur = h.level;
  let prev = 0;
  if (h.start !== 0) {
    const all = headings();
    const k = headingIndex(all, line - 1);
    prev = k === undefined ? 0 : all[k].level;
  }
  const promote = (n: number): void => {
    for (let i = 0; i < n; i++) ember.call("org-do-promote");
  };
  const demote = (n: number): void => {
    for (let i = 0; i < n; i++) ember.call("org-do-demote");
  };
  if (prev === 0) promote(cur - 1);
  else if (prev === cur) demote(1);
  else if (prev === 1) promote(cur - 1);
  else if (cur === 1) demote(prev - 1);
  else if (cur < prev) promote(1);
  else promote(1 + (cur - prev));
  return true;
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
      ember.message(`Content view to level: ${prefix}`);
      showLevels(prefix);
      showEmptyLines("t");
      ember.setVariable("org-cycle-global-status", "overview");
      return;
    }
    // As org-cycle-global does: C-u means the startup visibility, else C-u TAB.
    orgCycle(Array.isArray(prefix) ? [16] : [4]);
  },
});

ember.defineCommand({
  name: "org-global-cycle",
  doc: "Cycle the whole buffer: top headings only, then all headings, then everything.",
  run: () => orgCycle([4]),
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
  doc: "Show everything accessible, drawers and blocks included.",
  run: () => {
    // As org-fold-show-all: what is outside a narrowing stays as it is.
    for (const spec of ["outline", "org-hide-drawer", "org-hide-block"]) flag(ember.pointMin(), ember.pointMax(), false, spec);
  },
});

ember.defineCommand({
  name: "org-indent-line",
  doc: "Indent the line: text under a heading to the left margin, a list item's lines to its text, others as the line before.",
  run: () => indentLine(lineAt()),
});

const orgReturn = ember.defineCommand({
  name: "org-return",
  doc:
    "RET in Org: in a table, move to the next row; elsewhere start a new line, indented as org-indent-line does.\n\n" +
    "On a heading, the title after point goes to the new line, but the state, priority and tags stay. In a list " +
    "item, the text after point moves to the new line after it is indented.",
  run: () => orgReturnWith(true),
});

ember.defineCommand({
  name: "org-return-and-maybe-indent",
  doc: "C-j in Org: what RET does, but the new line is not indented, as electric-indent-mode leaves C-j alone.",
  run: () => orgReturnWith(false),
});

ember.defineVariable({
  name: "org-special-ctrl-o",
  doc: "Whether C-o in a table inserts a row rather than opening a line.",
  value: true,
});

ember.defineCommand({
  name: "org-open-line",
  doc: "C-o in Org: in a table, insert a row above; elsewhere, or at the very start of the buffer, open-line.",
  run: () => {
    const p = ember.point();
    if (ember.variable("org-special-ctrl-o") === true && p !== 0 && /^[ \t]*\|/.test(ember.lineText(lineAt())))
      ember.call("org-table-insert-row");
    else ember.callWithPrefix(ember.prefixArg(), "open-line");
  },
});

/**
 * RET in Org, as org-return does. Org calls newline interactively for RET,
 * so electric-indent-mode indents the new line, and from code for C-j, so it does not.
 */
function orgReturnWith(electric: boolean): void {
  // Org's newline self-inserts, so the newlines take on the text properties
  // around them, and runs of them undo together.
  const newline = (n: number): void => {
    ember.undoAutoAmalgamate();
    if (electric) electricNewline(n);
    else ember.insertAndInherit("\n".repeat(n));
  };
  checkInvisibleEditMaybe();
  const line = lineAt();
  const p = ember.point();
  const [ls, le] = [ember.lineStart(line), ember.lineEnd(line)];
  const n = Math.max(1, ember.prefixNumericValue());
  if (/^[ \t]*\|/.test(ember.lineText(line))) {
    // Before the first column or after the last, a table is split.
    if (/^[ \t]*$/.test(ember.bufferText(p, le)) || /^[ \t]*$/.test(ember.bufferText(ls, p))) ember.insert("\n");
    else {
      ember.call("org-table-justify-field-maybe");
      ember.call("org-table-next-row");
    }
    return;
  }
  const h = p > ls ? parseHeading(line) : undefined;
  // org-complex-heading-regexp also matches a line of bare stars, which
  // is not a heading, so the entry shown is the one it is in.
  const bareStars = p > ls && /^\*+[ \t]*$/.test(ember.lineText(line));
  if (h || bareStars) {
    const titleEnd = h ? h.titleAt + charCount(h.title) : p;
    const rest = h && h.title !== "" && p >= h.titleAt && p <= titleEnd ? ember.deleteRegion(p, titleEnd) : undefined;
    if (rest !== undefined && h?.tagsAt !== undefined) alignTags(line);
    ember.gotoChar(ember.lineEnd(line));
    const all = headings();
    const i = headingIndex(all, line);
    if (i !== undefined) {
      showEntry(all, i);
      hideDrawersIn(all[i].line + 1, entryEnd(all, i));
    } else {
      // Before the first heading, org-fold-show-entry works from the buffer's start.
      const end = all[0]?.start ?? ember.bufferSize();
      flag(0, end, false);
      hideDrawersIn(0, end);
    }
    newline(n);
    if (rest !== undefined) {
      const q = ember.point();
      ember.insert(rest.trim());
      ember.gotoChar(q);
    }
    return;
  }
  let context = elementAt(p)?.parent;
  while (context && context.type !== "item") context = context.parent;
  if (p < le && context) {
    const rest = ember.deleteRegion(p, le);
    newline(n);
    const q = ember.point();
    ember.insert(rest);
    ember.gotoChar(q);
    return;
  }
  newline(n);
}

/**
 * Inserts newlines and indents the new line, as newline does with
 * electric-indent-mode: spaces left at the end of the line before go.
 */
function electricNewline(n: number): void {
  ember.insertAndInherit("\n".repeat(n));
  const before = ember.point() - 1;
  const text = ember.bufferText(ember.lineStart(lineAt(before)), before);
  const spaces = text.length - text.replace(/[ \t]+$/, "").length;
  if (spaces > 0) ember.deleteRegion(before - spaces, before);
  indentLine(lineAt());
}

// Commands: moving between headings

ember.defineCommand({
  name: "org-end-of-line",
  doc: "Move to the end of the line, staying on a folded heading's line rather than going past its hidden text.",
  run: () => {
    const n = ember.prefixNumericValue();
    if (n !== 1) ember.callWithPrefix(n - 1, "next-line");
    // As move-beginning-of-line does, back to the start of the visible line first.
    ember.gotoChar(ember.lineStart(lineAt()));
    while (ember.point() > 0 && ember.invisibleAt(ember.point() - 1)) {
      let q = ember.point() - 1;
      while (q > 0 && ember.invisibleAt(q - 1)) q--;
      ember.gotoChar(ember.lineStart(lineAt(q)));
    }
    ember.gotoChar(ember.lineEnd(lineAt()));
  },
});

function visible(h: Heading): boolean {
  return h.start === 0 || !ember.invisibleAt(h.start - 1);
}

/**
 * Moves over headings, as org-next-visible-heading: a heading the search
 * finds inside a fold counts too, and the search goes on past the fold.
 * Without enough headings, point goes to the end, or to the start going back.
 */
function nextVisibleHeading(arg: number): void {
  const regexp = "^\\*+ ";
  const searchFails = (found: number | undefined, to: number): boolean => {
    if (found === undefined) ember.gotoChar(to);
    return found === undefined;
  };
  ember.gotoChar(arg < 0 ? ember.lineStart(lineAt()) : ember.lineEnd(lineAt()));
  while (arg < 0 && !searchFails(ember.reSearchBackward(regexp, { noerror: true }), ember.pointMin())) {
    if (ember.point() > ember.pointMin() && folded(ember.point())) {
      ember.gotoChar(ember.previousSingleCharPropertyChange(ember.point(), "invisible"));
      if (!ember.lookingAt(regexp)) searchFails(ember.reSearchBackward(regexp, { noerror: true }), ember.pointMin());
    }
    arg++;
  }
  while (arg > 0 && !searchFails(ember.reSearchForward(regexp, { noerror: true }), ember.pointMax())) {
    if (folded(ember.point())) {
      ember.gotoChar(ember.nextSingleCharPropertyChange(ember.point(), "invisible"));
      ember.skipCharsForward(" \t\n");
      ember.gotoChar(ember.lineEnd(lineAt()));
    }
    arg--;
  }
  ember.gotoChar(arg > 0 ? ember.pointMax() : ember.lineStart(lineAt()));
}

const nextHeading = ember.defineCommand({
  name: "org-next-visible-heading",
  doc: "Move to the next heading that is not hidden, or to the end of the buffer.",
  run: () => nextVisibleHeading(ember.prefixNumericValue()),
});

const previousHeading = ember.defineCommand({
  name: "org-previous-visible-heading",
  doc: "Move to the previous heading that is not hidden, or to the start of the buffer.",
  run: () => nextVisibleHeading(-ember.prefixNumericValue()),
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

/**
 * Moves `arg` headings at the same level as the one point is under, back
 * if `arg` is negative, stopping at the first or last under its parent, as
 * org-forward-heading-same-level does. Before the first heading it goes to
 * the first heading, or the start of the buffer going back.
 */
function forwardHeadingSameLevel(arg: number): void {
  const backward = arg < 0;
  const all = headings();
  const current = visibleHeadingIndex(all, lineAt());
  if (current === undefined) {
    if (backward) ember.gotoChar(0);
    else ember.gotoChar(all.find((h) => h.start > ember.point())?.start ?? ember.bufferSize());
    return;
  }
  const { level } = all[current];
  let result = backward ? all[current].start : all[current].end;
  let count = Math.abs(arg);
  const step = backward ? -1 : 1;
  for (let k = current + step; k >= 0 && k < all.length; k += step) {
    const h = all[k];
    if (count === 0) break;
    if (h.level < level) break;
    if (h.level === level && visible(h)) {
      count--;
      result = h.start;
    }
  }
  ember.gotoChar(ember.lineStart(lineAt(result)));
}

const forwardSameLevel = ember.defineCommand({
  name: "org-forward-heading-same-level",
  doc: "Move to the next heading at the same level, under the same parent.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardHeadingSameLevel(arg),
});

const backwardSameLevel = ember.defineCommand({
  name: "org-backward-heading-same-level",
  doc: "Move to the previous heading at the same level, under the same parent.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => forwardHeadingSameLevel(-arg),
});

/**
 * Puts point at the start of the element at point and the mark at its end,
 * or with the mark active, moves the mark to the end of the element there,
 * as org-mark-element does.
 */
function markElement(): void {
  const mark = ember.mark();
  const again = ember.lastCommand() === ember.thisCommand() && mark !== undefined;
  if (ember.calledInteractively() && (again || (ember.regionActive() && mark !== undefined))) {
    ember.setMark(elementAt(mark as number)?.end ?? (mark as number));
    return;
  }
  const e = elementAt(ember.point());
  if (!e) return;
  ember.gotoChar(ember.lineEnd(lineAt()));
  ember.pushMark(Math.min(ember.bufferSize(), e.end), { activate: true });
  ember.gotoChar(e.begin);
}

ember.defineCommand({
  name: "org-mark-element",
  doc: "Make the region the element at point; repeated, or with the mark active, take in the next element too.",
  run: () => markElement(),
});

const markSubtree = ember.defineCommand({
  name: "org-mark-subtree",
  doc: "Make the region the subtree point is in: point at its heading, the mark at its end.",
  run: () => {
    const line = lineAt();
    if (parseHeading(line)) ember.gotoChar(ember.lineStart(line));
    else if (headingIndex(headings(), line) === undefined) throw new Error("Not in a subtree");
    else ember.call("org-previous-visible-heading");
    markElement();
  },
});

// Commands: inserting headings and items

function blankLineAt(line: number): boolean {
  return line < ember.lineCount() && ember.lineText(line) === "";
}

/** Whether the line before point's is empty, as org-previous-line-empty-p says. */
function previousLineEmpty(): boolean {
  if (ember.point() === 0) return false;
  return /^[ \t]*$/.test(ember.lineText(Math.max(0, lineAt() - 1)));
}

/**
 * Whether a new heading here should have an empty line before it, as
 * org--blank-before-heading-p decides for org-blank-before-new-entry's
 * "auto": when the heading point is under, or its parent, has one.
 */
function blankBeforeHeading(parent: boolean): boolean {
  const all = headings();
  let i = headingIndex(all, lineAt());
  if (i === undefined) {
    // Before the first heading, the next one counts.
    i = all.findIndex((h) => h.start > ember.point());
    if (i < 0) return false;
  }
  if (parent) i = ancestors(all, i)[0] ?? i;
  const h = all[i];
  // Within the accessible portion, as bobp and point-max are.
  const [min, max] = [ember.pointMin(), ember.pointMax()];
  if (h.start !== min) return isBlank(ember.lineText(h.line - 1));
  const next = all[i + 1];
  if (next) return isBlank(ember.lineText(next.line - 1));
  // Trailing spaces on the last line are ignored.
  let q = max;
  while (q > min && /[ \t]/.test(ember.bufferText(q - 1, q))) q--;
  if (q !== ember.lineStart(lineAt(q)) || q === min) return false;
  return isBlank(ember.lineText(lineAt(q) - 1));
}

/** Makes the number of empty lines before point's line exactly n, as org-N-empty-lines-before-current does. */
function emptyLinesBeforeCurrent(n: number): void {
  const column = ember.point() - ember.lineStart(lineAt());
  ember.gotoChar(ember.lineStart(lineAt()));
  if (ember.point() > 0) {
    let q = ember.point();
    while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
    const start = ember.lineEnd(lineAt(q));
    if (start < ember.point() - 1) ember.deleteRegion(start, ember.point() - 1);
  }
  ember.insert("\n".repeat(n));
  const line = lineAt();
  ember.gotoChar(ember.lineStart(line) + Math.min(column, ember.lineEnd(line) - ember.lineStart(line)));
}

/** Keeps an empty line before the heading after a new one, as org-insert-heading's maybe-add-blank-after does. */
function maybeAddBlankAfter(blank: boolean): void {
  const p = ember.point();
  const line = lineAt();
  if (line + 1 < ember.lineCount() && blank && isHeadingLine(ember.lineText(line + 1))) {
    ember.gotoChar(ember.lineStart(line + 1));
    ember.insert("\n");
  }
  ember.gotoChar(p);
}

/**
 * Inserts a heading as org-insert-heading does, leaving point after its
 * stars. `arg` is the raw prefix argument: C-u inserts after the subtree,
 * C-u C-u after the parent's.
 */
/**
 * Inserts strings one after another, as Emacs's insert does with several
 * arguments: each is a change of its own, so Org's fold checks see the
 * text between them.
 */
function insertPieces(...pieces: string[]): void {
  for (const piece of pieces) if (piece !== "") ember.insert(piece);
}

function insertHeading(arg: ember.PrefixArg, invisibleOk = false): void {
  const parentEnd = Array.isArray(arg) && arg[0] === 16;
  const blank = blankBeforeHeading(parentEnd);
  const all = headings();
  const current = headingIndex(all, lineAt());
  // As org-current-level, from the whole buffer, so a heading above a narrowing counts.
  const level = ember.saveRestriction(() => {
    ember.widen();
    const wide = headings();
    const i = headingIndex(wide, lineAt());
    return i === undefined ? undefined : wide[i].level;
  });
  const stars = "*".repeat(level ?? 1);
  const p = ember.point();
  const respect =
    ember.variable("org-insert-heading-respect-content") === true ||
    (Array.isArray(arg) && (arg[0] === 4 || arg[0] === 16)) ||
    (!invisibleOk && ember.invisibleAt(Math.max(0, p - 1)));
  const atBol = (): boolean => ember.point() === ember.lineStart(lineAt());
  if (respect) {
    if (current === undefined) {
      const from = atBol() && p < ember.bufferSize() ? p + 1 : p;
      ember.gotoChar(all.find((h) => h.start >= from)?.start ?? ember.bufferSize());
    } else {
      let i = current;
      if (!invisibleOk) {
        // org-back-to-heading goes up to the first heading that is not
        // folded, leaving point at the last one it tried if none is.
        const lineage = [i, ...ancestors(all, i)];
        const shown = lineage.find((a) => !ember.invisibleAt(all[a].start));
        if (shown === undefined) {
          const last = all[lineage[lineage.length - 1]].start;
          ember.gotoChar(last);
          throw new Error(`Before first headline at position ${last + 1} in buffer ${ember.bufferName()}`);
        }
        i = shown;
      }
      if (parentEnd) i = ancestors(all, i)[0] ?? i;
      ember.gotoChar(subtreeRegion(all, i)[1]);
    }
    // At the end of a file with no final newline, the heading gets a line of its own.
    if (!atBol()) ember.insert("\n");
    if (blank && headingIndex(headings(), lineAt(ember.point() - 1)) === undefined) {
      ember.insert("\n");
      ember.gotoChar(ember.point() - 1);
    }
    if (level === undefined && ember.point() < ember.bufferSize() && ember.point() > 0) {
      if (isHeadingLine(ember.lineText(lineAt()))) ember.insert("\n");
      ember.gotoChar(ember.point() - 1);
    }
    if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
    insertPieces(stars, " ", "\n");
    ember.gotoChar(ember.point() - 1);
    maybeAddBlankAfter(blank);
    if (!invisibleOk) {
      const line = lineAt();
      if (folded(Math.max(0, ember.lineStart(line) - 1), "outline")) flag(Math.max(0, ember.lineStart(line) - 1), ember.lineEnd(line), false);
    }
    return;
  }
  const line = lineAt();
  const h = parseHeading(line);
  if (h) {
    if (atBol()) {
      if (blank) {
        ember.insert("\n");
        ember.gotoChar(p);
      }
      insertPieces(stars, " \n");
      ember.gotoChar(p);
      if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
      ember.gotoChar(ember.lineEnd(lineAt()));
      return;
    }
    const titleEnd = h.titleAt + charCount(h.title);
    if (ember.variable("org-M-RET-may-split-line") !== false && h.title !== "" && p >= h.titleAt && p <= titleEnd) {
      const split = ember.deleteRegion(p, titleEnd);
      if (/^[ \t]*$/.test(ember.bufferText(p, ember.lineEnd(line)))) ember.deleteRegion(p, ember.lineEnd(line));
      else alignTags(line);
      ember.gotoChar(ember.lineEnd(line));
      if (blank) ember.insert("\n");
      insertPieces("\n", stars, " ");
      maybeAddBlankAfter(blank);
      if (/\S/.test(split)) ember.insert(split);
      return;
    }
    ember.gotoChar(ember.lineEnd(line));
    if (blank) ember.insert("\n");
    insertPieces("\n", stars, " ");
    maybeAddBlankAfter(blank);
    return;
  }
  if (atBol()) {
    insertPieces(stars, " ");
    if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
    maybeAddBlankAfter(blank);
    return;
  }
  if (ember.variable("org-M-RET-may-split-line") === false) ember.gotoChar(ember.lineEnd(line));
  insertPieces("\n", stars, " ");
  if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
  maybeAddBlankAfter(blank);
}

/**
 * Inserts a heading with a TODO state, as org-insert-todo-heading does:
 * the state of the heading before it, unless that is done, or the first.
 */
function insertTodoHeading(arg: ember.PrefixArg, force: boolean): void {
  if (!force && insertListItem(true)) return;
  insertHeading(force ? [4] : Array.isArray(arg) && arg[0] === 16 ? arg : null);
  const p = ember.point();
  forwardHeadingSameLevel(-1);
  const previous = parseHeading(lineAt());
  ember.gotoChar(p);
  const first = todoSets()[0]?.todo[0] ?? "TODO";
  const state =
    (Array.isArray(arg) && arg[0] === 4) || previous?.todo === undefined || isDone(previous.todo) ? first : previous.todo;
  const line = lineAt();
  const stars = /^\*+ /.exec(ember.lineText(line));
  if (stars) {
    ember.gotoChar(ember.lineStart(line) + stars[0].length);
    ember.insert(`${state} `);
  }
  updateParentTodoStatistics(line);
}

const metaReturn = ember.defineCommand({
  name: "org-meta-return",
  doc:
    "M-RET in Org: insert a heading at the level of the one point is under, or an item in a list.\n\n" +
    "At the start of a line it goes before it; in the middle, the rest of the line goes to the new heading " +
    "(org-M-RET-may-split-line); at the end, after it.",
  run: () => {
    checkInvisibleEditMaybe();
    const prefix = ember.prefixArg();
    if (prefix !== null) {
      insertHeading(prefix);
      return;
    }
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) {
      ember.call("org-table-wrap-region");
      return;
    }
    if (inItem(lineAt()) !== undefined) insertListItem(false);
    else insertHeading(null);
  },
});

ember.defineCommand({
  name: "org-insert-heading",
  doc: "Insert a heading at the level of the one point is under. See org-meta-return.",
  run: () => insertHeading(ember.prefixArg()),
});

const respectContent = ember.defineCommand({
  name: "org-insert-heading-respect-content",
  doc: "Insert a heading after the subtree point is in, at its level.",
  run: () => insertHeading([4]),
});

const todoHeading = ember.defineCommand({
  name: "org-insert-todo-heading",
  doc: "Insert a heading with the first TODO state, as M-RET does; in a list, an item with a checkbox.",
  run: () => insertTodoHeading(ember.prefixArg(), false),
});

const todoHeadingRespectContent = ember.defineCommand({
  name: "org-insert-todo-heading-respect-content",
  doc: "Insert a heading with the first TODO state after the subtree point is in.",
  run: () => insertTodoHeading(ember.prefixArg(), true),
});

ember.defineCommand({
  name: "org-insert-item",
  doc: "Insert an item in the list point is in, at its level: before the item if point is before its text, else after it.",
  run: () => {
    insertListItem(Array.isArray(ember.prefixArg()));
  },
});

// Commands: promoting, demoting and moving

/**
 * Changes a heading's level, as org-promote and org-demote do: the stars
 * and the space after them are replaced, so point inside them goes to the
 * line's start, as save-excursion leaves it.
 */
function changeLevel(h: Heading, by: number): void {
  if (h.level + by < 1) throw new Error("Cannot promote to level 0.  UNDO to recover if necessary");
  // Org checks folds after promoting, but not after demoting.
  const change = (): void => {
    replaceKeepingPoint(h.start, h.start + h.level + 1, `${"*".repeat(h.level + by)} `);
    if (h.tags.length > 0) alignTagsAway(h.line);
  };
  if (by > 0) withoutFoldChecks(change);
  else change();
}

/** Moves point past the space after the stars or TODO state it is at, as org-fix-position-after-promote does. */
function fixPositionAfterPromote(): void {
  const h = parseHeading(lineAt());
  if (!h) return;
  const p = ember.point();
  const starsEnd = h.start + h.level;
  const todoEnd = h.todoAt !== undefined ? h.todoAt + charCount(h.todo ?? "") : undefined;
  if (p !== starsEnd && p !== todoEnd) return;
  if (p === ember.lineEnd(lineAt())) ember.insert(" ");
  else if (ember.bufferText(p, p + 1) === " ") ember.gotoChar(p + 1);
}

function changeSubtreeLevel(by: number): void {
  const [all, i] = backToHeading();
  const end = subtreeRegion(all, i)[1];
  const inside = all.filter((h, k) => k >= i && h.start < end);
  if (inside.some((h) => h.level + by < 1)) throw new Error("Cannot promote to level 0.  UNDO to recover if necessary");
  for (const h of [...inside].reverse()) changeLevel(parseHeading(h.line) ?? h, by);
  fixPositionAfterPromote();
}

/**
 * With the region active, the headings org-map-region goes through: those
 * starting in it, from its beginning on, which may be none.
 */
function headingsInRegion(): Heading[] | undefined {
  if (!orgRegionActive()) return undefined;
  const mark = ember.mark() ?? ember.point();
  const [from, to] = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
  return headings().filter((h) => h.start >= from && h.start < to);
}

/** Whether the active region begins on a heading's line, as org-metaleft and org-metaright check. */
function regionStartsAtHeading(): boolean {
  if (!orgRegionActive()) return false;
  const mark = ember.mark() ?? ember.point();
  return parseHeading(lineAt(Math.min(mark, ember.point()))) !== undefined;
}

ember.defineCommand({
  name: "org-do-promote",
  doc: "Make the heading point is on one level higher: one star fewer.",
  run: () => {
    const region = headingsInRegion();
    if (region) {
      ember.keepMarkActive(() => {
        // Forward, as org-map-region goes, so an error stops before the rest.
        for (const h of region) changeLevel(parseHeading(h.line) ?? h, -1);
      });
    } else {
      const [all, i] = backToHeading();
      changeLevel(all[i], -1);
    }
    fixPositionAfterPromote();
  },
});

ember.defineCommand({
  name: "org-do-demote",
  doc: "Make the heading point is on one level lower: one star more.",
  run: () => {
    const region = headingsInRegion();
    if (region) {
      ember.keepMarkActive(() => {
        // Forward, as org-map-region goes, so an error stops before the rest.
        for (const h of region) changeLevel(parseHeading(h.line) ?? h, 1);
      });
    } else {
      const [all, i] = backToHeading();
      changeLevel(all[i], 1);
    }
    fixPositionAfterPromote();
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

/** The next heading at the level of the one at pos, if no higher one comes first, as org-get-next-sibling finds it. */
function nextSiblingStart(all: Heading[], pos: number): number | undefined {
  const i = headingStartingAt(all, pos);
  const level = all[i].level;
  let k = i + 1;
  while (k < all.length && all[k].level > level) k++;
  return k < all.length && all[k].level >= level ? all[k].start : undefined;
}

/**
 * The heading before the one at pos at its level, as org-get-previous-sibling
 * finds it: deeper headings are skipped, but one at the start of the buffer
 * counts.
 */
function previousSiblingStart(all: Heading[], pos: number): number | undefined {
  const i = headingStartingAt(all, pos);
  const level = all[i].level;
  let k = i - 1;
  if (k < 0) return undefined;
  // As org-get-previous-sibling climbs with outline-previous-heading: a
  // deeper heading at the very start of the buffer stops it there, but above
  // the first heading is the start of the buffer, which is level 0.
  while (all[k].level > level) {
    if (all[k].start === 0) break;
    if (k === 0) return undefined;
    k--;
  }
  return all[k].level < level ? undefined : all[k].start;
}

/** Moves the subtree at point past arg siblings, back if negative, as org-move-subtree-down does. */
function moveSubtree(arg: number): void {
  const col = ember.point() - ember.lineStart(lineAt());
  const [all, found] = backToHeading(true);
  const i = visibleHeadingIndex(all, all[found].line) ?? found;
  const beg = all[i].start;
  ember.gotoChar(beg);
  const wasFolded = folded(all[i].end, "outline");
  const end = subtreeRegion(all, i)[1];
  let at = beg;
  for (let n = Math.abs(arg); n > 0; n--) {
    const next = arg > 0 ? nextSiblingStart(all, at) : previousSiblingStart(all, at);
    if (next === undefined) {
      ember.gotoChar(beg);
      throw new Error("Cannot move past superior level or buffer limit");
    }
    at = next;
  }
  let ins = at;
  if (arg > 0) {
    ins = subtreeRegion(all, firstHeadingFrom(all, at))[1];
    // Over any empty lines back to the end of the text, which gets a newline if it has none.
    let q = ins;
    while (q > 0 && /[ \t\n\r]/.test(ember.bufferText(q - 1, q))) q--;
    q = Math.min(lineStartOrEnd(lineAt(q) + 1), ins);
    if (q !== ember.lineStart(lineAt(q))) {
      ember.gotoChar(q);
      ember.insert("\n");
      if (q < ins) ins++;
    }
  }
  const txt = ember.bufferText(beg, end);
  edDelete(beg, end);
  let p = ins > beg ? ins - (end - beg) : ins;
  if (beg > 0) flag(beg - 1, beg, false);
  if (p > 0) flag(p - 1, p, false);
  if (p !== ember.lineStart(lineAt(p)) && ember.bufferText(p, p + 1) === "\n") p++;
  edInsert(p, txt, true);
  if (ember.point() !== ember.lineStart(lineAt())) edInsert(ember.point(), "\n");
  ember.gotoChar(p);
  while (ember.point() < ember.bufferSize() && /[ \t\n\r]/.test(ember.bufferText(ember.point(), ember.point() + 1))) {
    ember.gotoChar(ember.point() + 1);
  }
  const fresh = headings();
  const k = headingIndex(fresh, lineAt());
  if (k !== undefined) {
    if (wasFolded) flag(fresh[k].end, subtreeEnd(fresh, k), true);
    else {
      showEntry(fresh, k);
      hideDrawersIn(fresh[k].line + 1, entryEnd(fresh, k));
      showChildren(fresh, k);
    }
    cleanVisibilityAfterMove(fresh, k);
  }
  const line = lineAt();
  ember.gotoChar(ember.lineStart(line) + Math.min(col, ember.lineEnd(line) - ember.lineStart(line)));
}

/**
 * Folds the drawers of the subtrees around one that moved, and shows the
 * blank lines between them, as org-clean-visibility-after-subtree-move does.
 */
function cleanVisibilityAfterMove(all: Heading[], k: number): void {
  // As org-get-previous-sibling and org-get-next-sibling do, a search that
  // fails still leaves point where it stopped.
  // Each by halving, as the headings are in order.
  const levelAt = (pos: number): number => {
    const h = all[firstHeadingFrom(all, pos)];
    return h?.start === pos ? h.level : 0;
  };
  const before = (pos: number): number => all[firstHeadingFrom(all, pos) - 1]?.start ?? 0;
  const after = (pos: number): number => all[firstHeadingFrom(all, pos + 1)]?.start ?? ember.bufferSize();
  const previous = (pos: number): [number, boolean] => {
    const level = levelAt(pos);
    let p = before(pos);
    if (p === pos || levelAt(p) === 0) return [p, false];
    while (levelAt(p) > level && p !== 0) p = before(p);
    return [p, levelAt(p) >= level];
  };
  const next = (pos: number): [number, boolean] => {
    const level = levelAt(pos);
    let p = after(pos);
    while (p !== ember.bufferSize() && levelAt(p) > level) p = after(p);
    return [p, p !== ember.bufferSize() && levelAt(p) >= level];
  };
  let [from, ok] = previous(all[k].start);
  if (ok) from = previous(from)[0];
  let to = all[k].start;
  [to, ok] = next(to);
  if (ok) [to, ok] = next(to);
  if (ok) [to] = next(to);
  const end = levelAt(to) > 0 ? ember.lineEnd(lineAt(to)) : to;
  const re = new RegExp(`^${"\\*".repeat(all[k].level)} `);
  for (const h of all) {
    if (h.start < from || h.start > end || !re.test(ember.lineText(h.line))) continue;
    if (!ember.invisibleAt(h.start) && ember.invisibleAt(h.end)) showHeadingLine(h);
  }
  hideDrawersIn(lineAt(from), end);
  showEmptyLines("overview", [from, end]);
}

// Elements, after org-element.el: enough of the parse to drag paragraphs,
// lists, tables and drawers past each other with M-<up> and M-<down>.

interface Elem {
  type: string;
  begin: number;
  end: number;
  contentsBegin?: number;
  contentsEnd?: number;
  children: Elem[];
  parent?: Elem;
}

export const PLANNING = /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/;

function elem(type: string, begin: number, end: number, parent: Elem, contentsBegin?: number): Elem {
  const e: Elem = { type, begin, end, contentsBegin, children: [], parent };
  parent.children.push(e);
  return e;
}

/** Extends an element's end over the blank lines after it, up to a limit, as its post-blank. */
function postBlank(e: Elem, limit: number): void {
  let l = lineAt(e.end);
  while (e.end < limit && e.end === lineStartOrEnd(l) && l < ember.lineCount() && isBlank(ember.lineText(l))) {
    e.end = Math.min(limit, lineStartOrEnd(l + 1));
    l++;
  }
}

/** The line after a drawer opening at line, before limit, that closes it, if any. */
function drawerEnd(line: number, limit: number): number | undefined {
  for (let l = line + 1; l < ember.lineCount() && ember.lineStart(l) < limit; l++) {
    if (/^[ \t]*:END:[ \t]*$/i.test(ember.lineText(l))) return l;
    if (isHeadingLine(ember.lineText(l))) return undefined;
  }
  return undefined;
}

/** The block a line opens, and the line that closes it, before limit and the next heading. */
function blockAt(line: number, limit: number): { type: string; close: number } | undefined {
  const m = /^[ \t]*#\+begin_(\S+)/i.exec(ember.lineText(line));
  if (!m) return undefined;
  const close = new RegExp(`^[ \\t]*#\\+end_${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "i");
  for (let l = line + 1; l < ember.lineCount() && ember.lineStart(l) < limit; l++) {
    if (close.test(ember.lineText(l))) {
      const name = m[1].toLowerCase();
      const known = ["center", "quote", "comment", "example", "export", "src", "verse"];
      return { type: known.includes(name) ? `${name}-block` : "special-block", close: l };
    }
    if (isHeadingLine(ember.lineText(l))) return undefined;
  }
  return undefined;
}

/** A comment line, as org-element reads one: a hash, then a space or nothing. */
const COMMENT_LINE = /^[ \t]*#(?: |$)/;

/** A fixed-width line, as org-element reads one: a colon, then a space or nothing. */
const FIXED_WIDTH = /^[ \t]*:(?: |$)/;

/** Blocks whose contents are elements, which org-element parses inside them. */
const GREATER_BLOCKS = ["center-block", "quote-block", "special-block"];

/** Whether a line starts an element, so a paragraph before it ends. */
function startsElement(line: number, limit: number): boolean {
  const text = ember.lineText(line);
  return (
    isBlank(text) ||
    isHeadingLine(text) ||
    /^[ \t]*\|/.test(text) ||
    ITEM_RE.test(text) ||
    /^[ \t]*#\+\S*:/.test(text) ||
    FIXED_WIDTH.test(text) ||
    COMMENT_LINE.test(text) ||
    // As org-element-paragraph-separate has them: lines that look like an
    // item, rules, footnote definitions, diary sexps, table.el tables and clocks.
    /^[ \t]*(?:[-+*]|[0-9]+[.)])(?:[ \t]|$)/.test(text) ||
    /^[ \t]*-{5,}[ \t]*$/.test(text) ||
    /^\[fn:[-_\w]+\]/.test(text) ||
    /^%%\(/.test(text) ||
    /^[ \t]*\+(?:-+\+)+[ \t]*$/.test(text) ||
    /^[ \t]*CLOCK:/.test(text) ||
    (DRAWER_RE.test(text) && drawerEnd(line, limit) !== undefined) ||
    blockAt(line, limit) !== undefined
  );
}

/** Parses the elements between from and to into parent, as org-element--parse-elements does. */
function parseElements(
  parent: Elem,
  from: number,
  to: number,
  afterHeadline: boolean,
  list?: [Struct, Alist, Alist],
  firstSection = false,
): void {
  let p = from;
  let previous: string | undefined;
  while (p < to) {
    const line = lineAt(p);
    const text = ember.bufferText(p, ember.lineEnd(line));
    const next = lineStartOrEnd(line + 1);
    let e: Elem;
    if (afterHeadline && previous === undefined && PLANNING.test(text)) {
      e = elem("planning", p, Math.min(next, to), parent);
    } else if (
      (afterHeadline || (firstSection && p === 0)) &&
      (previous === undefined || previous === "planning") &&
      /^[ \t]*:PROPERTIES:[ \t]*$/i.test(text) &&
      drawerEnd(line, to) !== undefined &&
      // As org-property-drawer-re has it, every line inside is a property.
      Array.from({ length: (drawerEnd(line, to) as number) - line - 1 }, (_, k) => ember.lineText(line + 1 + k)).every((l) =>
        /^[ \t]*:\S+:(?:[ \t].*)?[ \t]*$/.test(l),
      )
    ) {
      const close = drawerEnd(line, to) as number;
      e = elem("property-drawer", p, Math.min(lineStartOrEnd(close + 1), to), parent, lineStartOrEnd(line + 1));
      e.contentsEnd = ember.lineStart(close);
      for (let l = line + 1; l < close; l++) elem("node-property", ember.lineStart(l), ember.lineStart(l + 1), e);
    } else if (p === ember.lineStart(line) && /^[ \t]*\|/.test(text)) {
      // Anchored at the line's start, as Org's is: an item's text that starts with a bar is no table.
      let last = line;
      while (last + 1 < ember.lineCount() && lineStartOrEnd(last + 1) < to && /^[ \t]*\|/.test(ember.lineText(last + 1))) last++;
      e = elem("table", p, Math.min(lineStartOrEnd(last + 1), to), parent, p);
      e.contentsEnd = e.end;
      for (let l = line; l <= last; l++) elem("table-row", ember.lineStart(l), Math.min(lineStartOrEnd(l + 1), to), e);
    } else if (p === ember.lineStart(line) && itemLine(line)) {
      const [struct, prevs, parents] = list ?? (() => {
        // Bounded by what holds the list, as org-element--list-struct is, not
        // by the drawer org-list-context may take a line for.
        const s = listStruct(line, { up: from, down: to });
        return [s, prevsAlist(s), parentsAlist(s)] as [Struct, Alist, Alist];
      })();
      // As org-element-plain-list-parser does, the list goes on through the
      // items that follow at the same indentation.
      const items = [p];
      for (let next = struct.find((e) => e.pos === getItem(struct, p).end); next && next.ind === getItem(struct, p).ind; ) {
        items.push(next.pos);
        const after = next.end;
        next = struct.find((e) => e.pos === after);
      }
      const end = Math.min(getItem(struct, items[items.length - 1]).end, to);
      e = elem("plain-list", p, end, parent, p);
      e.contentsEnd = end;
      for (const pos of items) {
        const it = getItem(struct, pos);
        const parts = itemParts(lineAt(pos));
        const cb = parts && parts.matchEnd < ember.lineEnd(lineAt(pos)) ? parts.matchEnd : undefined;
        const item = elem("item", pos, Math.min(it.end, to), e, cb);
        const contentsEnd = Math.min(itemEndBeforeBlank(struct, pos) + 1, item.end, ember.bufferSize());
        item.contentsEnd = contentsEnd;
        const start = cb ?? lineStartOrEnd(lineAt(pos) + 1);
        if (start < contentsEnd) parseElements(item, start, contentsEnd, false, [struct, prevs, parents]);
      }
    } else if (p === ember.lineStart(line) && DRAWER_RE.test(text) && drawerEnd(line, to) !== undefined) {
      const close = drawerEnd(line, to) as number;
      e = elem("drawer", p, Math.min(lineStartOrEnd(close + 1), to), parent, lineStartOrEnd(line + 1));
      e.contentsEnd = ember.lineStart(close);
      if (close > line + 1) parseElements(e, e.contentsBegin as number, e.contentsEnd, false);
      else e.contentsBegin = undefined;
    } else if (p === ember.lineStart(line) && blockAt(line, to) !== undefined) {
      const block = blockAt(line, to) as { type: string; close: number };
      const greater = GREATER_BLOCKS.includes(block.type) || block.type === "verse-block";
      const inside = block.close > line + 1;
      e = elem(block.type, p, Math.min(lineStartOrEnd(block.close + 1), to), parent, greater && inside ? lineStartOrEnd(line + 1) : undefined);
      if (greater && inside) e.contentsEnd = ember.lineStart(block.close);
      if (GREATER_BLOCKS.includes(block.type) && inside) parseElements(e, e.contentsBegin as number, e.contentsEnd as number, false);
    } else if (p === ember.lineStart(line) && /^[ \t]*-{5,}[ \t]*$/.test(text)) {
      e = elem("horizontal-rule", p, Math.min(next, to), parent);
    } else if (p === ember.lineStart(line) && /^[ \t]*CLOCK:/.test(text)) {
      e = elem("clock", p, Math.min(next, to), parent);
    } else if (p === ember.lineStart(line) && /^%%\(/.test(text)) {
      e = elem("diary-sexp", p, Math.min(next, to), parent);
    } else if (p === ember.lineStart(line) && COMMENT_LINE.test(text)) {
      let last = line;
      while (last + 1 < ember.lineCount() && lineStartOrEnd(last + 1) < to && COMMENT_LINE.test(ember.lineText(last + 1))) last++;
      e = elem("comment", p, Math.min(lineStartOrEnd(last + 1), to), parent);
    } else if (p === ember.lineStart(line) && FIXED_WIDTH.test(text)) {
      let last = line;
      while (last + 1 < ember.lineCount() && lineStartOrEnd(last + 1) < to && FIXED_WIDTH.test(ember.lineText(last + 1))) last++;
      e = elem("fixed-width", p, Math.min(lineStartOrEnd(last + 1), to), parent);
    } else if (p === ember.lineStart(line) && /^[ \t]*#\+\S*:/.test(text)) {
      e = elem("keyword", p, Math.min(next, to), parent);
    } else {
      let last = line;
      while (last + 1 < ember.lineCount() && lineStartOrEnd(last + 1) < to && !startsElement(last + 1, to)) last++;
      e = elem("paragraph", p, Math.min(lineStartOrEnd(last + 1), to), parent, p);
    }
    postBlank(e, to);
    if (e.type === "planning") {
      // Org's planning parser skips the blank lines after it, then goes back to
      // the start of the line it stopped on: a last line of only spaces, with
      // no newline, belongs to no element.
      const ls = ember.lineStart(lineAt(e.end));
      if (e.end === ember.bufferSize() && ls < e.end && isBlank(ember.bufferText(ls, e.end))) {
        e.end = ls;
        previous = e.type;
        break;
      }
    }
    previous = e.type;
    if (e.end <= p) break;
    p = e.end;
  }
}

/** Parses the buffer into its elements: headlines, sections and what they hold. */
/** The last parse and what it was made for, as headings are kept. */
let parseCache: { key: string; root: Elem } | undefined;

/**
 * The buffer's elements as far as the element at `pos` needs them: the
 * heading whose entry holds it with its ancestors and their sections, or
 * the text before the first heading. Other subtrees are left out, so the
 * parse costs what the entry does, not the buffer. Kept until the text, the
 * TODO keywords or that heading change.
 */
function parseFor(pos: number): Elem {
  const all = headingsAsRead();
  const branch = headingIndex(all, lineAt(pos));
  const key = `${ember.bufferName()}\n${ember.bufferModifiedTick()}\n${allKeywords().join(" ")}\n${branch ?? -1}\n${ember.pointMin()}-${ember.pointMax()}`;
  if (parseCache?.key !== key) parseCache = { key, root: parseBranch(all, branch) };
  return parseCache.root;
}

function parseBranch(all: Heading[], branch: number | undefined): Elem {
  const root: Elem = { type: "org-data", begin: 0, end: ember.bufferSize(), children: [] };
  const section = (parent: Elem, from: number, to: number, afterHeadline: boolean): void => {
    let p = from;
    while (p < to && isBlank(ember.lineText(lineAt(p))) && p === ember.lineStart(lineAt(p))) p = lineStartOrEnd(lineAt(p) + 1);
    if (p >= to) return;
    const sec = elem("section", p, to, parent, p);
    sec.contentsEnd = to;
    // Before the first heading, a property drawer may start the buffer.
    parseElements(sec, p, to, afterHeadline, undefined, parent.type === "org-data");
  };
  if (branch === undefined) {
    section(root, 0, all[0]?.start ?? ember.bufferSize(), false);
    return root;
  }
  // The headings holding the branch, outermost first, each with its section.
  let parent = root;
  for (const i of [...ancestors(all, branch).reverse(), branch]) {
    const h = all[i];
    const end = subtreeRegion(all, i)[1];
    const e = elem("headline", h.start, end, parent);
    section(e, lineStartOrEnd(h.line + 1), Math.min(all[i + 1]?.start ?? end, end), true);
    parent = e;
  }
  return root;
}

/**
 * Fails as Org's timestamp parser does on a planning line's timestamp that
 * only its loose form matches, <N-N-N ... +Nw>, and that holds no date.
 */
function checkPlanningTimestamps(line: number): void {
  const text = ember.lineText(line);
  for (const m of allMatches(/(?:SCHEDULED|DEADLINE|CLOSED):[ \t]*/g, text)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    if (/^[<[]\d{4}-\d{2}-\d{2}(?: .*?)?[\]>]/.test(rest)) continue;
    if (!/^<[0-9]+-[0-9]+-[0-9]+[^>\n]+?\+[0-9]+[dwmy]>/.test(rest)) continue;
    const start = /^[<[].*?(?=[\]>])/.exec(rest)?.[0] ?? rest;
    if (!/\d{4}-\d{2}-\d{2}/.test(start)) throw new Error(`Not an Org time string: ${start}`);
  }
}

/** The element at a position, as org-element-at-point finds it: the innermost, but not inside one starting there. */
function elementAt(pos: number): Elem | undefined {
  const found = elementAt_(pos);
  if (found?.type === "planning") checkPlanningTimestamps(lineAt(found.begin));
  return found;
}

function elementAt_(pos: number): Elem | undefined {
  let node = parseFor(pos);
  // At the end of the accessible portion, the element that ends there.
  const size = ember.pointMax();
  for (;;) {
    const child =
      node.children.find((c) => c.begin <= pos && pos < c.end) ??
      (pos === size ? node.children.find((c) => c.end === size && c.begin < size) : undefined);
    if (!child) return node.type === "org-data" || node.type === "section" ? undefined : node;
    if (child.type !== "section" && pos === child.begin) return child;
    node = child;
  }
}

function nested(a: Elem, b: Elem): boolean {
  return (a.begin >= b.begin && a.end <= b.end) || (b.begin >= a.begin && b.end <= a.end);
}

/** Where an element's text ends, before the blank lines after it. */
function endBeforeBlank(e: Elem): number {
  let q = e.end;
  while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
  return ember.lineEnd(lineAt(q));
}

/** Swaps two elements, a before b, leaving their blank lines, as org-element-swap-A-B does. */
function swapElements(a: Elem, b: Elem): void {
  withoutFoldChecks(() => swapElementsUnchecked(a, b));
}

function swapElementsUnchecked(a: Elem, b: Elem): void {
  const special = a.begin !== ember.lineStart(lineAt(a.begin));
  if (special && (b.type !== "paragraph" || b.begin !== b.contentsBegin)) {
    ember.gotoChar(a.begin);
    throw new Error("Cannot swap elements");
  }
  const indB = special ? indentation(ember.lineText(lineAt(b.begin))) : 0;
  const [begA, endA, begB, endB] = [a.begin, endBeforeBlank(a), b.begin, endBeforeBlank(b)];
  const bodyA = ember.bufferText(begA, endA);
  let bodyB = ember.bufferText(begB, endB);
  // As in Org, the folds each element is in, whole, go with it, placed
  // relative to where it now starts.
  const foldsOf = (from: number, to: number): [number, number, string][] =>
    ember
      .overlaysIn(from, to)
      .filter((id) => FOLD_SPECS.includes(String(ember.overlayGet(id, "invisible"))))
      .map((id) => [(ember.overlayStart(id) ?? from) - from, (ember.overlayEnd(id) ?? from) - from, String(ember.overlayGet(id, "invisible"))]);
  const restore = (folds: [number, number, string][], at: number): void => {
    for (const [s0, e0, spec] of folds) {
      const [from, to] = [Math.max(0, at + s0), Math.min(ember.bufferSize(), at + e0)];
      if (to > from) flag(from, to, true, spec);
    }
  };
  const foldsA = foldsOf(begA, endA);
  const foldsB = foldsOf(begB, endB);
  for (const spec of FOLD_SPECS) {
    flag(begA, endA, false, spec);
    flag(begB, endB, false, spec);
  }
  ember.deleteRegion(begB, endB);
  ember.gotoChar(begB);
  if (special) {
    bodyB = bodyB.replace(/^[ \t]*/, "");
    ember.insert(" ".repeat(indB));
  }
  ember.insert(bodyA);
  restore(foldsA, begB);
  ember.deleteRegion(begA, endA);
  ember.gotoChar(begA);
  ember.insert(bodyB);
  restore(foldsB, begA);
  ember.gotoChar(b.end);
}

ember.defineCommand({
  name: "org-drag-element-backward",
  doc: "Move the element at point, such as a paragraph or a list, before the one above it.",
  run: () => {
    const e = elementAt(ember.point());
    if (!e) throw new Error("No element at point");
    if (e.type === "headline") {
      // Point stays where it was in the subtree, even on blank lines below its heading.
      let q = ember.point();
      while (q > 0 && /[ \t\n]/.test(ember.bufferText(q - 1, q))) q--;
      const offset = ember.point() - q;
      ember.gotoChar(q);
      try {
        moveSubtree(-1);
      } finally {
        ember.gotoChar(ember.point() + offset);
      }
      return;
    }
    let prev: Elem | undefined;
    let q = e.begin;
    while (q > 0 && /[ \r\t\n]/.test(ember.bufferText(q - 1, q))) q--;
    if (q > 0) {
      prev = elementAt(q);
      for (let up = prev?.parent; prev && up && up.end <= e.begin; up = up.parent) prev = up;
    }
    if (!prev || nested(e, prev)) throw new Error("Cannot drag element backward");
    const pos = ember.point();
    swapElements(prev, e);
    ember.gotoChar(prev.begin + (pos - e.begin));
  },
});

ember.defineCommand({
  name: "org-drag-element-forward",
  doc: "Move the element at point, such as a paragraph or a list, after the one below it.",
  run: () => {
    const pos = ember.point();
    const e = elementAt(pos);
    if (!e) throw new Error("No element at point");
    if (e.end === ember.bufferSize()) throw new Error("Cannot drag element forward");
    const next = elementAt(e.end);
    if (!next || nested(e, next) || (next.type === "headline" && e.type !== "headline")) {
      ember.gotoChar(pos);
      throw new Error("Cannot drag element forward");
    }
    let q = endBeforeBlank(next);
    q = lineStartOrEnd(lineAt(q) + 1);
    if (q === ember.lineEnd(lineAt(q)) && q !== ember.lineStart(lineAt(q))) q++;
    const sizeNext = q - next.begin;
    const sizeBlank = e.end - lineStartOrEnd(lineAt(endBeforeBlank(e)) + 1);
    swapElements(e, next);
    ember.gotoChar(pos + sizeNext + sizeBlank);
  },
});

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
ember.defineCommand({
  name: "org-indent-item",
  doc: "Make the item point is on a child of the item before it, leaving its children where they are.",
  run: () => indentItemCommand(1, true),
});
ember.defineCommand({
  name: "org-outdent-item",
  doc: "Make the item point is on a sibling of its parent, leaving its children where they are.",
  run: () => indentItemCommand(-1, true),
});
ember.defineCommand({
  name: "org-indent-item-tree",
  doc: "Make the item point is on, with the items under it, a child of the item before it.",
  run: () => indentItemCommand(1, false),
});
ember.defineCommand({
  name: "org-outdent-item-tree",
  doc: "Make the item point is on, with the items under it, a sibling of its parent.",
  run: () => indentItemCommand(-1, false),
});

ember.defineCommand({
  name: "org-move-item-up",
  doc: "Swap the item point is on, with the items under it, with the one before it.",
  run: () => moveItemUp(),
});
ember.defineCommand({
  name: "org-move-item-down",
  doc: "Swap the item point is on, with the items under it, with the one after it.",
  run: () => moveItemDown(),
});

ember.defineCommand({
  name: "org-previous-item",
  doc: "Move to the item before the one point is in.",
  run: () => previousItem(),
});

ember.defineCommand({
  name: "org-next-item",
  doc: "Move to the item after the one point is in.",
  run: () => nextListItem(),
});

ember.defineCommand({
  name: "org-cycle-list-bullet",
  doc: "Change the bullets of the list point is in to the next kind: -, +, *, 1. and 1).",
  run: () => cycleListBullet(),
});

ember.defineCommand({
  name: "org-cycle-item-indentation",
  doc: "Indent an empty item, then outdent it a level at a time, then put it back, as repeated TAB does.",
  run: () => {
    cycleItemIndentation();
  },
});

ember.defineCommand({
  name: "org-cycle-level",
  doc: "Change the level of an empty heading: a child of the heading above, then up the levels, as repeated TAB does.",
  run: () => {
    cycleLevel();
  },
});

ember.defineCommand({
  name: "org-list-repair",
  doc: "Fix the indentation, bullets and checkboxes of the list point is in.",
  run: () => {
    const struct = structAtItem("This is not a list");
    writeStruct(struct, parentsAlist(struct));
  },
});

// Subtrees and the kill ring

/**
 * Kills or copies the subtree point is in, and the n - 1 after it, as
 * org-copy-subtree does. Point and the mark stay where they were, moving
 * as markers do when the text goes.
 */
/**
 * Kills or copies the subtree point is in, as org-copy-subtree does. Called
 * interactively it takes what looks like the subtree, the nearest heading
 * that shows; otherwise, as org-cut-subtree calls it, what is really there.
 */
function copySubtree(cut: boolean, n: number, visible: boolean): void {
  const p = ember.point();
  const [all, found] = backToHeading(true);
  let i = found;
  for (const a of [found, ...ancestors(all, found)]) {
    i = a;
    if (!visible || !ember.invisibleAt(all[a].start)) break;
  }
  let j = i;
  for (let k = 1; k < n; k++) j = sibling(all, j, 1) ?? j;
  const [beg, end] = [all[i].start, subtreeRegion(all, j)[1]];
  if (end <= beg) return;
  const mark = ember.mark();
  // Whether the tree shows folded, so pasting it back can fold it again.
  const folded = ember.invisibleAt(all[i].end);
  // Point after the mark, as Org passes them in order, so a kill joining
  // an earlier one goes after it.
  ember.setMark(beg);
  ember.gotoChar(end);
  ember.call(cut ? "kill-region" : "kill-ring-save");
  ember.setVariable("org-subtree-clip-folded", folded);
  ember.setVariable("org-subtree-clip", ember.currentKill());
  const moved = (x: number): number => (!cut || x <= beg ? x : x >= end ? x - (end - beg) : beg);
  ember.setMark(mark === undefined ? null : moved(mark));
  ember.gotoChar(moved(p));
  ember.message(`${cut ? "Cut" : "Copied"}: Subtree(s) with ${end - beg} characters`);
}

ember.defineCommand({
  name: "org-cut-subtree",
  doc: "Kill the subtree point is in, so C-c C-x C-y or C-y can put it back.",
  run: () => copySubtree(true, ember.prefixNumericValue(), false),
});

ember.defineCommand({
  name: "org-copy-subtree",
  doc: "Copy the subtree point is in to the kill ring.",
  run: () => copySubtree(false, ember.prefixNumericValue(), ember.calledInteractively()),
});

/** Whether text is one or more subtrees: it starts with a heading and none after is higher, as org-kill-is-subtree-p says. */
function killIsSubtree(text: string): boolean {
  const first = /^(?:[ \t\n\r]*?\n)?(\*+) /.exec(text);
  if (!first) return false;
  const level = first[1].length;
  return allMatches(/^(\*+) /gm, text).every((m) => m[1].length >= level);
}

/** The level of the heading on point's line, or 0 if it is not one. */
function levelHere(): number {
  return parseHeading(lineAt())?.level ?? 0;
}

/**
 * Pastes the last kill as a subtree at the level of the headings around
 * point, as org-paste-subtree does: before the heading point is at the
 * start of, or else before the next visible heading.
 */
function pasteSubtree(level: ember.PrefixArg): void {
  const txt = ember.currentKill();
  if (!killIsSubtree(txt)) throw new Error("The kill is not a (set of) tree(s).  Use \u2018C-y\u2019 to yank anyway");
  const visible = !ember.invisibleAt(ember.point());
  const old = /^(\*+) /m.exec(txt)?.[1].length ?? -1;
  const c4 = Array.isArray(level) && level[0] === 4;
  const c16 = Array.isArray(level) && level[0] === 16;
  const line = lineAt();
  const text = ember.lineText(line);
  const atBol = ember.point() === ember.lineStart(line);
  let indicator: number | undefined;
  let force: number | undefined;
  if ((level === null || c4 || c16) && /^\*+[ \t]*$/.test(text) && ember.bufferText(ember.point(), ember.point() + 1) !== "*") {
    indicator = (/^\*+/.exec(text) as RegExpExecArray)[0].length;
    force = indicator;
  } else if (c4) force = levelHere();
  else if (typeof level === "number") force = level;
  else if (!c16 && atBol && /^\*+ /.test(text)) force = levelHere();
  const all = headings();
  const shown = all.filter(visible_);
  const prev = parseHeading(line) ? levelHere() : (shown.filter((h) => h.line < line).at(-1)?.level ?? 1);
  const next = shown.find((h) => h.line > line)?.level ?? 1;
  const fresh = force ?? Math.max(c16 ? prev + 1 : 0, prev, next);
  let shift = old === -1 || fresh === -1 || old === fresh ? 0 : fresh - old;
  if (indicator !== undefined) ember.deleteRegion(ember.lineStart(line), lineStartOrEnd(line + 1));
  const here = lineAt();
  if (!(ember.point() === ember.lineStart(here) && parseHeading(here) && !c4 && !c16)) {
    if (c4) {
      const i = headingIndex(headings(), here);
      if (i !== undefined) ember.gotoChar(subtreeEnd(headings(), i));
    }
    const after = headings().filter(visible_).find((h) => h.line > lineAt());
    ember.gotoChar(after ? after.start : ember.bufferSize());
    if (ember.point() !== ember.lineStart(lineAt())) ember.insert("\n");
  }
  let beg = ember.point();
  // Org combines the paste's changes into one, after which its fold checks
  // change nothing here.
  withoutFoldChecks(() => {
    ember.insert(txt);
    if (!txt.endsWith("\n")) ember.insert("\n");
  });
  const end = ember.point();
  ember.gotoChar(beg);
  while (ember.point() < ember.bufferSize() && /[ \t\n\r]/.test(ember.bufferText(ember.point(), ember.point() + 1))) {
    ember.gotoChar(ember.point() + 1);
  }
  beg = ember.point();
  if (ember.invisibleAt(beg) && visible) showHeadingLine(parseHeading(lineAt(beg)) as Heading);
  const endMark = marker(end);
  while (shift !== 0) {
    for (const h of headings().filter((x) => x.start >= beg && x.start < endMark.pos).reverse()) {
      changeLevel(h, shift > 0 ? 1 : -1);
    }
    shift += shift > 0 ? -1 : 1;
  }
  dropMarker(endMark);
  ember.gotoChar(beg);
  ember.message(`Clipboard pasted as level ${fresh} subtree`);
  // A tree folded when it was killed or copied comes back folded.
  if (ember.variable("org-subtree-clip") === ember.currentKill() && ember.variable("org-subtree-clip-folded") === true) {
    foldSubtree(lineAt());
  }
}

/** Hides everything under the heading on a line, as org-fold-subtree does. */
function foldSubtree(line: number): void {
  const all = headings();
  const i = headingIndex(all, line);
  if (i === undefined) return;
  const next = subtreeRegion(all, i)[1];
  const end = next >= ember.bufferSize() ? ember.bufferSize() : next - 1;
  if (end > all[i].end) flag(all[i].end, end, true);
}

ember.defineVariable({
  name: "org-subtree-clip",
  doc: "The last subtree org-cut-subtree or org-copy-subtree put on the kill ring.",
  value: null,
});
ember.defineVariable({
  name: "org-subtree-clip-folded",
  doc: "Whether the subtree in org-subtree-clip was folded when it was cut or copied.",
  value: false,
});
ember.defineVariable({
  name: "org-yank-folded-subtrees",
  doc: "Whether C-y folds the subtrees it yanks, unless folding would hide text after them.",
  value: true,
});

/**
 * Yanks, as org-yank does: a kill that is a set of subtrees, yanked at the
 * start of a line, comes in folded, unless folding would hide text after it.
 */
function orgYank(arg: ember.PrefixArg): void {
  ember.setThisCommand("yank");
  if (arg !== null) {
    ember.callWithPrefix(arg, "yank");
    return;
  }
  const p = ember.point();
  const ls = ember.lineStart(lineAt());
  // As org-kill-is-subtree-p does, an empty kill ring is no subtree.
  let kill = "";
  try {
    kill = ember.currentKill();
  } catch {
    kill = "";
  }
  const subtreep =
    killIsSubtree(kill) &&
    (p === ls || (/^[ \t]*$/.test(ember.bufferText(p, ember.lineEnd(lineAt()))) && /^\*+$/.test(ember.bufferText(ls, p))));
  if (!subtreep || ember.variable("org-yank-folded-subtrees") !== true) {
    ember.call("yank");
    return;
  }
  const beg = p;
  ember.call("yank");
  const end = ember.point();
  ember.gotoChar(beg);
  const swallows = (): boolean => {
    let q = beg;
    while (q < end && !parseHeading(lineAt(q))) q = lineStartOrEnd(lineAt(q) + 1);
    const level = parseHeading(lineAt(Math.min(q, end)))?.level ?? 0;
    let r = end;
    while (r < ember.bufferSize() && /[ \t\r\n\v\f]/.test(ember.bufferText(r, r + 1))) r++;
    if (r >= ember.bufferSize()) return false;
    const h = r === ember.lineStart(lineAt(r)) ? parseHeading(lineAt(r)) : undefined;
    return !(h && h.level <= level);
  };
  if (beg === ember.lineStart(lineAt(beg))) {
    if (swallows()) ember.message("Inserted text not folded because that would swallow text");
    else {
      let q = beg;
      if (!parseHeading(lineAt(q))) {
        while (q < end && !parseHeading(lineAt(q))) q = lineStartOrEnd(lineAt(q) + 1);
        q = Math.min(q, end);
      }
      while (q < end && q === ember.lineStart(lineAt(q)) && parseHeading(lineAt(q))) {
        ember.gotoChar(q);
        foldSubtree(lineAt(q));
        showEmptyLines("folded");
        const all = headings();
        const i = headingIndex(all, lineAt(q)) as number;
        const sibling = all.find((h) => h.start >= subtreeRegion(all, i)[1]);
        q = sibling && sibling.level === all[i].level ? sibling.start : end;
      }
    }
  }
  let r = end;
  while (r < ember.bufferSize() && /[ \t\n\r]/.test(ember.bufferText(r, r + 1))) r++;
  ember.gotoChar(ember.lineStart(lineAt(r)));
  ember.pushMark(beg);
}

ember.defineCommand({
  name: "org-yank",
  doc:
    "C-y in Org: yank, folding the subtrees yanked at the start of a line, as org-yank-folded-subtrees says, " +
    "unless that would hide text after them.",
  run: () => orgYank(ember.prefixArg()),
});

function visible_(h: Heading): boolean {
  return visible(h);
}

ember.defineCommand({
  name: "org-paste-subtree",
  doc: "Paste the last kill as a subtree, its levels changed to fit the headings around point.",
  run: () => pasteSubtree(ember.prefixArg()),
});

ember.defineCommand({
  name: "org-fix-tags-on-the-fly",
  doc: "Align the tags of the heading point is on, if point is before them, as typing on a heading does.",
  run: () => {
    const line = lineAt();
    const m = /^\*+ (?:.*[ \t])?(:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u.exec(ember.lineText(line));
    if (m && ember.point() < ember.lineStart(line) + charCount(ember.lineText(line).slice(0, m[0].length - m[1].length - (/[ \t]*$/.exec(m[0])?.[0].length ?? 0)))) {
      alignTags(line);
    }
  },
});

ember.defineCommand({
  name: "org-paste-special",
  doc: "Paste a subtree at the right level, or in a table, the fields last cut or copied from one.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-paste-rectangle");
    else ember.callWithPrefix(ember.prefixArg(), "org-paste-subtree");
  },
});

ember.defineCommand({
  name: "org-cut-special",
  doc: "Cut the subtree point is in, or in a table, blank the field at point or the fields in the region.",
  run: () => ember.callInteractively(/^[ \t]*\|/.test(ember.lineText(lineAt())) ? "org-table-cut-region" : "org-cut-subtree"),
});

ember.defineCommand({
  name: "org-copy-special",
  doc: "Copy the subtree point is in, or in a table, the field at point or the fields in the region.",
  run: () => ember.callInteractively(/^[ \t]*\|/.test(ember.lineText(lineAt())) ? "org-table-copy-region" : "org-copy-subtree"),
});

// Commands: TODO states, priorities and tags

/** Changes a heading's TODO state, keeping point in place relative to the text around it. */
/**
 * Sets a heading's TODO state, or removes it, as org-todo does: the old
 * keyword and the spaces around it are replaced, so point there moves
 * past the new keyword. Then point near the keyword goes just after it.
 */
function setTodo(h: Heading, state: string | undefined): void {
  replaceTodoKeyword(h, state);
  fixPositionAfterTodo(h.line);
}

/** Replaces a heading's TODO keyword and the spaces around it, as org-todo does, so point there moves past the new one. */
function replaceTodoKeyword(h: Heading, state: string | undefined): void {
  const from = h.start + h.level;
  const rest = ember.bufferText(from, h.end);
  const kw = h.todo === undefined ? undefined : new RegExp(`^ +${h.todo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: +|[ \t]*$)`).exec(rest);
  const old = kw ? kw[0] : (/^ */.exec(rest)?.[0] ?? "");
  const p = marker(ember.point());
  withoutFoldChecks(() => {
    edDelete(from, from + charCount(old));
    edInsert(from, state === undefined ? " " : ` ${state} `, true);
  });
  ember.gotoChar(p.pos);
  dropMarker(p);
}

/**
 * Leaves one space after a heading's TODO keyword, or its stars, as org-todo's
 * last step does. Org moves there inside save-excursion, so point stays
 * where it was, moved only by the edit.
 */
function fixPositionAfterTodo(line: number): void {
  const fresh = parseHeading(line);
  if (!fresh) return;
  const end = fresh.todoAt !== undefined ? fresh.todoAt + charCount(fresh.todo ?? "") : fresh.start + fresh.level;
  const after = ember.bufferText(end, ember.lineEnd(line));
  if (!/^ /.test(after) || /^ *:/.test(after)) return;
  // just-one-space
  const spaces = /^[ \t]*/.exec(after)?.[0].length ?? 0;
  if (spaces > 1) {
    const p = marker(ember.point());
    edDelete(end + 1, end + spaces);
    ember.gotoChar(p.pos);
    dropMarker(p);
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

/**
 * Changes the TODO state of the heading point is under, as org-todo does:
 * the keyword, then the tags, CLOSED, the parent's statistics and a
 * repeat, then point just after the keyword if it was near it.
 */
function todo(direction: number, state?: string): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const before = h.todo;
  const next = state === undefined ? nextState(before, direction) : state === "" ? undefined : state;
  replaceTodoKeyword(h, next);
  if (parseHeading(h.line)?.tagsAt !== undefined) alignTagsAway(h.line);
  if (ember.variable("org-log-done") === "time") {
    if (isDone(next) && !isDone(before)) setPlanning(h.line, "CLOSED", `[${formatTimestamp(today(true), true)}]`);
    else if (!isDone(next) && isDone(before)) setPlanning(h.line, "CLOSED", undefined);
  }
  updateParentTodoStatistics(h.line);
  let note: [string, string] | undefined;
  if (isDone(next) && !isDone(before)) note = autoRepeat(h.line, before, next as string);
  fixPositionAfterTodo(h.line);
  // Org stores the note from post-command-hook, after the command.
  if (note) storeStateNote(h.line, note[0], note[1]);
}

/**
 * When a heading marked done has a repeating timestamp, puts it back to
 * its state and moves the timestamps on, as org-auto-repeat-maybe does.
 * Returns the note to log, if org-log-repeat says to.
 */
function autoRepeat(line: number, last: string | undefined, done: string): [string, string] | undefined {
  const h = parseHeading(line) as Heading;
  const all = headingsAsRead();
  const end = entryEnd(all, headingIndex(all, line) as number);
  const repeating = /<[0-9]{4}-[0-9][0-9]-[0-9][0-9] [^>\n]*?([.+]?\+([0-9]+)[hdwmy](?:\/[0-9]+[hdwmy])?)/;
  let found = false;
  for (let l = line + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
    const m = repeating.exec(ember.lineText(l));
    if (m) {
      found = Number(m[2]) !== 0;
      break;
    }
  }
  if (!found) return undefined;
  // Back to the first state of its sequence, or to none.
  const set = todoSets().find((t) => last !== undefined && (t.todo.includes(last) || t.done.includes(last)));
  const to = set ? set.todo[0] ?? set.done[0] : undefined;
  const p = marker(ember.point());
  ember.gotoChar(h.start);
  replaceTodoKeyword(parseHeading(line) as Heading, to);
  if (parseHeading(line)?.tagsAt !== undefined) alignTagsAway(line);
  updateParentTodoStatistics(line);
  setPlanning(line, "CLOSED", undefined);
  const log = ember.variable("org-log-repeat");
  if (log) entryPut(line, "LAST_REPEAT", `[${formatTimestamp(today(true), true)}]`);
  repeatEntry(parseHeading(line) as Heading);
  ember.gotoChar(p.pos);
  dropMarker(p);
  return log ? [done, last ?? ""] : undefined;
}

/**
 * Brings the statistics cookie of a heading's parent up to date with its
 * children's TODO states, as org-update-parent-todo-statistics does: the
 * children at the heading's level with a state, and those done.
 */
function updateParentTodoStatistics(line: number): void {
  const all = headingsAsRead();
  const i = headingIndex(all, line);
  if (i === undefined) return;
  const parent = ancestors(all, i)[0];
  if (parent === undefined || !HAS_COOKIE.test(ember.lineText(all[parent].line))) return;
  if (mapRegionStart && all[parent].start < mapRegionStart.pos) return;
  const level = all[i].level;
  const end = subtreeRegion(all, parent)[1];
  const children: Heading[] = [];
  for (let k = parent + 1; k < all.length && all[k].start < end; k++) if (all[k].level === level) children.push(all[k]);
  const p = marker(ember.point());
  withoutFoldChecks(() => {
    writeCookies(all[parent].line, children.filter((h) => isDone(h.todo)).length, children.filter((h) => h.todo !== undefined).length);
  });
  if (parseHeading(all[parent].line)?.tagsAt !== undefined) alignTagsAway(all[parent].line);
  ember.gotoChar(p.pos);
  dropMarker(p);
}

const todoCommand = ember.defineCommand({
  name: "org-todo",
  doc:
    "Change the TODO state of the heading point is under to the next one: none, TODO, DONE and back to none.\n\n" +
    "The states are org-todo-keywords, or a #+TODO: line's. Marking an entry done whose SCHEDULED or DEADLINE " +
    "date repeats, such as <2026-10-28 Wed +1w>, moves the date on and keeps it to do. With the region active, " +
    "every heading in it changes (org-loop-over-headlines-in-active-region).",
  run: () => {
    if (!forEachHeadingInRegion(() => todo(1), true)) todo(1);
  },
});

/**
 * Runs body at each visible heading in the active region, as org-map-entries
 * does for commands when org-loop-over-headlines-in-active-region is on.
 * Returns whether it applied.
 */
/**
 * Where org-map-entries has narrowed to the region it loops over, if it is
 * looping: headings above it are out of reach, so their cookies stay.
 */
let mapRegionStart: Marker | undefined;

function forEachHeadingInRegion(body: () => void, todoQuirk = false): boolean {
  const mark = ember.mark();
  if (!orgRegionActive() || mark === undefined || ember.variable("org-loop-over-headlines-in-active-region") !== true) return false;
  const [rb, re] = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
  if (todoQuirk && ember.invisibleAt(ember.point())) {
    // org-todo gives org-map-entries (when (org-invisible-p) (org-end-of-subtree
    // nil t)) to skip with, which runs once, there and then: point goes to the
    // end of the hidden subtree, and that position skips every heading.
    const all = headings();
    const i = headingIndex(all, lineAt());
    ember.gotoChar(i === undefined ? ember.bufferSize() : subtreeRegion(all, i)[1]);
    return true;
  }
  const outer = mapRegionStart;
  mapRegionStart = marker(rb);
  const atHeadingStart = re === ember.lineStart(lineAt(re)) && parseHeading(lineAt(re)) !== undefined;
  const end = marker(atHeadingStart ? re : (headings().find((h) => h.start > re)?.start ?? ember.bufferSize()));
  const origin = marker(ember.point());
  try {
    let at = marker(rb);
    for (;;) {
      const h = headings().find((x) => x.start >= at.pos && x.start < end.pos);
      if (!h) break;
      dropMarker(at);
      at = marker(h.end);
      if (ember.invisibleAt(h.start)) continue;
      ember.gotoChar(h.start);
      body();
    }
    dropMarker(at);
  } finally {
    ember.gotoChar(origin.pos);
    dropMarker(origin);
    dropMarker(end);
    dropMarker(mapRegionStart);
    mapRegionStart = outer;
  }
  return true;
}

ember.defineCommand({
  name: "org-todo-set",
  doc: "Set the TODO state of the heading point is under, or remove it with an empty state.",
  params: [{ name: "state", prompt: "TODO state: " }],
  run: (state) => todo(1, state),
});

/** Raises (1) or lowers (-1) a heading's priority, as org-priority does for up and down. */
function priority(direction: number): void {
  const [all, i] = backToHeading();
  const h = all[i];
  const highest = String(ember.variable("org-priority-highest") ?? "A").charCodeAt(0);
  const lowest = String(ember.variable("org-priority-lowest") ?? "C").charCodeAt(0);
  const fallback = String(ember.variable("org-priority-default") ?? "B").charCodeAt(0);
  const text = ember.lineText(h.line);
  const cookie = /^.*?(\[#([A-Z0-9]+)\] ?)/.exec(text);
  const again = ember.lastCommand() === ember.thisCommand();
  let next: number;
  if (cookie) next = cookie[2].charCodeAt(0) - direction;
  else next = again ? (direction > 0 ? lowest : highest) : fallback;
  let remove = false;
  if (next < highest || next > lowest) {
    if (!cookie && !again) throw new Error("The default can not be set, see \u2018org-priority-default\u2019 why");
    remove = true;
  }
  const p = marker(ember.point());
  if (cookie) {
    const start = h.start + charCount(cookie[0].slice(0, cookie[0].length - cookie[1].length));
    if (remove) edDelete(start, start + charCount(cookie[1]));
    else {
      // replace-match on the letter alone: point after it stays after it.
      edReplace(start + 2, start + 2 + charCount(cookie[2]), String.fromCharCode(next));
    }
  } else if (remove) {
    dropMarker(p);
    throw new Error("No priority cookie found in line");
  } else if (h.todoAt !== undefined) {
    edInsert(h.todoAt + charCount(h.todo ?? ""), ` [#${String.fromCharCode(next)}]`);
  } else {
    edInsert(h.titleAt, `[#${String.fromCharCode(next)}] `);
  }
  ember.gotoChar(p.pos);
  dropMarker(p);
  if (parseHeading(h.line)?.tagsAt !== undefined) alignTagsAway(h.line);
  ember.message(remove ? "Priority removed" : `Priority of current item set to ${String.fromCharCode(next)}`);
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
export function alignTags(line: number): void {
  const text = ember.lineText(line);
  const m = /^\*+ (?:.*[ \t])?(:[\p{L}\p{N}_@#%:]+:)[ \t]*$/u.exec(text);
  if (!m) return;
  const ls = ember.lineStart(line);
  const tagsIndex = m[0].length - m[1].length - (/[ \t]*$/.exec(m[0])?.[0].length ?? 0);
  const tagsStart = ls + charCount(text.slice(0, tagsIndex));
  const blankIndex = text.slice(0, tagsIndex).replace(/[ \t]+$/, "").length;
  const blankStart = ls + charCount(text.slice(0, blankIndex));
  const column = Number(ember.variable("org-tags-column") ?? -77);
  const blankColumn = ember.stringWidth(text.slice(0, blankIndex));
  const want = Math.max(column >= 0 ? column : -column - ember.stringWidth(m[1]), blankColumn + 1);
  const current = ember.stringWidth(text.slice(0, tagsIndex));
  if (want === current) return;
  // As org--align-tags-here does: point in the blanks keeps its column,
  // and elsewhere it moves as a marker does.
  const p = ember.point();
  const inBlank = lineAt(p) === line && p > blankStart && p <= tagsStart;
  const origin = marker(p);
  edDelete(blankStart, tagsStart);
  edInsert(blankStart, " ".repeat(want - blankColumn));
  if (inBlank) ember.gotoChar(Math.min(ls + (p - ls), ember.lineEnd(line)));
  else ember.gotoChar(origin.pos);
  dropMarker(origin);
}

/** Aligns a heading's tags with point at the heading, as Org does inside save-excursion, so point moves as a marker. */
function alignTagsAway(line: number): void {
  const p = marker(ember.point());
  ember.gotoChar(ember.lineStart(line));
  alignTags(line);
  ember.gotoChar(p.pos);
  dropMarker(p);
}

/** Gives the heading point is under these tags, as org-set-tags does. */
function setTags(tags: string[]): void {
  const [all, i] = backToHeading();
  const h = all[i];
  if (tags.join(":") === h.tags.join(":")) return;
  // The tags go, and the spaces before them, or trailing spaces if there are none.
  const text = ember.lineText(h.line);
  const before = text.slice(0, h.tagsAt !== undefined ? indexOf(h.line, text, h.tagsAt) : text.length).replace(/[ \t]+$/, "");
  replaceText(h.start + charCount(before), h.end, "");
  if (!parseHeading(h.line)) replaceText(ember.lineEnd(h.line), ember.lineEnd(h.line), " ");
  if (tags.length === 0) return;
  const end = ember.lineEnd(h.line);
  replaceText(end, end, ` :${tags.join(":")}:`);
  alignTags(h.line);
}

const setTagsCommand = ember.defineCommand({
  name: "org-set-tags-command",
  doc: "Set the tags of the heading point is under, written as :work:home: or work home; empty removes them.",
  params: [{ name: "tags", prompt: "Tags: ", history: "org-tags-history" }],
  run: (answer: string) => setTags(answer.split(/[:\s,]+/).filter((t) => t !== "")),
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

export interface DateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

export function today(withTime = false): DateTime {
  // Tests fix the day with ember--today, as "YYYY-MM-DD".
  const fixed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ember.variable("ember--today") ?? ""));
  if (fixed) return { year: Number(fixed[1]), month: Number(fixed[2]), day: Number(fixed[3]), ...(withTime ? { hour: 12, minute: 0 } : {}) };
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
export function formatTimestamp(d: DateTime, withTime = d.hour !== undefined): string {
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
  for (const m of allMatches(TS, text)) {
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
/** Whether point is in or just after a timestamp, as org-at-timestamp-p with lax says. */
function timestampHere(): boolean {
  const p = ember.point();
  return tsMatches(lineAt()).some((ts) => ts.start <= p && p <= ts.end);
}

function timestampText(ts: Timestamp): string {
  const [open, close] = ts.active ? ["<", ">"] : ["[", "]"];
  let end = "";
  if (ts.endTime) end = `-${two(ts.endTime[0])}:${two(ts.endTime[1])}`;
  return `${open}${formatTimestamp(ts.date)}${end}${ts.rest}${close}`;
}

/** Where the groups of org-ts-regexp3 match in a timestamp, as positions in the buffer. */
interface TsMatch {
  start: number;
  end: number;
  text: string;
  year: [number, number];
  month: [number, number];
  day: [number, number];
  dayName?: [number, number];
  hour?: [number, number];
  minute?: [number, number];
}

/** The timestamps on a line, matched as Org's org-ts-regexp3 matches them. */
function tsMatches(line: number): TsMatch[] {
  const text = ember.lineText(line);
  const re =
    /[[<](\d{4})-(\d{2})-(\d{2})(?:( *)([^\]+0-9>\r\n -]+))?(?:( )(\d{1,2}):(\d{2}))?[^\]>\n]{0,16}[\]>]/g;
  const out: TsMatch[] = [];
  for (const m of allMatches(re, text)) {
    const i = m.index ?? 0;
    const pos = (k: number): number => at(line, text, k);
    const ts: TsMatch = {
      start: pos(i),
      end: pos(i + m[0].length),
      text: m[0],
      year: [pos(i + 1), pos(i + 5)],
      month: [pos(i + 6), pos(i + 8)],
      day: [pos(i + 9), pos(i + 11)],
    };
    let k = i + 11;
    if (m[5] !== undefined) {
      k += m[4].length;
      ts.dayName = [pos(k), pos(k + m[5].length)];
      k += m[5].length;
    }
    if (m[7] !== undefined) {
      k += 1;
      ts.hour = [pos(k), pos(k + m[7].length)];
      k += m[7].length + 1;
      ts.minute = [pos(k), pos(k + 2)];
    }
    out.push(ts);
  }
  return out;
}

/**
 * What S-<up> changes, by where point is in a timestamp, as
 * org-at-timestamp-p says: a part of the date or time, the brackets, or an
 * offset into what follows the time, such as a repeater.
 */
function timestampCategory(ts: TsMatch, p: number): string | number {
  const inRange = (r?: [number, number]): boolean => r !== undefined && r[0] <= p && p <= r[1];
  if (p === ts.start || p === ts.end - 1) return "bracket";
  if (p === ts.end) return "after";
  if (inRange(ts.year)) return "year";
  if (inRange(ts.month)) return "month";
  if (inRange(ts.hour)) return "hour";
  if (inRange(ts.minute)) return "minute";
  if (inRange(ts.day) || inRange(ts.dayName)) return "day";
  const last = ts.minute?.[1] ?? ts.dayName?.[1];
  if (last !== undefined && p > last && p < ts.end) return p - last;
  return "day";
}

/** Changes an end time or repeater in what follows a timestamp's date, at offset pos, as org-modify-ts-extra does. */
function modifyTsExtra(extra: string, pos: number, n: number, step: number): string {
  const m = /^(?:(-([012][0-9]):([0-5][0-9])))?(?:( +\+)([0-9]+)([dmwy]))?(?:( +-)([0-9]+)([dmwy]))?/.exec(extra);
  if (!m) return extra;
  // Where each group starts and ends in extra.
  const ranges: { [group: number]: [number, number] } = {};
  let k = 0;
  if (m[1] !== undefined) {
    ranges[1] = [0, 6];
    ranges[2] = [1, 3];
    ranges[3] = [4, 6];
    k = 6;
  }
  if (m[5] !== undefined) {
    k += m[4].length;
    ranges[5] = [k, k + m[5].length];
    k += m[5].length;
    ranges[6] = [k, k + 1];
    k += 1;
  }
  if (m[8] !== undefined) {
    k += m[7].length;
    ranges[8] = [k, k + m[8].length];
    k += m[8].length;
    ranges[9] = [k, k + 1];
  }
  const inRange = (g: number): boolean => ranges[g] !== undefined && ranges[g][0] <= pos && pos <= ranges[g][1];
  const units: [string, number][] = [["d", 0], ["w", 1], ["m", 2], ["y", 3], ["d", -1], ["y", 4]];
  const unitAfter = (u: string): string | undefined => {
    const index = (units.find(([name]) => name === u)?.[1] ?? 0) + n;
    return units.find(([, i]) => i === index)?.[0];
  };
  let group: number | undefined;
  let fresh: string | undefined;
  if (inRange(2) || inRange(3)) {
    let hour = Number(m[2]);
    let minute = Number(m[3]);
    if (inRange(2)) hour += n;
    else {
      const rem = minute % step;
      if (rem !== 0) minute += n * step > 0 ? -rem : step - rem;
      minute += n * step;
    }
    if (minute < 0) [minute, hour] = [minute + 60, hour - 1];
    if (minute > 59) [minute, hour] = [minute - 60, hour + 1];
    hour = ((hour % 24) + 24) % 24;
    group = 1;
    fresh = `-${two(hour)}:${two(minute)}`;
  } else if (inRange(6)) {
    group = 6;
    fresh = unitAfter(m[6]);
  } else if (inRange(5)) {
    group = 5;
    fresh = String(Math.max(1, n + Number(m[5])));
  } else if (inRange(9)) {
    group = 9;
    fresh = unitAfter(m[9]);
  } else if (inRange(8)) {
    group = 8;
    fresh = String(Math.max(0, n + Number(m[8])));
  }
  if (group === undefined || fresh === undefined) return extra;
  return extra.slice(0, ranges[group][0]) + fresh + extra.slice(ranges[group][1]);
}

/**
 * Changes the timestamp at point by n of what point is on, or of `what`,
 * as org-timestamp-change does: the date and time are written again with
 * the right day name, keeping only an end time, repeaters and warning
 * periods from what followed them. On a bracket, the timestamp turns
 * between active and inactive.
 */
function changeTimestamp(n: number, what?: string, updown = true): void {
  const origin = ember.point();
  const ts = tsMatches(lineAt()).find((t) => t.start <= origin && origin <= t.end);
  if (!ts) throw new Error("Not at a timestamp");
  const category = timestampCategory(ts, origin);
  if (what === undefined && category === "bracket") {
    const swap: { [c: string]: string } = { "[": "<", "]": ">", "<": "[", ">": "]" };
    replaceText(ts.start, ts.start + 1, swap[ts.text[0]]);
    replaceText(ts.end - 1, ts.end, swap[ts.text[ts.text.length - 1]]);
    ember.message(`Timestamp is now ${ts.text[0] === "[" ? "" : "in"}active`);
    return;
  }
  const field = what ?? category;
  const inactive = ts.text[0] === "[";
  ember.deleteRegion(ts.start, ts.end);
  ember.gotoChar(ts.start);
  const extra = /((?:-[012][0-9]:[0-5][0-9])?(?: +[.+]?-?[-+][0-9]+[hdwmy](?:\/[0-9]+[hdwmy])?)*)[\]>]/.exec(ts.text)?.[1] ?? "";
  const withTime = /^.{10}.*?[0-9]+:[0-9][0-9]/.test(ts.text);
  const parsed = /(\d{4})-(\d{2})-(\d{2})(?: +[^\]+0-9>\r\n -]+)?(?: +(\d{1,2}):(\d{2}))?/.exec(ts.text);
  const d: DateTime = {
    year: Number(parsed?.[1]),
    month: Number(parsed?.[2]),
    day: Number(parsed?.[3]),
    hour: Number(parsed?.[4] ?? 0),
    minute: Number(parsed?.[5] ?? 0),
  };
  let step = Math.max(Number((ember.variable("org-time-stamp-rounding-minutes") as number[] | null)?.[1] ?? 5), 1);
  let increment = n;
  if (updown && field === "minute" && ember.prefixArg() === null) {
    increment = step * Math.sign(n);
    const rem = (d.minute ?? 0) % step;
    if (rem !== 0) d.minute = (d.minute ?? 0) + (n > 0 ? -rem : step - rem);
  } else step = 1;
  if (field === "minute") d.minute = (d.minute ?? 0) + increment;
  if (field === "hour") d.hour = (d.hour ?? 0) + increment;
  if (field === "day") d.day += increment;
  if (field === "month") d.month += increment;
  if (field === "year") d.year += increment;
  let tail = extra;
  if ((field === "hour" || field === "minute") && /-([012][0-9]):([0-5][0-9])/.test(tail)) {
    tail = modifyTsExtra(tail, field === "hour" ? 2 : 5, n, step);
  }
  if (typeof category === "number" && what === undefined) tail = modifyTsExtra(tail, category, n, step);
  const date = normalize(d);
  const [open, close] = inactive ? ["[", "]"] : ["<", ">"];
  // As org-insert-timestamp does, before markers: a mark that was in the
  // old timestamp ends up after the new one.
  ember.insertBeforeMarkers(`${open}${formatTimestamp(date, withTime)}${tail}${close}`);
  const fresh = tsMatches(lineAt(ts.start)).find((t) => t.start === ts.start);
  let target = origin;
  if (fresh) {
    if (category === "day") target = Math.min(fresh.hour ? fresh.hour[0] - 1 + 1 : (fresh.dayName?.[1] ?? fresh.day[1]) - 1, origin);
    else if (category === "hour") target = Math.min(fresh.hour?.[1] ?? origin, origin);
    else if (category === "minute") target = Math.min((fresh.minute?.[1] ?? origin + 1) - 1, origin);
    else if (typeof category === "number") target = Math.min(fresh.end - 1, origin);
    else if (category === "after") target = fresh.end;
  }
  ember.gotoChar(target);
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
  const p = ember.point();
  const ts = tsMatches(lineAt()).find((t) => t.start <= p && p <= t.end);
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
  if (updated === text) return;
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
  const all = headings();
  const end = entryEnd(all, headingIndex(all, h.line) as number);
  let repeated = false;
  for (let line = h.line + 1; line < ember.lineCount() && ember.lineStart(line) < end; line++) {
    if (repeatTimestampsOn(line)) repeated = true;
  }
  if (repeated) ember.message(`Entry repeats: ${ember.lineText(h.line + 1).trim()}`);
  return repeated;
}

/** Moves the repeating active timestamps on a line on by their repeaters. Returns whether there were any. */
function repeatTimestampsOn(line: number): boolean {
  let repeated = false;
  for (const ts of timestampsOn(line).reverse()) {
    if (!ts.active) continue;
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
    edDelete(ts.start, ts.end);
    edInsert(ts.start, timestampText(ts), true);
  }
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
  for (const m of allMatches(LINK, text)) {
    const start = at(line, text, m.index ?? 0);
    const end = at(line, text, (m.index ?? 0) + m[0].length);
    if (start <= p && p < end) return { start, end, path: m[1].replace(/\\([[\]\\])/g, "$1"), description: m[2] };
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of allMatches(re, text)) {
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
  showContext(pos);
}

/** Shows the headings above a position if it is folded away, as org-fold-show-context does. */
function showContext(pos: number): void {
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i !== undefined && folded(Math.max(0, all[i].start - 1), "outline")) {
    for (const h of all.slice(0, i + 1)) {
      if (h.start <= pos) flag(h.end, entryEnd(all, all.indexOf(h)), false);
    }
  }
}

// Imenu, as org.el's org-imenu-get-tree: headings to org-imenu-depth, a
// heading with headings under it a submenu of them.

ember.defineVariable({ name: "org-imenu-depth", doc: "How deep in the outline M-x imenu lists headings.", value: 2 });

/** A heading's text as Imenu lists it: no TODO, priority or tags, links as they read. */
const imenuTitle = (h: Heading): string => h.title.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_m, link: string, desc?: string) => desc ?? link);

type ImenuItem = [string, number | ImenuItem[]];

const orgImenuGetTree = ember.defun("org-imenu-get-tree", () => {
  const depth = Number(ember.variable("org-imenu-depth") ?? 2);
  const subs: ImenuItem[][] = Array.from({ length: depth + 1 }, () => []);
  let lastLevel = 0;
  for (const h of [...headings()].reverse()) {
    const headline = imenuTitle(h);
    if (h.level > depth || !/\S/.test(headline)) continue;
    if (h.level >= lastLevel) {
      subs[h.level]!.unshift([headline, h.start]);
    } else {
      subs[h.level]!.unshift([headline, subs.slice(h.level + 1).flat()]);
      for (let i = h.level + 1; i <= depth; i++) subs[i] = [];
    }
    lastLevel = h.level;
  }
  return (subs[1] ?? []) as unknown as ember.Value;
});

/**
 * Shows the heading at a position and its ancestors' heading lines, their
 * entries left folded, as org-fold-show-set-visibility's ancestors does:
 * org-fold-heading unfolds from the end of the line before a heading to its end.
 */
function showAncestors(pos: number): void {
  const all = headings();
  let i = headingIndex(all, lineAt(pos));
  if (i === undefined) return;
  // Not at a heading, its entry shows, as org-fold-show-entry.
  if (all[i]!.start !== ember.lineBeginningPosition(pos)) flag(all[i]!.end, entryEnd(all, i), false);
  while (i !== undefined) {
    const h = all[i]!;
    flag(Math.max(0, h.start - 1), h.end, false);
    let parent: number = i - 1;
    while (parent >= 0 && all[parent]!.level >= h.level) parent--;
    i = parent >= 0 ? parent : undefined;
  }
}

ember.addHook("imenu-after-jump-hook", () => {
  if (ember.derivedModeP("org-mode")) showAncestors(ember.point());
});

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
  run: () => openAtPoint_(),
});

/**
 * Follows the link at point, as org-open-at-point does. Elsewhere in an
 * entry Org's context is the heading: it follows the entry's only link,
 * found searching on from point, or says there are none.
 */
function openAtPoint_(): void {
  const link = linkHere();
  if (link) {
    openLink(link);
    return;
  }
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) throw new Error("No link found");
  const h = all[i];
  const p = ember.point();
  if (lineAt() === h.line && h.tagsAt !== undefined && p >= h.tagsAt && p < h.end) {
    throw new Error("Ember cannot show the agenda for a tag yet");
  }
  const end = all[i + 1]?.start ?? ember.bufferSize();
  const { links, last } = linksIn(h.start, end);
  if (links.length === 0) {
    ember.message("No links");
    return;
  }
  if (links.length > 1) throw new Error("Ember cannot choose between an entry's links yet");
  // Org searches on from point to the end of the buffer, and when the link
  // is not there, goes where the last link it found in the entry starts.
  const rest = ember.bufferText(p, ember.bufferSize());
  const at = rest.indexOf(links[0]);
  ember.gotoChar(at < 0 ? last : p + charCount(rest.slice(0, at)));
  openAtPoint_();
}

/**
 * The different links between two positions, in order, as
 * org-offer-links-in-entry finds them, and where the last one found starts.
 */
function linksIn(from: number, to: number): { links: string[]; last: number } {
  const out: string[] = [];
  let last = from;
  for (let l = lineAt(from); l < ember.lineCount() && ember.lineStart(l) < to; l++) {
    const text = ember.lineText(l);
    const found = [LINK, ANGLE_LINK, PLAIN_LINK]
      .flatMap((re) => allMatches(re, text).map((m) => ({ index: m.index ?? 0, text: m[0] })))
      .sort((a, b) => a.index - b.index);
    let after = 0;
    for (const m of found) {
      if (m.index < after) continue;
      after = m.index + m.text.length;
      last = at(l, text, m.index);
      if (!out.includes(m.text)) out.push(m.text);
    }
  }
  return { links: out, last };
}

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
    if (!ember.derivedModeP("org-mode")) return;
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
    else if (regionStartsAtHeading() || headingHere()) {
      if (hiddenBelow("headlines")) hiddenTreeError();
      ember.call("org-do-promote");
    } else if (itemHere()) {
      if (hiddenBelow("items")) hiddenTreeError();
      ember.call("org-outdent-item");
    }
    else ember.callWithPrefix(ember.prefixArg(), "backward-word");
  },
});

const metaRight = ember.defineCommand({
  name: "org-metaright",
  doc: "M-<right> in Org: demote a heading, indent an item, move a table column right, or move forward a word.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-column-right");
    else if (DRAWER_RE.test(ember.lineText(lineAt()))) ember.call("org-indent-drawer");
    else if (atBlock()) ember.call("org-indent-block");
    else if (regionStartsAtHeading() || headingHere()) {
      if (hiddenBelow("headlines")) hiddenTreeError();
      ember.call("org-do-demote");
    } else if (itemHere()) {
      if (hiddenBelow("items")) hiddenTreeError();
      ember.call("org-indent-item");
    }
    else ember.callWithPrefix(ember.prefixArg(), "forward-word");
  },
});

/** Swaps two stretches of text, as transpose-regions does. */
function transposeRegions(a: number, b: number, c: number, d: number): void {
  let [r1, r2] = [[Math.min(a, b), Math.max(a, b)], [Math.min(c, d), Math.max(c, d)]];
  if (r1[0] > r2[0] || (r1[0] === r2[0] && r1[1] > r2[1])) [r1, r2] = [r2, r1];
  // As transpose-regions does, an empty region next to the other changes nothing.
  if ((r1[0] === r1[1] || r2[0] === r2[1]) && r1[1] === r2[0]) return;
  if (r1[1] > r2[0]) throw new Error("Transposed regions overlap");
  const t1 = ember.bufferText(r1[0], r1[1]);
  const t2 = ember.bufferText(r2[0], r2[1]);
  edDelete(r2[0], r2[1]);
  edInsert(r2[0], t1);
  edDelete(r1[0], r1[1]);
  edInsert(r1[0], t2);
}

/**
 * M-<up> or M-<down> with an active region, as org-metaup and
 * org-metadown do: subtrees in the region move together past the one
 * next to them, and other lines swap with the line next to them.
 * Returns whether it applied.
 */
function metaRegion(up: boolean): boolean {
  const mark = ember.mark();
  if (!orgRegionActive() || mark === undefined) return false;
  const pt = ember.point();
  const [rb, re] = [Math.min(mark, pt), Math.max(mark, pt)];
  if (parseHeading(lineAt(rb))) {
    const origin = marker(pt);
    try {
      const all = headings();
      const level = all[headingIndex(all, lineAt(rb)) as number].level;
      const higher = (from: number, to: number): boolean =>
        all.some((h) => h.level < level && h.start >= from && h.start + h.level + 1 <= to);
      if (up) {
        const end = marker(Math.max(rb, re - 1));
        const before = all.filter((h) => h.level === level && h.start < ember.lineStart(lineAt(rb))).at(-1);
        if ((level > 1 && higher(rb === ember.lineStart(lineAt(rb)) ? rb : lineStartOrEnd(lineAt(rb) + 1), end.pos)) || !before) {
          dropMarker(end);
          throw new Error("Cannot move past superior level or buffer limit");
        }
        ember.gotoChar(before.start);
        while (ember.point() < end.pos) ember.keepMarkActive(() => moveSubtree(1));
        dropMarker(end);
      } else {
        const beg = marker(rb);
        const after = all.find((h) => h.level === level && h.start >= re && h.start + h.level + 1 > re);
        if ((level > 1 && higher(rb === ember.lineStart(lineAt(rb)) ? rb : lineStartOrEnd(lineAt(rb) + 1), re)) || !after) {
          dropMarker(beg);
          throw new Error("Cannot move past superior level or buffer limit");
        }
        ember.gotoChar(after.start);
        while (ember.point() > beg.pos) ember.keepMarkActive(() => moveSubtree(-1));
        dropMarker(beg);
      }
    } finally {
      ember.gotoChar(origin.pos);
      dropMarker(origin);
    }
    return true;
  }
  const a = ember.lineStart(lineAt(rb));
  const atBol = (x: number): boolean => x === ember.lineStart(lineAt(x));
  const b = atBol(re) && re > 0 ? re - 1 : ember.lineEnd(lineAt(re));
  const swap = pt < mark;
  ember.keepMarkActive(() => transposeRegionLines(up, a, b));
  if (swap) ember.call("exchange-point-and-mark");
  return true;
}

/** The region case of org-metaup and org-metadown: the region's lines and the line before or after swap places. */
function transposeRegionLines(up: boolean, a: number, b: number): void {
  const atBol = (x: number): boolean => x === ember.lineStart(lineAt(x));
  if (up) {
    const prev = Math.max(0, lineAt(a) - 1);
    // On the first line, move-beginning-of-line and move-end-of-line with 0 both stay at its start.
    const [c, d] = lineAt(a) === 0 ? [0, 0] : [ember.lineStart(prev), ember.lineEnd(prev)];
    transposeRegions(a, b, c, d);
    ember.setMark(c);
    ember.gotoChar(c + (b - a));
  } else {
    const next = atBol(b) ? lineAt(b) : lineAt(b) + 1;
    const [c, d] = next < ember.lineCount() ? [ember.lineStart(next), ember.lineEnd(next)] : [ember.bufferSize(), ember.bufferSize()];
    transposeRegions(a, b, c, d);
    ember.setMark(1 + a + (d - c));
    ember.gotoChar(1 + a + (d - c) + (b - a));
  }
}

/**
 * In a source block, M-<up> and M-<down> are Babel's first, from
 * org-metaup-hook and org-metadown-hook: they load the block into a session
 * or go to its session. Ember has no Babel sessions, so this fails as Org
 * does for a language without them.
 */
function babelSessionHook(action: "load" | "pop"): void {
  const el = elementAt(ember.point());
  if (el?.type !== "src-block") return;
  const header = ember.lineText(lineAt(el.begin));
  const lang = /^[ \t]*#\+begin_src[ \t]+([^ \t:]\S*)/i.exec(header)?.[1] ?? "nil";
  if (action === "load") throw new Error(`No org-babel-load-session function for ${lang}!`);
  if (!/:session/.test(header)) throw new Error("This block is not using a session!");
  throw new Error(`No org-babel-initiate-session function for ${lang}!`);
}

const metaUp = ember.defineCommand({
  name: "org-metaup",
  doc: "M-<up> in Org: move a subtree, an item or a table row up past the one before it.",
  run: () => {
    babelSessionHook("load");
    if (metaRegion(true)) return;
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-row-up");
    else if (headingHere()) ember.call("org-move-subtree-up");
    else if (itemHere()) ember.call("org-move-item-up");
    else ember.call("org-drag-element-backward");
  },
});

const metaDown = ember.defineCommand({
  name: "org-metadown",
  doc: "M-<down> in Org: move a subtree, an item or a table row down past the one after it.",
  run: () => {
    babelSessionHook("pop");
    if (metaRegion(false)) return;
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-row-down");
    else if (headingHere()) ember.call("org-move-subtree-down");
    else if (itemHere()) ember.call("org-move-item-down");
    else ember.call("org-drag-element-forward");
  },
});

const shiftMetaLeft = ember.defineCommand({
  name: "org-shiftmetaleft",
  doc: "M-S-<left> in Org: promote a subtree, outdent an item with its children, or delete a table column.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-delete-column");
    else if (headingHere()) ember.call("org-promote-subtree");
    else if (itemHere()) ember.call("org-outdent-item-tree");
    else throw new Error("This command is active in special context like tables, headlines or items");
  },
});

const shiftMetaRight = ember.defineCommand({
  name: "org-shiftmetaright",
  doc: "M-S-<right> in Org: demote a subtree, indent an item with its children, or insert a table column.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-insert-column");
    else if (headingHere()) ember.call("org-demote-subtree");
    else if (itemHere()) ember.call("org-indent-item-tree");
    else throw new Error("This command is active in special context like tables, headlines or items");
  },
});

const shiftMetaUp = ember.defineCommand({
  name: "org-shiftmetaup",
  doc: "M-S-<up> in Org: delete the table row point is on, or drag the line up.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-kill-row");
    else ember.callWithPrefix(ember.prefixArg(), "org-drag-line-backward");
  },
});

const shiftMetaDown = ember.defineCommand({
  name: "org-shiftmetadown",
  doc: "M-S-<down> in Org: insert a table row above the one point is on, or drag the line down.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-insert-row");
    else ember.callWithPrefix(ember.prefixArg(), "org-drag-line-forward");
  },
});

/** Drags the line at point `n` lines down, or up if `n` is negative, as org-drag-line-forward does. */
/**
 * Swaps the line before point's with point's, as transpose-lines does,
 * with the insertions and deletions of transpose-subr-1, so folds move as
 * Emacs's overlays do. On an error, the changes are undone, as
 * atomic-change-group does. Leaves point after both lines.
 */
function transposeLinesWithFolds(): void {
  // As transpose-lines' mover: forward a line, adding a newline at the end.
  const mover = (n: number): void => {
    if (n > 0) {
      let short = forwardLine(n);
      if (ember.point() === 0 || ember.bufferText(ember.point() - 1, ember.point()) !== "\n") short++;
      // Through newline, which amalgamates undo as self-insert-command does.
      if (short > 0) {
        ember.undoAutoAmalgamate();
        ember.insert("\n".repeat(short));
      }
    } else forwardLine(n);
  };
  const aux = (x: number): [number, number] => {
    mover(x);
    const a = ember.point();
    mover(-x);
    return [a, ember.point()];
  };
  const pos1 = aux(-1);
  const pos2 = aux(1);
  const sorted = (p: [number, number]): [number, number] => (p[0] > p[1] ? [p[1], p[0]] : p);
  let [a, b] = [sorted(pos1), sorted(pos2)];
  if (a[0] > b[0]) [a, b] = [b, a];
  if (a[1] > b[0]) throw new Error("Don’t have two things to transpose");
  const lenA = a[1] - a[0];
  const textB = ember.bufferText(b[0], b[1]);
  const end = marker(pos2[0]);
  const boundary = marker(b[0]);
  const wasModified = ember.bufferModified();
  const mark = ember.mark();
  // What to undo: insertions as [start, end], deletions as [position, text].
  const undo: ([number, number] | [number, string])[] = [];
  // Each step is recorded before it is made, so one whose fold check fails is undone too.
  try {
    undo.push([a[1], a[1] + charCount(textB)]);
    edInsert(a[1], textB, true);
    const textA = ember.bufferText(a[0], a[0] + lenA);
    undo.push([a[0], textA]);
    edDelete(a[0], a[0] + lenA);
    const at = boundary.pos;
    undo.push([at, at + lenA]);
    edInsert(at, textA);
    undo.push([at + lenA, textB]);
    edDelete(at + lenA, at + lenA + charCount(textB));
    ember.gotoChar(end.pos);
  } catch (e) {
    for (const step of undo.reverse()) {
      if (typeof step[1] === "number") {
        ember.gotoChar(step[0]);
        edDelete(step[0], step[1]);
      } else {
        edInsert(step[0], step[1]);
        ember.gotoChar(step[0]);
      }
    }
    if (!wasModified) ember.setBufferModified(false);
    // Undoing puts the mark back too, as Emacs's undo restores markers.
    if (mark !== undefined) ember.setMark(mark);
    throw e;
  } finally {
    dropMarker(end);
    dropMarker(boundary);
  }
}

function dragLine(n: number): void {
  for (let i = 0; i < Math.abs(n); i++) {
    // As Org does with current-column and org-move-to-column: hidden link text takes no columns.
    const column = ember.currentColumn();
    if (n > 0) {
      forwardLine(1);
      transposeLinesWithFolds();
      forwardLine(-1);
    } else {
      transposeLinesWithFolds();
      forwardLine(-2);
    }
    ember.moveToColumn(column);
  }
}

ember.defineCommand({
  name: "org-drag-line-forward",
  doc: "Drag the line at point down past the next line, or as many lines as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => dragLine(arg),
});

ember.defineCommand({
  name: "org-drag-line-backward",
  doc: "Drag the line at point up past the line before it, or as many lines as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => dragLine(-arg),
});

/**
 * What S-<left> and S-<right> do on a property, as
 * org-property-next-allowed-value does. Ember has no allowed values for
 * properties yet, so this is Org's error when none are defined.
 */
function nextAllowedValue(): never {
  if (headingIndex(headings(), lineAt()) === undefined) backToHeading();
  throw new Error("Allowed values for this property have not been defined");
}

/**
 * Whether a heading or item on point's line has folded headings or items
 * under it, as org-check-for-hidden says, so M-<left> and M-<right> would
 * change what cannot be seen.
 */
function hiddenBelow(what: "headlines" | "items"): boolean {
  if (orgRegionActive()) return false;
  let l = lineAt() + 1;
  while (l < ember.lineCount() && ember.invisibleAt(ember.lineStart(l) - 1)) l++;
  const end = lineStartOrEnd(l);
  for (let k = lineAt() + 1; k < ember.lineCount() && ember.lineStart(k) < end; k++) {
    const text = ember.lineText(k);
    if ((what === "headlines" ? /^\*+ /.test(text) : ITEM_RE.test(text)) && ember.invisibleAt(ember.lineStart(k))) return true;
  }
  return false;
}

function hiddenTreeError(): never {
  throw new Error("Hidden subtree, open with TAB or use subtree command M-S-<left>/<right>");
}

/**
 * Whether point is in an Org table, as org-at-table-p: its line starts as a
 * table row does, and the parser, which sees the whole buffer, puts point in a table.
 */
function atTableP(): boolean {
  if (!/^[ \t]*\|/.test(ember.lineText(lineAt()))) return false;
  const p = ember.point();
  return ember.saveRestriction(() => {
    ember.widen();
    for (let e = elementAt(p); e; e = e.parent) if (e.type === "table") return true;
    return false;
  });
}

const shiftUp = ember.defineCommand({
  name: "org-shiftup",
  doc: "S-<up> in Org: make a timestamp later, raise a heading's priority, or move to the previous item.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-up");
    else if (headingHere()) ember.call("org-priority-up");
    else if (itemHere()) ember.call("org-previous-item");
    else if (atTableP()) ember.call("org-table-move-cell-up");
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
    else if (atTableP()) ember.call("org-table-move-cell-down");
    else shiftSelectError();
  },
});

const shiftRight = ember.defineCommand({
  name: "org-shiftright",
  doc: "S-<right> in Org: move a timestamp a day on, change a heading to its next TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-up-day");
    // org-todo, which loops over the headings in an active region.
    else if (headingHere()) {
      if (!forEachHeadingInRegion(() => todo(1), true)) todo(1);
    }
    else if (itemLine(lineAt())) cycleListBullet();
    else if (elementAt(ember.point())?.type === "node-property") nextAllowedValue();
    else if (atTableP()) ember.call("org-table-move-cell-right");
    else shiftSelectError();
  },
});

const shiftLeft = ember.defineCommand({
  name: "org-shiftleft",
  doc: "S-<left> in Org: move a timestamp a day back, change a heading to its previous TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-down-day");
    // org-todo, which loops over the headings in an active region.
    else if (headingHere()) {
      if (!forEachHeadingInRegion(() => todo(-1), true)) todo(-1);
    }
    else if (itemLine(lineAt())) cycleListBullet("previous");
    else if (elementAt(ember.point())?.type === "node-property") nextAllowedValue();
    else if (atTableP()) ember.call("org-table-move-cell-left");
    else shiftSelectError();
  },
});

function nothingUseful(): never {
  throw new Error("‘C-c C-c’ can do nothing useful here");
}

/** The statistics cookie point is in on its line, if any. */
function cookieHere(): boolean {
  const line = lineAt();
  const text = ember.lineText(line);
  const p = ember.point();
  return allMatches(COOKIE, text).some((m) => {
    const start = at(line, text, m.index ?? 0);
    return start <= p && p <= start + charCount(m[0]);
  });
}

/** C-c C-c on an item's first line, as org-ctrl-c-ctrl-c does: toggles its checkbox, or repairs the list. */
function ctrlCCtrlCItem(line: number, arg: ember.PrefixArg): void {
  const struct = listStruct(line);
  const old = copyStruct(struct);
  const parents = parentsAlist(struct);
  const prevs = prevsAlist(struct);
  const item = getItem(struct, ember.lineStart(line));
  const box = item.checkbox;
  const c4 = Array.isArray(arg) && arg[0] === 4;
  const c16 = Array.isArray(arg) && arg[0] === 16;
  item.checkbox = c16 ? "[-]" : !box && c4 ? "[ ]" : !box || c4 ? undefined : box === "[X]" ? "[ ]" : "[X]";
  fixInd(struct, parents, 2);
  fixItemEnd(struct);
  fixBul(struct, prevs);
  fixInd(struct, parents);
  fixBox(struct, parents);
  if (box && sameStruct(struct, old)) {
    if (c16) ember.message("Checkboxes already reset");
    else throw new Error(`Cannot toggle this checkbox: ${box === "[X]" ? "all subitems checked" : "unchecked subitems"}`);
    return;
  }
  applyStruct(struct, old);
  updateCheckboxCount();
}

/**
 * Whether point is past a heading's title, which ends with a statistics
 * cookie. Org's org-element-context narrows to the title there, so it finds
 * the title's last object, and C-c C-c updates that cookie.
 */
function cookieEndsTitleBeforePoint(): boolean {
  const h = parseHeading(lineAt());
  if (!h || h.title === "") return false;
  const titleEnd = h.titleAt + charCount(h.title);
  if (ember.point() <= titleEnd) return false;
  return new RegExp(`(?:${COOKIE.source})$`).test(h.title);
}

const ctrlCCtrlC = ember.defineCommand({
  name: "org-ctrl-c-ctrl-c",
  doc:
    "C-c C-c in Org: tick or untick a checkbox, align a table, update a statistics cookie, set a heading's tags, " +
    "fix a timestamp, or re-read the buffer's #+ settings on a #+ line.",
  run: () => {
    const line = lineAt();
    const text = ember.lineText(line);
    if (/^[ \t]*$/.test(text)) nothingUseful();
    if (elementAt(ember.point())?.type === "table") {
      // At the table's start, Org recalculates every row and does not align.
      ember.call("org-table-recalculate");
      return;
    }
    if (/^[ \t]*\|/.test(text)) {
      ember.call("org-table-maybe-eval-formula");
      ember.call("org-table-align");
      return;
    }
    if (/^#\+\S*:/.test(text)) {
      storeTodoSets();
      ember.call("font-lock-flush");
      ember.message("Local setup has been refreshed");
      return;
    }
    if (cookieHere() || cookieEndsTitleBeforePoint()) {
      ember.call("org-update-statistics-cookies");
      return;
    }
    if (timestampHere()) {
      changeTimestamp(0, "day");
      return;
    }
    if (headingHere()) {
      // With the region active, Org sets the tags of each heading that starts
      // in it, which may be none.
      const region = ember.variable("org-loop-over-headlines-in-active-region") === true ? headingsInRegion() : undefined;
      if (region && region.length === 0) return;
      if (region) ember.gotoChar(region[0].start);
      ember.callInteractively("org-set-tags-command");
      return;
    }
    if (itemLine(line)) {
      ctrlCCtrlCItem(line, ember.prefixArg());
      return;
    }
    nothingUseful();
  },
});

ember.defineCommand({
  name: "org-toggle-checkbox",
  doc:
    "Tick or untick the checkbox of the item point is on, or of the items in the region or under the heading. " +
    "With C-u, add a checkbox to the item, or remove its checkbox.",
  run: () => toggleCheckbox(ember.prefixArg()),
});

ember.defineCommand({
  name: "org-update-statistics-cookies",
  doc: "Bring the statistics cookies, such as [1/3], of the heading or item point is in up to date.",
  run: () => {
    if (!headingHere()) {
      updateCheckboxCount();
      return;
    }
    // Point goes back where it was, kept by a marker, as in Org: inside a
    // cookie that changed, that is the cookie's start.
    const pos = marker(ember.point());
    const all = headings();
    updateHeadingCookies(all, headingIndex(all, lineAt()) as number);
    ember.gotoChar(pos.pos);
    dropMarker(pos);
  },
});

const ctrlCMinus = ember.defineCommand({
  name: "org-ctrl-c-minus",
  doc: "C-c - in Org: insert a table rule, change a list's bullets, or turn the line into an item.",
  run: () => {
    const line = lineAt();
    if (/^[ \t]*\|/.test(ember.lineText(line))) ember.callWithPrefix(ember.prefixArg(), "org-table-insert-hline");
    else if (orgRegionActive()) ember.call("org-toggle-item");
    else if (inItem(line) !== undefined) cycleListBullet();
    else ember.call("org-toggle-item");
  },
});

/** Replaces text as replace-match does under save-excursion: point inside it goes to its start. */
function replaceKeepingPoint(start: number, end: number, text: string): void {
  const p = marker(ember.point());
  edReplace(start, end, text);
  ember.gotoChar(p.pos);
  dropMarker(p);
}

/** Removes a heading's tags, planning line and property drawer, as org-list--delete-metadata does. */
function deleteMetadata(line: number): void {
  const h = parseHeading(line);
  if (!h) return;
  const text = ember.lineText(line);
  if (h.tagsAt !== undefined) {
    const before = text.slice(0, indexOf(line, text, h.tagsAt)).trimEnd();
    edDelete(ember.lineStart(line) + charCount(before), h.end);
    // As org-set-tags does, a heading that was only tags keeps its space.
    if (!parseHeading(line)) replaceText(ember.lineEnd(line), ember.lineEnd(line), " ");
  }
  const all = headings();
  const i = headingIndex(all, line) as number;
  let meta = endOfMetaData(all[i]);
  while (meta < ember.bufferSize() && /[ \t\n\r]/.test(ember.bufferText(meta, meta + 1))) meta++;
  if (meta < ember.bufferSize()) meta = ember.lineStart(lineAt(meta));
  const next = lineStartOrEnd(line + 1);
  if (meta > next) edDelete(next, meta);
}

/**
 * Indents the lines from point up to end, but not headings or blank ones,
 * so the least indented goes to `ind`, as org-toggle-item's shift-text
 * does. Leaves point at end.
 */
function shiftText(ind: number, end: Marker): void {
  let min = 1000;
  for (let l = lineAt(); l < ember.lineCount() && ember.lineStart(l) < end.pos; l++) {
    const text = ember.lineText(l);
    if (/^[ \t]*$/.test(text) || /^\*+ /.test(text)) continue;
    const i = textIndentation(text);
    if (i === 0) {
      min = 0;
      break;
    }
    min = Math.min(min, i);
  }
  const delta = ind - min;
  while (ember.point() < end.pos) {
    const line = lineAt();
    const text = ember.lineText(line);
    if (!/^[ \t]*$/.test(text) && !/^\*+ /.test(text)) indentLineTo(line, textIndentation(text) + delta);
    if (line + 1 >= ember.lineCount()) {
      ember.gotoChar(ember.bufferSize());
      break;
    }
    ember.gotoChar(ember.lineStart(line + 1));
  }
}

ember.defineCommand({
  name: "org-toggle-item",
  doc:
    "Turn the line, or the lines of the region, into list items; headings into items, their text into the " +
    "items' text; or items back into plain lines.",
  run: () => {
    const mark = ember.mark();
    const region = orgRegionActive() && mark !== undefined;
    let beg: number;
    let end: Marker;
    if (region) {
      const [rb, re] = [Math.min(mark as number, ember.point()), Math.max(mark as number, ember.point())];
      let q = rb;
      while (q < ember.bufferSize() && /[ \r\t\n]/.test(ember.bufferText(q, q + 1))) q++;
      beg = ember.lineStart(lineAt(q));
      end = marker(re);
    } else {
      beg = ember.lineStart(lineAt());
      end = marker(ember.lineEnd(lineAt()));
    }
    const origin = marker(ember.point());
    try {
      ember.gotoChar(beg);
      if (itemLine(lineAt())) {
        while (ember.point() < end.pos) {
          const line = lineAt();
          const parts = itemLine(line) ? itemParts(line) : undefined;
          if (parts) edDelete(parts.bulletAt, parts.bulletAt + charCount(/^\S+[ \t]*/.exec(parts.bullet)?.[0] ?? ""));
          if (line + 1 >= ember.lineCount()) break;
          ember.gotoChar(ember.lineStart(line + 1));
        }
      } else if (parseHeading(lineAt())) {
        deleteMetadata(lineAt());
        let refLevel = (parseHeading(lineAt()) as Heading).level;
        while (ember.point() < end.pos) {
          const line = lineAt();
          const h = parseHeading(line);
          if (!h) break;
          const delta = Math.max(0, h.level - refLevel);
          if (h.level < refLevel) refLevel = h.level;
          deleteMetadata(line);
          // The stars and TODO state go; the title stays.
          const fresh = parseHeading(line) as Heading;
          const titleAt = fresh.title === "" && fresh.priorityAt === undefined ? fresh.end : (fresh.priorityAt ?? fresh.titleAt);
          const ls = ember.lineStart(line);
          // Org checks folds after each change, and the line is neither a
          // heading nor an item between these two.
          edDelete(ls, titleAt);
          edInsert(ls, "- ");
          indentLineTo(line, 2 * delta);
          if (h.todo !== undefined) {
            const struct = listStruct(line);
            const old = copyStruct(struct);
            getItem(struct, ember.lineStart(line)).checkbox = isDone(h.todo) ? "[X]" : "[ ]";
            writeStruct(struct, parentsAlist(struct), old);
          }
          const sectionEnd = headings().find((x) => x.line > line)?.start ?? ember.bufferSize();
          if (line + 1 >= ember.lineCount()) {
            ember.gotoChar(ember.bufferSize());
            break;
          }
          ember.gotoChar(ember.lineStart(line + 1));
          const limit = marker(Math.min(end.pos, sectionEnd));
          shiftText(2 * (delta + 1), limit);
          dropMarker(limit);
        }
      } else {
        while (ember.point() < end.pos) {
          const line = lineAt();
          const text = ember.lineText(line);
          const m = /^([ \t]*)(\S)/.exec(text);
          if (m && !isHeadingLine(text) && !itemLine(line)) {
            const ls = ember.lineStart(line);
            replaceKeepingPoint(ls, ls + charCount(m[0]), `${m[1]}- ${m[2]}`);
          }
          if (line + 1 >= ember.lineCount()) break;
          ember.gotoChar(ember.lineStart(line + 1));
        }
      }
    } finally {
      ember.gotoChar(origin.pos);
      dropMarker(origin);
      dropMarker(end);
    }
  },
});

const ctrlCStar = ember.defineCommand({
  name: "org-ctrl-c-star",
  doc: "C-c * in Org: recalculate a table, or turn the line into a heading as org-toggle-heading does.",
  run: () => {
    if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-recalculate");
    else ember.callWithPrefix(ember.prefixArg(), "org-toggle-heading");
  },
});

const toggleHeading = ember.defineCommand({
  name: "org-toggle-heading",
  doc:
    "Turn lines into headings, or headings into plain text, as org-toggle-heading does.\n\n" +
    "Starting at a heading, take the stars off every heading in the region, or on the line. Starting at an item, " +
    "turn the lists in the region into headings, checkboxes into TODO states. Otherwise make every line of text a " +
    "heading, a level below the one it is under; with a number, at that level; with C-u, only the first line.",
  run: () => orgToggleHeading(ember.prefixArg()),
});

/** Whether a line is a comment, as org-at-comment-p says. */
function commentLine(line: number): boolean {
  return /^[ \t]*#(?: |$)/.test(ember.lineText(line));
}

function orgToggleHeading(nstars: ember.PrefixArg): void {
  // The start of the first line that is not blank or a comment, from pos's.
  const skipBlanks = (pos: number): number => {
    let line = lineAt(pos);
    while (line < ember.lineCount() - 1 && commentLine(line)) line++;
    let q = line === lineAt(pos) ? pos : ember.lineStart(line);
    while (q < ember.bufferSize() && /[ \r\t\n]/.test(ember.bufferText(q, q + 1))) q++;
    return ember.lineStart(lineAt(q));
  };
  if (nstars != null && itemLine(lineAt())) {
    // As org-mark-element does when called from code: the region is the item.
    const el = elementAt(ember.point());
    ember.gotoChar(ember.lineEnd(lineAt()));
    if (el) {
      ember.pushMark(Math.min(ember.bufferSize(), el.end), { activate: true });
      ember.gotoChar(el.begin);
    }
  }
  const mark = ember.mark();
  const region = orgRegionActive() && mark !== undefined;
  let beg: number;
  let end: Marker;
  if (region) {
    const [rb, re] = [Math.min(mark as number, ember.point()), Math.max(mark as number, ember.point())];
    beg = skipBlanks(rb);
    end = marker(re === ember.lineStart(lineAt(re)) ? re : ember.lineEnd(lineAt(re)));
  } else {
    beg = skipBlanks(ember.lineStart(lineAt()));
    end = marker(ember.lineEnd(lineAt()));
  }
  const origin = marker(ember.point());
  let toggled = false;
  let p = beg;
  const forwardLine = (): void => {
    const l = lineAt(p);
    p = l + 1 < ember.lineCount() ? ember.lineStart(l + 1) : ember.bufferSize();
  };
  try {
    if (parseHeading(lineAt(beg))) {
      while (p < end.pos) {
        const m = /^\*+ /.exec(ember.lineText(lineAt(p)));
        if (parseHeading(lineAt(p)) && m) {
          edReplace(p, p + m[0].length, "");
          toggled = true;
        }
        forwardLine();
      }
    } else if (itemLine(lineAt(beg))) {
      while (p < end.pos) {
        if (itemLine(lineAt(p))) {
          const struct = listStruct(lineAt(p));
          p = listToSubtree(p, Math.min(bottomPoint(struct), end.pos + 1));
          toggled = true;
        }
        forwardLine();
      }
    } else {
      const all = headings();
      const i = headingIndex(all, lineAt(beg));
      const count = typeof nstars === "number" ? nstars : i === undefined ? 0 : all[i].level;
      const stars = "*".repeat(count);
      const add = nstars != null ? "" : stars === "" ? "*" : ember.variable("org-odd-levels-only") === true ? "**" : "*";
      const rpl = `${stars}${add} `;
      const limit = Array.isArray(nstars) && nstars[0] === 4 ? marker(ember.lineEnd(lineAt(beg))) : end;
      while (p < limit.pos) {
        const line = lineAt(p);
        const m = /^([ \t]*)(\S)/.exec(ember.lineText(line));
        if (!parseHeading(line) && !itemLine(line) && !commentLine(line) && m) {
          edReplace(p, p + charCount(m[0]), rpl + m[2]);
          toggled = true;
        }
        forwardLine();
      }
      if (limit !== end) dropMarker(limit);
    }
  } finally {
    ember.gotoChar(origin.pos);
    dropMarker(origin);
    dropMarker(end);
  }
  if (!toggled) ember.message("Cannot toggle heading from here");
}

/**
 * Writes timestamps out again from their parts, as org-element-interpret-data
 * does: the day name worked out from the date, and anything else left out.
 */
function interpretTimestamps(text: string): string {
  return text.replace(/([<[])(\d{4})-(\d{2})-(\d{2})( .*?)?[\]>]/g, (_all, open: string, y: string, mo: string, d: string, rest = "") => {
    const time = /([012]?\d):([0-5]\d)/.exec(rest);
    const range = /[012]?\d:[0-5]\d-([012]?\d):([0-5]\d)/.exec(rest);
    const repeat = /[.+]?\+\d+[hdwmy]/.exec(rest);
    const warning = /-?-\d+[hdwmy]/.exec(rest);
    const date: DateTime = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(time?.[1] ?? 0), minute: Number(time?.[2] ?? 0) };
    let body = formatTimestamp(date, time !== null);
    if (range) body += `-${range[1].padStart(2, "0")}:${range[2]}`;
    if (repeat) body += ` ${repeat[0]}`;
    if (warning) body += ` ${warning[0]}`;
    return `${open}${body}${open === "<" ? ">" : "]"}`;
  });
}

/**
 * Turns the list items from pos up to limit into headings, as
 * org-list-to-subtree does with what org-list-to-lisp takes out: an item's
 * depth in the list adds levels, checkboxes become TODO states, and the
 * lines under an item lose their indentation. Returns where the headings end.
 */
function listToSubtree(pos: number, limit: number): number {
  const struct = listStruct(lineAt(pos));
  const parents = parentsAlist(struct);
  const items = struct.filter((e) => e.pos >= pos && e.pos < limit);
  const depth = (e: ListItem): number => {
    const parent = parents.get(e.pos);
    const up = parent === undefined ? undefined : items.find((x) => x.pos === parent);
    return up ? depth(up) + 1 : 1;
  };
  const bottom = Math.min(Math.max(...items.map((e) => e.end)), limit);
  const done = todoSets()[0]?.done[0] ?? "DONE";
  const todo = todoSets()[0]?.todo[0] ?? "TODO";
  // Each item's heading, without its stars, then the lines of text under it.
  const entries: { depth: number; title: string; body: string }[] = [];
  let blanks = 0;
  for (let l = lineAt(pos); l < ember.lineCount() && ember.lineStart(l) < bottom; l++) {
    const text = ember.lineText(l);
    const item = items.find((e) => e.pos === ember.lineStart(l));
    if (item) {
      // Org reads the list narrowed to the limit, so a line it cuts is read as far as it goes.
      const lineEnd = Math.min(ember.lineEnd(l), limit);
      const parts = itemParts(l) as ItemParts;
      const within = parts.matchEnd <= lineEnd;
      const box = parts.checkbox === undefined || !within ? "" : `${parts.checkbox === "[X]" ? done : todo} `;
      const tag = item.tag !== undefined && within ? ` ${item.tag} ` : "";
      const title = within ? ember.bufferText(parts.matchEnd, lineEnd) : "";
      entries.push({ depth: depth(item), title: box + tag + interpretTimestamps(title), body: "" });
      blanks = 0;
    } else if (/^[ \t]*$/.test(text)) blanks++;
    else if (entries.length > 0) {
      entries[entries.length - 1].body += "\n".repeat(blanks + 1) + interpretTimestamps(text.replace(/^[ \t]+/, ""));
      blanks = 0;
    }
  }
  edDelete(pos, bottom);
  const all = headings();
  const above = headingIndex(all, lineAt(pos));
  const level = above === undefined ? 1 : all[above].level + 1;
  // org-blank-before-new-entry's "auto": a blank line before the heading above means one between these.
  const previous = [...all].reverse().find((h) => h.start < pos);
  const blank = previous !== undefined && previous.start > 0 && /^[ \t]*$/.test(ember.lineText(previous.line - 1));
  const text = entries.map((e) => `${"*".repeat(level + e.depth - 1)} ${e.title}${e.body}`).join(blank ? "\n\n" : "\n");
  edInsert(pos, `${text}\n`);
  return pos + charCount(text) + 1;
}

// The mode

const keys: { [keys: string]: ember.CommandName | ember.DefinedCommand } = {
  TAB: cycle,
  "S-TAB": shiftTab,
  RET: orgReturn,
  "C-y": "org-yank",
  "C-j": "org-return-and-maybe-indent",
  "C-o": "org-open-line",
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
  "C-c C-x p": setProperty,
  "C-c C-x b": treeToIndirectBuffer,
  "C-c C-w": refileCommand,
  "C-c M-w": refileCopyCommand,
  "C-c C-x d": insertDrawer,
  "C-x n s": narrowToSubtree,
  "C-x n e": narrowToElement,
  "C-x n b": narrowToBlock,
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
  "C-c *": ctrlCStar,
  "C-c -": ctrlCMinus,
  "C-c @": markSubtree,
  "C-c |": "org-table-create-or-convert-from-region",
  "C-c C-x C-w": "org-cut-special",
  "C-c C-x M-w": "org-copy-special",
  "C-c C-x C-y": "org-paste-special",
  "<mouse-1>": mouseFollow,
};

ember.defineMajorMode({
  name: "org-mode",
  modeName: "Org",
  parent: "outline-mode",
  // As org-mode-syntax-table.
  syntax: { '"': '"', "\\": "_", "~": "_", "<": "(>", ">": ")<" },
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
    ember.setVariable("imenu-create-index-function", orgImenuGetTree);
    ember.addToInvisibilitySpec("org-hide-drawer", { ellipsis: true });
    ember.addToInvisibilitySpec("org-hide-block", { ellipsis: true });
    ember.addToInvisibilitySpec("org-link");
    storeTodoSets();
    if (ember.variable("org-startup-truncated") === true) ember.setVariable("truncate-lines", true);
    ember.addHook("jit-lock-functions", fontify, { local: true });
    ember.addHook("after-change-functions", foldsAfterChange, { local: true });
    ember.addHook("after-change-functions", headingsAfterChange, { local: true });
    startupVisibility();
  },
});

ember.defineCommand({
  name: "org-force-self-insert",
  doc: "Insert the character typed, as self-insert-command does, without the table handling of org-self-insert-command.",
  run: () => ember.callWithPrefix(ember.prefixArg(), "self-insert-command"),
});
ember.bindKey("|", "org-force-self-insert", "org-mode-map");

ember.remapCommand("org-mode-map", "self-insert-command", "org-self-insert-command");
ember.remapCommand("org-mode-map", "delete-backward-char", "org-delete-backward-char");
ember.remapCommand("org-mode-map", "delete-char", "org-delete-char");
ember.remapCommand("org-mode-map", "move-end-of-line", "org-end-of-line");
