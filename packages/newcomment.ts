// Comments, after Emacs's newcomment.el: M-; (comment-dwim) comments or
// uncomments the region, or adds a comment at the end of the line, or one
// on a blank line; C-x C-; (comment-line) comments whole lines; M-j breaks
// a comment onto a new line that continues it; C-x ; sets the column
// comments go to. Each major mode says what its comments look like with
// comment-start and comment-end, and its syntax table finds them.

import { escapeRegExp, numberValue as num, truthy } from "subr";

const defvar = (name: string, value: gnista.Value, doc: string, local = false) => gnista.defineVariable({ name, value, doc, local });
defvar("comment-start", null, "What starts a comment in this mode, with the space after it: \"// \" or \"# \". nil if the mode has no comments.", true);
defvar("comment-end", "", "What ends a comment, with the space before it: \" */\", or \"\" when comments end with the line.", true);
defvar("comment-start-skip", null, "A regexp matching a comment's start and the space after it.", true);
defvar("comment-column", 32, "The column comments at the end of a line go to. C-x ; sets it.", true);
defvar("comment-padding", " ", "What goes between a comment's start and its text.");
defvar("comment-add", 0, "How many more comment starts comment-region and M-; on a blank line add, as Lisp's ;; for comments of their own.", true);
defvar("comment-empty-lines", false, "Whether comment-region comments blank lines too.");
defvar("comment-inline-offset", 1, "The least space between code and the comment after it.");

const str = (name: string): string | undefined => {
  const v = gnista.variable(name);
  return typeof v === "string" ? v : undefined;
};
const charAt = (p: number): string => gnista.charAfter(p) ?? "";
const bol = (p = gnista.point()): number => gnista.lineBeginningPosition(p);
const eol = (p = gnista.point()): number => gnista.lineEndPosition(p);
const indentation = (line: number): number => gnista.currentIndentation(gnista.lineStart(line));
const blank = (line: number): boolean => /^[ \t]*$/.test(gnista.lineText(line));

/** Comment syntax, as comment-normalize-vars checks it is there. */
function commentStart(): string {
  const cs = str("comment-start");
  if (cs === undefined) throw new Error("No comment syntax defined");
  return cs;
}
const commentEnd = (): string => str("comment-end") ?? "";
const trim = (s: string): string => s.trim();

/** comment-start with comment-padding after it and `n` more of its last character, as comment-padright. */
function padRight(s: string, n = 0): string {
  const core = trim(s);
  if (core === "") return s;
  const lpad = /^\s*/.exec(s)![0];
  const existing = s.length - lpad.length - core.length;
  const padding = str("comment-padding") ?? " ";
  const rpad = s.slice(lpad.length + core.length) + padding.slice(Math.min(existing, padding.length));
  return lpad + core + core[core.length - 1].repeat(n) + rpad;
}

/** comment-end with comment-padding before it, as comment-padleft. */
function padLeft(s: string): string {
  const core = s.replace(/^\s+/, "");
  if (core === "") return "";
  const lead = s.length - core.length;
  const padding = str("comment-padding") ?? " ";
  return padding.slice(Math.min(lead, padding.length)) + s.slice(0, lead) + core;
}

/** Whether a comment starts at `p`, as the syntax table says, and how long its starter is. */
function commentStartAt(p: number): number | undefined {
  const c = charAt(p);
  if (c === "") return undefined;
  const d = gnista.syntaxEntry(c) ?? "";
  const flags = d.slice(2);
  if (d[0] === "<" || d[0] === "!") return 1;
  if (flags.includes("1")) {
    const next = gnista.syntaxEntry(charAt(p + 1)) ?? "";
    if (next.slice(2).includes("2")) return 2;
  }
  // Modes without comment syntax in their table, by comment-start itself.
  const cs = trim(str("comment-start") ?? "");
  if (cs !== "" && gnista.bufferText(p, p + cs.length) === cs && !hasCommentSyntax()) return cs.length;
  return undefined;
}

