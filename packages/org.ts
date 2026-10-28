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
  for (const m of markers) {
    if (m.pos > end || (m.pos === end && end > start) || (m.pos === start && start === end && m.before)) m.pos += delta;
    else if (m.pos > start) m.pos = start;
  }
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
function nextSameOrHigher(all: Heading[], i: number): Heading | undefined {
  return all.slice(i + 1).find((h) => h.level <= all[i].level);
}

/**
 * Where a heading's subtree ends for folding: before the newline of the
 * next heading at its level or higher, or at the end of the buffer, as
 * org-fold-subtree takes it.
 */
function subtreeEnd(all: Heading[], i: number): number {
  const next = nextSameOrHigher(all, i);
  return next ? next.start - 1 : ember.bufferSize();
}

/** Where a heading's entry ends for showing it: at the next heading, as org-fold-show-entry takes it. */
function entryEnd(all: Heading[], i: number): number {
  return all[i + 1]?.start ?? ember.bufferSize();
}

/** Where a subtree's text starts and ends for moving or killing it: whole lines. */
function subtreeRegion(all: Heading[], i: number): [number, number] {
  const next = nextSameOrHigher(all, i);
  return [all[i].start, next ? next.start : ember.bufferSize()];
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
  for (const h of all.slice(i + 1)) {
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
  for (let j = i - 1; j >= 0; j--) {
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
    const re =
      k === 1
        ? /(\n[ \t]*\n\*+) /g
        : k === 2
          ? /^[ \t]*(\n[ \t]*\n\*+) /gm
          : new RegExp(`^(?:[ \\t]*\\n){${k - 2}}[ \\t]*(\\n[ \\t]*\\n\\*+) `, "gm");
    const text = ember.bufferText(range[0], range[1]);
    const shown: [number, number][] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const e = range[0] + charCount(text.slice(0, m.index + m[0].length - 1));
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
  const last = headings()
    .filter((h) => h.start < size && h.start >= (narrowed?.[0] ?? 0))
    .at(-1);
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
function cycleHeading(all: Heading[], i: number): void {
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
    const next = all.slice(i + 1).find((x) => x.start > eos);
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
    showEntry(all, i);
    showChildren(all, i);
    for (const a of ancestors(all, i)) {
      showHeadingLine(all[a]);
      showChildren(all, a);
    }
    ember.message("CHILDREN");
    const next = all.slice(i + 1).find((x) => x.start > eos);
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
  for (let line = 0; line < end; line++) {
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
  flag(last, ember.bufferSize(), true);
}

/** Shows the headings up to a level, or all of them, as org-cycle-content does. */
function showLevels(levels: number): void {
  flag(0, ember.bufferSize(), false);
  hideTopDrawers();
  let last = ember.bufferSize();
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
    valid = start > 0 && (ITEM_RE.test(opener) || /^\*+ /.test(opener));
    if (valid) {
      // A top-level heading is never hidden, nor one partly hidden at the end.
      for (let l = before + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
        if (/^\* /.test(ember.lineText(l))) flag(Math.max(0, ember.lineStart(l) - 1), ember.lineEnd(l), false);
      }
      // The heading on the line where the fold ends shows, as
      // org-fold--reveal-headline-at-point shows it, with any blank lines after it.
      const bol = ember.lineStart(lastLine);
      if (isHeadingLine(ember.lineText(lastLine)) && !folded(bol, "outline")) {
        let to = ember.lineEnd(lastLine);
        let q = to;
        while (q < size && /[\n\t\r ]/.test(ember.bufferText(q, q + 1))) q++;
        if (q === ember.lineEnd(lineAt(q))) to = q;
        flag(Math.max(0, bol - 1), to, false);
      }
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
  if (!valid) for (const other of ids) ember.deleteOverlay(other);
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
 * Positions that move with the text as Emacs's markers do, so commands can
 * edit a list and put point back. `before` markers move past text inserted
 * where they are.
 */
const markers: { pos: number; before?: boolean }[] = [];

function marker(pos: number): { pos: number } {
  const m = { pos };
  markers.push(m);
  return m;
}

function dropMarker(m: { pos: number }): void {
  markers.splice(markers.indexOf(m), 1);
}

function edInsert(pos: number, text: string, beforeMarkers = false): void {
  const n = charCount(text);
  if (n === 0) return;
  ember.gotoChar(pos);
  if (beforeMarkers) ember.insertBeforeMarkers(text);
  else ember.insert(text);
  for (const m of markers) if (m.pos > pos || (m.pos === pos && (beforeMarkers || m.before))) m.pos += n;
}

function edDelete(from: number, to: number): string {
  if (to <= from) return "";
  const text = ember.deleteRegion(from, to);
  for (const m of markers) {
    if (m.pos >= to) m.pos -= to - from;
    else if (m.pos > from) m.pos = from;
  }
  return text;
}

/**
 * Replaces text as replace-match does: markers inside it go to its start,
 * and those at its end or after move with the text after it.
 */
function edReplace(from: number, to: number, text: string): void {
  const n = charCount(text);
  const delta = n - (to - from);
  const mark = ember.mark();
  // One change, as replace-match is, so folds are checked once, after it.
  const checks = !foldChecksOff;
  withoutFoldChecks(() => {
    ember.deleteRegion(from, to);
    ember.gotoChar(from);
    ember.insert(text);
  });
  const moved = (x: number): number => (x >= to ? x + delta : x > from ? from : x);
  for (const m of markers) m.pos = moved(m.pos);
  if (mark !== undefined) ember.setMark(moved(mark));
  if (checks) fixFoldsAround(from, from + n);
}

/** Sets a line's indentation, as indent-line-to does. */
function indentLineTo(line: number, col: number): void {
  const text = ember.lineText(line);
  const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
  if (textIndentation(text) === col && ws === indentString(col)) return;
  const ls = ember.lineStart(line);
  edDelete(ls, ls + charCount(ws));
  edInsert(ls, indentString(col));
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
function listStruct(line: number): Struct {
  const ctx = listContext(line);
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
  return new Map(struct.map((e) => [e.pos, struct.find((x) => x.end === e.pos)?.pos]));
}

function parentsAlist(struct: Struct): Alist {
  let indToOri: [number, number | undefined][] = [[struct[0].ind, undefined]];
  const prevPos = [struct[0].pos];
  const out: Alist = new Map([[struct[0].pos, undefined]]);
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
  for (const e of struct.slice(1)) {
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
    if (e.ind !== textIndentation(ember.lineText(line))) {
      const ws = /^[ \t]*/.exec(ember.lineText(line))?.[0] ?? "";
      edDelete(item, item + charCount(ws));
      edInsert(item, indentString(e.ind));
    }
  };
  const endList: [number, number | undefined][] = [];
  let accEnd: [number, number][] = [];
  const itmShift = new Map<number, number>();
  for (const e of old) {
    const now = getItem(struct, e.pos);
    itmShift.set(e.pos, now.ind + charCount(now.bullet) - (e.ind + charCount(e.bullet)));
    if (!old.some((x) => x.pos === e.end)) {
      const up = accEnd.find(([end]) => end > e.end)?.[1];
      endList.unshift([e.end, up]);
    }
    accEnd.unshift([e.end, e.pos]);
  }
  const allEnds = [...new Set([...itmShift.keys(), ...endList.map(([end]) => end)])].sort((a, b) => a - b);
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
  const region = ember.regionActive() && ember.mark() !== undefined;
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
  const region = ember.regionActive() && ember.mark() !== undefined;
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

/** Moves to a column of point's line, or its end, as move-to-column does. */
function moveToColumn(col: number): void {
  const line = lineAt();
  ember.gotoChar(ember.lineStart(line) + Math.min(col, ember.lineEnd(line) - ember.lineStart(line)));
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
    let limDown: { pos: number };
    let single = false;
    const firstItemFrom = (from: number, limit: number): number | undefined => {
      for (let l = lineAt(from); l < ember.lineCount() && ember.lineStart(l) < limit; l++) {
        if (ember.lineStart(l) >= from && itemLine(l)) return ember.lineStart(l);
      }
      return undefined;
    };
    if (ember.regionActive() && ember.mark() !== undefined) {
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
    const box = itemParts(lineAt(limUp))?.checkbox;
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
  });
}

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
    const before = all.filter((h) => h.start < p).at(-1);
    const start = before?.start ?? 0;
    const end = all.find((h) => h.start > p)?.start ?? ember.bufferSize();
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
      for (const m of text.matchAll(COOKIE)) {
        const cs = ember.lineStart(l) + charCount(text.slice(0, m.index ?? 0));
        if (cs < start || cs >= end) continue;
        const container = inItem(l);
        let count: [number, number];
        if (container !== undefined && !isHeadingLine(text)) {
          const s = listStruct(lineAt(container));
          count = countIn(container, getItem(s, container).end, container);
        } else count = countIn(start, end, undefined);
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
  const text = ember.lineText(line);
  for (const m of [...text.matchAll(COOKIE)].reverse()) {
    const percent = m[1].endsWith("%");
    const value = percent ? `[${total === 0 ? 0 : Math.floor((100 * done) / total)}%]` : `[${done}/${total}]`;
    const start = at(line, text, m.index ?? 0);
    replaceText(start, start + charCount(m[0]), value);
  }
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
    const states = all.slice(i + 1).filter((x) => x.start < sub && x.level === next.level && x.todo !== undefined);
    writeCookies(h.line, states.filter((x) => isDone(x.todo)).length, states.length);
  } else {
    const text = ember.lineText(h.line);
    for (const m of [...text.matchAll(COOKIE)].reverse()) {
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
}

// Indentation

/** The column an item's text starts at, after its bullet, as org-list-item-body-column says. */
function listBodyColumn(pos: number): number {
  const text = ember.lineText(lineAt(pos));
  const m = /^[ \t]*(\S+)/.exec(text);
  return m ? ember.stringWidth(m[0].replace(/\t/g, "        ")) + 1 : 0;
}

const GREATER_ELEMENTS = ["drawer", "headline", "item", "plain-list", "property-drawer", "section", "table"];

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
  if (isHeadingLine(text) || blockBefore(line) !== undefined) return;
  const ls = ember.lineStart(line);
  const el = elementAt(ls);
  if (el && (el.type === "plain-list" || el.type === "item") && el.begin === ls) return;
  const want = expectedIndent(el, false, line);
  const ws = /^[ \t]*/.exec(text)?.[0] ?? "";
  const p = ember.point();
  const inIndentation = lineAt(p) === line && p - ls <= charCount(ws);
  if (textIndentation(text) !== want || ws !== indentString(want)) replaceText(ls, ls + charCount(ws), indentString(want));
  if (inIndentation) ember.gotoChar(ls + charCount(indentString(want)));
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
      if (toggleDrawerOrBlock(line)) return;
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
      cycleHeading(...here);
      return;
    }
    if (itemLine(line)) {
      cycleItem(line);
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
  doc:
    "RET in Org: in a table, move to the next row; elsewhere start a new line, indented as org-indent-line does.\n\n" +
    "On a heading, the title after point goes to the new line, but the state, priority and tags stay. In a list " +
    "item, the text after point moves to the new line after it is indented.",
  run: () => {
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
    if (h) {
      const titleEnd = h.titleAt + charCount(h.title);
      const rest = h.title !== "" && p >= h.titleAt && p <= titleEnd ? ember.deleteRegion(p, titleEnd) : undefined;
      if (rest !== undefined && h.tagsAt !== undefined) alignTags(line);
      ember.gotoChar(ember.lineEnd(line));
      const all = headings();
      const i = headingIndex(all, line);
      if (i !== undefined) {
        showEntry(all, i);
        hideDrawersIn(line + 1, entryEnd(all, i));
      }
      electricNewline(n);
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
      electricNewline(n);
      const q = ember.point();
      ember.insert(rest);
      ember.gotoChar(q);
      return;
    }
    electricNewline(n);
  },
});

/**
 * Inserts newlines and indents the new line, as newline does with
 * electric-indent-mode: spaces left at the end of the line before go.
 */
function electricNewline(n: number): void {
  ember.insert("\n".repeat(n));
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
  const order = backward ? all.slice(0, current).reverse() : all.slice(current + 1);
  for (const h of order) {
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
  run: () => forwardHeadingSameLevel(ember.prefixNumericValue()),
});

const backwardSameLevel = ember.defineCommand({
  name: "org-backward-heading-same-level",
  doc: "Move to the previous heading at the same level, under the same parent.",
  run: () => forwardHeadingSameLevel(-ember.prefixNumericValue()),
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
  if (h.start !== 0) return isBlank(ember.lineText(h.line - 1));
  const next = all[i + 1];
  if (next) return isBlank(ember.lineText(next.line - 1));
  // Trailing spaces on the last line are ignored.
  const size = ember.bufferSize();
  let q = size;
  while (q > 0 && /[ \t]/.test(ember.bufferText(q - 1, q))) q--;
  if (q !== ember.lineStart(lineAt(q)) || q === 0) return false;
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
function insertHeading(arg: ember.PrefixArg, invisibleOk = false): void {
  const parentEnd = Array.isArray(arg) && arg[0] === 16;
  const blank = blankBeforeHeading(parentEnd);
  const all = headings();
  const current = headingIndex(all, lineAt());
  const stars = "*".repeat(current === undefined ? 1 : all[current].level);
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
      if (parentEnd) i = ancestors(all, i)[0] ?? i;
      ember.gotoChar(subtreeRegion(all, i)[1]);
    }
    // At the end of a file with no final newline, the heading gets a line of its own.
    if (!atBol()) ember.insert("\n");
    if (blank && headingIndex(headings(), lineAt(ember.point() - 1)) === undefined) {
      ember.insert("\n");
      ember.gotoChar(ember.point() - 1);
    }
    if (current === undefined && ember.point() < ember.bufferSize() && ember.point() > 0) {
      if (isHeadingLine(ember.lineText(lineAt()))) ember.insert("\n");
      ember.gotoChar(ember.point() - 1);
    }
    if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
    ember.insert(`${stars} \n`);
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
      ember.insert(`${stars} \n`);
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
      ember.insert(`\n${stars} `);
      maybeAddBlankAfter(blank);
      if (/\S/.test(split)) ember.insert(split);
      return;
    }
    ember.gotoChar(ember.lineEnd(line));
    if (blank) ember.insert("\n");
    ember.insert(`\n${stars} `);
    maybeAddBlankAfter(blank);
    return;
  }
  if (atBol()) {
    ember.insert(`${stars} `);
    if (!(blank && previousLineEmpty())) emptyLinesBeforeCurrent(blank ? 1 : 0);
    maybeAddBlankAfter(blank);
    return;
  }
  if (ember.variable("org-M-RET-may-split-line") === false) ember.gotoChar(ember.lineEnd(line));
  ember.insert(`\n${stars} `);
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
      for (const h of [...region].reverse()) changeLevel(parseHeading(h.line) ?? h, 1);
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
  const i = all.findIndex((h) => h.start === pos);
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
  const i = all.findIndex((h) => h.start === pos);
  const level = all[i].level;
  let k = i - 1;
  if (k < 0) return undefined;
  while (all[k].level > level && all[k].start > 0 && k > 0) k--;
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
    ins = subtreeRegion(all, all.findIndex((h) => h.start === at))[1];
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
  const levelAt = (pos: number): number => all.find((h) => h.start === pos)?.level ?? 0;
  const previous = (pos: number): [number, boolean] => {
    const level = levelAt(pos);
    let p = all.filter((h) => h.start < pos).at(-1)?.start ?? 0;
    if (p === pos || levelAt(p) === 0) return [p, false];
    while (levelAt(p) > level && p !== 0) p = all.filter((h) => h.start < p).at(-1)?.start ?? 0;
    return [p, levelAt(p) >= level];
  };
  const next = (pos: number): [number, boolean] => {
    const level = levelAt(pos);
    let p = all.find((h) => h.start > pos)?.start ?? ember.bufferSize();
    while (p !== ember.bufferSize() && levelAt(p) > level) p = all.find((h) => h.start > p)?.start ?? ember.bufferSize();
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

const PLANNING = /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/;

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

/** Whether a line starts an element, so a paragraph before it ends. */
function startsElement(line: number, limit: number): boolean {
  const text = ember.lineText(line);
  return (
    isBlank(text) ||
    isHeadingLine(text) ||
    /^[ \t]*\|/.test(text) ||
    ITEM_RE.test(text) ||
    /^[ \t]*#\+\S*:/.test(text) ||
    (DRAWER_RE.test(text) && drawerEnd(line, limit) !== undefined)
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
      drawerEnd(line, to) !== undefined
    ) {
      const close = drawerEnd(line, to) as number;
      e = elem("property-drawer", p, Math.min(lineStartOrEnd(close + 1), to), parent, lineStartOrEnd(line + 1));
      e.contentsEnd = ember.lineStart(close);
      for (let l = line + 1; l < close; l++) elem("node-property", ember.lineStart(l), ember.lineStart(l + 1), e);
    } else if (/^[ \t]*\|/.test(text)) {
      let last = line;
      while (last + 1 < ember.lineCount() && lineStartOrEnd(last + 1) < to && /^[ \t]*\|/.test(ember.lineText(last + 1))) last++;
      e = elem("table", p, Math.min(lineStartOrEnd(last + 1), to), parent, p);
      e.contentsEnd = e.end;
      for (let l = line; l <= last; l++) elem("table-row", ember.lineStart(l), Math.min(lineStartOrEnd(l + 1), to), e);
    } else if (p === ember.lineStart(line) && itemLine(line)) {
      const [struct, prevs, parents] = list ?? (() => {
        const s = listStruct(line);
        return [s, prevsAlist(s), parentsAlist(s)] as [Struct, Alist, Alist];
      })();
      const items = allItems(p, prevs);
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
    } else if (p === ember.lineStart(line) && /^[ \t]*#\+\S*:/.test(text)) {
      e = elem("keyword", p, Math.min(next, to), parent);
    } else {
      let last = line;
      while (last + 1 < ember.lineCount() && lineStartOrEnd(last + 1) < to && !startsElement(last + 1, to)) last++;
      e = elem("paragraph", p, Math.min(lineStartOrEnd(last + 1), to), parent, p);
    }
    postBlank(e, to);
    previous = e.type;
    if (e.end <= p) break;
    p = e.end;
  }
}

/** Parses the buffer into its elements: headlines, sections and what they hold. */
function parseBuffer(): Elem {
  const root: Elem = { type: "org-data", begin: 0, end: ember.bufferSize(), children: [] };
  const all = headings();
  const section = (parent: Elem, from: number, to: number, afterHeadline: boolean): void => {
    let p = from;
    while (p < to && isBlank(ember.lineText(lineAt(p))) && p === ember.lineStart(lineAt(p))) p = lineStartOrEnd(lineAt(p) + 1);
    if (p >= to) return;
    const sec = elem("section", p, to, parent, p);
    sec.contentsEnd = to;
    // Before the first heading, a property drawer may start the buffer.
    parseElements(sec, p, to, afterHeadline, undefined, parent.type === "org-data");
  };
  const headline = (i: number, parent: Elem): number => {
    const h = all[i];
    const end = subtreeRegion(all, i)[1];
    const e = elem("headline", h.start, end, parent);
    const sectionEnd = Math.min(all[i + 1]?.start ?? end, end);
    section(e, lineStartOrEnd(h.line + 1), sectionEnd, true);
    let k = i + 1;
    while (k < all.length && all[k].start < end) k = headline(k, e);
    return k;
  };
  section(root, 0, all[0]?.start ?? ember.bufferSize(), false);
  for (let k = 0; k < all.length; ) k = headline(k, root);
  return root;
}

/** The element at a position, as org-element-at-point finds it: the innermost, but not inside one starting there. */
function elementAt(pos: number): Elem | undefined {
  let node = parseBuffer();
  const size = ember.bufferSize();
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
function copySubtree(cut: boolean, n: number): void {
  const p = ember.point();
  const [all, found] = backToHeading(true);
  // As org-back-to-heading does without invisible-ok, the nearest heading that shows.
  let i = found;
  for (const a of [found, ...ancestors(all, found)]) {
    i = a;
    if (!ember.invisibleAt(all[a].start)) break;
  }
  let j = i;
  for (let k = 1; k < n; k++) j = sibling(all, j, 1) ?? j;
  const [beg, end] = [all[i].start, subtreeRegion(all, j)[1]];
  if (end <= beg) return;
  const mark = ember.mark();
  ember.setMark(end);
  ember.gotoChar(beg);
  ember.call(cut ? "kill-region" : "kill-ring-save");
  const moved = (x: number): number => (!cut || x <= beg ? x : x >= end ? x - (end - beg) : beg);
  ember.setMark(mark === undefined ? null : moved(mark));
  ember.gotoChar(moved(p));
  ember.message(`${cut ? "Cut" : "Copied"}: Subtree(s) with ${end - beg} characters`);
}

ember.defineCommand({
  name: "org-cut-subtree",
  doc: "Kill the subtree point is in, so C-c C-x C-y or C-y can put it back.",
  run: () => copySubtree(true, ember.prefixNumericValue()),
});

ember.defineCommand({
  name: "org-copy-subtree",
  doc: "Copy the subtree point is in to the kill ring.",
  run: () => copySubtree(false, ember.prefixNumericValue()),
});

/** Whether text is one or more subtrees: it starts with a heading and none after is higher, as org-kill-is-subtree-p says. */
function killIsSubtree(text: string): boolean {
  const first = /^(?:[ \t\n\r]*?\n)?(\*+) /.exec(text);
  if (!first) return false;
  const level = first[1].length;
  return [...text.matchAll(/^(\*+) /gm)].every((m) => m[1].length >= level);
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
  ember.insert(txt);
  if (!txt.endsWith("\n")) ember.insert("\n");
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
}

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
  run: () => ember.call(/^[ \t]*\|/.test(ember.lineText(lineAt())) ? "org-table-cut-region" : "org-cut-subtree"),
});

ember.defineCommand({
  name: "org-copy-special",
  doc: "Copy the subtree point is in, or in a table, the field at point or the fields in the region.",
  run: () => ember.call(/^[ \t]*\|/.test(ember.lineText(lineAt())) ? "org-table-copy-region" : "org-copy-subtree"),
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

/** Moves point just past a heading's TODO keyword if it is near it, as org-todo does last. */
function fixPositionAfterTodo(line: number): void {
  const fresh = parseHeading(line);
  if (!fresh) return;
  const at = ember.point();
  const end = fresh.todoAt !== undefined ? fresh.todoAt + charCount(fresh.todo ?? "") : fresh.start + fresh.level;
  if (lineAt(at) === line && at !== fresh.start && at < end + 2) {
    ember.gotoChar(end);
    const after = ember.bufferText(end, fresh.end);
    if (/^ /.test(after) && !/^ *:/.test(after)) {
      // just-one-space
      const spaces = /^[ \t]*/.exec(after)?.[0].length ?? 0;
      replaceText(end, end + spaces, " ");
      ember.gotoChar(end + 1);
    }
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
  const all = headings();
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
  const all = headings();
  const i = headingIndex(all, line);
  if (i === undefined) return;
  const parent = ancestors(all, i)[0];
  if (parent === undefined || !HAS_COOKIE.test(ember.lineText(all[parent].line))) return;
  const level = all[i].level;
  const end = subtreeRegion(all, parent)[1];
  const children = all.filter((h, k) => k > parent && h.start < end && h.level === level);
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
    if (!forEachHeadingInRegion(() => todo(1))) todo(1);
  },
});

/**
 * Runs body at each visible heading in the active region, as org-map-entries
 * does for commands when org-loop-over-headlines-in-active-region is on.
 * Returns whether it applied.
 */
function forEachHeadingInRegion(body: () => void): boolean {
  const mark = ember.mark();
  if (!ember.regionActive() || mark === undefined || ember.variable("org-loop-over-headlines-in-active-region") !== true) return false;
  const [rb, re] = [Math.min(mark, ember.point()), Math.max(mark, ember.point())];
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
      edDelete(start + 2, start + 2 + charCount(cookie[2]));
      edInsert(start + 2, String.fromCharCode(next));
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
function alignTags(line: number): void {
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
  for (const m of text.matchAll(re)) {
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
  ember.insert(`${open}${formatTimestamp(date, withTime)}${tail}${close}`);
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
  if (i !== undefined && folded(Math.max(0, all[i].start - 1), "outline")) {
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
    else if (headingsInRegion() || headingHere()) {
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
    else if (headingsInRegion() || headingHere()) {
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
  if (r1[0] > r2[0]) [r1, r2] = [r2, r1];
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
  if (!ember.regionActive() || mark === undefined) return false;
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
        while (ember.point() < end.pos) moveSubtree(1);
        dropMarker(end);
      } else {
        const beg = marker(rb);
        const after = all.find((h) => h.level === level && h.start >= re && h.start + h.level + 1 > re);
        if ((level > 1 && higher(rb === ember.lineStart(lineAt(rb)) ? rb : lineStartOrEnd(lineAt(rb) + 1), re)) || !after) {
          dropMarker(beg);
          throw new Error("Cannot move past superior level or buffer limit");
        }
        ember.gotoChar(after.start);
        while (ember.point() > beg.pos) moveSubtree(-1);
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
  if (up) {
    const prev = Math.max(0, lineAt(a) - 1);
    const [c, d] = [ember.lineStart(prev), ember.lineEnd(prev)];
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
  if (swap) ember.call("exchange-point-and-mark");
  return true;
}

const metaUp = ember.defineCommand({
  name: "org-metaup",
  doc: "M-<up> in Org: move a subtree, an item or a table row up past the one before it.",
  run: () => {
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
      if (short > 0) ember.insert("\n".repeat(short));
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
    throw e;
  } finally {
    dropMarker(end);
    dropMarker(boundary);
  }
}

function dragLine(n: number): void {
  for (let i = 0; i < Math.abs(n); i++) {
    const column = ember.point() - ember.lineStart(lineAt());
    if (n > 0) {
      forwardLine(1);
      transposeLinesWithFolds();
      forwardLine(-1);
    } else {
      transposeLinesWithFolds();
      forwardLine(-2);
    }
    const line = lineAt();
    ember.gotoChar(ember.lineStart(line) + Math.min(column, ember.lineEnd(line) - ember.lineStart(line)));
  }
}

ember.defineCommand({
  name: "org-drag-line-forward",
  doc: "Drag the line at point down past the next line, or as many lines as the prefix argument says.",
  run: () => dragLine(ember.prefixNumericValue()),
});

ember.defineCommand({
  name: "org-drag-line-backward",
  doc: "Drag the line at point up past the line before it, or as many lines as the prefix argument says.",
  run: () => dragLine(-ember.prefixNumericValue()),
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
  if (ember.regionActive()) return false;
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

const shiftUp = ember.defineCommand({
  name: "org-shiftup",
  doc: "S-<up> in Org: make a timestamp later, raise a heading's priority, or move to the previous item.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-up");
    else if (headingHere()) ember.call("org-priority-up");
    else if (itemHere()) ember.call("org-previous-item");
    else if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-cell-up");
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
    else if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-cell-down");
    else shiftSelectError();
  },
});

const shiftRight = ember.defineCommand({
  name: "org-shiftright",
  doc: "S-<right> in Org: move a timestamp a day on, change a heading to its next TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-up-day");
    else if (headingHere()) todo(1);
    else if (itemLine(lineAt())) cycleListBullet();
    else if (elementAt(ember.point())?.type === "node-property") nextAllowedValue();
    else if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-cell-right");
    else shiftSelectError();
  },
});

const shiftLeft = ember.defineCommand({
  name: "org-shiftleft",
  doc: "S-<left> in Org: move a timestamp a day back, change a heading to its previous TODO state, or change list bullets.",
  run: () => {
    if (timestampHere()) ember.callWithPrefix(ember.prefixArg(), "org-timestamp-down-day");
    else if (headingHere()) todo(-1);
    else if (itemLine(lineAt())) cycleListBullet("previous");
    else if (elementAt(ember.point())?.type === "node-property") nextAllowedValue();
    else if (/^[ \t]*\|/.test(ember.lineText(lineAt()))) ember.call("org-table-move-cell-left");
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
  return [...text.matchAll(COOKIE)].some((m) => {
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

const ctrlCCtrlC = ember.defineCommand({
  name: "org-ctrl-c-ctrl-c",
  doc:
    "C-c C-c in Org: tick or untick a checkbox, align a table, update a statistics cookie, set a heading's tags, " +
    "fix a timestamp, or re-read the buffer's #+ settings on a #+ line.",
  run: () => {
    const line = lineAt();
    const text = ember.lineText(line);
    if (/^[ \t]*$/.test(text)) nothingUseful();
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
    if (cookieHere()) {
      ember.call("org-update-statistics-cookies");
      return;
    }
    if (timestampHere()) {
      changeTimestamp(0, "day");
      return;
    }
    if (headingHere()) {
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
    const all = headings();
    updateHeadingCookies(all, headingIndex(all, lineAt()) as number);
  },
});

const ctrlCMinus = ember.defineCommand({
  name: "org-ctrl-c-minus",
  doc: "C-c - in Org: insert a table rule, change a list's bullets, or turn the line into an item.",
  run: () => {
    const line = lineAt();
    if (/^[ \t]*\|/.test(ember.lineText(line))) ember.callWithPrefix(ember.prefixArg(), "org-table-insert-hline");
    else if (ember.regionActive()) ember.call("org-toggle-item");
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
function shiftText(ind: number, end: { pos: number }): void {
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
    const region = ember.regionActive() && mark !== undefined;
    let beg: number;
    let end: { pos: number };
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
  doc: "Turn the line into a heading, or a heading into plain text; an item becomes a heading.",
  run: () => {
    let line = lineAt();
    // Blank lines are skipped, but not past the line point is on.
    while (line < ember.lineCount() - 1 && isBlank(ember.lineText(line))) line++;
    if (line !== lineAt()) {
      ember.message("Cannot toggle heading from here");
      return;
    }
    const text = ember.lineText(line);
    const ls = ember.lineStart(line);
    const existing = /^\*+ /.exec(text);
    if (existing) {
      replaceKeepingPoint(ls, ls + existing[0].length, "");
      return;
    }
    const all = headings();
    const i = headingIndex(all, line);
    const stars = `${"*".repeat((i === undefined ? 0 : all[i].level) + 1)} `;
    if (itemLine(line)) {
      // A checkbox becomes a TODO state, done if it was ticked.
      const item = parseItem(line) as Item;
      const set = todoSets()[0];
      const state = item.checkbox === undefined ? "" : `${(item.checkbox === "X" ? set?.done[0] : set?.todo[0]) ?? "TODO"} `;
      const end = item.checkboxAt !== undefined ? Math.min(item.checkboxAt + 4, ember.lineEnd(line)) : item.contentAt;
      // As org-list-to-subtree does, the item is deleted first, and the
      // heading's level comes from the heading at or above where it was.
      const rest = ember.bufferText(end, ember.lineEnd(line));
      const next = lineStartOrEnd(line + 1);
      const hadNewline = next > ember.lineEnd(line);
      edDelete(ls, next);
      const above = headingIndex(headings(), lineAt(ls));
      const level = above === undefined ? 1 : (headings()[above].level ?? 0) + 1;
      edInsert(ls, `${"*".repeat(level)} ${state}${rest}${hadNewline ? "\n" : ""}`);
      if (ember.lineEnd(line) === ember.bufferSize()) {
        ember.gotoChar(ember.bufferSize());
        ember.insert("\n");
      }
      ember.gotoChar(ls);
      return;
    }
    const m = /^([ \t]*)(\S)/.exec(text);
    if (m) replaceKeepingPoint(ls, ls + charCount(m[0]), stars + m[2]);
    else ember.message("Cannot toggle heading from here");
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
  "C-c *": ctrlCStar,
  "C-c -": ctrlCMinus,
  "C-c @": markSubtree,
  "C-c |": "org-table-create-or-convert-from-region",
  "C-c SPC": "org-table-blank-field",
  "C-c C-x C-w": "org-cut-special",
  "C-c C-x M-w": "org-copy-special",
  "C-c C-x C-y": "org-paste-special",
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
    ember.addHook("after-change-functions", foldsAfterChange, { local: true });
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
