// Highlighting by regexp, after Emacs's hi-lock.el: M-s h r highlights the
// matches of a regexp in a face, M-s h p a phrase, M-s h . the symbol at
// point, M-s h l whole lines, and M-s h u takes one away. As Emacs does in
// a buffer without font-lock rules, the matches get overlays, so text typed
// later is not highlighted.

import { PerBuffer, regexpQuote } from "subr";

for (const [name, background, foreground, bold] of [
  ["hi-yellow", "#ffff00", "#000000", false],
  ["hi-pink", "#ffc0cb", "#000000", false],
  ["hi-green", "#90ee90", "#000000", false],
  ["hi-blue", "#add8e6", "#000000", false],
  ["hi-salmon", "#ffa07a", "#000000", false],
  ["hi-aquamarine", "#7fffd4", "#000000", false],
  ["hi-black-b", undefined, undefined, true],
  ["hi-blue-b", undefined, "#0000ff", true],
  ["hi-green-b", undefined, "#00ff00", true],
  ["hi-red-b", undefined, "#ff0000", true],
  ["hi-black-hb", undefined, undefined, true],
] as const) {
  const attributes: e8.FaceAttributes = {};
  if (background !== undefined) attributes.background = background;
  if (foreground !== undefined) attributes.foreground = foreground;
  if (bold) attributes.bold = true;
  e8.defineFace({ name, doc: `A face for highlighting with hi-lock: ${name.replace("hi-", "").replace("-hb", " bold and big").replace("-b", " bold")}.`, attributes });
}

e8.defineVariable({
  name: "hi-lock-face-defaults",
  doc: "The faces hi-lock offers, in order.",
  value: ["hi-yellow", "hi-pink", "hi-green", "hi-blue", "hi-salmon", "hi-aquamarine", "hi-black-b", "hi-blue-b", "hi-red-b", "hi-green-b", "hi-black-hb"],
});
e8.defineVariable({ name: "hi-lock-auto-select-face", doc: "Whether hi-lock takes the next unused face without asking.", value: false });

/** A highlighting: what it matches, the name it goes by, its face, and its overlays. */
interface Pattern {
  regexp: string;
  lighter: string;
  face: string;
  overlays: number[];
}

/** Each buffer's highlightings, newest first, as hi-lock-interactive-patterns. */
const patterns = new PerBuffer<Pattern[]>();
/** Faces not used yet in each buffer, as hi-lock--unused-faces. */
const unused = new PerBuffer<string[]>();

const defaults = (): string[] => ((e8.variable("hi-lock-face-defaults") ?? []) as string[]).map(String);
const mine = (): Pattern[] => patterns.get(e8.bufferName()) ?? [];

e8.defineMinorMode({
  name: "hi-lock-mode",
  lighter: " Hi",
  doc: "Highlight text matching regexps, set with M-s h r and the other M-s h keys.",
  onChange: (on) => {
    if (on) return;
    for (const p of mine()) for (const o of p.overlays) e8.deleteOverlay(o);
    patterns.delete(e8.bufferName());
  },
});

/** Whether a regexp search folds case here, as hi-lock decides with search-upper-case. */
function foldsCase(regexp: string): boolean {
  const on = (v: e8.Value | undefined) => v !== null && v !== undefined && v !== false;
  if (!on(e8.variable("case-fold-search"))) return false;
  if (!on(e8.variable("search-upper-case"))) return true;
  return !/[A-Z]/u.test(regexp.replace(/\\./g, ""));
}

/** Reads the face to highlight with, offering the next unused one, as hi-lock-read-face-name. */
async function readFaceName(prefix: e8.PrefixArg): Promise<string> {
  const buffer = e8.bufferName();
  if (mine().length === 0) unused.set(buffer, defaults());
  const last = mine()[0]?.face;
  const all = defaults();
  const offered = [...new Set([...(unused.get(buffer) ?? []), ...(last === undefined ? [] : all.slice(all.indexOf(last) + 1)), ...all])];
  let face: string;
  if (e8.variable("hi-lock-auto-select-face") === true && prefix === null) {
    face = unused.get(buffer)?.shift() ?? offered[0]!;
  } else {
    const answer = await e8.completingRead(`Highlight using face (default ${offered[0]}): `, offered, { history: "face-name-history" });
    face = answer === "" ? offered[0]! : answer;
    unused.set(buffer, (unused.get(buffer) ?? []).filter((f) => f !== face));
  }
  return face;
}

/** Highlights the matches of `regexp` (or its group `subexp`) in `face`, as hi-lock-set-pattern does with overlays. */
function setPattern(regexp: string, face: string, subexp = 0, lighter?: string, caseFold = foldsCase(regexp)): void {
  const buffer = e8.bufferName();
  const list = mine();
  if (list.some((p) => p.regexp === regexp || p.lighter === (lighter ?? regexp))) {
    unused.set(buffer, [face, ...(unused.get(buffer) ?? []).filter((f) => f !== face)]);
    return;
  }
  if (e8.variable("hi-lock-mode") !== true) e8.call("hi-lock-mode");
  const pattern: Pattern = { regexp, lighter: lighter ?? regexp, face, overlays: [] };
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    while (e8.reSearchForward(regexp, { noerror: true, caseFold }) !== undefined) {
      const [b, e] = [e8.matchBeginning(subexp), e8.matchEnd(subexp)];
      if (b !== undefined && e !== undefined) {
        pattern.overlays.push(e8.makeOverlay(b, e, { face, priority: 1, "hi-lock-overlay": true, "hi-lock-overlay-regexp": regexp }));
      }
      // An empty match must not stop the search where it is.
      if (e8.matchBeginning(0) === e8.matchEnd(0)) {
        if (e8.point() >= e8.pointMax()) break;
        e8.gotoChar(e8.point() + 1);
      }
    }
  });
  patterns.set(buffer, [pattern, ...list]);
  if (pattern.overlays.length === 0) e8.message(`No matches for "${regexp}"`);
}