/** Whether the syntax table knows the mode's comments, as comment-use-syntax. */
function hasCommentSyntax(): boolean {
  const cs = trim(str("comment-start") ?? "");
  if (cs === "") return false;
  const d = gnista.syntaxEntry(cs[0]) ?? "";
  return d[0] === "<" || d[0] === "!" || d.slice(2).includes("1");
}

/**
 * Finds the next comment's start from `from` before `limit`, not in a
 * string, as comment-search-forward: returns where it starts, leaving
 * point after its starter and the space after.
 */
function commentSearchForward(from: number, limit: number): number | undefined {
  for (let p = from; p < limit; p++) {
    const len = commentStartAt(p);
    if (len === undefined) continue;
    const st = gnista.syntaxPpss(p);
    if (st.inString !== null) continue;
    if (st.inComment !== null) {
      // Already in a comment: its start.
      const start = st.start!;
      if (start < from) continue;
      return skipStarter(start, commentStartAt(start) ?? len);
    }
    return skipStarter(p, len);
  }
  return undefined;
}

/** Puts point after a comment's starter, its repeats and the space after, as matching comment-start-skip leaves it. */
function skipStarter(start: number, len: number): number {
  const starter = gnista.bufferText(start, start + len);
  let q = start + len;
  // Repeats of the starter's last character, as ;; or ///.
  while (charAt(q) === starter[starter.length - 1] && len === 1) q++;
  while (charAt(q) === " " || charAt(q) === "\t") q++;
  gnista.gotoChar(q);
  return start;
}

/** Where the comment on point's line starts, if it has one. */
function commentOnLine(line: number): number | undefined {
  const p = gnista.point();
  const found = commentSearchForward(gnista.lineStart(line), gnista.lineEnd(line));
  gnista.gotoChar(p);
  return found;
}

/** Whether the text from `beg` to `end` is only comments and whitespace, as comment-only-p. */
function commentOnly(beg: number, end: number): boolean {
  for (let line = gnista.lineOf(beg); line <= gnista.lineOf(Math.max(beg, end - 1)); line++) {
    if (blank(line)) continue;
    const start = gnista.lineStart(line) + /^[ \t]*/.exec(gnista.lineText(line))![0].length;
    if (commentOnLine(line) !== start) return false;
  }
  return true;
}

/** The lines a region covers: from its start's line to its end's, leaving out a line the end is at the start of. */
function regionLines(beg: number, end: number): [number, number] {
  const first = gnista.lineOf(beg);
  let last = gnista.lineOf(end);
  if (end > beg && end === gnista.lineStart(last) && last > first) last--;
  return [first, last];
}

/** Comments each line of the region at its least indentation, as comment-region with the indent style. */
function commentRegion(begIn: number, endIn: number, arg: number): void {
  if (arg < 0) return uncommentRegion(begIn, endIn, -arg);
  // The region without the blank lines around it, as comment-region-default-1 sanitizes it.
  let b = begIn;
  while (b < gnista.bufferSize() && " \t\n\r".includes(charAt(b))) b++;
  const beg = Math.max(begIn, bol(b));
  let e = endIn;
  while (e > 0 && " \t\n\r".includes(charAt(e - 1))) e--;
  const end = Math.min(endIn, eol(e));
  if (beg >= end) throw new Error("Nothing to comment");
  // Comments that end with the line end the region's last line there.
  if (commentEnd() === "" && end !== eol(end)) {
    const p = gnista.makeMarker();
    gnista.gotoChar(end);
    gnista.insert("\n");
    gnista.call("indent-according-to-mode");
    gnista.gotoChar(gnista.markerPosition(p)!);
    gnista.deleteMarker(p);
  }
  const add = num("comment-add", 0) + arg - 1;
  const cs = padRight(commentStart(), add);
  const ceRaw = commentEnd();
  const ce = ceRaw === "" ? "" : padLeft(ceRaw);
  const [first, last] = regionLines(beg, end);
  const empty = truthy(gnista.variable("comment-empty-lines"));
  let min = Infinity;
  for (let l = first; l <= last; l++) if (empty || !blank(l)) min = Math.min(min, blank(l) ? Infinity : indentation(l));
  if (min === Infinity) min = 0;
  const p = gnista.makeMarker();
  for (let l = last; l >= first; l--) {
    if (!empty && blank(l)) continue;
    gnista.gotoChar(gnista.lineStart(l));
    gnista.moveToColumn(min);
    if (gnista.currentColumn() < min) gnista.insert(" ".repeat(min - gnista.currentColumn()));
    // Trailing whitespace makes no comment of its own.
    const content = gnista.lineText(l).replace(/[ \t]+$/, "");
    gnista.insert(content.trim() === "" ? cs.replace(/\s+$/, "") : cs);
    if (ce !== "") {
      gnista.gotoChar(gnista.lineEnd(l));
      gnista.insert(ce);
    }
  }
  gnista.gotoChar(gnista.markerPosition(p)!);
  gnista.deleteMarker(p);
}

