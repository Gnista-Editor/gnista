// Filling, after Emacs's fill.el, with auto-fill-mode, do-auto-fill and
// set-fill-column from simple.el. M-q fills the paragraph at or after point,
// or the region when it is active, so no line passes fill-column; with a
// prefix argument it also justifies, lining both edges up. A paragraph's
// lines keep the prefix they share, such as "> " or "  - ", as Adaptive Fill
// mode finds it. Auto Fill mode breaks a line as you type a space past
// fill-column. Two spaces after a period end a sentence, as
// sentence-end-double-space says, and filling keeps them.

import { allMatches, escapeRegExp, forwardLine, regexpQuote, truthy } from "subr";

gnista.defineVariable({
  name: "fill-column",
  doc: "The column filling breaks lines before. Each buffer has its own; C-x f sets it.",
  value: 70,
  local: true,
});
gnista.defineVariable({
  name: "fill-prefix",
  doc: "Text filling puts at the start of each line, or nil to work it out from the paragraph when adaptive-fill-mode is on. C-x . sets it.",
  value: null,
  local: true,
});
gnista.defineVariable({
  name: "adaptive-fill-mode",
  doc: "Whether filling takes a paragraph's fill prefix from its text, as its second line starts, or its first if it has one line.",
  value: true,
});
gnista.defineVariable({
  name: "adaptive-fill-regexp",
  doc: "What a fill prefix in a paragraph's text looks like, as a regular expression matched at the start of a line.",
  value: "[-\u2013!|#%;>*\u00b7\u2022\u2023\u2043\u25e6 \t]*",
});
gnista.defineVariable({
  name: "adaptive-fill-first-line-regexp",
  doc: "What the prefix of a paragraph's only line must look like for the lines filling makes to take it too; otherwise they take as many spaces.",
  value: "\\`[ \t]*\\'",
});
gnista.defineVariable({
  name: "sentence-end-double-space",
  doc: "Whether a sentence ends with two spaces after its period, so a period followed by one space is no end of sentence, and filling keeps two.",
  value: true,
});
gnista.defineVariable({
  name: "colon-double-space",
  doc: "Whether filling leaves two spaces after a colon.",
  value: false,
});
gnista.defineVariable({
  name: "default-justification",
  doc: "How filling lines lines up: left, full (both edges), or none.",
  value: "left",
  local: true,
});
gnista.defineVariable({
  name: "normal-auto-fill-function",
  doc: "The command Auto Fill mode puts in auto-fill-function. Some major modes set it.",
  value: "do-auto-fill",
});
gnista.defineVariable({
  name: "fill-paragraph-function",
  doc: "A command M-q runs instead of filling plain text, as major modes such as Org set it, or nil.",
  value: null,
  local: true,
});

const fillColumn = (): number => {
  const v = gnista.variable("fill-column");
  return typeof v === "number" ? v : 70;
};
const charAt = (p: number): string => gnista.charAfter(p) ?? "";
const charBefore = (p: number): string => gnista.charBefore(p) ?? "";
const bolAt = (p: number): number => gnista.lineBeginningPosition(p);
const eolAt = (p: number): number => gnista.lineEndPosition(p);
const bolp = (): boolean => gnista.point() === bolAt(gnista.point());
const eolp = (): boolean => gnista.point() === eolAt(gnista.point());
const eobp = (): boolean => gnista.point() >= gnista.bufferSize();