/** Reads a regexp for the highlighting commands, offering the last one, as read-regexp. */
async function readRegexp(prompt: string, def?: string): Promise<string> {
  const history = e8.variable("regexp-history");
  const last = def ?? (Array.isArray(history) && typeof history[0] === "string" ? history[0] : undefined);
  const answer = await e8.readString(last === undefined ? `${prompt}: ` : `${prompt} (default ${last}): `, { history: "regexp-history" });
  const regexp = answer === "" && last !== undefined ? last : answer;
  if (regexp === "") e8.userError("Empty regexp");
  return regexp;
}

e8.defineCommand({
  name: "highlight-regexp",
  doc:
    "Highlight the matches of a regexp in a face, asked for, the next unused one by default; with a prefix argument, " +
    "only that group of the regexp. With the region active, its text is the default regexp.",
  params: [{ name: "subexp", kind: "prefix" }],
  run: async (subexp: e8.PrefixArg) => {
    const mark = e8.mark();
    let def: string | undefined;
    if (e8.regionActive() && mark !== undefined) {
      def = e8.bufferSubstringNoProperties(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
      e8.deactivateMark();
    }
    const regexp = await readRegexp("Regexp to highlight", def);
    const face = await readFaceName(null);
    setPattern(regexp, face, subexp === null ? 0 : e8.prefixNumericValue(subexp));
  },
});
e8.defalias("hi-lock-face-buffer", "highlight-regexp");

e8.defineCommand({
  name: "highlight-phrase",
  doc: "Highlight a phrase, its spaces matching any run of spaces, tabs and newlines, in a face asked for.",
  run: async () => {
    const phrase = await readRegexp("Phrase to highlight");
    const face = await readFaceName(null);
    // As search-whitespace-regexp makes each run of spaces match.
    setPattern(phrase.replace(/ +/g, "[ \\t\\n]+"), face, 0, phrase, foldsCase(phrase));
  },
});
e8.defalias("hi-lock-face-phrase-buffer", "highlight-phrase");

e8.defineCommand({
  name: "highlight-lines-matching-regexp",
  doc: "Highlight the whole lines that have a match for a regexp, in a face asked for.",
  run: async () => {
    const regexp = await readRegexp("Regexp to highlight line");
    const face = await readFaceName(null);
    setPattern(`^.*\\(?:${regexp}\\).*\\(?:$\\)\n?`, face, 0, undefined, foldsCase(regexp));
  },
});
e8.defalias("hi-lock-line-face-buffer", "highlight-lines-matching-regexp");

e8.defineCommand({
  name: "highlight-symbol-at-point",
  doc: "Highlight the symbol at point wherever it is in the buffer, in the next unused face.",
  run: () => {
    const re = "\\(?:\\sw\\|\\s_\\)+";
    const symbol = e8.saveExcursion(() => {
      if (!e8.lookingAt(re)) e8.skipSyntaxBackward("w_");
      e8.skipSyntaxBackward("w_");
      return e8.lookingAt(re) ? e8.matchString(0) : undefined;
    });
    if (symbol === undefined || symbol === "") e8.userError("No symbol at point");
    const buffer = e8.bufferName();
    if (mine().length === 0) unused.set(buffer, defaults());
    const face = unused.get(buffer)?.shift() ?? defaults()[0]!;
    const regexp = `\\_<${regexpQuote(symbol!)}\\_>`;
    setPattern(regexp, face, 0, undefined, foldsCase(symbol!));
  },
});
e8.defalias("hi-lock-face-symbol-at-point", "highlight-symbol-at-point");

e8.defineCommand({
  name: "unhighlight-regexp",
  doc: "Take a highlighting away, the one at point by default; with a prefix argument, all of them.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: e8.PrefixArg) => {
    const buffer = e8.bufferName();
    const list = mine();
    let gone: Pattern[];
    if (arg !== null) {
      gone = list;
    } else {
      if (list.length === 0) e8.userError("No highlighting to remove");
      // The highlighting at point first, as hi-lock--regexps-at-point.
      const at = list.filter((p) => p.overlays.some((o) => e8.overlaysIn(e8.point(), e8.point() + 1).includes(o)));
      const def = (at[0] ?? list[0])!.lighter;
      const answer = await e8.completingRead(`Regexp to unhighlight (default ${def}): `, list.map((p) => p.lighter), { requireMatch: true });
      const name = answer === "" ? def : answer;
      gone = list.filter((p) => p.lighter === name);
    }
    for (const p of gone) {
      for (const o of p.overlays) e8.deleteOverlay(o);
      // Its face is the next one offered.
      unused.set(buffer, [p.face, ...(unused.get(buffer) ?? []).filter((f) => f !== p.face)]);
    }
    patterns.set(buffer, list.filter((p) => !gone.includes(p)));
  },
});
e8.defalias("hi-lock-unface-buffer", "unhighlight-regexp");

for (const [keys, command] of [
  ["M-s h r", "highlight-regexp"],
  ["M-s h p", "highlight-phrase"],
  ["M-s h l", "highlight-lines-matching-regexp"],
  ["M-s h .", "highlight-symbol-at-point"],
  ["M-s h u", "unhighlight-regexp"],
] as const) {
  e8.bindKey(keys, command);
}
