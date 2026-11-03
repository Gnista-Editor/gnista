// Folding, after org-fold.el and org-cycle.el

import {
  entryEnd,
  findFrom,
  firstHeadingFrom,
  type Heading,
  headingIndex,
  headings,
  isBlank,
  isHeadingLine,
  keywordLines,
  nextSameOrHigher,
  subtreeEnd,
} from "org";
import { DRAWER_RE, ITEM_RE } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";
import { charCount, escapeRegExp } from "subr";

export function hideOverlay(start: number, end: number, spec: string): void {
  // Text inserted at either end goes outside, as with org-fold-core's
  // overlays, which advance at the front only.
  ember.makeOverlay(start, end, { invisible: spec, evaporate: true }, { frontAdvance: true });
}

/**
 * Hides or shows the text from start up to end, as Emacs's org-fold-region
 * does: overlays hiding it with `spec` are removed, cut back where they
 * reach outside it, and a new one hides it.
 */
export function flag(start: number, end: number, hide: boolean, spec = "outline"): void {
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

export const FOLD_SPECS = ["outline", "org-hide-drawer", "org-hide-block"];

/** Whether a heading, drawer or block fold hides the character at pos, or one with `spec` if given. */
export function folded(pos: number, spec?: string): boolean {
  return ember.overlaysAt(pos).some((id) => {
    const value = ember.overlayGet(id, "invisible");
    return spec === undefined ? FOLD_SPECS.includes(String(value)) : value === spec;
  });
}

/** Shows a heading's own line, as org-fold-heading does. */
export function showHeadingLine(h: Heading): void {
  flag(Math.max(0, h.start - 1), h.end, false);
}

/** Shows a heading's line and its text up to the next heading, as org-fold-show-entry does. */
export function showEntry(all: Heading[], i: number): void {
  flag(Math.max(0, all[i].start - 1), entryEnd(all, i), false);
}

/**
 * Shows the heading lines of a heading's children, as org-fold-show-children
 * does: the shallowest headings under it, and any as deep as the first one
 * if that is deeper. Returns whether it has any.
 */
export function showChildren(all: Heading[], i: number): boolean {
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
export function ancestors(all: Heading[], i: number): number[] {
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

export function showEmptyLines(state: string, narrowed?: [number, number]): void {
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
export function endOfHidden(line: number): number {
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
export function cycleHeading(all: Heading[], i: number, at = i): void {
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
export function overview(): void {
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
export function showLevels(levels: number): void {
  flag(ember.pointMin(), ember.pointMax(), false);
  hideTopDrawers();
  let last = ember.pointMax();
  for (const h of [...headings()].reverse()) {
    if (h.level > levels) continue;
    flag(h.end, last, true);
    last = Math.max(0, h.start - 1);
  }
}

export function contents(): void {
  showLevels(Infinity);
}

/** Cycles the whole buffer, as org-cycle-internal-global does. */
export function globalCycle(): void {
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
export function checkInvisibleEditMaybe(): void {
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
export function foldsAfterChange(beg: number, end: number): void {
  fixFoldsAround(beg, end);
}

/** Whether edits skip the fold checks, as org-fold-core-ignore-modifications makes them. */
export let foldChecksOff = false;

/** Runs body with no fold checks after its edits, as Org's org-fold-core-ignore-modifications does. */
export function withoutFoldChecks<T>(body: () => T): T {
  const was = foldChecksOff;
  foldChecksOff = true;
  try {
    return body();
  } finally {
    foldChecksOff = was;
  }
}

/** Checks the folds near a change, as org-fold-core--fix-folded-region does after each one. */
export function fixFoldsAround(from: number, to: number): void {
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
        : new RegExp(`^[ \\t]*#\\+end${block?.[1] ? `_${escapeRegExp(block[1])}[ \\t]*$` : ":?[ \\t]*$"}`, "i");
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
let delayedReveals: { buffer: ember.Buffer; id: number }[] = [];

/**
 * Shows a region, every kind of fold in it, once the command is over, as
 * org-fold-core--region-delayed does: Org's fragility checks run from
 * after-change-functions, and commands may assume those leave what shows
 * alone.
 */
function revealAfterCommand(start: number, end: number): void {
  delayedReveals.push({ buffer: ember.currentBuffer(), id: ember.makeOverlay(start, end) });
}

// Each in the buffer it was made in, which need not be current once the
// command is over: a change made from the agenda or capture is to another.
ember.addHook("post-command-hook", () => {
  const reveals = delayedReveals;
  delayedReveals = [];
  for (const { buffer, id } of reveals) {
    if (!ember.bufferLiveP(buffer)) continue;
    ember.withCurrentBuffer(buffer, () => {
      const [start, end] = [ember.overlayStart(id), ember.overlayEnd(id)];
      ember.deleteOverlay(id);
      if (start === undefined || end === undefined || start >= end) return;
      for (const spec of FOLD_SPECS) flag(start, end, false, spec);
    });
  }
});

export const DRAWER = /^[ \t]*:([\w-]+):[ \t]*$/;
export const BLOCK_BEGIN = /^[ \t]*#\+begin_(\S+)/i;
export const BLOCK_END = /^[ \t]*#\+end_(\S+)/i;

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
export function toggleDrawerOrBlock(line: number, hide?: boolean): boolean {
  const close = closingLine(line);
  if (close === undefined) return false;
  const spec = BLOCK_BEGIN.test(ember.lineText(line)) ? "org-hide-block" : "org-hide-drawer";
  const start = ember.lineEnd(line);
  flag(start, ember.lineEnd(close), hide ?? !folded(start, spec), spec);
  return true;
}

/** The line opening the drawer or block a closing line ends, if it is one. */
export function openerOf(line: number): number | undefined {
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
export function hideDrawersIn(fromLine: number, to: number): void {
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
export function startupVisibility(): void {
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
