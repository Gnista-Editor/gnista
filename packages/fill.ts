// Filling, after Emacs's fill.el, with auto-fill-mode, do-auto-fill and
// set-fill-column from simple.el. M-q fills the paragraph at or after point,
// or the region when it is active, so no line passes fill-column; with a
// prefix argument it also justifies, lining both edges up. A paragraph's
// lines keep the prefix they share, such as "> " or "  - ", as Adaptive Fill
// mode finds it. Auto Fill mode breaks a line as you type a space past
// fill-column. Two spaces after a period end a sentence, as
// sentence-end-double-space says, and filling keeps them.

ember.defineVariable({
  name: "fill-column",
  doc: "The column filling breaks lines before. Each buffer has its own; C-x f sets it.",
  value: 70,
  local: true,
});
ember.defineVariable({
  name: "fill-prefix",
  doc: "Text filling puts at the start of each line, or nil to work it out from the paragraph when adaptive-fill-mode is on. C-x . sets it.",
  value: null,
  local: true,
});
ember.defineVariable({
  name: "adaptive-fill-mode",
  doc: "Whether filling takes a paragraph's fill prefix from its text, as its second line starts, or its first if it has one line.",
  value: true,
});
ember.defineVariable({
  name: "adaptive-fill-regexp",
  doc: "What a fill prefix in a paragraph's text looks like, as a regular expression matched at the start of a line.",
  value: "[-\u2013!|#%;>*\u00b7\u2022\u2023\u2043\u25e6 \t]*",
});
ember.defineVariable({
  name: "adaptive-fill-first-line-regexp",
  doc: "What the prefix of a paragraph's only line must look like for the lines filling makes to take it too; otherwise they take as many spaces.",
  value: "\\`[ \t]*\\'",
});
ember.defineVariable({
  name: "sentence-end-double-space",
  doc: "Whether a sentence ends with two spaces after its period, so a period followed by one space is no end of sentence, and filling keeps two.",
  value: true,
});
ember.defineVariable({
  name: "colon-double-space",
  doc: "Whether filling leaves two spaces after a colon.",
  value: false,
});
ember.defineVariable({
  name: "default-justification",
  doc: "How filling lines lines up: left, full (both edges), or none.",
  value: "left",
  local: true,
});
ember.defineVariable({
  name: "normal-auto-fill-function",
  doc: "The command Auto Fill mode puts in auto-fill-function. Some major modes set it.",
  value: "do-auto-fill",
});
ember.defineVariable({
  name: "fill-paragraph-function",
  doc: "A command M-q runs instead of filling plain text, as major modes such as Org set it, or nil.",
  value: null,
  local: true,
});

const truthy = (v: ember.Value | undefined): boolean => v !== undefined && v !== null && v !== false;
const fillColumn = (): number => {
  const v = ember.variable("fill-column");
  return typeof v === "number" ? v : 70;
};
const charAt = (p: number): string => ember.bufferText(p, Math.min(p + 1, ember.bufferSize()));
const charBefore = (p: number): string => (p > 0 ? ember.bufferText(p - 1, p) : "");
const bolAt = (p: number): number => ember.lineStart(ember.lineOf(p));
const eolAt = (p: number): number => ember.lineEnd(ember.lineOf(p));
const bolp = (): boolean => ember.point() === bolAt(ember.point());
const eolp = (): boolean => ember.point() === eolAt(ember.point());
const eobp = (): boolean => ember.point() >= ember.bufferSize();

