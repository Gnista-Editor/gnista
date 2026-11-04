// VERTical Interactive COmpletion, after vertico.el 2.5 and vertico-sort.el
// (https://github.com/minad/vertico): with vertico-mode on, every prompt
// that completes lists its candidates down the minibuffer, the first
// selected; C-n and C-p move, TAB puts the candidate in, RET takes it,
// M-RET takes the input as typed. Candidates are matched by the completion
// styles, as orderless adds one, and sorted by history, length and name.
//
// Copyright (C) 2021-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { completionAllCompletions, completionMetadataGet, testCompletion, type CompletionMetadata } from "minibuffer";
import { truthy } from "subr";

ember.defineVariable({ name: "vertico-count-format", doc: 'Format string used for the candidate count, as [outer, inner], or nil for none.', value: ["%-6s ", "%s/%s"] });
ember.defineVariable({ name: "vertico-group-format", doc: "Format string used for the group title, %s for the title, or nil for no titles.", value: "     %s " });
ember.defineVariable({ name: "vertico-count", doc: "Maximal number of candidates to show.", value: 10 });
ember.defineVariable({
  name: "vertico-preselect",
  doc: 'What is selected first: "prompt" the input, "first" the first candidate, "no-prompt" like first without ever selecting the input, "directory" like first but the input if it is a directory.',
  value: "directory",
});
ember.defineVariable({ name: "vertico-scroll-margin", doc: "Number of lines at the top and bottom when scrolling, between 0 and vertico-count/2.", value: 2 });
ember.defineVariable({ name: "vertico-resize", doc: 'How the minibuffer window resizes: t shrinks and grows, "grow-only" only grows, nil keeps it vertico-count high.', value: true });
ember.defineVariable({ name: "vertico-cycle", doc: "Enable cycling for vertico-next and vertico-previous.", value: false });
ember.defineVariable({
  name: "vertico-sort-function",
  doc: "Default sorting function, used if the table gives no display-sort-function: a function of the candidates.",
  value: "vertico-sort-history-length-alpha",
});
ember.defineVariable({ name: "vertico-sort-override-function", doc: "Override sort function which overrides the display-sort-function.", value: null });
ember.defineVariable({ name: "vertico-sort-history-duplicate", doc: "History position shift for duplicate history elements, which decays with vertico-sort-history-decay.", value: 10 });
ember.defineVariable({ name: "vertico-sort-history-decay", doc: "Exponential decay for the position shift of duplicate elements.", value: 10 });

ember.defineFace({ name: "vertico-multiline", doc: "Face used to highlight multiline replacement characters.", attributes: { inherit: "shadow" } });
ember.defineFace({ name: "vertico-group-title", doc: "Face used for the title text of the candidate group headlines.", attributes: { inherit: "shadow", slant: "italic" } });
ember.defineFace({ name: "vertico-group-separator", doc: "Face used for the separator lines of the candidate groups.", attributes: { inherit: "vertico-group-title", strikeThrough: true } });
ember.defineFace({ name: "vertico-current", doc: "Face used to highlight the currently selected candidate.", attributes: { inherit: "highlight", extend: true } });

type Text = string | ember.PropertizedString;

/** The open prompt's state, as vertico's buffer-local variables in the minibuffer. */
interface State {
  index: number;
  scroll: number;
  /** The input and point last worked out, or true before the first time. */
  input: [string, number] | true;
  candidates: string[];
  base: string;
  total: number;
  hilit: (c: string) => Text;
  lockCandidate: boolean;
  lockGroups: boolean;
  allGroups: string[];
  groups: string[];
  allowPrompt: boolean;
  candidatesOv: number;
  countOv: number;
  promptOv: number;
}

/** Each open prompt's state, by minibuffer depth. */
const states = new Map<number, State>();
const state = (): State | undefined => states.get(ember.minibufferDepth());

const number = (name: string, fallback: number): number => {
  const v = ember.variable(name);
  return typeof v === "number" ? v : fallback;
};

// Sorting, after vertico-sort.el.

