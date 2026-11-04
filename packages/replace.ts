// Replacing, after Emacs's replace.el: query-replace (M-%) and
// query-replace-regexp (C-M-%) ask at each match, and replace-string and
// replace-regexp replace every match. All of them work from point to the
// end of the buffer, or on the region when it is active and they run from
// a key or M-x.
//
// While query-replace asks, query-replace-map overrides other keymaps:
// y or SPC replaces and moves on, n or DEL skips, ! replaces the rest, . replaces
// and stops, "," replaces and stays, ^ goes back to the last match, and q or
// RET stops. Any other key stops and then runs.

gnista.defineFace({
  name: "query-replace",
  doc: "The match query-replace is asking about.",
  attributes: { inherit: "isearch" },
});

gnista.defineVariable({
  name: "query-replace-history",
  doc: "Strings and replacements answered to query-replace and the other replace commands, newest first.",
  value: [],
});

gnista.defineVariable({
  name: "case-replace",
  doc:
    "Whether replacing follows the case of the text replaced, when the search ignores case: " +
    "\"foo\" replacing \"Hello\" gives \"Foo\", and replacing \"HELLO\" gives \"FOO\".",
  value: true,
});

interface Replace {
  from: string;
  to: string;
  regexp: boolean;
  caseFold: boolean;
  /** Whether the match asked about was already replaced, by ",". */
  replaced: boolean;
  /** Where the search goes on from. */
  next: number;
  count: number;
  /** The match being asked about. */
  match?: { start: number; end: number };
  /** Positions of earlier matches, for ^. */
  history: number[];
  current?: number;
  others: number[];
}

let replacing: Replace | undefined;

/** The range to work on: the active region from a key or M-x, else point to the end. */
function scope(): { start: number; endMarker: number } {
  let start = gnista.point();
  let end = gnista.bufferSize();
  if (gnista.calledInteractively() && gnista.regionActive()) {
    const mark = gnista.mark() ?? start;
    end = Math.max(mark, start);
    start = Math.min(mark, start);
    gnista.deactivateMark();
  }
  // An overlay keeps the end in place as replacements change the text before it.
  const endMarker = gnista.makeOverlay(end, end);
  return { start, endMarker };
}

function endOf(marker: number): number {
  return gnista.overlayStart(marker) ?? gnista.bufferSize();
}

/** Finds the next match from a position, stepping past empty matches where the last one ended. */
function findFrom(r: Replace, from: number, end: number, lastEnd: number | undefined) {
  let m = gnista.search(r.from, { from, regexp: r.regexp, bound: end, caseFold: r.caseFold });
  if (m && m.start === m.end && m.start === lastEnd) {
    if (from + 1 > end) return undefined;
    m = gnista.search(r.from, { from: from + 1, regexp: r.regexp, bound: end, caseFold: r.caseFold });
  }
  // As in Emacs, nothing is replaced once the search reaches the end.
  if (m && m.start === m.end && m.start >= end) return undefined;
  return m;
}

function replaceCurrent(r: Replace): number {
  const fixedCase = !(r.caseFold && gnista.variable("case-replace") === true);
  const replaced = gnista.replaceMatch(r.to, { literal: !r.regexp, fixedCase });
  r.count += 1;
  return replaced.end;
}

function occurrences(n: number): string {
  return `Replaced ${n} occurrence${n === 1 ? "" : "s"}`;
}

/** Replaces every match from `start` up to the end marker, returning how many. */
function replaceAll(r: Replace, start: number, endMarker: number): void {
  let pos = start;
  let lastEnd: number | undefined;
  for (;;) {
    const m = findFrom(r, pos, endOf(endMarker), lastEnd);
    if (m === undefined) break;
    pos = replaceCurrent(r);
    lastEnd = pos;
    if (m.start === m.end) {
      // Step past an empty match so the next search moves on.
      if (pos >= endOf(endMarker)) break;
    }
  }
  gnista.gotoChar(pos);
}

