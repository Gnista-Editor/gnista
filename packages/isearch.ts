// Incremental search, after Emacs's isearch.el. C-s and C-r search as you
// type, from point. While searching, isearch-mode-map overrides every other
// keymap: printing characters extend the search string, C-s and C-r find the
// next match, DEL takes back the last change, RET ends the search, and C-g
// cancels it. Any other key ends the search and then does what it usually
// does. The current match is highlighted with the isearch face and the other
// matches nearby with lazy-highlight.

ember.defineFace({
  name: "isearch",
  doc: "The match incremental search is at.",
  attributes: { background: "accent", foreground: "bg" },
});
ember.defineFace({
  name: "lazy-highlight",
  doc: "Other matches for the string incremental search is looking for.",
  attributes: { background: "selection" },
});
ember.defineFace({
  name: "isearch-fail",
  doc: "The part of the search string that does not match.",
  attributes: { background: "bad", foreground: "bg" },
});

ember.defineVariable({
  name: "search-ring",
  doc: "Strings searched for with incremental search, most recent first.",
  value: [],
});
ember.defineVariable({
  name: "regexp-search-ring",
  doc: "Regular expressions searched for with incremental search, most recent first.",
  value: [],
});
ember.defineVariable({
  name: "lazy-highlight-max-at-a-time",
  doc: "How many other matches incremental search highlights at most, around point.",
  value: 200,
});

/** One step of a search, which DEL goes back to. */
interface Step {
  string: string;
  point: number;
  /** Where the current match starts and ends, if it found one. */
  match?: { start: number; end: number };
  success: boolean;
  wrapped: boolean;
  forward: boolean;
  /** Why the string cannot be searched for, such as an unfinished regexp. */
  error?: string;
}

interface Search {
  regexp: boolean;
  origin: number;
  steps: Step[];
  /** The overlay on the current match, and on the other matches. */
  current?: number;
  others: number[];
}

let active: Search | undefined;

function top(search: Search): Step {
  return search.steps[search.steps.length - 1];
}

function ringName(regexp: boolean): string {
  return regexp ? "regexp-search-ring" : "search-ring";
}