/** Moves forward over characters in `chars`, not past `limit`, as skip-chars-forward. */
const skipForward = (chars: string, limit?: number): number => gnista.skipCharsForward(chars, limit);
/** Moves back over characters in `chars`, not before `limit`, as skip-chars-backward. Returns how far it went. */
const skipBackward = (chars: string, limit?: number): number => -gnista.skipCharsBackward(chars, limit);
/** Where an Emacs regexp matching at `p`, within its line, ends, as looking-at. */
function lookingAt(regexp: string, p: number): number | undefined {
  const m = gnista.search(regexp, { from: p, regexp: true, bound: eolAt(p), caseFold: false });
  return m !== undefined && m.start === p ? m.end : undefined;
}
const marker = (pos: number, advances = false): gnista.Marker => gnista.makeMarker(pos, { advances });
const at = (m: gnista.Marker): number => gnista.markerPosition(m)!;
const free = (...ms: gnista.Marker[]): void => ms.forEach((m) => gnista.deleteMarker(m));
const saveExcursion = <T>(fn: () => T): T => gnista.saveExcursion(fn);
function barfIfReadOnly(): void {
  if (gnista.bufferReadOnly()) throw new Error(`Buffer is read-only: #<buffer ${gnista.bufferName()}>`);
}

/** How to justify, as current-justification: undefined for none. */
function currentJustification(): string | undefined {
  const j = gnista.variable("default-justification");
  return j === "none" || typeof j !== "string" ? undefined : j;
}

// --- The fill prefix -------------------------------------------------------

/** The adaptive prefix at point, as fill-match-adaptive-prefix: none if as long as the fill column. */
function matchAdaptivePrefix(): string | undefined {
  const re = gnista.variable("adaptive-fill-regexp");
  if (typeof re !== "string") return undefined;
  const end = lookingAt(re, gnista.point());
  if (end === undefined) return undefined;
  const str = gnista.bufferText(gnista.point(), end);
  return str.length >= fillColumn() ? undefined : str;
}

/** The longest start two strings share, as fill-common-string-prefix, or undefined if none. */
function commonPrefix(a: string, b: string): string | undefined {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === 0 ? undefined : a.slice(0, i);
}


/** The fill prefix a paragraph's text suggests, as fill-context-prefix. */
function fillContextPrefix(from: number, to: number): string | undefined {
  return saveExcursion(() => {
    gnista.gotoChar(from);
    if (eolp()) forwardLine(1);
    gnista.gotoChar(bolAt(gnista.point()));
    let first = matchAdaptivePrefix();
    forwardLine(1);
    if (gnista.point() < to) {
      let second = matchAdaptivePrefix();
      if (/^[ \t]*$/.test(gnista.lineText(gnista.lineOf(gnista.point()))) && gnista.point() === bolAt(gnista.point())) {
        second = undefined;
      }
      if (second === undefined) return undefined;
      first ??= "";
      // The second line's prefix if the first has its words in order, as
      // "/* " and " * " do; else what the two share.
      let re = "\\`";
      for (const word of second.match(/[^ \t]+/g) ?? []) re += ".*" + regexpQuote(word);
      return gnista.stringMatch(re, first) !== undefined ? second : commonPrefix(first, second);
    }
    if (first === undefined) return undefined;
    const firstLine = gnista.variable("adaptive-fill-first-line-regexp");
    const result =
      typeof firstLine === "string" && gnista.stringMatch(firstLine, first) !== undefined
        ? first
        : " ".repeat(gnista.stringWidth(first));
    // Not one that would start a paragraph.
    return result.startsWith("\f") ? undefined : result;
  });
}

/** Deletes the fill prefix from each line after the first, as fill-delete-prefix; point goes past the first's. */
function fillDeletePrefix(from: number, to: gnista.Marker, prefix: string | undefined): number {
  const words = prefix !== undefined && !/^[ \t]*$/.test(prefix);
  const fpre = words
    ? new RegExp(`^[ \\t]*(?:${escapeRegExp(prefix!).replace(/[ \t]+/g, "[ \\t]*")})?[ \\t]*`)
    : /^[ \t]*/;
  gnista.gotoChar(from);
  forwardLine(1);
  while (gnista.point() < at(to)) {
    const m = fpre.exec(gnista.lineText(gnista.lineOf(gnista.point())))!;
    if (m[0].length > 0) gnista.deleteRegion(gnista.point(), gnista.point() + m[0].length);
    forwardLine(1);
    if (eobp()) break;
  }
  gnista.gotoChar(from);
  const m = fpre.exec(gnista.bufferText(from, eolAt(from)))!;
  gnista.gotoChar(from + m[0].length);
  return gnista.point();
}