/** Takes the comment starts and ends out of the region, as uncomment-region: all of them, or `arg` levels. */
function uncommentRegion(beg: number, end: number, arg?: number): void {
  const cs = trim(commentStart());
  const ce = trim(commentEnd());
  const [first, last] = regionLines(beg, end);
  const padding = str("comment-padding") ?? " ";
  const p = gnista.makeMarker();
  let found = false;
  for (let l = last; l >= first; l--) {
    const start = commentOnLine(l);
    if (start === undefined) continue;
    found = true;
    // The starter, its last character repeated as it may be, as
    // (comment-padright comment-start 're) matches it; with `arg`, that
    // many levels only.
    let q = start + (gnista.bufferText(start, start + cs.length) === cs ? cs.length : (commentStartAt(start) ?? 0));
    const last = cs[cs.length - 1];
    let extra = arg === undefined ? Infinity : arg - 1;
    while (extra > 0 && charAt(q) === last) {
      q++;
      extra--;
    }
    if (gnista.bufferText(q, q + padding.length) === padding) q += padding.length;
    if (ce !== "") {
      const lineEnd = gnista.lineEnd(l);
      const text = gnista.bufferText(q, lineEnd);
      const m = new RegExp(`[ \\t]*${escapeRegExp(ce)}[ \\t]*$`).exec(text);
      if (m !== null) gnista.deleteRegion(q + m.index, lineEnd);
    }
    gnista.deleteRegion(start, q);
  }
  gnista.gotoChar(gnista.markerPosition(p)!);
  gnista.deleteMarker(p);
  if (!found) throw new Error("Can't find any comment");
}

function commentOrUncommentRegion(beg: number, end: number, arg: gnista.PrefixArg): void {
  if (commentOnly(beg, end)) uncommentRegion(beg, end, arg === null ? undefined : gnista.prefixNumericValue(arg));
  else commentRegion(beg, end, arg === null ? 1 : gnista.prefixNumericValue(arg));
}

/** The column for the comment at point, as comment-choose-indent: near comment-column, within the fill column, as the comments around align. */
function chooseIndent(indent: number): number {
  const fill = num("fill-column", 70);
  let max = gnista.currentColumn() + (fill - columnAt(eol()));
  let q = gnista.point();
  while (q > bol() && " \t".includes(charAt(q - 1))) q--;
  let min = q === bol() ? 0 : num("comment-inline-offset", 1) + columnAt(q);
  if (max < min) max = min;
  let target = indent;
  if (max <= target) target = max;
  // As the comment on the line before is aligned, if that fits.
  const line = gnista.lineOf(gnista.point());
  if (line > 0) {
    const other = commentOnLine(line - 1);
    if (other !== undefined) {
      const col = columnAt(other);
      if (col <= max && col >= min) return col;
    }
  }
  // Or those after.
  for (let l = line + 1; l < gnista.lineCount(); l++) {
    const other = commentOnLine(l);
    if (other === undefined) break;
    const omax = columnAt(other) + (fill - columnAt(gnista.lineEnd(l)));
    let o = other;
    while (o > gnista.lineStart(l) && " \t".includes(charAt(o - 1))) o--;
    const omin = columnAt(o) + 1;
    if (omax >= min && omin <= max) {
      min = Math.max(omin, min);
      max = Math.min(omax, max);
    } else break;
  }
  return Math.max(min, Math.min(max, target));
}