/** Moves forward over characters in `chars`, not past `limit`, as skip-chars-forward. */
function skipForward(chars: string, limit = ember.bufferSize()): void {
  let p = ember.point();
  while (p < limit && chars.includes(charAt(p))) p++;
  ember.gotoChar(p);
}
/** Moves back over characters in `chars`, not before `limit`, as skip-chars-backward. Returns how far it went. */
function skipBackward(chars: string, limit = 0): number {
  const start = ember.point();
  let p = start;
  while (p > limit && chars.includes(charBefore(p))) p--;
  ember.gotoChar(p);
  return start - p;
}
/** As forward-line: to the start of a later or earlier line, or an end of the buffer. */
function forwardLine(n: number): void {
  const line = ember.lineOf(ember.point()) + n;
  if (line < 0) ember.gotoChar(0);
  else if (line >= ember.lineCount()) ember.gotoChar(ember.bufferSize());
  else ember.gotoChar(ember.lineStart(line));
}
/** Where an Emacs regexp matching at `p`, within its line, ends, as looking-at. */
function lookingAt(regexp: string, p: number): number | undefined {
  const m = ember.search(regexp, { from: p, regexp: true, bound: eolAt(p), caseFold: false });
  return m !== undefined && m.start === p ? m.end : undefined;
}
const marker = (pos: number, advances = false): number => ember.makeMarker(pos, { advances });
const at = (m: number): number => ember.markerPosition(m)!;
const free = (...ms: number[]): void => ms.forEach((m) => ember.setMarker(m, null));
/** Runs `fn` and puts point back where it was, moved with the text, as save-excursion. */
function saveExcursion<T>(fn: () => T): T {
  const p = marker(ember.point());
  try {
    return fn();
  } finally {
    ember.gotoChar(at(p));
    free(p);
  }
}
function barfIfReadOnly(): void {
  if (ember.bufferReadOnly()) throw new Error(`Buffer is read-only: #<buffer ${ember.bufferName()}>`);
}

/** How to justify, as current-justification: undefined for none. */
function currentJustification(): string | undefined {
  const j = ember.variable("default-justification");
  return j === "none" || typeof j !== "string" ? undefined : j;
}

// --- The fill prefix -------------------------------------------------------

/** The adaptive prefix at point, as fill-match-adaptive-prefix: none if as long as the fill column. */
function matchAdaptivePrefix(): string | undefined {
  const re = ember.variable("adaptive-fill-regexp");
  if (typeof re !== "string") return undefined;
  const end = lookingAt(re, ember.point());
  if (end === undefined) return undefined;
  const str = ember.bufferText(ember.point(), end);
  return str.length >= fillColumn() ? undefined : str;
}

/** The longest start two strings share, as fill-common-string-prefix, or undefined if none. */
function commonPrefix(a: string, b: string): string | undefined {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === 0 ? undefined : a.slice(0, i);
}

const regexpQuote = (s: string): string => s.replace(/[.*+?^$[\]\\]/g, "\\$&");

/** The fill prefix a paragraph's text suggests, as fill-context-prefix. */
function fillContextPrefix(from: number, to: number): string | undefined {
  return saveExcursion(() => {
    ember.gotoChar(from);
    if (eolp()) forwardLine(1);
    ember.gotoChar(bolAt(ember.point()));
    let first = matchAdaptivePrefix();
    forwardLine(1);
    if (ember.point() < to) {
      let second = matchAdaptivePrefix();
      if (/^[ \t]*$/.test(ember.lineText(ember.lineOf(ember.point()))) && ember.point() === bolAt(ember.point())) {
        second = undefined;
      }
      if (second === undefined) return undefined;
      first ??= "";
      // The second line's prefix if the first has its words in order, as
      // "/* " and " * " do; else what the two share.
      let re = "\\`";
      for (const word of second.match(/[^ \t]+/g) ?? []) re += ".*" + regexpQuote(word);
      return ember.stringMatch(re, first) !== undefined ? second : commonPrefix(first, second);
    }
    if (first === undefined) return undefined;
    const firstLine = ember.variable("adaptive-fill-first-line-regexp");
    const result =
      typeof firstLine === "string" && ember.stringMatch(firstLine, first) !== undefined
        ? first
        : " ".repeat(ember.stringWidth(first));
    // Not one that would start a paragraph.
    return result.startsWith("\f") ? undefined : result;
  });
}