function clearHighlights(r: Replace) {
  if (r.current !== undefined) gnista.deleteOverlay(r.current);
  r.current = undefined;
  for (const id of r.others) gnista.deleteOverlay(id);
  r.others = [];
}

function highlight(r: Replace, endMarker: number) {
  clearHighlights(r);
  if (r.match === undefined) return;
  r.current = gnista.makeOverlay(r.match.start, r.match.end, { face: "query-replace", priority: 1001 });
  let pos = r.match.end;
  const end = endOf(endMarker);
  while (r.others.length < 200) {
    const m = gnista.search(r.from, { from: pos, regexp: r.regexp, bound: end, caseFold: r.caseFold });
    if (m === undefined || m.end === m.start) break;
    r.others.push(gnista.makeOverlay(m.start, m.end, { face: "lazy-highlight", priority: 1000 }));
    pos = m.end;
  }
}

let endMarker = -1;

/** Moves to the next match and asks about it, or finishes if there is none. */
function askNext(r: Replace) {
  const lastEnd = r.match === undefined ? undefined : r.next;
  const m = findFrom(r, r.next, endOf(endMarker), lastEnd);
  if (m === undefined) {
    finish(r);
    return;
  }
  r.match = { start: m.start, end: m.end };
  r.replaced = false;
  gnista.gotoChar(m.end);
  highlight(r, endMarker);
  gnista.message(`Query replacing ${r.from} with ${r.to}: (? for help) `);
}

function finish(r: Replace) {
  clearHighlights(r);
  gnista.deleteOverlay(endMarker);
  gnista.setOverridingMap(null);
  replacing = undefined;
  gnista.message(occurrences(r.count));
}

function start(from: string, to: string, regexp: boolean, query: boolean) {
  if (from === "") throw new Error("Empty search string");
  const caseFold = gnista.foldCaseFor(from, true);
  const { start, endMarker: marker } = scope();
  gnista.pushMark(start);
  const r: Replace = { from, to, regexp, caseFold, replaced: false, next: start, count: 0, history: [], others: [] };
  if (!query) {
    replaceAll(r, start, marker);
    gnista.deleteOverlay(marker);
    gnista.message(occurrences(r.count));
    return;
  }
  endMarker = marker;
  replacing = r;
  gnista.setOverridingMap("query-replace-map");
  askNext(r);
}

function asking(): Replace {
  if (replacing === undefined) throw new Error("Not replacing");
  return replacing;
}

/** Replaces the match being asked about; the search goes on after it. */
function replaceHere(r: Replace) {
  if (r.match === undefined || r.replaced) return;
  // The match data may have moved on while highlighting; find this match again.
  gnista.search(r.from, { from: r.match.start, regexp: r.regexp, bound: r.match.end, caseFold: r.caseFold });
  r.history.push(r.match.start);
  r.next = replaceCurrent(r);
  r.match = { start: r.match.start, end: r.next };
}

gnista.defineKeymap("query-replace-map");

const actions: [string[], string, string, (r: Replace) => void][] = [
  [["y", "SPC"], "query-replace-act", "Replace this match and go on to the next.", (r) => {
    replaceHere(r);
    askNext(r);
  }],
  [["n", "DEL", "<delete>"], "query-replace-skip", "Leave this match and go on to the next.", (r) => {
    if (r.match && !r.replaced) {
      r.history.push(r.match.start);
      r.next = r.match.end;
    }
    askNext(r);
  }],
  [["!"], "query-replace-automatic", "Replace this match and all the rest without asking.", (r) => {
    replaceHere(r);
    replaceAll(r, r.next, endMarker);
    finish(r);
  }],
  [["."], "query-replace-act-and-exit", "Replace this match and stop.", (r) => {
    replaceHere(r);
    finish(r);
  }],
  [[","], "query-replace-act-and-stay", "Replace this match and stay here; y or n then moves on.", (r) => {
    replaceHere(r);
    r.replaced = true;
    clearHighlights(r);
    gnista.gotoChar(r.next);
    gnista.message(`Query replacing ${r.from} with ${r.to}: (? for help) `);
  }],
  [["^"], "query-replace-backup", "Go back to the last match asked about.", (r) => {
    const back = r.history.pop();
    if (back === undefined) {
      gnista.message("No previous match");
      return;
    }
    r.next = back;
    r.match = undefined;
    askNext(r);
  }],
  [["q", "RET"], "query-replace-exit", "Stop replacing.", (r) => finish(r)],
  [["?", "C-h"], "query-replace-help", "Say what the keys do while query-replace asks.", (r) => {
    gnista.message(
      "y or SPC: replace, n or DEL: skip, !: replace the rest, .: replace and stop, " +
        ",: replace and stay, ^: back, q or RET: stop",
    );
  }],
];