// --- Spaces between words and sentences --------------------------------------

/** A sentence's end, as (sentence-end) with its defaults: its punctuation, then two spaces or the end of a line. */
function sentenceEnd(): string {
  const spacing = truthy(gnista.variable("sentence-end-double-space"))
    ? "(?:$|[ \u00a0]$|\t|[ \u00a0][ \u00a0])"
    : "(?:$|[\t \u00a0])";
  return `(?:[.?!\u2026\u203d][\\]"'\u201d\u2019)}\u00bb\u203a]*${spacing}|[\u3002\uff0e\uff1f\uff01]+)[ \u00a0\t\n]*`;
}

/**
 * Leaves one space between words and two after a sentence or colon, as
 * sentence-end-double-space and colon-double-space say, and turns tabs into
 * spaces, as canonically-space-region.
 */
function canonicallySpaceRegion(beg: number, endMarker: gnista.Marker): void {
  // Tabs become spaces, in place.
  gnista.substCharInRegion(beg, at(endMarker), "\t", " ");
  const text = gnista.bufferText(beg, at(endMarker));
  const double = truthy(gnista.variable("sentence-end-double-space"));
  const colon = truthy(gnista.variable("colon-double-space"));
  const re = new RegExp(`(${sentenceEnd()}) *|  +`, "gmu");
  const before = gnista.bufferText(bolAt(beg), beg);
  const full = before + text;
  const deletions: [number, number][] = [];
  for (const m of allMatches(re, text)) {
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
      // What comes before the spaces, looking past closing brackets, into
      // the line before the region if need be.
      let back = before.length + start;
      while (back > 0 && " ]})\"'".includes(full[back - 1])) back--;
      const prev = back > 0 ? full[back - 1] : "\n";
      const keep = double && ".?!".includes(prev) ? 2 : colon && prev === ":" ? 2 : prev === "\n" ? 0 : 1;
      deletions.push([start + keep, end]);
    }
  }
  // The offsets are UTF-16 units of the text; the buffer counts characters.
  const pos = (i: number): number => beg + [...text.slice(0, i)].length;
  for (const [a, b] of deletions.reverse()) if (b > a) gnista.deleteRegion(pos(a), pos(b));
}

/** Joins a paragraph's lines into one, as fill-delete-newlines: two spaces after a sentence ending a line. */
function fillDeleteNewlines(from: number, to: gnista.Marker, justify: string | undefined): void {
  // A sentence that ends a line gets a second space.
  const end = new RegExp(`[.?!\u2026\u203d][\\]"'\u201d\u2019)}\u00bb\u203a]*$`, "u");
  for (let line = gnista.lineOf(at(to)) - 1; line >= gnista.lineOf(from); line--) {
    const e = gnista.lineEnd(line);
    if (e < at(to) && e >= from && end.test(gnista.bufferText(gnista.lineStart(line), e))) {
      gnista.gotoChar(e);
      gnista.insertAndInherit(" ");
    }
  }
  gnista.gotoChar(from);
  skipForward(" \t");
  const squeezeFrom = gnista.point();
  // Newlines become spaces, in place.
  gnista.substCharInRegion(from, at(to), "\n", " ");
  void justify;
  canonicallySpaceRegion(squeezeFrom, to);
  // No whitespace at the end.
  gnista.gotoChar(at(to));
  const n = skipBackward(" \t");
  if (n > 0) gnista.deleteRegion(gnista.point(), gnista.point() + n);
  gnista.gotoChar(from);
}

// --- Breaking lines --------------------------------------------------------