/** Deletes the fill prefix from each line after the first, as fill-delete-prefix; point goes past the first's. */
function fillDeletePrefix(from: number, to: number, prefix: string | undefined): number {
  const words = prefix !== undefined && !/^[ \t]*$/.test(prefix);
  const fpre = words
    ? new RegExp(`^[ \\t]*(?:${prefix!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ \t]+/g, "[ \\t]*")})?[ \\t]*`)
    : /^[ \t]*/;
  ember.gotoChar(from);
  forwardLine(1);
  while (ember.point() < at(to)) {
    const m = fpre.exec(ember.lineText(ember.lineOf(ember.point())))!;
    if (m[0].length > 0) ember.deleteRegion(ember.point(), ember.point() + m[0].length);
    forwardLine(1);
    if (eobp()) break;
  }
  ember.gotoChar(from);
  const m = fpre.exec(ember.bufferText(from, eolAt(from)))!;
  ember.gotoChar(from + m[0].length);
  return ember.point();
}

// --- Spaces between words and sentences --------------------------------------

/** A sentence's end, as (sentence-end) with its defaults: its punctuation, then two spaces or the end of a line. */
function sentenceEnd(): string {
  const spacing = truthy(ember.variable("sentence-end-double-space"))
    ? "(?:$|[ \u00a0]$|\t|[ \u00a0][ \u00a0])"
    : "(?:$|[\t \u00a0])";
  return `(?:[.?!\u2026\u203d][\\]"'\u201d\u2019)}\u00bb\u203a]*${spacing}|[\u3002\uff0e\uff1f\uff01]+)[ \u00a0\t\n]*`;
}

/**
 * Leaves one space between words and two after a sentence or colon, as
 * sentence-end-double-space and colon-double-space say, and turns tabs into
 * spaces, as canonically-space-region.
 */
function canonicallySpaceRegion(beg: number, endMarker: number): void {
  // Tabs become spaces, in place.
  ember.substCharInRegion(beg, at(endMarker), "\t", " ");
  const text = ember.bufferText(beg, at(endMarker));
  const double = truthy(ember.variable("sentence-end-double-space"));
  const colon = truthy(ember.variable("colon-double-space"));
  const re = new RegExp(`(${sentenceEnd()}) *|  +`, "gmu");
  const deletions: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (m[1] !== undefined) {
      const end1 = start + m[1].length;
      if (end > end1) {
        deletions.push([end1, end]);
      } else {
        // Keep at most two spaces after the sentence.
        let back = end;
        while (back > start && text[back - 1] === " ") back--;
        deletions.push([Math.min(end, back + (double ? 2 : 1)), end]);
      }
    } else {
      let back = start;
      while (back > 0 && " ]})\"'".includes(text[back - 1])) back--;
      const prev = back > 0 ? text[back - 1] : "\n";
      const keep = double && ".?!".includes(prev) ? 2 : colon && prev === ":" ? 2 : prev === "\n" ? 0 : 1;
      deletions.push([start + keep, end]);
    }
  }
  for (const [a, b] of deletions.reverse()) if (b > a) ember.deleteRegion(beg + a, beg + b);
}

/** Joins a paragraph's lines into one, as fill-delete-newlines: two spaces after a sentence ending a line. */
function fillDeleteNewlines(from: number, to: number, justify: string | undefined): void {
  // A sentence that ends a line gets a second space.
  const end = new RegExp(`[.?!\u2026\u203d][\\]"'\u201d\u2019)}\u00bb\u203a]*$`, "u");
  for (let line = ember.lineOf(at(to)) - 1; line >= ember.lineOf(from); line--) {
    const e = ember.lineEnd(line);
    if (e < at(to) && e >= from && end.test(ember.bufferText(ember.lineStart(line), e))) {
      ember.gotoChar(e);
      ember.insertAndInherit(" ");
    }
  }
  ember.gotoChar(from);
  skipForward(" \t");
  const squeezeFrom = ember.point();
  // Newlines become spaces, in place.
  ember.substCharInRegion(from, at(to), "\n", " ");
  void justify;
  canonicallySpaceRegion(squeezeFrom, to);
  // No whitespace at the end.
  ember.gotoChar(at(to));
  const n = skipBackward(" \t");
  if (n > 0) ember.deleteRegion(ember.point(), ember.point() + n);
  ember.gotoChar(from);
}

