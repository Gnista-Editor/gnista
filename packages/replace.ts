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

ember.defineFace({
  name: "query-replace",
  doc: "The match query-replace is asking about.",
  attributes: { inherit: "isearch" },
});

ember.defineVariable({
  name: "query-replace-history",
  doc: "Strings and replacements answered to query-replace and the other replace commands, newest first.",
  value: [],
});

ember.defineVariable({
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
  let start = ember.point();
  let end = ember.bufferSize();
  if (ember.calledInteractively() && ember.regionActive()) {
    const mark = ember.mark() ?? start;
    end = Math.max(mark, start);
    start = Math.min(mark, start);
    ember.deactivateMark();
  }
  // An overlay keeps the end in place as replacements change the text before it.
  const endMarker = ember.makeOverlay(end, end);
  return { start, endMarker };
}

function endOf(marker: number): number {
  return ember.overlayStart(marker) ?? ember.bufferSize();
}

/** Finds the next match from a position, stepping past empty matches where the last one ended. */
function findFrom(r: Replace, from: number, end: number, lastEnd: number | undefined) {
  let m = ember.search(r.from, { from, regexp: r.regexp, bound: end, caseFold: r.caseFold });
  if (m && m.start === m.end && m.start === lastEnd) {
    if (from + 1 > end) return undefined;
    m = ember.search(r.from, { from: from + 1, regexp: r.regexp, bound: end, caseFold: r.caseFold });
  }
  // As in Emacs, nothing is replaced once the search reaches the end.
  if (m && m.start === m.end && m.start >= end) return undefined;
  return m;
}

function replaceCurrent(r: Replace): number {
  const fixedCase = !(r.caseFold && ember.variable("case-replace") === true);
  const replaced = ember.replaceMatch(r.to, { literal: !r.regexp, fixedCase });
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
  ember.gotoChar(pos);
}

function clearHighlights(r: Replace) {
  if (r.current !== undefined) ember.deleteOverlay(r.current);
  r.current = undefined;
  for (const id of r.others) ember.deleteOverlay(id);
  r.others = [];
}

function highlight(r: Replace, endMarker: number) {
  clearHighlights(r);
  if (r.match === undefined) return;
  r.current = ember.makeOverlay(r.match.start, r.match.end, { face: "query-replace", priority: 1001 });
  let pos = r.match.end;
  const end = endOf(endMarker);
  while (r.others.length < 200) {
    const m = ember.search(r.from, { from: pos, regexp: r.regexp, bound: end, caseFold: r.caseFold });
    if (m === undefined || m.end === m.start) break;
    r.others.push(ember.makeOverlay(m.start, m.end, { face: "lazy-highlight", priority: 1000 }));
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
  ember.gotoChar(m.end);
  highlight(r, endMarker);
  ember.message(`Query replacing ${r.from} with ${r.to}: (? for help) `);
}

function finish(r: Replace) {
  clearHighlights(r);
  ember.deleteOverlay(endMarker);
  ember.setOverridingMap(null);
  replacing = undefined;
  ember.message(occurrences(r.count));
}

function start(from: string, to: string, regexp: boolean, query: boolean) {
  if (from === "") throw new Error("Empty search string");
  const caseFold = ember.foldCaseFor(from, true);
  const { start, endMarker: marker } = scope();
  ember.pushMark(start);
  const r: Replace = { from, to, regexp, caseFold, replaced: false, next: start, count: 0, history: [], others: [] };
  if (!query) {
    replaceAll(r, start, marker);
    ember.deleteOverlay(marker);
    ember.message(occurrences(r.count));
    return;
  }
  endMarker = marker;
  replacing = r;
  ember.setOverridingMap("query-replace-map");
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
  ember.search(r.from, { from: r.match.start, regexp: r.regexp, bound: r.match.end, caseFold: r.caseFold });
  r.history.push(r.match.start);
  r.next = replaceCurrent(r);
  r.match = { start: r.match.start, end: r.next };
}

ember.defineKeymap("query-replace-map");

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
    ember.gotoChar(r.next);
    ember.message(`Query replacing ${r.from} with ${r.to}: (? for help) `);
  }],
  [["^"], "query-replace-backup", "Go back to the last match asked about.", (r) => {
    const back = r.history.pop();
    if (back === undefined) {
      ember.message("No previous match");
      return;
    }
    r.next = back;
    r.match = undefined;
    askNext(r);
  }],
  [["q", "RET"], "query-replace-exit", "Stop replacing.", (r) => finish(r)],
  [["?", "C-h"], "query-replace-help", "Say what the keys do while query-replace asks.", (r) => {
    ember.message(
      "y or SPC: replace, n or DEL: skip, !: replace the rest, .: replace and stop, " +
        ",: replace and stay, ^: back, q or RET: stop",
    );
  }],
];

for (const [keys, name, doc, act] of actions) {
  const command = ember.defineCommand({ name, doc, run: () => act(asking()) });
  for (const key of keys) ember.bindKey(key, command, "query-replace-map");
}

const quit = ember.defineCommand({
  name: "query-replace-quit",
  doc: "Stop replacing, keeping what has been replaced.",
  run: () => {
    finish(asking());
    ember.message("Quit");
  },
});
ember.bindKey("C-g", quit, "query-replace-map");

const otherKey = ember.defineCommand({
  name: "query-replace-other-key",
  doc: "Stop replacing and run the key typed, as query-replace does for keys it does not know.",
  run: () => {
    const key = ember.lastKey();
    finish(asking());
    if (key !== undefined) ember.unreadKeys(key);
  },
});
ember.setKeymapDefault("query-replace-map", otherKey);

const queryReplace = ember.defineCommand({
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

const queryReplaceRegexp = ember.defineCommand({
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

ember.defineCommand({
  name: "replace-string",
  doc: "Replace every match of a string from point to the end of the buffer, or in the active region.",
  params: [
    { name: "from", prompt: "Replace string: ", history: "query-replace-history" },
    { name: "to", prompt: "Replace string with: ", history: "query-replace-history" },
  ],
  run: (from, to) => start(from, to, false, false),
});

ember.defineCommand({
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

ember.bindKey("M-%", queryReplace);
ember.bindKey("C-M-%", queryReplaceRegexp);