/** The positions of the history's elements, for the base being completed, as vertico-sort--history. */
function historyPositions(base: string): Map<string, number> {
  const name = ember.minibufferInfo()?.history;
  const hist = name && name !== "t" ? ember.variable(name) : undefined;
  const list = Array.isArray(hist) ? hist.map(String) : [];
  const positions = new Map<string, number>();
  const filep = base.length > 0 && name === "file-name-history";
  const decay = -1 / (number("vertico-sort-history-duplicate", 10) * number("vertico-sort-history-decay", 10));
  list.forEach((elem, idx) => {
    if (!(base.length === 0 || elem.startsWith(base))) return;
    const sep = filep ? elem.indexOf("/", base.length) : -1;
    if (base.length > 0 || sep >= 0) elem = elem.slice(base.length, sep >= 0 ? sep + 1 : undefined);
    const r = positions.get(elem);
    positions.set(elem, r !== undefined ? r - Math.round(number("vertico-sort-history-duplicate", 10) * Math.exp(decay * idx)) : idx === 0 ? -Number.MAX_SAFE_INTEGER : idx);
  });
  return positions;
}

const lengthAlpha = (x: string, y: string): number => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
const alpha = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** Sorts by history position first, then by COMPARE, as vertico-sort--define's functions. */
function sortBy(candidates: string[], history: boolean, compare: (a: string, b: string) => number): string[] {
  const positions = history ? historyPositions(state()?.base ?? "") : new Map<string, number>();
  const inHistory: [number, string][] = [];
  const rest: string[] = [];
  for (const c of candidates) {
    const at = positions.get(c);
    if (at !== undefined) inHistory.push([at, c]);
    else rest.push(c);
  }
  inHistory.sort((a, b) => a[0] - b[0]);
  return [...inHistory.map(([, c]) => c), ...rest.sort(compare)];
}

export const sortHistoryLengthAlpha = (c: string[]): string[] => sortBy(c, true, lengthAlpha);
export const sortHistoryAlpha = (c: string[]): string[] => sortBy(c, true, alpha);
export const sortLengthAlpha = (c: string[]): string[] => sortBy(c, false, lengthAlpha);
export const sortAlpha = (c: string[]): string[] => sortBy(c, false, alpha);
ember.defun("vertico-sort-history-length-alpha", sortHistoryLengthAlpha);
ember.defun("vertico-sort-history-alpha", sortHistoryAlpha);
ember.defun("vertico-sort-length-alpha", sortLengthAlpha);
ember.defun("vertico-sort-alpha", sortAlpha);
ember.defun("vertico-sort-directories-first", (list: string[]) => {
  const sorted = sortHistoryLengthAlpha(list);
  return [...sorted.filter((x) => x.endsWith("/")), ...sorted.filter((x) => !x.endsWith("/"))];
});

/** The sort function: the override, the table's own, or vertico-sort-function, as vertico--sort-function. */
function sortFunction(): ((c: string[]) => string[]) | undefined {
  const override = ember.variable("vertico-sort-override-function");
  if (truthy(override)) return (c) => ember.funcall(override as string, c) as string[];
  const own = completionMetadataGet("displaySortFunction");
  if (own) return own;
  const fn = ember.variable("vertico-sort-function");
  return truthy(fn) ? (c) => ember.funcall(fn as string, c) as string[] : undefined;
}

// Working out the candidates.

function moveToFront(elem: string, list: string[]): string[] {
  const at = list.indexOf(elem);
  return at < 0 ? list : [elem, ...list.slice(0, at), ...list.slice(at + 1)];
}

/** Groups the candidates by FUN's titles, the groups in order of their first candidate, as vertico--group-by. */
function groupBy(fun: NonNullable<CompletionMetadata["groupFunction"]>, elems: string[], s: State): [string[], string[], string[]] {
  const groups = new Map<string, string[]>();
  for (const e of elems) {
    const title = fun(e, false) ?? "";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title)!.push(e);
  }
  let titles = [...groups.keys()];
  if (s.lockGroups) {
    const first = s.allGroups.find((g) => groups.has(g));
    if (first !== undefined) {
      const at = titles.indexOf(first);
      titles = [...titles.slice(at), ...titles.slice(0, at)];
    }
  }
  const all = titles.flatMap((t) => groups.get(t)!);
  const unseen = [...groups.keys()].some((g) => !s.allGroups.includes(g));
  return [all, titles, unseen || s.allGroups.length === 0 ? titles : s.allGroups];
}