const columnAt = (p: number): number =>
  gnista.saveExcursion(() => {
    gnista.gotoChar(p);
    return gnista.currentColumn();
  });

/** Puts a comment at the end of the line, or indents the one there, as comment-indent. */
function commentIndent(): void {
  const starter = commentStart();
  const ender = commentEnd();
  gnista.gotoChar(bol());
  let begpos = commentSearchForward(gnista.point(), eol());
  let cpos: gnista.Marker;
  if (begpos !== undefined) {
    cpos = gnista.makeMarker();
  } else {
    gnista.gotoChar(eol());
    const p = gnista.point();
    gnista.indentTo(num("comment-column", 32));
    // A space before it, as sh needs and is neater.
    if (gnista.point() > 0 && !["\n", "\t", " "].includes(charAt(gnista.point() - 1))) gnista.insert(" ");
    void p;
    begpos = gnista.point();
    gnista.insert(starter);
    cpos = gnista.makeMarker();
    gnista.insert(ender);
  }
  gnista.gotoChar(begpos);
  // As comment-indent-default: comment-column for a comment after code, or the code's indentation for one alone on its line.
  const alone = gnista.currentColumn() === indentation(gnista.lineOf(begpos));
  const starts = commentStartAt(begpos) ?? 1;
  const doubled = starts === 1 && charAt(begpos + 1) === charAt(begpos);
  const tripled = doubled && charAt(begpos + 2) === charAt(begpos);
  if (doubled && (tripled || !alone)) {
    reindent(chooseIndent(0));
  } else if (!alone) {
    reindent(chooseIndent(num("comment-column", 32)));
  } else if (starts === 1 && !doubled && num("comment-add", 0) > 0) {
    // A comment alone of one starter, where comment-region doubles them, goes to comment-column.
    reindent(num("comment-column", 32));
  } else {
    gnista.call("indent-according-to-mode");
  }
  gnista.gotoChar(gnista.markerPosition(cpos)!);
  gnista.deleteMarker(cpos);
}

/** Moves the comment at point to `column`, replacing the whitespace before it. */
function reindent(column: number): void {
  if (gnista.currentColumn() === column) return;
  let q = gnista.point();
  while (q > bol() && " \t".includes(charAt(q - 1))) q--;
  gnista.deleteRegion(q, gnista.point());
  gnista.gotoChar(q);
  gnista.indentTo(column);
}

/** Kills the comment on the line, and the whitespace before it, as comment-kill. */
function commentKill(count: number): void {
  for (let i = 0; i < Math.max(count, 1); i++) {
    const line = gnista.lineOf(gnista.point());
    const start = commentOnLine(line);
    if (start !== undefined) {
      let q = start;
      while (q > gnista.lineStart(line) && " \t".includes(charAt(q - 1))) q--;
      gnista.killRegion(q, gnista.lineEnd(line));
      gnista.call("indent-according-to-mode");
    }
    if (count > 1 && line + 1 < gnista.lineCount()) gnista.gotoChar(gnista.lineStart(line + 1));
  }
}

const regionUsed = (): boolean => gnista.regionActive() && gnista.mark() !== undefined && gnista.mark() !== gnista.point();
const region = (): [number, number] => [Math.min(gnista.point(), gnista.mark()!), Math.max(gnista.point(), gnista.mark()!)];
const barf = (): void => {
  if (gnista.bufferReadOnly()) throw new Error(`Buffer is read-only: #<buffer ${gnista.bufferName()}>`);
};