// --- Breaking lines --------------------------------------------------------

/** Whether a line must not break at point, as fill-nobreak-p: after a period and one space, or before what would start a paragraph. */
function fillNobreakP(): boolean {
  if (bolp()) return false;
  const p = ember.point();
  if (truthy(ember.variable("sentence-end-double-space"))) {
    let q = p;
    while (q > 0 && charBefore(q) === " ") q--;
    if (charBefore(q) === "." && charAt(q) === " " && q + 1 < ember.bufferSize() && !" \n".includes(charAt(q + 1))) {
      return true;
    }
  }
  let q = p;
  while (q < ember.bufferSize() && " \t".includes(charAt(q))) q++;
  return q < ember.bufferSize() && charAt(q) !== "\n" && charAt(q) === "\f";
}

/** Moves back to where the line should break, after `linebeg`, as fill-move-to-break-point. */
function fillMoveToBreakPoint(linebeg: number): void {
  if (linebeg > ember.point()) ember.gotoChar(linebeg);
  for (;;) {
    let p = ember.point() - 1;
    while (p >= linebeg && !" \t".includes(charAt(p))) p--;
    if (p < linebeg) {
      ember.gotoChar(linebeg);
      break;
    }
    ember.gotoChar(p + 1);
    if (!fillNobreakP()) break;
    skipBackward(" \t", linebeg);
  }
  skipBackward(" \t");
  if (linebeg >= ember.point()) {
    // Keep at least one word on the line.
    const to = eolAt(linebeg);
    let first = true;
    ember.gotoChar(linebeg);
    while (ember.point() < to && (first || fillNobreakP())) {
      skipForward(" \t");
      let q = ember.point();
      while (q < ember.bufferSize() && !" \n\t".includes(charAt(q))) q++;
      ember.gotoChar(q);
      first = false;
    }
  }
}

/** Indents the current line to the left margin, column 0, as fill-indent-to-left-margin. */
function indentToLeftMargin(): void {
  const start = bolAt(ember.point());
  const ws = /^[ \t]*/.exec(ember.lineText(ember.lineOf(start)))![0].length;
  if (ws > 0) ember.deleteRegion(start, start + ws);
  ember.gotoChar(start);
}

/** Breaks the line at point and starts the next with the fill prefix, as fill-newline. */
function fillNewline(prefix: string | undefined): void {
  skipBackward(" \t");
  ember.insert("\n");
  indentToLeftMargin();
  if (prefix !== undefined && prefix !== "") ember.insertBeforeMarkers(prefix);
}

/** Spreads the spaces of the line at point so it ends at the fill column, as justify-current-line does for full. */
function justifyCurrentLine(how: string | undefined, eop: boolean, prefix: string | undefined): void {
  if (how !== "full") return;
  saveExcursion(() => {
    const fc = fillColumn();
    ember.gotoChar(eolAt(ember.point()));
    skipBackward(" \t");
    if (bolp() || ember.currentColumn() === fc) return;
    const end = ember.point();
    ember.gotoChar(bolAt(end));
    skipForward(" \t");
    if (prefix !== undefined && prefix !== "" && ember.bufferText(ember.point(), ember.point() + prefix.length) === prefix) {
      ember.gotoChar(ember.point() + prefix.length);
    } else if (truthy(ember.variable("adaptive-fill-mode"))) {
      const re = ember.variable("adaptive-fill-regexp");
      const e = typeof re === "string" ? lookingAt(re, ember.point()) : undefined;
      if (e !== undefined) ember.gotoChar(e);
    }
    skipForward(" \t");
    const beg = ember.point();
    ember.gotoChar(end);
    const ncols = fc - ember.currentColumn();
    const text = ember.bufferText(beg, end);
    const gaps = [...text.matchAll(/ +/g)].map((m) => beg + m.index! + m[0].length);
    const nspaces = gaps.length;
    if (ncols <= 0 || nspaces === 0 || eop) return;
    let frac = ncols + Math.floor(nspaces / 2);
    const extra: number[] = [];
    for (let i = 0; i < nspaces; i++) {
      extra.push(Math.floor(frac / nspaces));
      frac = (frac % nspaces) + ncols;
    }
    for (let i = nspaces - 1; i >= 0; i--) {
      ember.gotoChar(gaps[i]);
      ember.insertAndInherit(" ".repeat(extra[i]));
    }
  });
}