/** Works the candidates out afresh for the input and point, as vertico--recompute. */
function recompute(s: State, pt: number, content: string): void {
  const info = ember.minibufferInfo();
  const found = completionAllCompletions(ember.minibufferPromptEnd() + pt);
  if (!found) return;
  const field = found.field.before + found.field.after;
  const completingFile = completionMetadataGet("category") === "file";
  let all = found.completions;
  if (completingFile) all = all.filter((c) => c !== "./" && c !== "../");
  s.base = found.base;
  const sort = sortFunction();
  if (sort) all = sort(all);
  all = all.filter((c, i) => i === 0 || c !== all[i - 1]);
  const def = info?.default ?? undefined;
  if (typeof def === "string") all = moveToFront(def, all);
  if (completingFile && !field.endsWith("/")) all = moveToFront(`${field}/`, all);
  all = moveToFront(field, all);
  const groupFun = completionMetadataGet("groupFunction");
  let groups: [string[], string[], string[]] | undefined;
  if (groupFun && all.length > 0) {
    groups = groupBy(groupFun, all, s);
    all = groups[0];
  }
  const defMissing = typeof def === "string" && def !== "" && content === "" && !all.includes(def);
  // The candidate selected before stays selected, if it is still there.
  let lock: number | undefined;
  if (s.lockCandidate) {
    const at = s.index < 0 ? -1 : all.indexOf(s.candidates[s.index]);
    lock = s.index < 0 || at >= 0 ? at : undefined;
  }
  const preselect = String(ember.variable("vertico-preselect"));
  s.candidates = all;
  s.total = all.length;
  s.hilit = found.hilit ?? ((c) => c);
  s.allowPrompt = preselect !== "no-prompt" && (defMissing || preselect === "prompt" || !info?.requireMatch);
  s.lockCandidate = lock !== undefined;
  s.groups = groups?.[1] ?? [];
  s.allGroups = groups?.[2] ?? s.allGroups;
  s.index =
    lock ??
    (defMissing || preselect === "prompt" || all.length === 0 ||
    (completingFile && preselect === "directory" && found.base.length === content.length && testCompletion(content))
      ? -1
      : 0);
}

/** Works the candidates out if the input or point changed, as vertico--update. */
function update(s: State): void {
  const pt = Math.max(0, ember.point() - ember.minibufferPromptEnd());
  const content = ember.minibufferContents();
  if (s.input !== true && s.input[0] === content && s.input[1] === pt) return;
  recompute(s, pt, content);
  s.input = [content, pt];
}

// Showing them.

/** Each candidate with its prefix and suffix, as vertico--affixate. */
function affixate(cands: Text[]): [Text, Text, Text][] {
  const plain = cands.map(String);
  const aff = completionMetadataGet("affixationFunction");
  if (aff) return aff(plain).map(([, p, x], i) => [cands[i], p, x]);
  const ann = completionMetadataGet("annotationFunction");
  if (ann) {
    return cands.map((c, i) => {
      const suffix = ann(plain[i]) ?? "";
      return [c, "", typeof suffix === "string" ? ember.propertize(suffix, { face: "completions-annotations" }) : suffix];
    });
  }
  return cands.map((c) => [c, "", ""]);
}

/** The new scroll position, as vertico--compute-scroll. */
function computeScroll(s: State): void {
  const count = number("vertico-count", 10);
  const margin = number("vertico-scroll-margin", 2);
  const off = Math.max(Math.min(margin, Math.trunc(count / 2)), 0);
  const corr = margin === Math.trunc(count / 2) ? (count % 2) - 1 : 0;
  s.scroll = Math.min(Math.max(0, s.total - count), Math.max(0, s.index + off + 1 - count, Math.min(s.index - off - corr, s.scroll)));
}

function minibufferWidth(): number {
  return ember.windowSize(ember.minibufferWindow())?.width ?? 80;
}

/** A group's title line, as vertico--format-group-title. */
function formatGroupTitle(title: string): Text {
  const format = ember.variable("vertico-group-format");
  if (typeof format !== "string") return "";
  const [before, after] = format.split("%s");
  const width = Math.max(0, minibufferWidth() - 1 - before.length - title.length - (after ?? "").length);
  return ember.concat(
    ember.propertize(before.slice(0, 4), { face: "vertico-group-separator" }),
    ember.propertize(`${before.slice(4)}${title}${after ?? ""}`, { face: "vertico-group-title" }),
    ember.propertize(" ".repeat(width), { face: "vertico-group-separator" }),
    "\n",
  );
}