function ring(regexp: boolean): string[] {
  const value = ember.variable(ringName(regexp));
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** What the echo area shows while searching, as Emacs words it. */
function prompt(search: Search): string {
  const step = top(search);
  const parts: string[] = [];
  if (!step.success && !step.error) parts.push("Failing");
  else if (step.wrapped) parts.push("Wrapped");
  parts.push(search.regexp ? "Regexp I-search" : "I-search");
  let text = parts.join(" ");
  if (!step.forward) text += " backward";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const suffix = step.error ? ` [${step.error}]` : "";
  return `${text}: ${step.string}${suffix}`;
}

function clearHighlights(search: Search) {
  if (search.current !== undefined) ember.deleteOverlay(search.current);
  search.current = undefined;
  for (const id of search.others) ember.deleteOverlay(id);
  search.others = [];
}

/** Highlights the current match, and the other matches within a few hundred lines. */
function highlight(search: Search) {
  clearHighlights(search);
  const step = top(search);
  if (step.string === "" || step.error) return;
  if (step.match && step.success) {
    search.current = ember.makeOverlay(step.match.start, step.match.end, { face: "isearch", priority: 1001 });
  }
  const max = Number(ember.variable("lazy-highlight-max-at-a-time") ?? 200);
  const line = ember.lineOf(ember.point());
  const from = ember.lineStart(Math.max(0, line - 100));
  const to = ember.lineEnd(Math.min(ember.lineCount() - 1, line + 100));
  const caseFold = ember.foldCaseFor(step.string, true);
  let pos = from;
  while (search.others.length < max) {
    const m = ember.search(step.string, { from: pos, regexp: search.regexp, bound: to, caseFold });
    if (m === undefined) break;
    if (m.end === m.start) {
      // An empty match shows nothing; step past it.
      pos = m.end + 1;
      if (pos > to) break;
      continue;
    }
    if (!(step.match && m.start === step.match.start && m.end === step.match.end)) {
      search.others.push(ember.makeOverlay(m.start, m.end, { face: "lazy-highlight", priority: 1000 }));
    }
    pos = m.end;
  }
}

/**
 * Looks for the string from a position, wrapping round to the other end of
 * the buffer if asked, and returns the step that results.
 */
function find(search: Search, string: string, from: number, forward: boolean, wrap: boolean, wrapped: boolean): Step {
  const last = top(search);
  const step: Step = { string, point: last.point, match: last.match, success: false, wrapped, forward };
  if (string === "") {
    return { ...step, success: true, match: undefined, point: last.point };
  }
  const caseFold = ember.foldCaseFor(string, true);
  try {
    let m = ember.search(string, { from, regexp: search.regexp, backward: !forward, caseFold });
    if (m === undefined && wrap) {
      step.wrapped = true;
      m = ember.search(string, {
        from: forward ? 0 : ember.bufferSize(),
        regexp: search.regexp,
        backward: !forward,
        caseFold,
      });
    }
    if (m !== undefined) {
      return { ...step, success: true, match: { start: m.start, end: m.end }, point: forward ? m.end : m.start };
    }
  } catch (e) {
    // An unfinished regular expression, such as "\\(", fails without an error.
    return { ...step, error: "incomplete input" };
  }
  return step;
}

/** Shows a step: moves point, highlights, and says where the search is. */
function show(search: Search) {
  const step = top(search);
  ember.gotoChar(step.point);
  highlight(search);
  ember.message(prompt(search));
}

function begin(forward: boolean, regexp: boolean) {
  const point = ember.point();
  active = {
    regexp,
    origin: point,
    steps: [{ string: "", point, success: true, wrapped: false, forward }],
    others: [],
  };
  ember.setOverridingMap("isearch-mode-map");
  ember.message(prompt(active));
}

/** Ends the search, leaving point where it is, as RET does. */
function finish(search: Search) {
  clearHighlights(search);
  ember.setOverridingMap(null);
  active = undefined;
  const string = top(search).string;
  if (string !== "") {
    const name = ringName(search.regexp);
    const previous = ring(search.regexp).filter((s) => s !== string);
    ember.setVariable(name, [string, ...previous].slice(0, 16));
  }
  if (ember.point() !== search.origin) {
    ember.pushMark(search.origin);
    ember.message("Mark saved where search started");
  } else {
    ember.message("");
  }
}

function current(): Search {
  if (active === undefined) throw new Error("Not searching");
  return active;
}

/** C-s and C-r: start a search, or while searching, find the next match. */
function repeat(forward: boolean, regexp: boolean) {
  if (active === undefined) {
    begin(forward, regexp);
    return;
  }
  const search = active;
  const last = top(search);
  // Searching again with nothing typed uses the last string searched for.
  if (last.string === "") {
    const previous = ring(search.regexp)[0];
    if (previous === undefined) {
      search.steps.push({ ...last, forward });
      ember.message(prompt(search));
      return;
    }
    search.steps.push(find(search, previous, last.point, forward, false, false));
    show(search);
    return;
  }
  // Turning round first moves to the other end of the current match.
  if (forward !== last.forward && last.match && last.success) {
    search.steps.push({ ...last, forward, point: forward ? last.match.end : last.match.start });
    show(search);
    return;
  }
  let from = last.point;
  if (last.match && last.match.start === last.match.end) {
    // After an empty match, start one character on so the search moves.
    from = forward ? Math.min(from + 1, ember.bufferSize()) : Math.max(from - 1, 0);
  }
  // A search that has failed wraps round to the other end of the buffer.
  const wrap = !last.success && forward === last.forward;
  if (wrap) from = forward ? 0 : ember.bufferSize();
  const step = find(search, last.string, from, forward, false, last.wrapped || wrap);
  search.steps.push(step.success || step.error ? step : { ...step, point: last.point, match: last.match });
  show(search);
}

ember.defineKeymap("isearch-mode-map");

const isearchForward = ember.defineCommand({
  name: "isearch-forward",
  doc:
    "Search forward incrementally: as you type, point moves to the next match of what you have typed.\n\n" +
    "C-s again finds the next match, and once a search fails, wraps round to the start. C-r searches backward. " +
    "DEL takes back the last character or step, C-w adds the next word from the buffer and C-y the last kill. " +
    "RET ends the search, leaving point at the match and the mark where the search started; any other key " +
    "does the same and then runs. C-g goes back to where the search started, or while it fails, removes " +
    "what does not match. Case is ignored unless the string has a capital letter.",
  run: () => repeat(true, false),
});

const isearchBackward = ember.defineCommand({
  name: "isearch-backward",
  doc: "Search backward incrementally. See isearch-forward for the keys that work while searching.",
  run: () => repeat(false, false),
});

const isearchForwardRegexp = ember.defineCommand({
  name: "isearch-forward-regexp",
  doc: "Search forward incrementally for a regular expression, in Emacs's syntax. See isearch-forward.",
  run: () => repeat(true, true),
});

const isearchBackwardRegexp = ember.defineCommand({
  name: "isearch-backward-regexp",
  doc: "Search backward incrementally for a regular expression, in Emacs's syntax. See isearch-forward.",
  run: () => repeat(false, true),
});

const repeatForward = ember.defineCommand({
  name: "isearch-repeat-forward",
  doc: "Find the next match forward of the string being searched for.",
  run: () => repeat(true, current().regexp),
});

const repeatBackward = ember.defineCommand({
  name: "isearch-repeat-backward",
  doc: "Find the next match backward of the string being searched for.",
  run: () => repeat(false, current().regexp),
});

/** Adds text to the search string and searches again from the current match. */
function extend(text: string) {
  const search = current();
  const last = top(search);
  const string = last.string + text;
  // Typing more keeps looking at the current match first: forward from its
  // start, or backward from far enough after it for the longer string to
  // match there, but not past where the search began.
  const length = Array.from(string).length;
  const from = last.match
    ? last.forward
      ? last.match.start
      : Math.min(search.origin, last.match.start + length)
    : last.point;
  const step = last.success || last.error ? find(search, string, from, last.forward, false, last.wrapped) : { ...last, string };
  search.steps.push(step.success || step.error ? step : { ...step, point: last.point, match: last.match });
  show(search);
}

/** The character a key types, if it is a printing character. */
function printingChar(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (key === "SPC") return " ";
  return Array.from(key).length === 1 ? key : undefined;
}

const printingCharCommand = ember.defineCommand({
  name: "isearch-printing-char",
  doc:
    "Add the character typed to the search string, or for any other key, end the search and run the key.\n\n" +
    "Bound as the default of isearch-mode-map, so it sees every key that map does not bind.",
  run: () => {
    const key = ember.lastKey();
    const c = printingChar(key);
    if (c !== undefined) {
      extend(c);
      return;
    }
    finish(current());
    if (key !== undefined) ember.unreadKeys(key);
  },
});

const deleteChar = ember.defineCommand({
  name: "isearch-delete-char",
  doc: "Take back the last change to the search: the last character typed, or the last C-s or C-r.",
  run: () => {
    const search = current();
    if (search.steps.length > 1) search.steps.pop();
    show(search);
  },
});

const exit = ember.defineCommand({
  name: "isearch-exit",
  doc: "End the search, leaving point at the match and the mark where the search started.",
  run: () => finish(current()),
});

const abort = ember.defineCommand({
  name: "isearch-abort",
  doc:
    "While the search fails, remove what does not match; otherwise end it and go back to where it started.",
  run: () => {
    const search = current();
    if (!top(search).success) {
      while (search.steps.length > 1 && !top(search).success) search.steps.pop();
      show(search);
      return;
    }
    clearHighlights(search);
    ember.setOverridingMap(null);
    active = undefined;
    ember.gotoChar(search.origin);
    ember.message("Quit");
  },
});

const yankWord = ember.defineCommand({
  name: "isearch-yank-word-or-char",
  doc: "Add the rest of the word after point to the search string, or the next character if point is not before a word.",
  run: () => {
    const point = ember.point();
    const size = ember.bufferSize();
    if (point >= size) return;
    const word = ember.search("\\w+", { from: point, regexp: true, caseFold: false });
    const end = word && word.start === point ? word.end : point + 1;
    extend(ember.bufferText(point, end));
  },
});

const yankKill = ember.defineCommand({
  name: "isearch-yank-kill",
  doc: "Add the last kill to the search string.",
  run: () => {
    const kill = ember.currentKill();
    if (kill !== undefined) extend(kill);
  },
});

const toggleRegexp = ember.defineCommand({
  name: "isearch-toggle-regexp",
  doc: "Switch between searching for a string and for a regular expression.",
  run: () => {
    const search = current();
    search.regexp = !search.regexp;
    const last = top(search);
    search.steps.push(find(search, last.string, search.origin, last.forward, false, false));
    show(search);
  },
});

ember.bindKey("C-s", isearchForward);
ember.bindKey("C-r", isearchBackward);
ember.bindKey("C-M-s", isearchForwardRegexp);
ember.bindKey("C-M-r", isearchBackwardRegexp);

ember.setKeymapDefault("isearch-mode-map", printingCharCommand);
for (const [keys, command] of [
  ["C-s", repeatForward],
  ["C-r", repeatBackward],
  ["C-M-s", repeatForward],
  ["C-M-r", repeatBackward],
  ["DEL", deleteChar],
  ["RET", exit],
  ["C-g", abort],
  ["C-w", yankWord],
  ["C-y", yankKill],
  ["M-r", toggleRegexp],
] as const) {
  ember.bindKey(keys, command, "isearch-mode-map");
}