// --- Filling ---------------------------------------------------------------

/**
 * Fills the text from `from` to `to` as one paragraph, as
 * fill-region-as-paragraph, leaving point at the start of the line after
 * it. Returns the fill prefix it used.
 */
function fillRegionAsParagraph(fromIn: number, toIn: number, justifyIn?: string): string | undefined {
  let justify = justifyIn;
  ember.gotoChar(Math.min(fromIn, toIn));
  const toPos = Math.max(fromIn, toIn);
  skipForward(" \t\n");
  const fromPlusIndent = ember.point();
  const from = Math.max(bolAt(ember.point()), Math.min(fromIn, toIn));
  // All but one newline at the end go.
  ember.gotoChar(toPos);
  let oneleft = false;
  while (ember.point() > from && charBefore(ember.point()) === "\n") {
    if (oneleft) ember.deleteRegion(ember.point() - 1, ember.point());
    else {
      ember.gotoChar(ember.point() - 1);
      oneleft = true;
    }
  }
  const to = marker(ember.point(), true);
  ember.gotoChar(fromPlusIndent);
  try {
    if (!(at(to) > ember.point())) return undefined;
    justify ??= currentJustification();
    const fp = ember.variable("fill-prefix");
    let prefix = typeof fp === "string" ? fp : undefined;
    if (truthy(ember.variable("adaptive-fill-mode")) && (prefix === undefined || prefix === null || prefix === "")) {
      prefix = fillContextPrefix(from, at(to));
    }
    if (justify === undefined) return prefix;
    const start = fillDeletePrefix(from, to, prefix);
    fillDeleteNewlines(start, to, justify);
    ember.gotoChar(start);
    while (ember.point() < at(to)) {
      const linebeg = ember.point();
      ember.moveToColumn(fillColumn());
      let cut = false;
      if (ember.point() < at(to)) {
        ember.gotoChar(ember.point() + 1);
        fillMoveToBreakPoint(linebeg);
        skipForward(" \t");
        cut = ember.point() < at(to);
      }
      if (cut) {
        fillNewline(prefix);
        if (justify === "full") {
          saveExcursion(() => {
            forwardLine(-1);
            justifyCurrentLine(justify, false, prefix);
          });
        }
      } else {
        ember.gotoChar(at(to));
        justifyCurrentLine(justify, true, prefix);
        break;
      }
    }
    ember.gotoChar(at(to));
    if (!eobp()) ember.gotoChar(ember.point() + 1);
    return prefix;
  } finally {
    free(to);
  }
}

/** Moves over paragraphs, as forward-paragraph, and says how many it could not. */
function forwardParagraph(n: number): number {
  if (n > 0) {
    // forward-paragraph finds none if only blank lines follow.
    let p = bolAt(ember.point());
    while (p < ember.bufferSize() && /^[ \t\f]*$/.test(ember.lineText(ember.lineOf(p)))) {
      const next = ember.lineOf(p) + 1;
      p = next < ember.lineCount() ? ember.lineStart(next) : ember.bufferSize();
    }
    if (p >= ember.bufferSize()) {
      ember.gotoChar(ember.bufferSize());
      return n;
    }
  }
  ember.callWithPrefix(n, "forward-paragraph");
  return 0;
}