gnista.defineCommand({
  name: "comment-dwim",
  doc:
    "Comment or uncomment the region if it is active. Otherwise put a comment at the end of the line, or indent the one there, " +
    "or start one on a blank line. With a prefix argument and no region, kill the line's comment.",
  run: () => {
    barf();
    commentStart();
    const arg = gnista.prefixArg();
    if (regionUsed()) return commentOrUncommentRegion(...region(), arg);
    if (!blank(gnista.lineOf(gnista.point()))) {
      if (arg !== null) commentKill(typeof arg === "number" ? arg : 1);
      else commentIndent();
      return;
    }
    const add = num("comment-add", 0) + (arg === null ? 0 : gnista.prefixNumericValue(arg) - 1);
    gnista.call("indent-according-to-mode");
    gnista.insert(padRight(commentStart(), add));
    const ce = commentEnd();
    if (ce !== "") {
      const p = gnista.makeMarker();
      gnista.insert(padLeft(ce));
      gnista.gotoChar(gnista.markerPosition(p)!);
      gnista.deleteMarker(p);
    }
  },
});

gnista.defineCommand({
  name: "comment-region",
  doc: "Comment out each line of the region. With a prefix argument N, use N comment starts; negative, uncomment instead.",
  run: () => {
    barf();
    if (gnista.mark() === undefined) gnista.userError("The mark is not set now, so there is no region");
    commentRegion(...region(), gnista.prefixNumericValue(gnista.prefixArg()));
  },
});

gnista.defineCommand({
  name: "uncomment-region",
  doc: "Take the comment starts and ends out of the region's lines. With a prefix argument, take out that many levels.",
  run: () => {
    barf();
    commentStart();
    if (gnista.mark() === undefined) gnista.userError("The mark is not set now, so there is no region");
    const arg = gnista.prefixArg();
    uncommentRegion(...region(), arg === null ? undefined : gnista.prefixNumericValue(arg));
  },
});

gnista.defineCommand({
  name: "comment-or-uncomment-region",
  doc: "Uncomment the region's lines if they are all comments, else comment them.",
  run: () => {
    barf();
    commentStart();
    if (gnista.mark() === undefined) gnista.userError("The mark is not set now, so there is no region");
    commentOrUncommentRegion(...region(), gnista.prefixArg());
  },
});

gnista.defineCommand({
  name: "comment-line",
  doc:
    "Comment or uncomment the current line, or the region's lines, and move to the next line. " +
    "With a prefix argument N, the N lines from this one; negative, the lines above.",
  run: () => {
    barf();
    commentStart();
    if (regionUsed()) {
      const [a, b] = region();
      return commentOrUncommentRegion(bol(a), eol(b), null);
    }
    let n = gnista.prefixNumericValue(gnista.prefixArg());
    if (gnista.lastCommand() === "comment-line-backward" && n >= 0) n = -n;
    const start = bol();
    const target = gnista.lineOf(gnista.point()) + n - 1;
    const end = target < 0 ? 0 : target >= gnista.lineCount() ? gnista.bufferSize() : gnista.lineEnd(target);
    gnista.gotoChar(end);
    commentOrUncommentRegion(Math.min(start, end), Math.max(start, end), null);
    const next = gnista.lineOf(gnista.point()) + 1;
    gnista.gotoChar(next < gnista.lineCount() ? gnista.lineStart(next) : gnista.bufferSize());
    gnista.gotoChar(gnista.point() + /^[ \t]*/.exec(gnista.lineText(gnista.lineOf(gnista.point())))![0].length);
    if (n < 0) gnista.setThisCommand("comment-line-backward" as gnista.CommandName);
  },
});

gnista.defineCommand({
  name: "comment-line-backward",
  doc: "What comment-line becomes when it goes backward, so typing it again goes on backward.",
  run: () => gnista.call("comment-line"),
});