/** The lines of candidates to show, around the selected one, as vertico--arrange-candidates. */
function arrangeCandidates(s: State): Text[] {
  computeScroll(s);
  const count = number("vertico-count", 10);
  const groupFun = ember.variable("vertico-group-format") ? completionMetadataGet("groupFunction") : undefined;
  const shown = s.candidates.slice(s.scroll, s.scroll + count);
  const cands = affixate(shown.map((c) => s.hilit(c)));
  const lines: (Text | [number, Text, Text, Text])[] = [];
  let title: string | undefined;
  let currLine = 0;
  cands.forEach(([cand, prefix, suffix], k) => {
    const index = s.scroll + k;
    let shownCand = cand;
    if (groupFun) {
      const newTitle = groupFun(shown[k], false);
      if (newTitle !== undefined && newTitle !== title) {
        title = newTitle;
        lines.push(formatGroupTitle(title));
      }
      const transformed = groupFun(shown[k], true);
      if (transformed !== undefined) shownCand = transformed;
    }
    if (index === s.index) currLine = lines.length;
    lines.push([index, shownCand, prefix, suffix]);
  });
  for (let total = lines.length; total > count; total--) {
    if (currLine < Math.trunc(total / 2)) lines.pop();
    else {
      currLine--;
      lines.shift();
    }
  }
  return lines.map((line) => {
    if (!Array.isArray(line)) return line;
    const [index, cand, prefix, suffix] = line;
    let text: Text = String(cand).includes("\n") ? String(cand).replace(/\n/g, "↲") : cand;
    text = ember.concat(prefix, text, suffix, "\n");
    if (index === s.index) {
      text = ember.concat(...splitFaces(text, "vertico-current"));
    }
    return text;
  });
}

/** TEXT with FACE added under the faces it has, as add-face-text-property with APPEND. */
function splitFaces(text: Text, face: string): Text[] {
  if (typeof text === "string") return [ember.propertize(text, { face })];
  // A propertized string: its runs, each with FACE after its own.
  const runs = (text as unknown as { string: string; properties: [number, number, { [name: string]: ember.Value }][] }).properties ?? [];
  const string = String(text);
  const out: Text[] = [];
  let at = 0;
  for (const [start, end, props] of [...runs].sort((a, b) => a[0] - b[0])) {
    if (start > at) out.push(ember.propertize(string.slice(at, start), { face }));
    const own = props.face;
    out.push(ember.propertize(string.slice(start, end), { ...props, face: own ? [...(Array.isArray(own) ? own : [own]), face] : face }));
    at = end;
  }
  if (at < string.length) out.push(ember.propertize(string.slice(at), { face }));
  return out;
}

/** The count before the prompt, as vertico--format-count. */
function formatCount(s: State): string {
  const format = ember.variable("vertico-count-format");
  if (!Array.isArray(format)) return "";
  const which = s.index >= 0 ? String(s.index + 1) : s.allowPrompt ? "*" : "!";
  const inner = String(format[1]).replace("%s", which).replace("%s", String(s.total));
  const outer = String(format[0]);
  const m = /%(-?)(\d*)s/.exec(outer);
  if (!m) return outer;
  const padded = m[1] ? inner.padEnd(Number(m[2] || 0)) : inner.padStart(Number(m[2] || 0));
  return outer.replace(m[0], padded);
}

/** Shows the count, the prompt's selection and the candidates, as vertico--exhibit. */
function exhibit(): void {
  const s = state();
  if (!s) return;
  ember.letBind({ "buffer-undo-list": true }, () => {
    update(s);
    ember.moveOverlay(s.promptOv, ember.minibufferPromptEnd(), ember.pointMax());
    ember.overlayPut(s.promptOv, "face", s.index < 0 && s.allowPrompt ? "vertico-current" : null);
    ember.moveOverlay(s.countOv, ember.pointMin(), ember.pointMin());
    ember.overlayPut(s.countOv, "before-string", formatCount(s));
    const lines = arrangeCandidates(s);
    ember.moveOverlay(s.candidatesOv, ember.pointMax(), ember.pointMax());
    ember.overlayPut(s.candidatesOv, "after-string", ember.concat(ember.propertize(" ", { cursor: true }), ...(lines.length > 0 ? ["\n"] : []), ...lines));
  });
}

/** Works the candidates out before a vertico command runs, so it sees them for the input, as vertico--prepare. */
function prepare(): void {
  const s = state();
  const command = ember.thisCommand();
  if (s && command?.startsWith("vertico-")) update(s);
}