/** Whether a line must not break at point, as fill-nobreak-p: after a period and one space, or before what would start a paragraph. */
function fillNobreakP(): boolean {
  if (bolp()) return false;
  const p = gnista.point();
  if (truthy(gnista.variable("sentence-end-double-space"))) {
    let q = p;
    while (q > 0 && charBefore(q) === " ") q--;
    if (charBefore(q) === "." && charAt(q) === " " && q + 1 < gnista.bufferSize() && !" \n".includes(charAt(q + 1))) {
      return true;
    }
  }
  let q = p;
  while (q < gnista.bufferSize() && " \t".includes(charAt(q))) q++;
  return q < gnista.bufferSize() && charAt(q) !== "\n" && charAt(q) === "\f";
}

/** Moves back to where the line should break, after `linebeg`, as fill-move-to-break-point. */
function fillMoveToBreakPoint(linebeg: number): void {
  if (linebeg > gnista.point()) gnista.gotoChar(linebeg);
  for (;;) {
    let p = gnista.point() - 1;
    while (p >= linebeg && !" \t".includes(charAt(p))) p--;
    if (p < linebeg) {
      gnista.gotoChar(linebeg);
      break;
    }
    gnista.gotoChar(p + 1);
    if (!fillNobreakP()) break;
    skipBackward(" \t", linebeg);
  }
  skipBackward(" \t");
  if (linebeg >= gnista.point()) {
    // Keep at least one word on the line.
    const to = eolAt(linebeg);
    let first = true;
    gnista.gotoChar(linebeg);
    while (gnista.point() < to && (first || fillNobreakP())) {
      skipForward(" \t");
      let q = gnista.point();
      while (q < gnista.bufferSize() && !" \n\t".includes(charAt(q))) q++;
      gnista.gotoChar(q);
      first = false;
    }
  }
}

/** Indents the current line to the left margin, column 0, as fill-indent-to-left-margin. */
function indentToLeftMargin(): void {
  const start = bolAt(gnista.point());
  const ws = /^[ \t]*/.exec(gnista.lineText(gnista.lineOf(start)))![0].length;
  if (ws > 0) gnista.deleteRegion(start, start + ws);
  gnista.gotoChar(start);
}

/** Breaks the line at point and starts the next with the fill prefix, as fill-newline. */
function fillNewline(prefix: string | undefined): void {
  skipBackward(" \t");
  gnista.insert("\n");
  indentToLeftMargin();
  if (prefix !== undefined && prefix !== "") gnista.insertBeforeMarkers(prefix);
}