gnista.defineCommand({
  name: "comment-indent",
  doc: "Put a comment at the end of the line at comment-column, or indent the comment there to it.",
  run: () => {
    barf();
    commentIndent();
  },
});

gnista.defineCommand({
  name: "comment-kill",
  doc: "Kill the comment on this line. With a prefix argument, on that many lines.",
  run: () => {
    barf();
    commentKill(gnista.prefixNumericValue(gnista.prefixArg()));
  },
});

gnista.defineCommand({
  name: "comment-set-column",
  doc: "Set comment-column to point's column. With C-u, to that of the comment on the line before; with a negative argument, kill the comment.",
  run: () => {
    const arg = gnista.prefixArg();
    if (arg === "-" || (typeof arg === "number" && arg < 0)) return commentKill(1);
    if (Array.isArray(arg)) {
      const line = gnista.lineOf(gnista.point());
      for (let l = line - 1; l >= 0; l--) {
        const c = commentOnLine(l);
        if (c !== undefined) {
          const col = columnAt(c);
          gnista.setVariable("comment-column", col);
          gnista.message(`Comment column set to ${col}`);
          return;
        }
      }
      return;
    }
    gnista.setVariable("comment-column", gnista.currentColumn());
    gnista.message(`Comment column set to ${gnista.currentColumn()}`);
  },
});

gnista.defineCommand({
  name: "comment-indent-new-line",
  doc: "Break the line, continuing the comment point is in on the new one, as M-j does; outside a comment, a newline that indents.",
  run: () => {
    barf();
    const st = gnista.syntaxPpss();
    const cs = str("comment-start");
    if (st.inComment === null || cs === undefined) {
      gnista.call("default-indent-new-line" as gnista.CommandName);
      return;
    }
    const start = st.start!;
    // The starter as written on this line: its characters, the last one's
    // repeats, as ;; or ///, and the padding after, as comment-start-skip matches.
    let q = start + (commentStartAt(start) ?? 1);
    while (q < gnista.point() && charAt(q) === charAt(q - 1)) q++;
    let pad = q;
    while (pad < gnista.point() && " \t".includes(charAt(pad))) pad++;
    const starter = gnista.bufferText(start, pad);
    const column = columnAt(start);
    // The whitespace either side goes.
    let a = gnista.point();
    let b = a;
    while (a > 0 && " \t".includes(charAt(a - 1))) a--;
    while (b < gnista.bufferSize() && " \t".includes(charAt(b))) b++;
    gnista.deleteRegion(a, b);
    gnista.gotoChar(a);
    const ce = commentEnd();
    if (ce !== "") {
      // A comment with an end is continued with comment-continue's start.
      gnista.insertAndInherit("\n");
      gnista.indentTo(column);
      gnista.insert(starter.replace(/^\S/, " "));
      return;
    }
    gnista.insertAndInherit("\n");
    gnista.indentTo(column);
    gnista.insert(starter);
  },
});

gnista.defineCommand({
  name: "default-indent-new-line",
  doc: "Break the line and indent the new one, continuing a comment point is in, as comment-indent-new-line does.",
  run: () => {
    if (gnista.syntaxPpss().inComment !== null && str("comment-start") !== undefined) {
      gnista.call("comment-indent-new-line");
      return;
    }
    gnista.insertAndInherit("\n");
    let a = gnista.point() - 1;
    while (a > 0 && " \t".includes(charAt(a - 1))) a--;
    gnista.deleteRegion(a, gnista.point() - 1);
    gnista.call("indent-according-to-mode");
  },
});

gnista.bindKey("M-;", "comment-dwim");
gnista.bindKey("C-x C-;", "comment-line");
gnista.bindKey("C-x ;", "comment-set-column");
gnista.bindKey("M-j", "default-indent-new-line");
gnista.bindKey("C-M-j", "default-indent-new-line");