/** Sets vertico up in the minibuffer of a prompt that completes, as vertico--setup. */
function setup(): void {
  if (!truthy(ember.variable("vertico-mode")) || !ember.minibufferInfo()?.completing) return;
  // The minibuffer may grow to the frame's height for vertico-count lines,
  // and shrinks with them only as vertico-resize t says, as
  // vertico--resize-window has it.
  for (const [name, value] of [
    ["completion-auto-help", null],
    ["completion-show-inline-help", null],
    ["max-mini-window-height", 1.0],
    ["resize-mini-windows", ember.variable("vertico-resize") === true ? true : "grow-only"],
  ] as const) {
    ember.makeLocalVariable(name);
    ember.setVariable(name, value);
  }
  const s: State = {
    index: -1,
    scroll: 0,
    input: true,
    candidates: [],
    base: "",
    total: 0,
    hilit: (c) => c,
    lockCandidate: false,
    lockGroups: false,
    allGroups: [],
    groups: [],
    allowPrompt: false,
    candidatesOv: ember.makeOverlay(ember.pointMax(), ember.pointMax()),
    countOv: ember.makeOverlay(ember.pointMin(), ember.pointMin()),
    promptOv: ember.makeOverlay(ember.minibufferPromptEnd(), ember.pointMax()),
  };
  ember.overlayPut(s.countOv, "priority", 1);
  states.set(ember.minibufferDepth(), s);
  ember.composeLocalMap("vertico-map");
  ember.addHook("pre-command-hook", prepare, { local: true });
  ember.addHook("post-command-hook", exhibit, { local: true });
  exhibit();
}

ember.addHook("minibuffer-setup-hook", setup);
ember.addHook("minibuffer-exit-hook", () => {
  const s = state();
  if (!s) return;
  for (const ov of [s.candidatesOv, s.countOv, s.promptOv]) ember.deleteOverlay(ov);
  states.delete(ember.minibufferDepth());
});

// Commands.

/** Selects the candidate at INDEX, or the input, as vertico--goto. */
function goTo(s: State, index: number): void {
  s.index = Math.max(s.allowPrompt || s.total === 0 ? -1 : 0, Math.min(index, s.total - 1));
  s.lockCandidate = s.index >= 0 || s.allowPrompt;
}

/** The selected candidate with its base, or the input, or the default for empty input, as vertico--candidate. */
export function candidate(): string | undefined {
  const s = state();
  if (!s) return undefined;
  const content = s.input === true ? ember.minibufferContents() : s.input[0];
  if (s.index >= 0) return s.base + s.candidates[s.index];
  const def = ember.minibufferInfo()?.default;
  if (content === "" && def) return def;
  return content;
}
ember.defun("vertico--candidate", () => candidate());

/** Works the candidates out again and shows them, as when a table's names changed between commands, as consult--vertico-refresh does. */
ember.defun("vertico--refresh", () => {
  const s = state();
  if (!s) return;
  s.input = true;
  exhibit();
});

/** Whether INPUT may be the answer, as vertico--match-p. */
function matchP(input: string): boolean {
  if (!ember.minibufferInfo()?.requireMatch || input === "" || testCompletion(input)) return true;
  ember.message("Match required");
  return false;
}

const withState = (fn: (s: State) => void) => () => {
  const s = state();
  if (s) fn(s);
};

const first = ember.defineCommand({
  name: "vertico-first",
  doc: "Go to first candidate, or to the prompt when the first candidate is selected.",
  run: withState((s) => goTo(s, s.index > 0 ? 0 : -1)),
});
const last = ember.defineCommand({ name: "vertico-last", doc: "Go to last candidate.", run: withState((s) => goTo(s, s.total - 1)) });

const scrollDown = ember.defineCommand({
  name: "vertico-scroll-down",
  doc: "Go back by N pages.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => withState((s) => goTo(s, Math.max(0, s.index - n * number("vertico-count", 10))))(),
});
const scrollUp = ember.defineCommand({
  name: "vertico-scroll-up",
  doc: "Go forward by N pages.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => withState((s) => goTo(s, Math.max(0, s.index + n * number("vertico-count", 10))))(),
});

/** Moves N candidates on, cycling if vertico-cycle says, as vertico-next. */
function next(n: number): void {
  const s = state();
  if (!s) return;
  const index = s.index + n;
  const mod = (a: number, b: number) => ((a % b) + b) % b;
  goTo(
    s,
    !truthy(ember.variable("vertico-cycle"))
      ? index
      : s.total === 0
        ? -1
        : s.allowPrompt
          ? mod(index + 1, s.total + 1) - 1
          : mod(index, s.total),
  );
}