/** Fills each paragraph from `from` to `to`, as fill-region, and returns the last fill prefix. */
function fillRegion(from: number, to: number, justify?: string): string | undefined {
  const start = marker(ember.point());
  const max = marker(Math.max(from, to), true);
  const beg = Math.min(from, to);
  let prefix: string | undefined;
  ember.gotoChar(bolAt(beg));
  while (ember.point() < at(max)) {
    const initial = ember.point();
    forwardParagraph(1);
    const end = Math.min(at(max), ember.point());
    forwardParagraph(-1);
    if (ember.point() < beg) ember.gotoChar(beg);
    if (ember.point() >= initial && ember.point() < end) prefix = fillRegionAsParagraph(ember.point(), end, justify);
    else ember.gotoChar(end);
    if (ember.point() <= initial) break;
  }
  ember.gotoChar(at(start));
  free(start, max);
  return prefix;
}

const justifyArg = (): string | undefined => (ember.prefixArg() !== null ? "full" : undefined);

ember.defineCommand({
  name: "fill-paragraph",
  doc:
    "Fill the paragraph at or after point, breaking lines so none passes fill-column, or each paragraph in the region if it is active.\n\n" +
    "With a prefix argument, justify as well, so the lines end at fill-column too. The lines keep the prefix the paragraph's lines share, as adaptive-fill-mode finds it.",
  run: () => {
    barfIfReadOnly();
    const justify = justifyArg();
    const unmodified = !ember.bufferModified();
    const before = unmodified ? ember.bufferText(0, ember.bufferSize()) : "";
    try {
      if (ember.regionActive() && ember.mark() !== undefined && ember.mark() !== ember.point()) {
        const [a, b] = [Math.min(ember.point(), ember.mark()!), Math.max(ember.point(), ember.mark()!)];
        fillRegion(a, b, justify);
        return;
      }
      const fn = ember.variable("fill-paragraph-function");
      if (typeof fn === "string") {
        ember.call(fn as ember.CommandName);
        return;
      }
      saveExcursion(() => {
        const here = marker(ember.point());
        ember.gotoChar(bolAt(ember.point()));
        if (forwardParagraph(1) === 0) {
          const end = ember.point();
          forwardParagraph(-1);
          const beg = ember.point();
          ember.gotoChar(at(here));
          fillRegionAsParagraph(beg, end, justify);
        }
        free(here);
      });
    } finally {
      if (unmodified && ember.bufferText(0, ember.bufferSize()) === before) ember.setBufferModified(false);
    }
  },
});

ember.defineCommand({
  name: "fill-region",
  doc: "Fill each paragraph in the region. With a prefix argument, justify as well.",
  run: () => {
    barfIfReadOnly();
    const mark = ember.mark();
    if (mark === undefined) throw new Error("The mark is not set now, so there is no region");
    fillRegion(Math.min(ember.point(), mark), Math.max(ember.point(), mark), justifyArg());
  },
});

ember.defineCommand({
  name: "fill-region-as-paragraph",
  doc: "Fill the region as one paragraph, joining its paragraphs. With a prefix argument, justify as well.",
  run: () => {
    barfIfReadOnly();
    const mark = ember.mark();
    if (mark === undefined) throw new Error("The mark is not set now, so there is no region");
    fillRegionAsParagraph(Math.min(ember.point(), mark), Math.max(ember.point(), mark), justifyArg());
  },
});

ember.defineCommand({
  name: "set-fill-prefix",
  doc: "Make the current line's text before point the fill prefix, which filling puts at the start of each line. At the start of a line, cancel it.",
  run: () => {
    const start = bolAt(ember.point());
    const prefix = ember.point() > start ? ember.bufferText(start, ember.point()) : "";
    ember.setVariable("fill-prefix", prefix === "" ? null : prefix);
    ember.message(prefix === "" ? "fill-prefix canceled" : `fill-prefix: "${prefix}"`);
  },
});