for (const [keys, name, doc, act] of actions) {
  const command = gnista.defineCommand({ name, doc, run: () => act(asking()) });
  for (const key of keys) gnista.bindKey(key, command, "query-replace-map");
}

const quit = gnista.defineCommand({
  name: "query-replace-quit",
  doc: "Stop replacing, keeping what has been replaced.",
  run: () => {
    finish(asking());
    gnista.message("Quit");
  },
});
gnista.bindKey("C-g", quit, "query-replace-map");

const otherKey = gnista.defineCommand({
  name: "query-replace-other-key",
  doc: "Stop replacing and run the key typed, as query-replace does for keys it does not know.",
  run: () => {
    const key = gnista.lastKey();
    finish(asking());
    if (key !== undefined) gnista.unreadKeys(key);
  },
});
gnista.setKeymapDefault("query-replace-map", otherKey);

const queryReplace = gnista.defineCommand({
  name: "query-replace",
  doc:
    "Replace a string with another, asking at each match.\n\n" +
    "At each match: y or SPC replaces it, n or DEL skips it, ! replaces the rest, . replaces it and stops, " +
    "q or RET stops. Case is ignored unless the string has a capital letter, and then replacements follow " +
    "the case of what they replace. Works from point to the end of the buffer, or on the region if it is active.",
  params: [
    { name: "from", prompt: "Query replace: ", history: "query-replace-history" },
    { name: "to", prompt: "Query replace with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, false, true),
});

const queryReplaceRegexp = gnista.defineCommand({
  name: "query-replace-regexp",
  doc:
    "Replace matches of a regular expression, asking at each one.\n\n" +
    "In the replacement, \\& is the whole match and \\1 to \\9 its groups. See query-replace for the keys.",
  params: [
    { name: "regexp", prompt: "Query replace regexp: ", history: "query-replace-history" },
    { name: "to", prompt: "Query replace regexp with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, true, true),
});

gnista.defineCommand({
  name: "replace-string",
  doc: "Replace every match of a string from point to the end of the buffer, or in the active region.",
  params: [
    { name: "from", prompt: "Replace string: ", history: "query-replace-history" },
    { name: "to", prompt: "Replace string with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, false, false),
});

gnista.defineCommand({
  name: "replace-regexp",
  doc:
    "Replace every match of a regular expression from point to the end of the buffer, or in the active region.\n\n" +
    "In the replacement, \\& is the whole match and \\1 to \\9 its groups.",
  params: [
    { name: "regexp", prompt: "Replace regexp: ", history: "query-replace-history" },
    { name: "to", prompt: "Replace regexp with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, true, false),
});

gnista.bindKey("M-%", queryReplace);
gnista.bindKey("C-M-%", queryReplaceRegexp);

// Lines matching a regexp, after replace.el: keep-lines, flush-lines,
// kill-matching-lines, copy-matching-lines and how-many, from point to the
// end, or in the region when it is active.

/**
 * Whether a regexp search folds case, as these commands decide: with
 * case-fold-search and search-upper-case, only if the regexp has no
 * capital letter that is not after a backslash, as isearch-no-upper-case-p.
 */
function regexpFoldsCase(regexp: string): boolean {
  const on = (v: gnista.Value | undefined) => v !== null && v !== undefined && v !== false;
  if (!on(gnista.variable("case-fold-search"))) return false;
  if (!on(gnista.variable("search-upper-case"))) return true;
  return !/(^|[^\\])(\\\\)*[A-Z]/u.test(regexp.replace(/\\[A-Za-z]/g, ""));
}

/** Reads the regexp for keep-lines and the rest, as keep-lines-read-args. */
const readLinesRegexp = (prompt: string) => gnista.readString(`${prompt}: `, { history: "regexp-history" });

/**
 * The stretch these commands work on: the region if it is active, else
 * from point to the end; with `wholeLines`, the end goes back to the start
 * of its line, as keep-lines has it. Point goes to the start.
 */
function linesRange(wholeLines: boolean): [number, gnista.Marker] {
  const mark = gnista.mark();
  let [start, end] = gnista.regionActive() && mark !== undefined ? [Math.min(mark, gnista.point()), Math.max(mark, gnista.point())] : [gnista.point(), gnista.pointMax()];
  if (wholeLines && gnista.regionActive()) {
    const bol = gnista.lineBeginningPosition(end);
    if (end !== bol && end !== gnista.pointMax()) end = bol;
  }
  gnista.gotoChar(start);
  return [start, gnista.makeMarker(end)];
}

const forwardLineFrom = (pos: number): number => {
  const line = gnista.lineOf(pos) + 1;
  return line >= gnista.lineCount() ? gnista.pointMax() : Math.min(gnista.pointMax(), gnista.lineStart(line));
};

gnista.defineCommand({
  name: "keep-lines",
  doc: "Delete the lines after point, or in the region, that have no match for a regexp. A match across lines keeps them all.",
  run: async () => {
    if (gnista.bufferReadOnly()) gnista.signal("buffer-read-only", `Buffer is read-only: ${gnista.bufferName()}`);
    const regexp = await readLinesRegexp("Keep lines containing match for regexp");
    const [, rend] = linesRange(true);
    const caseFold = regexpFoldsCase(regexp);
    gnista.saveExcursion(() => {
      if (gnista.point() !== gnista.lineBeginningPosition()) gnista.gotoChar(forwardLineFrom(gnista.point()));
      let start = gnista.point();
      while (gnista.point() < gnista.markerPosition(rend)!) {
        if (gnista.reSearchForward(regexp, { bound: gnista.markerPosition(rend)!, noerror: true, caseFold }) === undefined) {
          gnista.deleteRegion(start, gnista.markerPosition(rend)!);
          gnista.gotoChar(gnista.markerPosition(rend)!);
        } else {
          const end = gnista.lineBeginningPosition(gnista.matchBeginning(0)!);
          if (start < end) gnista.deleteRegion(start, end);
        }
        start = forwardLineFrom(gnista.point());
        if (gnista.point() < gnista.markerPosition(rend)! && gnista.matchBeginning(0) === gnista.matchEnd(0)) gnista.gotoChar(gnista.point() + 1);
      }
    });
    gnista.deleteMarker(rend);
  },
});

/** Runs `act` on each line after point, or in the region, with a match for `regexp`, and says how many, as flush-lines and its kin. */
function matchingLines(regexp: string, act: (from: number, to: number, first: boolean) => void, verb: string): void {
  const [, rend] = linesRange(false);
  const caseFold = regexpFoldsCase(regexp);
  let count = 0;
  gnista.saveExcursion(() => {
    while (gnista.point() < gnista.markerPosition(rend)! && gnista.reSearchForward(regexp, { bound: gnista.markerPosition(rend)!, noerror: true, caseFold }) !== undefined) {
      const from = gnista.lineBeginningPosition(gnista.matchBeginning(0)!);
      const to = forwardLineFrom(gnista.point());
      gnista.gotoChar(to);
      act(from, to, count === 0);
      count++;
    }
  });
  gnista.deleteMarker(rend);
  gnista.message(`${verb} ${count} matching line${count === 1 ? "" : "s"}`);
}

gnista.defineCommand({
  name: "flush-lines",
  doc: "Delete the lines after point, or in the region, that have a match for a regexp.",
  run: async () => {
    if (gnista.bufferReadOnly()) gnista.signal("buffer-read-only", `Buffer is read-only: ${gnista.bufferName()}`);
    const regexp = await readLinesRegexp("Flush lines containing match for regexp");
    matchingLines(regexp, (from, to) => gnista.deleteRegion(from, to), "Deleted");
  },
});

gnista.defineCommand({
  name: "kill-matching-lines",
  doc: "Kill the lines after point, or in the region, that have a match for a regexp, together as one kill.",
  run: async () => {
    if (gnista.bufferReadOnly()) gnista.signal("buffer-read-only", `Buffer is read-only: ${gnista.bufferName()}`);
    const regexp = await readLinesRegexp("Kill lines containing match for regexp");
    matchingLines(regexp, (from, to, first) => {
      if (!first) gnista.setLastCommand("kill-region");
      gnista.killRegion(from, to);
    }, "Killed");
  },
});

gnista.defineCommand({
  name: "copy-matching-lines",
  doc: "Copy the lines after point, or in the region, that have a match for a regexp to the kill ring, together as one kill.",
  run: async () => {
    const regexp = await readLinesRegexp("Copy lines containing match for regexp");
    matchingLines(regexp, (from, to, first) => {
      if (!first) gnista.setLastCommand("kill-region");
      // As copy-region-as-kill, through M-w's command, the mark put back after.
      const mark = gnista.mark();
      gnista.setMark(from);
      gnista.gotoChar(to);
      gnista.call("kill-ring-save");
      if (mark !== undefined) gnista.setMark(mark);
    }, "Copied");
  },
});

gnista.defineCommand({
  name: "how-many",
  doc: "Say how many matches for a regexp there are after point, or in the region.",
  run: async () => {
    const regexp = await readLinesRegexp("How many matches for regexp");
    let count = 0;
    gnista.saveExcursion(() => {
      const mark = gnista.mark();
      const [start, end] = gnista.regionActive() && mark !== undefined ? [Math.min(mark, gnista.point()), Math.max(mark, gnista.point())] : [gnista.point(), gnista.pointMax()];
      gnista.gotoChar(start);
      const caseFold = regexpFoldsCase(regexp);
      while (gnista.point() < end && gnista.reSearchForward(regexp, { bound: end, noerror: true, caseFold }) !== undefined) {
        if (gnista.matchBeginning(0) === gnista.matchEnd(0) && gnista.point() < gnista.pointMax()) gnista.gotoChar(gnista.point() + 1);
        count++;
      }
    });
    gnista.message(`${count} occurrence${count === 1 ? "" : "s"}`);
  },
});

for (const [alias, name] of [
  ["delete-non-matching-lines", "keep-lines"],
  ["delete-matching-lines", "flush-lines"],
  ["count-matches", "how-many"],
] as const) {
  gnista.defalias(alias, name);
}

// occur, after replace.el: the lines of the buffer matching a regexp, listed
// in *Occur* with their line numbers, the matches highlighted; RET or a
// click goes to one, and next-error goes through them.

for (const [name, doc, value] of [
  ["list-matching-lines-face", "The face occur shows matches in.", "match"],
  ["list-matching-lines-buffer-name-face", "The face of occur's line naming the buffer.", "underline"],
  ["list-matching-lines-prefix-face", "The face of the line numbers occur shows.", "shadow"],
  ["occur-hook", "Functions run after occur makes *Occur*.", null],
] as const) {
  gnista.defineVariable({ name, doc, value: value as gnista.Value });
}

/** Where each line of an *Occur* buffer goes: the buffer, and markers at the start and end of each match on the line. */
const occurTargets = new Map<number, { buffer: string; matches: [gnista.Marker, gnista.Marker][] }>();
let nextOccurTarget = 0;

/** What occur was last asked, to make *Occur* again with g. */
let occurArgs: { regexp: string; buffer: string; region?: [number, number] } | undefined;

/** Lists the lines matching `regexp` in *Occur*, as occur-1 does for one buffer; returns how many matches there are. */
function occurIn(regexp: string, buffer: string, region?: [number, number]): number {
  const caseFold = gnista.withCurrentBuffer(buffer, () => regexpFoldsCase(regexp));
  const lines: { line: number; text: string; spans: [number, number][]; target: number }[] = [];
  let matches = 0;
  gnista.withCurrentBuffer(buffer, () =>
    gnista.saveExcursion(() =>
      gnista.saveRestriction(() => {
        if (region !== undefined) gnista.narrowToRegion(region[0], region[1]);
        gnista.gotoChar(gnista.pointMin());
        let lastLine = -1;
        while (gnista.point() < gnista.pointMax() && gnista.reSearchForward(regexp, { noerror: true, caseFold }) !== undefined) {
          const [b, e] = [gnista.matchBeginning(0)!, gnista.matchEnd(0)!];
          const bol = gnista.lineBeginningPosition(b);
          const eol = gnista.lineEndPosition(b);
          const line = gnista.saveRestriction(() => {
            gnista.widen();
            return gnista.lineOf(b) + 1;
          });
          // Every match on the line, highlighted, as occur-engine-line.
          const text = gnista.bufferSubstringNoProperties(bol, eol);
          const spans: [number, number][] = [];
          let from = 0;
          while (from <= text.length) {
            const s = gnista.stringMatch(regexp, text, { caseFold, start: from });
            if (s === undefined) break;
            const f = gnista.matchEnd(0)!;
            if (f === s) {
              from = s + 1;
              continue;
            }
            spans.push([s, f]);
            from = f;
          }
          if (spans.length === 0) spans.push([b - bol, b - bol]);
          matches += spans.filter(([s, f]) => f > s).length || 1;
          if (line !== lastLine) {
            const id = nextOccurTarget++;
            occurTargets.set(id, { buffer, matches: spans.map(([s, f]) => [gnista.makeMarker(bol + s), gnista.makeMarker(bol + f)]) });
            lines.push({ line, text, spans, target: id });
            lastLine = line;
          }
          gnista.gotoChar(Math.max(e, eol));
          if (gnista.point() < gnista.pointMax()) gnista.gotoChar(gnista.point() + 1);
        }
      }),
    ),
  );
  gnista.getBufferCreate("*Occur*");
  gnista.withCurrentBuffer("*Occur*", () => {
    if (gnista.variable("major-mode") !== "occur-mode") gnista.call("occur-mode");
    gnista.letBind({ "inhibit-read-only": true }, () => {
      gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
      const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
      const header =
        `${matches} ${plural(matches, "match", "matches")}` +
        (lines.length === matches ? "" : ` in ${lines.length} ${plural(lines.length, "line", "lines")}`) +
        ` for "${regexp}" in buffer: ${buffer}` +
        (region === undefined ? "" : ` within region: ${region[0] + 1}-${region[1] + 1}`);
      gnista.insert(gnista.propertize(header, { face: String(gnista.variable("list-matching-lines-buffer-name-face") ?? "underline"), "read-only": true }));
      gnista.insert("\n");
      for (const { line, text, spans, target } of lines) {
        const start = gnista.point();
        gnista.insert(gnista.propertize(String(line).padStart(7) + ":", { face: String(gnista.variable("list-matching-lines-prefix-face") ?? "shadow"), "occur-prefix": true, "read-only": true }));
        // The line, its matches in list-matching-lines-face.
        const face = String(gnista.variable("list-matching-lines-face") ?? "match");
        let at = 0;
        for (const [b, f] of spans) {
          if (f <= b) continue;
          gnista.insert(text.slice(at, b));
          gnista.insert(gnista.propertize(text.slice(b, f), { face }));
          at = f;
        }
        gnista.insert(text.slice(at));
        gnista.putTextProperty(start, gnista.point(), "occur-target", target);
        gnista.putTextProperty(start, gnista.point(), "mouse-face", "highlight");
        gnista.insert("\n");
      }
    });
    gnista.gotoChar(gnista.pointMin());
    gnista.setBufferModified(false);
  });
  return matches;
}

/** Makes *Occur* for a regexp in a buffer, shows it and says how many matches, as occur. */
function runOccur(regexp: string, buffer: string, region?: [number, number]): void {
  occurArgs = { regexp, buffer, region };
  const count = occurIn(regexp, buffer, region);
  gnista.message(`Searched 1 buffer; ${count === 0 ? "no" : String(count)} ${count === 1 ? "match" : "matches"} for "${regexp}"`);
  if (count === 0) {
    gnista.call("kill-buffer", "*Occur*");
    return;
  }
  gnista.call("display-buffer", "*Occur*");
  gnista.setVariable("next-error-last-buffer", gnista.getBuffer("*Occur*") ?? null);
  gnista.withCurrentBuffer("*Occur*", () => gnista.runHooks("occur-hook"));
}

gnista.defineVariable({ name: "regexp-history", doc: "Regexps answered at prompts that ask for one, newest first.", value: [] });

gnista.defineCommand({
  name: "occur",
  doc:
    "List the lines of the buffer, or of the region if it is active, that match a regexp, in *Occur*.\n\n" +
    "There RET goes to a line's match, C-o shows it, n and p go through them, and M-g n does from anywhere.",
  run: async () => {
    const history = gnista.variable("regexp-history");
    const def = Array.isArray(history) && typeof history[0] === "string" ? history[0] : undefined;
    const answer = await gnista.readString(def === undefined ? "List lines matching regexp: " : `List lines matching regexp (default ${def}): `, {
      history: "regexp-history",
    });
    const regexp = answer === "" && def !== undefined ? def : answer;
    if (regexp === "") gnista.userError("Empty regexp");
    const mark = gnista.mark();
    const region: [number, number] | undefined =
      gnista.regionActive() && mark !== undefined ? [Math.min(mark, gnista.point()), Math.max(mark, gnista.point())] : undefined;
    runOccur(regexp, gnista.bufferName(), region);
  },
});
gnista.bindKey("M-s o", "occur");

/** The *Occur* line's target at point, or an error, as occur-mode--find-occurrences. */
function occurTargetAt(pos: number): { buffer: string; matches: [gnista.Marker, gnista.Marker][] } {
  const id = gnista.getTextProperty(pos, "occur-target");
  const target = typeof id === "number" ? occurTargets.get(id) : undefined;
  if (target === undefined) throw new Error("No occurrence on this line");
  if (!gnista.getBuffer(target.buffer)) throw new Error("Buffer for this occurrence was killed");
  return target;
}

/** Goes to the occurrence on this *Occur* line, in another window with `other`, or only shows it with `display`. */
function gotoOccurrence(how: "pop" | "other" | "display"): void {
  const target = occurTargetAt(gnista.point());
  const pos = gnista.markerPosition(target.matches[0]![0])!;
  if (how === "display") {
    const occur = gnista.selectedWindow();
    gnista.call("display-buffer", target.buffer);
    const window = gnista.windowList().find((w) => gnista.windowBuffer(w) === target.buffer);
    if (window !== undefined) {
      gnista.selectWindow(window);
      gnista.gotoChar(pos);
      gnista.selectWindow(occur);
    }
    return;
  }
  gnista.call(how === "other" ? "switch-to-buffer-other-window" : "pop-to-buffer", target.buffer);
  gnista.gotoChar(pos);
}

gnista.defineCommand({ name: "occur-mode-goto-occurrence", doc: "Go to the occurrence on this line.", run: () => gotoOccurrence("pop") });
gnista.defineCommand({ name: "occur-mode-goto-occurrence-other-window", doc: "Go to the occurrence on this line, in another window.", run: () => gotoOccurrence("other") });
gnista.defineCommand({ name: "occur-mode-display-occurrence", doc: "Show the occurrence on this line in another window, staying in *Occur*.", run: () => gotoOccurrence("display") });

/** Moves to the `n`th next line with an occurrence, back if negative, as occur-find-match. */
function occurFindMatch(n: number, message: string): void {
  for (let i = 0; i < Math.abs(n); i++) {
    const line = gnista.lineOf(gnista.point());
    let l = line + (n > 0 ? 1 : -1);
    while (l >= 0 && l < gnista.lineCount() && gnista.getTextProperty(gnista.lineStart(l), "occur-target") === undefined) l += n > 0 ? 1 : -1;
    if (l < 0 || l >= gnista.lineCount() || gnista.getTextProperty(gnista.lineStart(l), "occur-target") === undefined) throw new Error(message);
    gnista.gotoChar(gnista.lineStart(l) + 8);
  }
}

gnista.defineCommand({
  name: "occur-next",
  doc: "Move to the next occurrence in *Occur*; with a prefix argument, that many.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => occurFindMatch(n, "No more matches"),
});
gnista.defineCommand({
  name: "occur-prev",
  doc: "Move to the occurrence before in *Occur*; with a prefix argument, that many back.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => occurFindMatch(-n, "No earlier matches"),
});

gnista.defun("occur-next-error", (n: number, reset: boolean) => {
  if (reset) gnista.gotoChar(gnista.pointMin());
  else if (n < 0) gnista.gotoChar(gnista.lineBeginningPosition());
  else if (n > 0) gnista.gotoChar(gnista.lineEndPosition());
  occurFindMatch(n === 0 ? 1 : n, "No more matches");
  const occur = gnista.bufferName();
  const p = gnista.point();
  // In case *Occur* shows in a window that is not selected.
  const window = gnista.windowList().find((w) => gnista.windowBuffer(w) === occur);
  if (window !== undefined) {
    const selected = gnista.selectedWindow();
    gnista.selectWindow(window);
    gnista.gotoChar(p);
    gnista.selectWindow(selected);
  }
  gnista.withCurrentBuffer(occur, () => gnista.gotoChar(p));
  const target = gnista.withCurrentBuffer(occur, () => occurTargetAt(p));
  gnista.call("pop-to-buffer", target.buffer);
  gnista.gotoChar(gnista.markerPosition(target.matches[0]![0])!);
});

gnista.defineCommand({
  name: "occur-revert-buffer",
  doc: "Make *Occur* again, for the same regexp in the same buffer.",
  run: () => {
    if (occurArgs !== undefined) runOccur(occurArgs.regexp, occurArgs.buffer, occurArgs.region);
  },
});

gnista.defineMajorMode({
  name: "occur-mode",
  modeName: "Occur",
  doc: "The mode of *Occur*: the lines matching a regexp. RET goes to one, o in another window, C-o shows it, n and p and M-n and M-p move, g lists them again.",
  bindings: {
    RET: "occur-mode-goto-occurrence",
    "C-c C-c": "occur-mode-goto-occurrence",
    o: "occur-mode-goto-occurrence-other-window",
    "C-o": "occur-mode-display-occurrence",
    n: "next-error-no-select",
    p: "previous-error-no-select",
    "M-n": "occur-next",
    "M-p": "occur-prev",
    g: "occur-revert-buffer",
    q: "quit-window",
  } as Record<string, gnista.CommandName>,
  setup: () => {
    gnista.setVariable("next-error-function", "occur-next-error");
    gnista.setReadOnly(true);
  },
});