const nextCommand = ember.defineCommand({
  name: "vertico-next",
  doc: "Go forward N candidates.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => next(n),
});
const previousCommand = ember.defineCommand({
  name: "vertico-previous",
  doc: "Go backward N candidates.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => next(-n),
});

/** Puts the selected candidate in the minibuffer, as vertico-insert. */
function insert(): void {
  const s = state();
  if (!s || s.total === 0) return;
  const saved = s.index;
  s.index = Math.max(0, s.index);
  const cand = candidate()!;
  s.index = saved;
  ember.deleteRegion(ember.minibufferPromptEnd(), ember.pointMax());
  ember.insert(cand);
}

const insertCommand = ember.defineCommand({ name: "vertico-insert", doc: "Insert current candidate in minibuffer.", run: () => insert() });

const exitCommand = ember.defineCommand({
  name: "vertico-exit",
  doc: "Exit minibuffer with current candidate, or with the input if given a prefix argument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.Value) => {
    const s = state();
    if (s && !truthy(arg) && s.index >= 0) insert();
    if (matchP(ember.minibufferContents())) ember.call("exit-minibuffer");
  },
});

const exitInput = ember.defineCommand({
  name: "vertico-exit-input",
  doc: "Exit minibuffer with input.",
  run: () => ember.callWithPrefix([4], exitCommand),
});

const saveCommand = ember.defineCommand({
  name: "vertico-save",
  doc: "Save current candidate to kill ring.",
  run: () => {
    if (ember.regionActive()) ember.call("kill-ring-save");
    else ember.killNew(candidate() ?? "");
  },
});

/** Cycles the groups N on, as vertico-next-group; a zero prefix argument resets their order. */
function nextGroup(n: number): void {
  const s = state();
  if (!s || s.groups.length < 2) return;
  s.lockGroups = n !== 0;
  if (s.lockGroups) {
    const len = s.groups.length;
    const by = len - (((-n % len) + len) % len);
    s.groups = [...s.groups.slice(by % len), ...s.groups.slice(0, by % len)];
    const at = s.allGroups.indexOf(s.groups[0]);
    if (at >= 0) s.allGroups = [...s.allGroups.slice(at), ...s.allGroups.slice(0, at)];
  } else {
    s.groups = [];
    s.allGroups = [];
  }
  s.lockCandidate = false;
  s.input = true;
}

const nextGroupCommand = ember.defineCommand({
  name: "vertico-next-group",
  doc: "Cycle N groups forward. When the prefix argument is 0, the group order is reset.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => nextGroup(n),
});
const previousGroupCommand = ember.defineCommand({
  name: "vertico-previous-group",
  doc: "Cycle N groups backward. When the prefix argument is 0, the group order is reset.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => nextGroup(-n),
});

ember.defineKeymap("vertico-map");
for (const [from, to] of [
  ["beginning-of-buffer", first],
  ["end-of-buffer", last],
  ["scroll-down-command", scrollDown],
  ["scroll-up-command", scrollUp],
  ["next-line", nextCommand],
  ["previous-line", previousCommand],
  ["backward-paragraph", previousGroupCommand],
  ["forward-paragraph", nextGroupCommand],
  ["exit-minibuffer", exitCommand],
  ["minibuffer-complete-and-exit", exitCommand],
  ["kill-ring-save", saveCommand],
] as const) {
  ember.remapCommand("vertico-map", from as ember.CommandName, to);
}
// Emacs's minibuffer has these on next-line-or-history-element, which vertico remaps.
ember.defineKey("vertico-map", "<down>", nextCommand);
ember.defineKey("vertico-map", "<up>", previousCommand);
ember.defineKey("vertico-map", "M-RET", exitInput);
ember.defineKey("vertico-map", "TAB", insertCommand);

ember.defineMinorMode({
  name: "vertico-mode",
  global: true,
  doc: "VERTical Interactive COmpletion: list the candidates of every prompt that completes down the minibuffer. Turning it on turns icomplete's modes off, as both would list them.",
  onChange: (enabled) => {
    if (!enabled) return;
    for (const mode of ["fido-vertical-mode", "icomplete-vertical-mode", "fido-mode", "icomplete-mode"]) {
      if (truthy(ember.variable(mode))) ember.callWithPrefix(-1, mode as ember.CommandName);
    }
  },
});