/** Spreads the spaces of the line at point so it ends at the fill column, as justify-current-line does for full. */
function justifyCurrentLine(how: string | undefined, eop: boolean, prefix: string | undefined): void {
  if (how !== "full") return;
  saveExcursion(() => {
    const fc = fillColumn();
    gnista.gotoChar(eolAt(gnista.point()));
    skipBackward(" \t");
    if (bolp() || gnista.currentColumn() === fc) return;
    const end = gnista.point();
    gnista.gotoChar(bolAt(end));
    skipForward(" \t");
    if (prefix !== undefined && prefix !== "" && gnista.bufferText(gnista.point(), gnista.point() + prefix.length) === prefix) {
      gnista.gotoChar(gnista.point() + prefix.length);
    } else if (truthy(gnista.variable("adaptive-fill-mode"))) {
      const re = gnista.variable("adaptive-fill-regexp");
      const e = typeof re === "string" ? lookingAt(re, gnista.point()) : undefined;
      if (e !== undefined) gnista.gotoChar(e);
    }
    skipForward(" \t");
    const beg = gnista.point();
    gnista.gotoChar(end);
    const ncols = fc - gnista.currentColumn();
    const text = gnista.bufferText(beg, end);
    // In characters, as the buffer counts them, not UTF-16 units.
    const gaps = allMatches(/ +/g, text).map((m) => beg + [...text.slice(0, m.index! + m[0].length)].length);
    const nspaces = gaps.length;
    if (ncols <= 0 || nspaces === 0 || eop) return;
    let frac = ncols + Math.floor(nspaces / 2);
    const extra: number[] = [];
    for (let i = 0; i < nspaces; i++) {
      extra.push(Math.floor(frac / nspaces));
      frac = (frac % nspaces) + ncols;
    }
    for (let i = nspaces - 1; i >= 0; i--) {
      gnista.gotoChar(gaps[i]);
      gnista.insertAndInherit(" ".repeat(extra[i]));
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
  gnista.gotoChar(Math.min(fromIn, toIn));
  const toPos = Math.max(fromIn, toIn);
  skipForward(" \t\n");
  const fromPlusIndent = gnista.point();
  const from = Math.max(bolAt(gnista.point()), Math.min(fromIn, toIn));
  // All but one newline at the end go.
  gnista.gotoChar(toPos);
  let oneleft = false;
  while (gnista.point() > from && charBefore(gnista.point()) === "\n") {
    if (oneleft) gnista.deleteRegion(gnista.point() - 1, gnista.point());
    else {
      gnista.gotoChar(gnista.point() - 1);
      oneleft = true;
    }
  }
  const to = marker(gnista.point(), true);
  gnista.gotoChar(fromPlusIndent);
  try {
    if (!(at(to) > gnista.point())) return undefined;
    justify ??= currentJustification();
    const fp = gnista.variable("fill-prefix");
    let prefix = typeof fp === "string" ? fp : undefined;
    if (truthy(gnista.variable("adaptive-fill-mode")) && (prefix === undefined || prefix === null || prefix === "")) {
      prefix = fillContextPrefix(from, at(to));
    }
    if (justify === undefined) return prefix;
    const start = fillDeletePrefix(from, to, prefix);
    fillDeleteNewlines(start, to, justify);
    gnista.gotoChar(start);
    while (gnista.point() < at(to)) {
      const linebeg = gnista.point();
      gnista.moveToColumn(fillColumn());
      let cut = false;
      if (gnista.point() < at(to)) {
        gnista.gotoChar(gnista.point() + 1);
        fillMoveToBreakPoint(linebeg);
        skipForward(" \t");
        cut = gnista.point() < at(to);
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
        gnista.gotoChar(at(to));
        justifyCurrentLine(justify, true, prefix);
        break;
      }
    }
    gnista.gotoChar(at(to));
    if (!eobp()) gnista.gotoChar(gnista.point() + 1);
    return prefix;
  } finally {
    free(to);
  }
}

/** Moves over paragraphs, as forward-paragraph, and says how many it could not. */
function forwardParagraph(n: number): number {
  if (n > 0) {
    // forward-paragraph finds none if only blank lines follow.
    let p = bolAt(gnista.point());
    while (p < gnista.bufferSize() && /^[ \t\f]*$/.test(gnista.lineText(gnista.lineOf(p)))) {
      const next = gnista.lineOf(p) + 1;
      p = next < gnista.lineCount() ? gnista.lineStart(next) : gnista.bufferSize();
    }
    if (p >= gnista.bufferSize()) {
      gnista.gotoChar(gnista.bufferSize());
      return n;
    }
  }
  gnista.callWithPrefix(n, "forward-paragraph");
  return 0;
}

/** Fills each paragraph from `from` to `to`, as fill-region, and returns the last fill prefix. */
function fillRegion(from: number, to: number, justify?: string): string | undefined {
  const start = marker(gnista.point());
  const max = marker(Math.max(from, to), true);
  const beg = Math.min(from, to);
  let prefix: string | undefined;
  gnista.gotoChar(bolAt(beg));
  while (gnista.point() < at(max)) {
    const initial = gnista.point();
    forwardParagraph(1);
    const end = Math.min(at(max), gnista.point());
    forwardParagraph(-1);
    if (gnista.point() < beg) gnista.gotoChar(beg);
    if (gnista.point() >= initial && gnista.point() < end) prefix = fillRegionAsParagraph(gnista.point(), end, justify);
    else gnista.gotoChar(end);
    if (gnista.point() <= initial) break;
  }
  gnista.gotoChar(at(start));
  free(start, max);
  return prefix;
}

const justifyArg = (): string | undefined => (gnista.prefixArg() !== null ? "full" : undefined);

gnista.defineCommand({
  name: "fill-paragraph",
  doc:
    "Fill the paragraph at or after point, breaking lines so none passes fill-column, or each paragraph in the region if it is active.\n\n" +
    "With a prefix argument, justify as well, so the lines end at fill-column too. The lines keep the prefix the paragraph's lines share, as adaptive-fill-mode finds it.",
  run: () => {
    barfIfReadOnly();
    const justify = justifyArg();
    const unmodified = !gnista.bufferModified();
    const before = unmodified ? gnista.bufferText(0, gnista.bufferSize()) : "";
    try {
      if (gnista.regionActive() && gnista.mark() !== undefined && gnista.mark() !== gnista.point()) {
        const [a, b] = [Math.min(gnista.point(), gnista.mark()!), Math.max(gnista.point(), gnista.mark()!)];
        fillRegion(a, b, justify);
        return;
      }
      const fn = gnista.variable("fill-paragraph-function");
      if (typeof fn === "string") {
        gnista.callWithPrefix(gnista.prefixArg(), fn as gnista.CommandName);
        return;
      }
      saveExcursion(() => {
        const here = marker(gnista.point());
        gnista.gotoChar(bolAt(gnista.point()));
        if (forwardParagraph(1) === 0) {
          const end = gnista.point();
          forwardParagraph(-1);
          const beg = gnista.point();
          gnista.gotoChar(at(here));
          fillRegionAsParagraph(beg, end, justify);
        }
        free(here);
      });
    } finally {
      if (unmodified && gnista.bufferText(0, gnista.bufferSize()) === before) gnista.setBufferModified(false);
    }
  },
});

gnista.defineCommand({
  name: "fill-region",
  doc: "Fill each paragraph in the region. With a prefix argument, justify as well.",
  run: () => {
    barfIfReadOnly();
    const mark = gnista.mark();
    if (mark === undefined) gnista.userError("The mark is not set now, so there is no region");
    fillRegion(Math.min(gnista.point(), mark), Math.max(gnista.point(), mark), justifyArg());
  },
});

gnista.defineCommand({
  name: "fill-region-as-paragraph",
  doc: "Fill the region as one paragraph, joining its paragraphs. With a prefix argument, justify as well.",
  run: () => {
    barfIfReadOnly();
    const mark = gnista.mark();
    if (mark === undefined) gnista.userError("The mark is not set now, so there is no region");
    fillRegionAsParagraph(Math.min(gnista.point(), mark), Math.max(gnista.point(), mark), justifyArg());
  },
});

gnista.defineCommand({
  name: "set-fill-prefix",
  doc: "Make the current line's text before point the fill prefix, which filling puts at the start of each line. At the start of a line, cancel it.",
  run: () => {
    const start = bolAt(gnista.point());
    const prefix = gnista.point() > start ? gnista.bufferText(start, gnista.point()) : "";
    gnista.setVariable("fill-prefix", prefix === "" ? null : prefix);
    gnista.message(prefix === "" ? "fill-prefix canceled" : `fill-prefix: "${prefix}"`);
  },
});

gnista.defineCommand({
  name: "set-fill-column",
  doc:
    "Set fill-column, the column filling breaks lines before, as read in the minibuffer. " +
    "Plain C-u sets it to point's column, and C-u with a number to that number.",
  run: () => {
    const set = (n: number) => {
      if (!Number.isInteger(n)) throw new Error("set-fill-column requires an explicit argument");
      gnista.message(`Fill column set to ${n} (was ${fillColumn()})`);
      gnista.setVariable("fill-column", n);
    };
    const arg = gnista.prefixArg();
    // As set-fill-column: C-u for point's column, a number, and nothing else.
    if (arg !== null) return set(Array.isArray(arg) ? gnista.currentColumn() : arg === "-" ? NaN : arg);
    // As read-number with the current column as its default.
    const column = gnista.currentColumn();
    const text = gnista.readString(`Change fill-column from ${fillColumn()} to (default ${column}): `).trim();
    if (text === "") return set(column);
    const n = Number(text);
    if (Number.isNaN(n)) throw new Error("Please enter a number.");
    set(n);
  },
});

// --- Auto Fill mode ----------------------------------------------------------

/** Breaks a line at whitespace and starts the next as fill-prefix or the mode says, as default-indent-new-line. */
function defaultIndentNewLine(prefix: string | undefined): void {
  // In a comment, the new line continues it, as comment-line-break-function does.
  if (typeof gnista.variable("comment-start") === "string" && gnista.syntaxPpss().inComment !== null) {
    gnista.call("comment-indent-new-line");
    return;
  }
  gnista.insertAndInherit("\n");
  // The whitespace either side goes.
  saveExcursion(() => {
    gnista.gotoChar(gnista.point() - 1);
    deleteHorizontalSpace();
  });
  deleteHorizontalSpace();
  if (prefix !== undefined && prefix !== null) gnista.insertAndInherit(prefix);
  else gnista.call("indent-according-to-mode");
}

function deleteHorizontalSpace(): void {
  let a = gnista.point();
  let b = a;
  while (a > 0 && " \t".includes(charBefore(a))) a--;
  while (b < gnista.bufferSize() && " \t".includes(charAt(b))) b++;
  if (b > a) gnista.deleteRegion(a, b);
}

gnista.defineCommand({
  name: "do-auto-fill",
  doc: "Break the line before point at whitespace if it passes fill-column, as many times as it takes. Auto Fill mode runs it as you type a space or newline.",
  run: () => {
    const justify = currentJustification();
    const fc = fillColumn();
    if (justify === undefined || (justify === "left" && gnista.currentColumn() <= fc)) return;
    let prefix = gnista.variable("fill-prefix") as string | null | undefined;
    if (truthy(gnista.variable("adaptive-fill-mode")) && (prefix === null || prefix === undefined || prefix === "")) {
      const from = saveExcursion(() => {
        forwardParagraph(-1);
        return gnista.point();
      });
      const to = saveExcursion(() => {
        forwardParagraph(1);
        return gnista.point();
      });
      const p = fillContextPrefix(from, to);
      if (p !== undefined && p !== "") prefix = p;
    }
    const pfx = prefix ?? undefined;
    let giveUp = false;
    while (!giveUp && gnista.currentColumn() > fc) {
      const fillPoint = saveExcursion(() => {
        gnista.gotoChar(bolAt(gnista.point()));
        if (pfx !== undefined) gnista.moveToColumn(gnista.stringWidth(pfx));
        const afterPrefix = gnista.point();
        gnista.moveToColumn(fc + 1);
        fillMoveToBreakPoint(afterPrefix);
        return gnista.point();
      });
      // No use breaking at the start or end of the line.
      const useless = saveExcursion(() => {
        gnista.gotoChar(fillPoint);
        if (bolp()) return true;
        skipForward(" ");
        return eolp();
      });
      if (useless) {
        giveUp = true;
        continue;
      }
      const prev = gnista.currentColumn();
      const atPoint = saveExcursion(() => {
        skipBackward(" \t");
        return gnista.point() === fillPoint;
      });
      if (atPoint) defaultIndentNewLine(pfx);
      else {
        saveExcursion(() => {
          gnista.gotoChar(fillPoint);
          defaultIndentNewLine(pfx);
        });
      }
      if (gnista.currentColumn() >= prev) giveUp = true;
    }
  },
});

gnista.defineMinorMode({
  name: "auto-fill-mode",
  lighter: " Fill",
  doc: "Break lines as you type a space or newline past fill-column, as auto-fill-function says.",
  onChange: (on) => {
    gnista.setVariable("auto-fill-function", on ? (gnista.variable("normal-auto-fill-function") ?? "do-auto-fill") : null);
  },
});

gnista.bindKey("M-q", "fill-paragraph");
gnista.bindKey("C-x f", "set-fill-column");
gnista.bindKey("C-x .", "set-fill-prefix");