ember.defineCommand({
  name: "set-fill-column",
  doc:
    "Set fill-column, the column filling breaks lines before, as read in the minibuffer. " +
    "Plain C-u sets it to point's column, and C-u with a number to that number.",
  run: () => {
    const set = (n: number) => {
      if (!Number.isInteger(n)) throw new Error("set-fill-column requires an explicit argument");
      ember.message(`Fill column set to ${n} (was ${fillColumn()})`);
      ember.setVariable("fill-column", n);
    };
    const arg = ember.prefixArg();
    if (arg !== null) return set(Array.isArray(arg) ? ember.currentColumn() : arg === "-" ? -1 : arg);
    // As read-number with the current column as its default.
    const column = ember.currentColumn();
    ember.readString(`Change fill-column from ${fillColumn()} to (default ${column}): `, (text) => {
      if (text.trim() === "") return set(column);
      const n = Number(text.trim());
      if (Number.isNaN(n)) throw new Error("Please enter a number.");
      set(n);
    });
  },
});

// --- Auto Fill mode ----------------------------------------------------------

/** Breaks a line at whitespace and starts the next as fill-prefix or the mode says, as default-indent-new-line. */
function defaultIndentNewLine(prefix: string | undefined): void {
  ember.insertAndInherit("\n");
  // The whitespace either side goes.
  saveExcursion(() => {
    ember.gotoChar(ember.point() - 1);
    deleteHorizontalSpace();
  });
  deleteHorizontalSpace();
  if (prefix !== undefined && prefix !== null) ember.insertAndInherit(prefix);
  else ember.call("indent-according-to-mode");
}

function deleteHorizontalSpace(): void {
  let a = ember.point();
  let b = a;
  while (a > 0 && " \t".includes(charBefore(a))) a--;
  while (b < ember.bufferSize() && " \t".includes(charAt(b))) b++;
  if (b > a) ember.deleteRegion(a, b);
}

ember.defineCommand({
  name: "do-auto-fill",
  doc: "Break the line before point at whitespace if it passes fill-column, as many times as it takes. Auto Fill mode runs it as you type a space or newline.",
  run: () => {
    const justify = currentJustification();
    const fc = fillColumn();
    if (justify === undefined || (justify === "left" && ember.currentColumn() <= fc)) return;
    let prefix = ember.variable("fill-prefix") as string | null | undefined;
    if (truthy(ember.variable("adaptive-fill-mode")) && (prefix === null || prefix === undefined || prefix === "")) {
      const from = saveExcursion(() => {
        forwardParagraph(-1);
        return ember.point();
      });
      const to = saveExcursion(() => {
        forwardParagraph(1);
        return ember.point();
      });
      const p = fillContextPrefix(from, to);
      if (p !== undefined && p !== "") prefix = p;
    }
    const pfx = prefix ?? undefined;
    let giveUp = false;
    while (!giveUp && ember.currentColumn() > fc) {
      const fillPoint = saveExcursion(() => {
        ember.gotoChar(bolAt(ember.point()));
        if (pfx !== undefined) ember.moveToColumn(ember.stringWidth(pfx));
        const afterPrefix = ember.point();
        ember.moveToColumn(fc + 1);
        fillMoveToBreakPoint(afterPrefix);
        return ember.point();
      });
      // No use breaking at the start or end of the line.
      const useless = saveExcursion(() => {
        ember.gotoChar(fillPoint);
        if (bolp()) return true;
        skipForward(" ");
        return eolp();
      });
      if (useless) {
        giveUp = true;
        continue;
      }
      const prev = ember.currentColumn();
      const atPoint = saveExcursion(() => {
        skipBackward(" \t");
        return ember.point() === fillPoint;
      });
      if (atPoint) defaultIndentNewLine(pfx);
      else {
        saveExcursion(() => {
          ember.gotoChar(fillPoint);
          defaultIndentNewLine(pfx);
        });
      }
      if (ember.currentColumn() >= prev) giveUp = true;
    }
  },
});

ember.defineMinorMode({
  name: "auto-fill-mode",
  lighter: " Fill",
  doc: "Break lines as you type a space or newline past fill-column, as auto-fill-function says.",
  onChange: (on) => {
    ember.setVariable("auto-fill-function", on ? (ember.variable("normal-auto-fill-function") ?? "do-auto-fill") : null);
  },
});

ember.bindKey("M-q", "fill-paragraph");
ember.bindKey("C-x f", "set-fill-column");
ember.bindKey("C-x .", "set-fill-prefix");
