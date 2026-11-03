// Consult, after consult.el 2.x and its consult-imenu, consult-compile,
// consult-xref, consult-register and consult-kmacro
// (https://github.com/minad/consult): commands that read with completion,
// previewing the candidate the selection is on and narrowing by kind.
// consult-line finds a line, consult-buffer a buffer, recent file or
// bookmark, consult-ripgrep and consult-grep search files as you type,
// consult-goto-line, -outline, -imenu, -mark and -compile-error go
// somewhere, consult-yank-pop yanks from the kill ring, consult-history
// takes earlier input.
//
// Copyright (C) 2021-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { jumpTo as bookmarkJumpTo } from "bookmark";
import { makeIndex, type IndexItem } from "imenu";
import { completingReadWithMetadata, type CompletionMetadata } from "minibuffer";
import { current as projectCurrent } from "project";
import { truthy } from "subr";

ember.defineVariable({ name: "consult-narrow-key", doc: 'The prefix key for narrowing, such as "<": "< b" narrows consult-buffer to buffers. Typing a narrowing key and SPC on empty input narrows too.', value: null });
ember.defineVariable({ name: "consult-widen-key", doc: "The key that widens again; by default the narrow key twice.", value: null });
ember.defineVariable({ name: "consult-preview-key", doc: 'When to preview: "any" key, keys such as ["S-<down>", "S-<up>"], or nil never; with [":debounce", seconds, ...] to wait first.', value: "any" });
ember.defineVariable({ name: "consult-async-min-input", doc: "How many characters an async command such as consult-ripgrep needs before it searches.", value: 3 });
ember.defineVariable({ name: "consult-async-split-style", doc: 'How async input splits into the search and a filter: "perl", #search#filter.', value: "perl" });
ember.defineVariable({ name: "consult-line-start-from-top", doc: "Whether consult-line lists the lines from the top rather than from point.", value: false });
ember.defineVariable({ name: "consult-line-numbers-widen", doc: "Whether line numbers count from the start of the whole buffer when it is narrowed.", value: true });
ember.defineVariable({ name: "consult-point-placement", doc: 'Where consult-line puts point on the line: "match-beginning", "match-end" or "line-beginning".', value: "match-beginning" });
ember.defineVariable({
  name: "consult-buffer-filter",
  doc: "Regexps of the names of buffers consult-buffer leaves out, unless narrowed to hidden ones.",
  value: ["\\` ", "\\`\\*Completions\\*\\'", "\\`\\*Flymake log\\*\\'", "\\`\\*Semantic SymRef\\*\\'", "\\`\\*vc\\*\\'", "\\`newsrc-dribble\\'", "\\`\\*tramp/.*\\*\\'"],
});
ember.defineVariable({ name: "consult-ripgrep-args", doc: "The ripgrep command consult-ripgrep runs, before the pattern.", value: "rg --null --line-buffered --color=never --max-columns=1000 --path-separator / --smart-case --no-heading --with-filename --line-number --search-zip" });
ember.defineVariable({ name: "consult-grep-args", doc: "The grep command consult-grep runs, before the pattern.", value: "grep --null --line-buffered --color=never --ignore-case --exclude-dir=.git --line-number -I -r" });
ember.defineVariable({ name: "consult-find-args", doc: "The find command consult-find runs.", value: "find . -not ( -path */.[A-Za-z]* -prune )" });
ember.defineVariable({ name: "consult-grep-max-columns", doc: "How much of a long matching line consult-grep shows.", value: 300 });
ember.defineVariable({ name: "consult-mode-histories", doc: "The history of each mode, as [mode, history] pairs, for consult-history.", value: [["eshell-mode", "eshell-history-ring"], ["comint-mode", "comint-input-ring"], ["term-mode", "term-input-ring"]] });
ember.defineHook("consult-after-jump-hook", "Functions called after consult jumps to a place.");

const faceSpecs: [string, ember.FaceAttributes][] = [
  ["consult-preview-insertion", { inherit: "region" }],
  ["consult-preview-line", { inherit: "consult-preview-insertion", extend: true }],
  ["consult-highlight-match", { inherit: "match" }],
  ["consult-preview-match", { inherit: "isearch" }],
  ["consult-narrow-indicator", { inherit: "warning" }],
  ["consult-async-running", { inherit: "consult-narrow-indicator" }],
  ["consult-async-finished", { inherit: "success" }],
  ["consult-async-failed", { inherit: "error" }],
  ["consult-async-split", { inherit: "font-lock-negation-char-face" }],
  ["consult-help", { inherit: "shadow" }],
  ["consult-key", { inherit: "font-lock-keyword-face" }],
  ["consult-line-number", { inherit: "consult-key" }],
  ["consult-file", { inherit: "font-lock-function-name-face" }],
  ["consult-grep-context", { inherit: "shadow" }],
  ["consult-bookmark", { inherit: "font-lock-constant-face" }],
  ["consult-buffer", {}],
  ["consult-line-number-prefix", { inherit: "line-number" }],
  ["consult-line-number-wrapped", { inherit: ["consult-line-number-prefix", "font-lock-warning-face"] as unknown as string }],
  ["consult-separator", { inherit: "shadow" }],
];
for (const [name, attributes] of faceSpecs) ember.defineFace({ name, doc: `Face consult uses: ${name.slice(8).replace(/-/g, " ")}.`, attributes });

type Text = string | ember.PropertizedString;

// Telling candidates apart, as consult--tofu-encode: lines with the same
// text get invisible characters after them, zero-width here.

const TOFU = ["​", "‌", "‍", "⁠"];
function tofu(n: number): string {
  let s = "";
  do {
    s += TOFU[n % 4];
    n = Math.floor(n / 4);
  } while (n > 0);
  return s;
}
const stripTofu = (s: string): string => s.replace(/[​‌‍⁠]+$/u, "");

// Customizing commands, as consult-customize.

/** What consult-customize gives a command or source: its preview key, prompt, keymap and the rest. */
export interface Customization {
  previewKey?: ember.Value;
  prompt?: string;
  keymap?: string | ember.Keymap;
  initial?: string;
  [key: string]: unknown;
}
const customizations = new Map<string, Customization>();

/** Sets options for commands or sources, as consult-customize: consultCustomize(["consult-line"], { prompt: "Search: " }). */
export function consultCustomize(names: string[], options: Customization): void {
  for (const n of names) customizations.set(n, { ...customizations.get(n), ...options });
}
ember.defun("consult-customize", (names: string[], options: Customization) => consultCustomize(names, options));

// Reading with preview, as consult--read.

/** What a state function is told, as consult's state actions. */
export type StateAction = "setup" | "preview" | "exit" | "return";
export type State = (action: StateAction, cand: unknown) => void;

export interface ReadOptions {
  prompt: string;
  /** The candidates, or a function of the input for a table that changes, as consult's async tables. */
  candidates: string[] | ((input: string) => string[]);
  /** What a candidate stands for, given the candidate and the input. */
  lookup?: (cand: string, input: string) => unknown;
  state?: State;
  category?: string;
  sort?: boolean;
  group?: CompletionMetadata["groupFunction"];
  annotate?: CompletionMetadata["annotationFunction"];
  affixate?: CompletionMetadata["affixationFunction"];
  boundaries?: CompletionMetadata["boundaries"];
  requireMatch?: boolean;
  default?: string;
  initial?: string;
  history?: string;
  /** The narrowing keys, as [key, name] pairs, and the predicate that says whether a candidate shows when narrowed. */
  narrow?: { keys: [string, string][]; predicate: (cand: string, key: string) => boolean };
  keymap?: string | ember.Keymap;
  /** The command, for consult-customize. */
  command?: string;
  previewKey?: ember.Value;
}

/** The window previews show in: the one selected when the prompt opened, as minibuffer-selected-window. */
let previewWindow = 0;

/** The narrowing of the open consult prompt, by minibuffer depth. */
const narrowing = new Map<number, { options: ReadOptions; key?: string; prompt: string; overlay?: number }>();

ember.defineKeymap("consult-narrow-map");

/** Whether a candidate shows, as narrowed. */
function narrowed(options: ReadOptions, cand: string): boolean {
  const n = narrowing.get(ember.minibufferDepth());
  return !n?.key || !options.narrow || options.narrow.predicate(cand, n.key);
}

/** Narrows to KEY, or widens with none, as consult-narrow: the prompt says what it is narrowed to. */
function narrow(key: string | undefined): void {
  const n = narrowing.get(ember.minibufferDepth());
  if (!n) return;
  n.key = key;
  const name = key ? n.options.narrow?.keys.find(([k]) => k === key)?.[1] : undefined;
  // " [Buffer]" before the prompt's last character, as consult--narrow-indicator shows it.
  if (n.overlay !== undefined) ember.deleteOverlay(n.overlay);
  n.overlay = undefined;
  if (name) {
    const end = ember.minibufferPromptEnd();
    n.overlay = ember.makeOverlay(Math.max(ember.pointMin(), end - 1), end);
    ember.overlayPut(n.overlay, "before-string", ember.propertize(` [${name}]`, { face: "consult-narrow-indicator" }));
  }
  ember.refreshCompletionTable();
  if (ember.fboundp("vertico--refresh")) ember.funcall("vertico--refresh");
}

const narrowCommand = ember.defineCommand({
  name: "consult-narrow",
  doc: "Narrow the candidates to the kind the key typed names, or widen.",
  run: () => {
    const keys = ember.thisCommandKeysVector();
    const key = keys[keys.length - 1];
    const n = narrowing.get(ember.minibufferDepth());
    narrow(n?.key === key ? undefined : key);
  },
});

/** SPC after a narrowing key on empty input narrows, as consult--narrow-space; else it inserts a space. */
const narrowSpace = ember.defineCommand({
  name: "consult-narrow-space",
  doc: "Narrow by the key typed before, if the input is just one narrowing key; else insert a space.",
  run: () => {
    const n = narrowing.get(ember.minibufferDepth());
    const input = ember.minibufferContents();
    if (n?.options.narrow?.keys.some(([k]) => k === input)) {
      ember.deleteRegion(ember.minibufferPromptEnd(), ember.pointMax());
      narrow(input);
    } else {
      ember.insert(" ");
    }
  },
});

/** DEL on empty input widens, as consult--narrow-delete; else it deletes. */
const narrowDelete = ember.defineCommand({
  name: "consult-narrow-delete",
  doc: "Widen, on empty input; else delete the character before point.",
  run: () => {
    const n = narrowing.get(ember.minibufferDepth());
    if (n?.key && ember.minibufferContents() === "") narrow(undefined);
    else ember.call("delete-backward-char", 1);
  },
});

/** The selected candidate of the open prompt, as consult--completion-candidate-hook finds it: vertico's, or the input. */
function selectedCandidate(): string | undefined {
  if (ember.fboundp("vertico--candidate")) return ember.funcall("vertico--candidate") as string | undefined;
  return ember.minibufferContents();
}

/** The keys that preview, and how long to wait first, as consult--preview-key-normalize. */
function previewKeys(value: ember.Value): { any: boolean; keys: string[]; debounce: number } {
  const list = Array.isArray(value) ? value : value === null || value === undefined || value === false ? [] : [value];
  let debounce = 0;
  const keys: string[] = [];
  let any = false;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v === ":debounce") {
      debounce = Number(list[++i]);
    } else if (v === "any") {
      any = true;
    } else if (typeof v === "string") {
      keys.push(v);
    }
  }
  return { any, keys, debounce };
}

/**
 * Reads a candidate with completion, previewing it with the state
 * function as the selection moves and narrowing by kind, as consult--read;
 * returns what it stands for, or the input if it is none.
 */
export function consultRead(options: ReadOptions): { cand: string; value: unknown } | undefined {
  const custom = { ...(options.command ? customizations.get(options.command) : undefined) };
  const prompt = custom.prompt ?? options.prompt;
  const previewKey = custom.previewKey ?? options.previewKey ?? ember.variable("consult-preview-key");
  const keymap = custom.keymap ?? options.keymap;
  const state = options.state;
  const lookup = options.lookup ?? ((c: string) => c);
  const { any, keys, debounce } = previewKeys(previewKey as ember.Value);
  const depth = ember.minibufferDepth() + 1;
  const origWindow = ember.selectedWindow();
  previewWindow = origWindow;
  let last: string | undefined;
  let timer: number | undefined;
  const preview = () => {
    const cand = selectedCandidate();
    if (cand === last) return;
    last = cand;
    const value = cand === undefined ? undefined : lookup(cand, ember.minibufferContents());
    previewWindow = origWindow;
    // Showing another buffer in the window keeps the minibuffer's current.
    ember.withCurrentBuffer(ember.currentBuffer(), () => state?.("preview", value));
  };
  const postCommand = () => {
    if (!state) return;
    if (!any && !keys.includes(ember.thisCommandKeys())) return;
    if (debounce > 0) {
      if (timer !== undefined) ember.cancelTimer(timer);
      timer = ember.runWithTimer(debounce, null, () => {
        timer = undefined;
        if (ember.minibufferDepth() === depth) preview();
      });
    } else {
      preview();
    }
  };
  const setup = () => {
    if (ember.minibufferDepth() !== depth) return;
    ember.removeHook("minibuffer-setup-hook", setup);
    narrowing.set(depth, { options, prompt });
    if (options.narrow) {
      const map = ember.makeSparseKeymap();
      const nk = ember.variable("consult-narrow-key");
      for (const [k] of options.narrow.keys) if (typeof nk === "string") ember.defineKey(map, `${nk} ${k}`, narrowCommand);
      ember.defineKey(map, "SPC", narrowSpace);
      ember.defineKey(map, "DEL", narrowDelete);
      ember.composeLocalMap(map);
    }
    if (keymap) ember.composeLocalMap(keymap);
    ember.addHook("post-command-hook", postCommand, { local: true });
    state?.("setup", undefined);
    if (any && debounce === 0) preview();
  };
  ember.addHook("minibuffer-setup-hook", setup);
  const table = (input: string): string[] => {
    const all = typeof options.candidates === "function" ? options.candidates(input) : options.candidates;
    return options.narrow ? all.filter((c) => narrowed(options, c)) : all;
  };
  let answer: string | undefined;
  try {
    answer = completingReadWithMetadata(prompt, table, {
      requireMatch: options.requireMatch,
      default: options.default,
      initial: custom.initial ?? options.initial,
      history: options.history,
      category: options.category,
      metadata: {
        category: options.category,
        groupFunction: options.group,
        annotationFunction: options.annotate,
        affixationFunction: options.affixate,
        displaySortFunction: options.sort === false ? (c) => c : undefined,
        boundaries: options.boundaries,
      },
    });
  } catch (e) {
    ember.removeHook("minibuffer-setup-hook", setup);
    if (timer !== undefined) ember.cancelTimer(timer);
    narrowing.delete(depth);
    state?.("exit", undefined);
    state?.("return", undefined);
    throw e;
  }
  ember.removeHook("minibuffer-setup-hook", setup);
  if (timer !== undefined) ember.cancelTimer(timer);
  narrowing.delete(depth);
  state?.("exit", undefined);
  const value = answer === undefined ? undefined : lookup(answer, answer);
  state?.("return", value);
  return answer === undefined ? undefined : { cand: answer, value };
}

// Jumping, as consult--jump and consult--jump-preview.

/** A place: a buffer and a position in it. */
export interface Location {
  buffer: string;
  pos: number;
  /** Where matches are on the line, as [start, end] after pos. */
  matches?: [number, number][];
}

/** Goes to a place, pushing the mark first if it is in this buffer, as consult--jump. */
export function jump(loc: Location): void {
  if (ember.bufferName() !== loc.buffer) ember.call("switch-to-buffer", loc.buffer);
  else ember.pushMark(ember.point());
  if (loc.pos < ember.pointMin() || loc.pos > ember.pointMax()) ember.widen();
  ember.gotoChar(loc.pos);
  ember.runHooks("consult-after-jump-hook");
}

/** Previews places in the original window, the line highlighted, as consult--jump-preview; returning jumps. */
export function jumpState(): State {
  let restore: (() => void)[] = [];
  const undo = () => {
    for (const f of restore.reverse()) f();
    restore = [];
  };
  return (action, cand) => {
    if (action === "preview") {
      undo();
      const loc = cand as Location | undefined;
      if (!loc || !ember.bufferLiveP(ember.getBuffer(loc.buffer))) return;
      const window = previewWindow;
      const oldBuffer = ember.windowBuffer(window)!;
      const oldPoint = ember.windowPoint(window);
      const oldStart = ember.windowStart(window);
      if (oldBuffer !== loc.buffer) ember.setWindowBuffer(window, loc.buffer);
      ember.withCurrentBuffer(loc.buffer, () => {
        const line = [ember.lineBeginningPosition(loc.pos), ember.lineEndPosition(loc.pos) + 1] as const;
        const overlays = [ember.makeOverlay(line[0], Math.min(line[1], ember.pointMax()))];
        ember.overlayPut(overlays[0], "face", "consult-preview-line");
        ember.overlayPut(overlays[0], "priority", 1);
        for (const [a, b] of loc.matches ?? []) {
          const ov = ember.makeOverlay(loc.pos + a, loc.pos + b);
          ember.overlayPut(ov, "face", "consult-preview-match");
          ember.overlayPut(ov, "priority", 2);
          overlays.push(ov);
        }
        restore.push(() => {
          if (ember.bufferLiveP(ember.getBuffer(loc.buffer))) ember.withCurrentBuffer(loc.buffer, () => overlays.forEach((o) => ember.deleteOverlay(o)));
        });
      });
      ember.setWindowPoint(window, loc.pos);
      restore.push(() => {
        if (!ember.windowList().includes(window)) return;
        if (oldBuffer !== loc.buffer && ember.bufferLiveP(ember.getBuffer(oldBuffer))) ember.setWindowBuffer(window, oldBuffer);
        ember.setWindowStart(window, oldStart);
        ember.setWindowPoint(window, oldPoint);
      });
      ember.runHooks("consult-after-jump-hook");
    } else if (action === "exit") {
      undo();
    } else if (action === "return" && cand) {
      jump(cand as Location);
    }
  };
}

// consult-line.

/** The line numbers before candidates, wrapped ones in their own face, as consult--line-prefix. */
function linePrefix(lines: Map<string, number>, currLine: number): CompletionMetadata["affixationFunction"] {
  const width = String(ember.lineCount()).length;
  return (cands) =>
    cands.map((c) => {
      const line = lines.get(c) ?? 0;
      return [c, ember.propertize(`${String(line).padStart(width)} `, { face: line < currLine ? "consult-line-number-wrapped" : "consult-line-number-prefix" }), ""];
    });
}

/** The buffer's non-blank lines as candidates, from point's line on unless TOP, as consult--line-candidates. */
function lineCandidates(top: boolean, currLine: number): { cands: string[]; locs: Map<string, Location>; lines: Map<string, number> } {
  const buffer = ember.bufferName();
  const cands: string[] = [];
  const locs = new Map<string, Location>();
  const lines = new Map<string, number>();
  const first = ember.lineOf(ember.pointMin());
  const last = ember.lineOf(ember.pointMax());
  let n = 0;
  let defaultAt = -1;
  for (let line = first; line <= last; line++) {
    const text = ember.lineText(line);
    if (/^\s*$/.test(text)) continue;
    const cand = text + tofu(n++);
    cands.push(cand);
    locs.set(cand, { buffer, pos: ember.lineStart(line) });
    lines.set(cand, line + 1);
    if (defaultAt < 0 && line + 1 >= currLine) defaultAt = cands.length - 1;
  }
  if (cands.length === 0) ember.userError("No lines");
  const ordered = top || defaultAt < 0 ? cands : [...cands.slice(defaultAt), ...cands.slice(0, defaultAt)];
  return { cands: ordered, locs, lines };
}

/** Where the input matches on the line, for point to go to, as consult--line-match with consult-point-placement. */
function lineMatch(loc: Location | undefined, cand: string, input: string): Location | undefined {
  if (!loc) return undefined;
  const text = stripTofu(cand);
  const words = input.split(/ +/).filter((w) => w !== "");
  const matches: [number, number][] = [];
  for (const w of words) {
    let re: RegExp;
    try {
      re = ember.emacsRegexp(w, { caseFold: !/\p{Lu}/u.test(w) });
    } catch {
      continue;
    }
    const m = re.exec(text);
    if (m) matches.push([m.index, m.index + m[0].length]);
  }
  matches.sort((a, b) => a[0] - b[0]);
  const place = String(ember.variable("consult-point-placement"));
  const offset = matches.length === 0 || place === "line-beginning" ? 0 : place === "match-end" ? matches[0][1] : matches[0][0];
  return { ...loc, pos: loc.pos + offset, matches: matches.map(([a, b]) => [a - offset, b - offset]) };
}

export const consultLine = ember.defineCommand({
  name: "consult-line",
  doc: "Search for a matching line, previewing it, and go to the match. The lines start from point's, or the top with a prefix argument.",
  params: [{ name: "start", kind: "prefix" }],
  run: (start: ember.Value) => {
    const currLine = ember.lineOf(ember.point()) + 1;
    const top = truthy(start) !== truthy(ember.variable("consult-line-start-from-top"));
    const { cands, locs, lines } = lineCandidates(top, currLine);
    consultRead({
      command: "consult-line",
      prompt: top ? "Go to line from top: " : "Go to line: ",
      candidates: cands,
      affixate: linePrefix(lines, currLine),
      category: "consult-location",
      sort: false,
      requireMatch: true,
      history: "consult--line-history",
      default: cands[0],
      lookup: (cand, input) => lineMatch(locs.get(cand), cand, input),
      state: jumpState(),
    });
  },
});
ember.defineVariable({ name: "consult--line-history", doc: "Input consult-line was given.", value: [] });

// consult-goto-line.

export const consultGotoLine = ember.defineCommand({
  name: "consult-goto-line",
  doc: "Read a line number, previewing it as it is typed, and go to it. With a prefix argument, go there at once.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.Value) => {
    if (typeof arg === "number") {
      ember.gotoChar(ember.lineStart(Math.max(0, Math.min(arg - 1, ember.lineCount() - 1))));
      return;
    }
    const buffer = ember.bufferName();
    const origin = ember.point();
    const window = ember.selectedWindow();
    let overlay: number | undefined;
    const show = (input: string) => {
      if (overlay !== undefined) ember.withCurrentBuffer(buffer, () => ember.deleteOverlay(overlay!));
      overlay = undefined;
      const m = /^\s*(\d+)(?::(\d+))?\s*$/.exec(input);
      if (!m) return;
      ember.withCurrentBuffer(buffer, () => {
        const line = Math.max(0, Math.min(Number(m[1]) - 1, ember.lineCount() - 1));
        const pos = Math.min(ember.lineStart(line) + Number(m[2] ?? 0), ember.lineEnd(line));
        overlay = ember.makeOverlay(ember.lineStart(line), Math.min(ember.lineEnd(line) + 1, ember.pointMax()));
        ember.overlayPut(overlay, "face", "consult-preview-line");
        ember.setWindowPoint(window, pos);
      });
    };
    const setup = () => {
      ember.removeHook("minibuffer-setup-hook", setup);
      ember.addHook("post-command-hook", () => show(ember.minibufferContents()), { local: true });
    };
    ember.addHook("minibuffer-setup-hook", setup);
    let answer: string;
    try {
      answer = ember.readString("Go to line: ");
    } finally {
      ember.removeHook("minibuffer-setup-hook", setup);
      if (overlay !== undefined) ember.withCurrentBuffer(buffer, () => ember.deleteOverlay(overlay!));
      ember.setWindowPoint(window, origin);
    }
    const m = /^\s*(\d+)(?::(\d+))?\s*$/.exec(answer);
    if (!m) ember.userError("Please enter a number");
    const line = Math.max(0, Math.min(Number(m[1]) - 1, ember.lineCount() - 1));
    ember.pushMark(origin);
    ember.gotoChar(Math.min(ember.lineStart(line) + Number(m[2] ?? 0), ember.lineEnd(line)));
    ember.runHooks("consult-after-jump-hook");
  },
});

// consult-outline.

/** The headings of the buffer, as outline-regexp finds them, as consult--outline-candidates. */
function outlineCandidates(): { cands: string[]; locs: Map<string, Location>; levels: Map<string, number>; lines: Map<string, number> } {
  const buffer = ember.bufferName();
  const regexp = `^\\(?:${String(ember.variable("outline-regexp") ?? "[*\f]+")}\\)`;
  const re = ember.emacsRegexp(regexp);
  const cands: string[] = [];
  const locs = new Map<string, Location>();
  const levels = new Map<string, number>();
  const lines = new Map<string, number>();
  const last = ember.lineOf(ember.pointMax());
  let n = 0;
  for (let line = ember.lineOf(ember.pointMin()); line <= last; line++) {
    const text = ember.lineText(line);
    const m = re.exec(text);
    if (!m || m.index !== 0) continue;
    const cand = text + tofu(n++);
    cands.push(cand);
    locs.set(cand, { buffer, pos: ember.lineStart(line) });
    levels.set(cand, m[0].replace(/\s+$/, "").length);
    lines.set(cand, line + 1);
  }
  if (cands.length === 0) ember.userError("No headings");
  return { cands, locs, levels, lines };
}

export const consultOutline = ember.defineCommand({
  name: "consult-outline",
  doc: "Jump to an outline heading, previewing it; digits narrow to headings at that level or above.",
  run: () => {
    const { cands, locs, levels, lines } = outlineCandidates();
    const keys: [string, string][] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), `Level ${n}`]);
    consultRead({
      command: "consult-outline",
      prompt: "Go to heading: ",
      candidates: cands,
      affixate: linePrefix(lines, 0),
      category: "consult-location",
      sort: false,
      requireMatch: true,
      history: "consult--line-history",
      narrow: { keys, predicate: (c, k) => (levels.get(c) ?? 0) <= Number(k) },
      lookup: (c) => locs.get(c),
      state: jumpState(),
    });
  },
});

// consult-imenu, after consult-imenu.el.

/** The imenu index, flattened to "Group Item" candidates, as consult-imenu--items. */
function imenuItems(index: IndexItem[], prefix = ""): [string, number][] {
  const out: [string, number][] = [];
  for (const [name, where] of index) {
    if (typeof where === "number") out.push([prefix ? `${prefix} ${name}` : name, where]);
    else out.push(...imenuItems(where, prefix ? `${prefix} ${name}` : name));
  }
  return out;
}

export const consultImenu = ember.defineCommand({
  name: "consult-imenu",
  doc: "Jump to a place the buffer's imenu index has, previewing it, grouped as the index groups them.",
  run: () => {
    const buffer = ember.bufferName();
    const items = imenuItems(makeIndex());
    if (items.length === 0) ember.userError("No imenu items");
    const locs = new Map<string, Location>();
    const cands = items.map(([name, pos], i) => {
      const cand = name + tofu(i);
      locs.set(cand, { buffer, pos });
      return cand;
    });
    const topGroups = new Set(makeIndex().filter(([, w]) => typeof w !== "number").map(([n]) => n));
    consultRead({
      command: "consult-imenu",
      prompt: "Go to item: ",
      candidates: cands,
      category: "imenu",
      sort: false,
      requireMatch: true,
      history: "consult-imenu--history",
      group: (c, transform) => {
        const first = c.split(" ")[0];
        const grouped = topGroups.has(first);
        if (transform) return grouped ? c.slice(first.length + 1) : c;
        return grouped ? first : "";
      },
      lookup: (c) => locs.get(c),
      state: jumpState(),
    });
  },
});
ember.defineVariable({ name: "consult-imenu--history", doc: "Items consult-imenu went to.", value: [] });

// consult-buffer and its sources.

/** A source of consult-buffer's candidates, as consult--multi's sources. */
export interface Source {
  name: string;
  narrow?: string;
  hidden?: boolean;
  category: string;
  face?: string;
  history?: string;
  enabled?: () => boolean;
  items: () => string[];
  /** What choosing an item does, as :action. */
  action: (item: string) => void;
  /** What previewing an item does, or undefined for none. */
  preview?: (item: string) => void;
}

const bufferFiltered = (name: string): boolean => {
  const filter = ember.variable("consult-buffer-filter");
  return Array.isArray(filter) && filter.some((r) => ember.stringMatch(String(r), name) !== undefined);
};

/** Buffers, the selected window's first left out, then the most recently used, as consult--buffer-query with :sort visibility. */
function buffersByVisibility(): string[] {
  const current = ember.bufferName();
  const visible = new Set(ember.windowList().map((w) => ember.windowBuffer(w)));
  const all = ember.bufferList();
  const hidden = all.filter((b) => !visible.has(b));
  const shown = all.filter((b) => visible.has(b) && b !== current);
  return [...hidden, ...shown, ...(all.includes(current) ? [current] : [])];
}

const previewBuffer = (b: string) => {
  if (ember.bufferLiveP(ember.getBuffer(b))) ember.setWindowBuffer(previewWindow, b);
};
const switchTo = (b: string) => ember.call("switch-to-buffer", b);
const visitFile = (f: string) => ember.call("find-file", ember.expandFileName(f));

export const sourceHiddenBuffer: Source = {
  name: "Hidden Buffer",
  narrow: " ",
  hidden: true,
  category: "buffer",
  history: "buffer-name-history",
  items: () => buffersByVisibility().filter((b) => bufferFiltered(b)),
  action: switchTo,
  preview: previewBuffer,
};
export const sourceModifiedBuffer: Source = {
  name: "Modified Buffer",
  narrow: "*",
  hidden: true,
  category: "buffer",
  history: "buffer-name-history",
  items: () => buffersByVisibility().filter((b) => !bufferFiltered(b) && ember.withCurrentBuffer(b, () => ember.bufferModified() && ember.bufferFileName() !== undefined)),
  action: switchTo,
  preview: previewBuffer,
};
export const sourceBuffer: Source = {
  name: "Buffer",
  narrow: "b",
  category: "buffer",
  face: "consult-buffer",
  history: "buffer-name-history",
  items: () => buffersByVisibility().filter((b) => !bufferFiltered(b)),
  action: switchTo,
  preview: previewBuffer,
};
export const sourceRecentFile: Source = {
  name: "File",
  narrow: "f",
  category: "file",
  face: "consult-file",
  history: "file-name-history",
  enabled: () => truthy(ember.variable("recentf-mode")),
  items: () => {
    const open = new Set(ember.bufferList().map((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName())).filter(Boolean).map((f) => ember.expandFileName(f!)));
    const list = ember.variable("recentf-list");
    return (Array.isArray(list) ? list.map(String) : []).filter((f) => !open.has(ember.expandFileName(f))).map((f) => ember.abbreviateFileName(ember.expandFileName(f)));
  },
  action: visitFile,
};
export const sourceBookmark: Source = {
  name: "Bookmark",
  narrow: "m",
  category: "bookmark",
  face: "consult-bookmark",
  history: "bookmark-history",
  items: () => {
    const alist = ember.variable("bookmark-alist");
    return Array.isArray(alist) ? (alist as ember.Value[]).filter(Array.isArray).map((b) => String((b as ember.Value[])[0])) : [];
  },
  action: (b) => bookmarkJumpTo(b, "switch-to-buffer"),
};
const projectRoot = (): string | undefined => projectCurrent();
const inProject = (file: string | undefined, root: string): boolean => file !== undefined && ember.expandFileName(file).startsWith(ember.expandFileName(root));
export const sourceProjectBuffer: Source = {
  name: "Project Buffer",
  narrow: "b",
  category: "buffer",
  face: "consult-buffer",
  history: "buffer-name-history",
  enabled: () => projectRoot() !== undefined,
  items: () => {
    const root = projectRoot()!;
    return buffersByVisibility().filter((b) => !bufferFiltered(b) && inProject(ember.withCurrentBuffer(b, () => ember.bufferFileName() ?? String(ember.variable("default-directory") ?? "")), root));
  },
  action: switchTo,
  preview: previewBuffer,
};
export const sourceProjectRecentFile: Source = {
  name: "Project File",
  narrow: "f",
  category: "file",
  face: "consult-file",
  history: "file-name-history",
  enabled: () => projectRoot() !== undefined && truthy(ember.variable("recentf-mode")),
  items: () => {
    const root = ember.expandFileName(projectRoot()!);
    return sourceRecentFile.items().filter((f) => inProject(f, root)).map((f) => ember.expandFileName(f).slice(root.length));
  },
  action: (f) => visitFile(ember.expandFileName(f, projectRoot())),
};
const sourceProjectBufferHidden: Source = { ...sourceProjectBuffer, hidden: true, narrow: "p", name: "Project Buffer" };
const sourceProjectRecentFileHidden: Source = { ...sourceProjectRecentFile, hidden: true, narrow: "p", name: "Project File" };

ember.defineVariable({
  name: "consult-buffer-sources",
  doc: "The sources consult-buffer draws on, by the names consultSources has them.",
  value: ["consult--source-hidden-buffer", "consult--source-modified-buffer", "consult--source-buffer", "consult--source-recent-file", "consult--source-bookmark", "consult--source-project-buffer-hidden", "consult--source-project-recent-file-hidden"],
});
ember.defineVariable({
  name: "consult-project-buffer-sources",
  doc: "The sources consult-project-buffer draws on.",
  value: ["consult--source-project-buffer", "consult--source-project-recent-file"],
});

/** The sources by name, for consult-buffer-sources to list and packages to add to. */
export const consultSources = new Map<string, Source>([
  ["consult--source-hidden-buffer", sourceHiddenBuffer],
  ["consult--source-modified-buffer", sourceModifiedBuffer],
  ["consult--source-buffer", sourceBuffer],
  ["consult--source-recent-file", sourceRecentFile],
  ["consult--source-bookmark", sourceBookmark],
  ["consult--source-project-buffer", sourceProjectBuffer],
  ["consult--source-project-recent-file", sourceProjectRecentFile],
  ["consult--source-project-buffer-hidden", sourceProjectBufferHidden],
  ["consult--source-project-recent-file-hidden", sourceProjectRecentFileHidden],
]);

/** Reads one item of several sources, grouped by source, narrowed by their keys, as consult--multi; runs its action. */
export function consultMulti(sourceNames: string[], options: { prompt: string; history?: string; command?: string }): void {
  const sources = sourceNames.map((n) => consultSources.get(n)).filter((s): s is Source => s !== undefined && (!s.enabled || s.enabled()));
  const items = new Map<string, { source: Source; item: string }>();
  const cands: string[] = [];
  let n = 0;
  for (const source of sources) {
    for (const item of source.items()) {
      const cand = items.has(item) ? item + tofu(n++) : item;
      items.set(cand, { source, item });
      cands.push(cand);
    }
  }
  const keys: [string, string][] = [];
  for (const s of sources) if (s.narrow && !keys.some(([k]) => k === s.narrow)) keys.push([s.narrow, s.name]);
  const visible = (c: string, key: string | undefined): boolean => {
    const s = items.get(c)?.source;
    return s !== undefined && (key ? s.narrow === key : !s.hidden);
  };
  const result = consultRead({
    command: options.command,
    prompt: options.prompt,
    candidates: cands,
    history: options.history,
    sort: false,
    category: "multi-category",
    narrow: { keys, predicate: (c, k) => visible(c, k) },
    group: (c, transform) => (transform ? c : (items.get(c)?.source.name ?? "")),
    annotate: (c) => {
      const entry = items.get(c);
      if (!entry) return undefined;
      const fn = ember.funcall("completion-metadata-get", "category");
      void fn;
      return undefined;
    },
    lookup: (c) => items.get(c),
    state: (action, cand) => {
      if (action === "preview") {
        const entry = cand as { source: Source; item: string } | undefined;
        restorePreview?.();
        restorePreview = undefined;
        if (entry?.source.preview) {
          const window = previewWindow;
          const old = ember.windowBuffer(window)!;
          const [pt, start] = [ember.windowPoint(window), ember.windowStart(window)];
          entry.source.preview(entry.item);
          restorePreview = () => {
            if (ember.windowList().includes(window) && ember.bufferLiveP(ember.getBuffer(old))) {
              ember.setWindowBuffer(window, old);
              ember.setWindowStart(window, start);
              ember.setWindowPoint(window, pt);
            }
          };
        }
      } else if (action === "exit") {
        restorePreview?.();
        restorePreview = undefined;
      }
    },
  });
  if (!result) return;
  const entry = items.get(result.cand);
  if (entry) entry.source.action(entry.item);
  else if (result.cand !== "") switchTo(result.cand);
}
let restorePreview: (() => void) | undefined;

const sourceNames = (variable: string): string[] => {
  const v = ember.variable(variable);
  return Array.isArray(v) ? v.map(String) : [];
};

export const consultBuffer = ember.defineCommand({
  name: "consult-buffer",
  doc: "Switch to a buffer, or a recent file or bookmark as a buffer to be, previewing buffers; b, f, m and p narrow to buffers, files, bookmarks and the project's.",
  run: () => consultMulti(sourceNames("consult-buffer-sources"), { prompt: "Switch to: ", history: "consult--buffer-history", command: "consult-buffer" }),
});
ember.defineVariable({ name: "consult--buffer-history", doc: "Buffers and files consult-buffer switched to.", value: [] });

ember.defineCommand({
  name: "consult-buffer-other-window",
  doc: "Switch to a buffer as consult-buffer does, in another window.",
  run: () => {
    ember.call("other-window");
    if (ember.windowList().length === 1) ember.call("split-window-below");
    ember.call(consultBuffer);
  },
});

ember.defineCommand({
  name: "consult-buffer-other-frame",
  doc: "Switch to a buffer as consult-buffer does, in another frame.",
  run: () => {
    ember.call("make-frame-command");
    ember.call(consultBuffer);
  },
});

ember.defineCommand({
  name: "consult-project-buffer",
  doc: "Switch to one of the project's buffers or recent files, as consult-buffer does.",
  run: () => {
    if (projectRoot() === undefined) ember.userError("No project found");
    consultMulti(sourceNames("consult-project-buffer-sources"), { prompt: "Switch to: ", history: "consult--buffer-history", command: "consult-project-buffer" });
  },
});

ember.defineCommand({
  name: "consult-recent-file",
  doc: "Visit a recently visited file.",
  run: () => {
    const list = ember.variable("recentf-list");
    const files = (Array.isArray(list) ? list.map(String) : []).map((f) => ember.abbreviateFileName(ember.expandFileName(f)));
    const r = consultRead({ command: "consult-recent-file", prompt: "Find recent file: ", candidates: files, sort: false, requireMatch: true, category: "file", history: "file-name-history" });
    if (r) visitFile(r.cand);
  },
});

ember.defineCommand({
  name: "consult-bookmark",
  doc: "Jump to a bookmark, or set one of a new name.",
  run: () => {
    const names = sourceBookmark.items();
    const r = consultRead({ command: "consult-bookmark", prompt: "Bookmark: ", candidates: names, category: "bookmark", history: "bookmark-history" });
    if (!r) return;
    if (names.includes(r.cand)) bookmarkJumpTo(r.cand, "switch-to-buffer");
    else ember.callInteractively("bookmark-set");
  },
});

// consult-yank-pop and its kin.

/** The kill ring as candidates, newest first, without duplicates. */
function killRingCandidates(): string[] {
  const seen = new Set<string>();
  return ember.killRing().filter((k) => k !== "" && !seen.has(k) && (seen.add(k), true));
}

/** Previews TEXT inserted at point, or in place of the text the last yank put, as consult--yank-state. */
function yankState(replace: boolean): State {
  let overlay: number | undefined;
  const buffer = ember.bufferName();
  const [start, end] = replace && ember.mark() !== undefined ? [Math.min(ember.mark()!, ember.point()), Math.max(ember.mark()!, ember.point())] : [ember.point(), ember.point()];
  return (action, cand) => {
    if (action === "preview" || action === "exit") {
      if (overlay !== undefined) ember.withCurrentBuffer(buffer, () => ember.deleteOverlay(overlay!));
      overlay = undefined;
    }
    if (action === "preview" && typeof cand === "string") {
      ember.withCurrentBuffer(buffer, () => {
        overlay = ember.makeOverlay(start, end);
        ember.overlayPut(overlay, start === end ? "before-string" : "display", ember.propertize(cand, { face: "consult-preview-insertion" }));
      });
    }
  };
}

function readKill(prompt: string, replace: boolean): string | undefined {
  const cands = killRingCandidates();
  if (cands.length === 0) ember.userError("Kill ring is empty");
  const r = consultRead({ command: "consult-yank-pop", prompt, candidates: cands.map((c) => c.replace(/\n/g, "↲")), sort: false, requireMatch: true, category: "kill-ring", state: undefined });
  if (!r) return undefined;
  return cands.find((c) => c.replace(/\n/g, "↲") === r.cand) ?? r.cand;
}

ember.defineCommand({
  name: "consult-yank-from-kill-ring",
  doc: "Choose text from the kill ring and yank it.",
  run: () => {
    const text = readKill("Yank from kill-ring: ", false);
    if (text === undefined) return;
    ember.pushMark(ember.point());
    ember.insert(text);
  },
});

ember.defineCommand({
  name: "consult-yank-pop",
  doc: "After a yank, replace the text yanked with text chosen from the kill ring; otherwise yank text chosen from it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.Value) => {
    const afterYank = ember.variable("last-command") === "yank" || ember.lastCommand?.() === "yank";
    if (afterYank && arg !== null) {
      ember.callWithPrefix(typeof arg === "number" ? arg : 1, "yank-pop");
      return;
    }
    const text = readKill("Yank from kill-ring: ", afterYank);
    if (text === undefined) return;
    if (afterYank && ember.mark() !== undefined) {
      ember.deleteRegion(Math.min(ember.mark()!, ember.point()), Math.max(ember.mark()!, ember.point()));
    } else {
      ember.pushMark(ember.point());
    }
    ember.insert(text);
    void yankState;
  },
});

// consult-history.

ember.defineCommand({
  name: "consult-history",
  doc: "Insert an element of the minibuffer's history, or the mode's, chosen with completion.",
  run: () => {
    const info = ember.minibufferInfo();
    const name = info?.history;
    const hist = name ? ember.variable(name) : undefined;
    const items = Array.isArray(hist) ? [...new Set(hist.map(String))] : [];
    if (items.length === 0) ember.userError("History is empty");
    ember.letBind({ "enable-recursive-minibuffers": true }, () => {
      const r = consultRead({ command: "consult-history", prompt: "History: ", candidates: items, sort: false, category: "consult-history" });
      if (!r) return;
      if (info) ember.deleteRegion(ember.minibufferPromptEnd(), ember.pointMax());
      ember.insert(r.cand);
    });
  },
});

// consult-complex-command and consult-mode-command.

ember.defineCommand({
  name: "consult-complex-command",
  doc: "Run again a command run before with arguments it read, chosen from command-history.",
  run: () => {
    const hist = ember.variable("command-history");
    const items = Array.isArray(hist) ? hist.map(String) : [];
    if (items.length === 0) ember.userError("Command history is empty");
    const r = consultRead({ command: "consult-complex-command", prompt: "Command: ", candidates: items, sort: false, category: "expression" });
    if (r) ember.callWithPrefix(items.indexOf(r.cand) + 1, "repeat-complex-command" as ember.CommandName);
  },
});

ember.defineCommand({
  name: "consult-mode-command",
  doc: "Run a command of the major mode or the minor modes on, grouped by mode; l, g and m narrow to local, global and major mode commands.",
  run: () => {
    const modes = [String(ember.variable("major-mode")), ...ember.localMinorModes()];
    const cands: string[] = [];
    const group = new Map<string, string>();
    for (const mode of modes) {
      const prefix = mode.replace(/-mode$/, "");
      for (const c of ember.commandNames()) {
        if (c.startsWith(`${prefix}-`) && !group.has(c)) {
          group.set(c, mode);
          cands.push(c);
        }
      }
    }
    if (cands.length === 0) ember.userError("No commands for the modes on");
    const r = consultRead({
      command: "consult-mode-command",
      prompt: "Mode command: ",
      candidates: cands,
      category: "command",
      requireMatch: true,
      history: "extended-command-history",
      group: (c, transform) => (transform ? c : (group.get(c) ?? "")),
    });
    if (r) ember.callInteractively(r.cand as ember.CommandName);
  },
});

// consult-ripgrep, consult-grep and consult-find: searching as you type.

/** The async part of the input and the filter after it, as consult--async-split with the perl style: #search#filter. */
function asyncSplit(input: string): { search: string; filterAt: number } {
  const style = String(ember.variable("consult-async-split-style"));
  const sep = input[0];
  if (style === "perl" && sep !== undefined && /[\p{P}\p{S}]/u.test(sep) && sep !== "-" && sep !== "^") {
    const end = input.indexOf(sep, 1);
    return end < 0 ? { search: input.slice(1), filterAt: input.length } : { search: input.slice(1, end), filterAt: end + 1 };
  }
  return { search: input, filterAt: input.length };
}

/** A table that runs a program for the async part of the input, its output the candidates, as consult--async-process. */
function asyncTable(build: (search: string) => string[] | undefined, parse: (line: string) => string | undefined, dir: string): {
  table: (input: string) => string[];
  stop: () => void;
} {
  let searching: string | undefined;
  let proc: string | undefined;
  let lines: string[] = [];
  let partial = "";
  const stop = () => {
    if (proc && ember.processLiveP(proc)) ember.deleteProcess(proc);
    proc = undefined;
  };
  // Output comes in another buffer's time: the minibuffer's list is redone in it.
  const refresh = () => {
    if (ember.minibufferDepth() === 0) return;
    const minibuffer = ember.windowBuffer(ember.minibufferWindow());
    if (minibuffer === undefined) return;
    ember.withCurrentBuffer(minibuffer, () => {
      ember.refreshCompletionTable();
      if (ember.fboundp("vertico--refresh")) ember.funcall("vertico--refresh");
    });
  };
  const table = (input: string): string[] => {
    const { search } = asyncSplit(input);
    if (search !== searching) {
      searching = search;
      stop();
      lines = [];
      partial = "";
      const min = Number(ember.variable("consult-async-min-input") ?? 3);
      const command = [...search].length >= min ? build(search) : undefined;
      if (command) {
        proc = ember.makeProcess({
          name: "consult-async",
          command,
          directory: dir,
          stderr: false,
          connectionType: "pipe",
          filter: (_p, output) => {
            const chunk = partial + output;
            const parts = chunk.split("\n");
            partial = parts.pop() ?? "";
            for (const l of parts) {
              const c = parse(l);
              if (c !== undefined) lines.push(c);
            }
            refresh();
          },
          sentinel: () => {
            if (partial) {
              const c = parse(partial);
              if (c !== undefined) lines.push(c);
              partial = "";
            }
            refresh();
          },
        });
      }
    }
    return lines;
  };
  return { table, stop };
}

/** Splits a command line into words, as split-string-and-unquote. */
const splitArgs = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");

/** Reads a grep match and goes to it, previewing each, as consult--grep. */
function consultGrep(prompt: string, makeCommand: (search: string) => string[], dir: string, initial?: string): void {
  const root = ember.fileNameAsDirectory(ember.expandFileName(dir));
  const locs = new Map<string, [string, number, number]>();
  const { table, stop } = asyncTable(
    makeCommand,
    (line) => {
      const nul = line.indexOf("\0");
      const m = nul >= 0 ? /^(\d+):(.*)$/s.exec(line.slice(nul + 1)) : /^(.*?):(\d+):(.*)$/s.exec(line);
      if (!m) return undefined;
      const [file, num, text] = nul >= 0 ? [line.slice(0, nul), m[1], m[2]] : [m[1], m[2], m[3]];
      const max = Number(ember.variable("consult-grep-max-columns") ?? 300);
      const cand = `${file}:${num}:${text.length > max ? text.slice(0, max) : text}`;
      locs.set(cand, [file, Number(num), 0]);
      return cand;
    },
    root,
  );
  const state = jumpState();
  const lookup = (cand: string): Location | undefined => {
    const key = [...locs.keys()].find((k) => cand === k || cand.endsWith(k));
    const loc = key ? locs.get(key) : undefined;
    if (!loc) return undefined;
    const file = ember.expandFileName(loc[0], root);
    const existing = ember.bufferList().find((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === file);
    // Visited without leaving the minibuffer's buffer current.
    const buffer = existing ?? ember.withCurrentBuffer(ember.currentBuffer(), () => ember.findFileNoselect(file));
    const pos = ember.withCurrentBuffer(buffer, () => ember.lineStart(Math.max(0, Math.min(loc[1] - 1, ember.lineCount() - 1))));
    return { buffer, pos };
  };
  try {
    consultRead({
      command: "consult-grep",
      prompt,
      candidates: table,
      boundaries: (input) => asyncSplit(input).filterAt,
      initial: initial ?? "#",
      sort: false,
      requireMatch: true,
      category: "consult-grep",
      history: "consult--grep-history",
      group: (c, transform) => {
        const m = /^(.*?):(\d+):(.*)$/s.exec(c);
        if (!m) return transform ? c : "";
        return transform ? `${ember.propertize(m[2], { face: "consult-line-number" })}:${m[3]}` : m[1];
      },
      lookup,
      state,
    });
  } finally {
    stop();
  }
}
ember.defineVariable({ name: "consult--grep-history", doc: "Searches consult-grep and consult-ripgrep made.", value: [] });

/** The directory a search runs in: the project's root, or with a prefix argument one read, as consult--directory-prompt. */
function searchDirectory(arg: ember.Value): string {
  if (arg !== null && arg !== undefined && arg !== false) return ember.readFileName("Search in directory: ", { dir: String(ember.variable("default-directory")) });
  return projectRoot() ?? String(ember.variable("default-directory"));
}

ember.defineCommand({
  name: "consult-ripgrep",
  doc: "Search the project's files with ripgrep as you type, previewing each match; #search#filter filters the matches. A prefix argument asks for the directory.",
  params: [{ name: "dir", kind: "prefix" }],
  run: (arg: ember.Value) => {
    const dir = searchDirectory(arg);
    consultGrep(`Ripgrep (${ember.abbreviateFileName(dir)}): `, (search) => [...splitArgs(String(ember.variable("consult-ripgrep-args"))), "-e", search, "."], dir);
  },
});

ember.defineCommand({
  name: "consult-grep",
  doc: "Search the project's files with grep as you type, previewing each match; #search#filter filters the matches. A prefix argument asks for the directory.",
  params: [{ name: "dir", kind: "prefix" }],
  run: (arg: ember.Value) => {
    const dir = searchDirectory(arg);
    consultGrep(`Grep (${ember.abbreviateFileName(dir)}): `, (search) => [...splitArgs(String(ember.variable("consult-grep-args"))), "-e", search, "."], dir);
  },
});

ember.defineCommand({
  name: "consult-find",
  doc: "Find a file under the project's root whose name matches as you type, and visit it.",
  params: [{ name: "dir", kind: "prefix" }],
  run: (arg: ember.Value) => {
    const dir = ember.fileNameAsDirectory(ember.expandFileName(searchDirectory(arg)));
    const { table, stop } = asyncTable((search) => [...splitArgs(String(ember.variable("consult-find-args"))), "-ipath", `*${search}*`], (l) => (l.startsWith("./") ? l.slice(2) : l), dir);
    try {
      const r = consultRead({ command: "consult-find", prompt: `Find (${ember.abbreviateFileName(dir)}): `, candidates: table, boundaries: (i) => asyncSplit(i).filterAt, initial: "#", sort: false, requireMatch: true, category: "file" });
      if (r) {
        const { filterAt } = asyncSplit(r.cand);
        visitFile(ember.expandFileName(r.cand.slice(filterAt) || r.cand, dir));
      }
    } finally {
      stop();
    }
  },
});

// consult-mark and consult-global-mark.

ember.defineCommand({
  name: "consult-mark",
  doc: "Jump to a mark in the buffer's mark ring, previewing each.",
  run: () => {
    const buffer = ember.bufferName();
    const marks = [ember.mark(), ...ember.markRing()].filter((m): m is number => typeof m === "number");
    if (marks.length === 0) ember.userError("No marks");
    const locs = new Map<string, Location>();
    const lines = new Map<string, number>();
    const cands = [...new Set(marks)].map((pos, i) => {
      const line = ember.lineOf(pos);
      const cand = ember.lineText(line) + tofu(i);
      locs.set(cand, { buffer, pos });
      lines.set(cand, line + 1);
      return cand;
    });
    consultRead({ command: "consult-mark", prompt: "Go to mark: ", candidates: cands, affixate: linePrefix(lines, 0), sort: false, requireMatch: true, category: "consult-location", lookup: (c) => locs.get(c), state: jumpState() });
  },
});

// consult-compile-error, after consult-compile.el.

ember.defineCommand({
  name: "consult-compile-error",
  doc: "Jump to an error in the compilation buffers, previewing each.",
  run: () => {
    const locs = new Map<string, Location>();
    const cands: string[] = [];
    for (const b of ember.bufferList()) {
      if (ember.bufferLocalValue("major-mode", b) !== "compilation-mode" && ember.bufferLocalValue("major-mode", b) !== "grep-mode") continue;
      ember.withCurrentBuffer(b, () => {
        const last = ember.lineOf(ember.pointMax());
        for (let line = 0; line <= last; line++) {
          const text = ember.lineText(line);
          const m = /^([^:\s][^:\n]*):(\d+)(?::(\d+))?:/.exec(text);
          if (!m) continue;
          const cand = text + tofu(cands.length);
          cands.push(cand);
          locs.set(cand, { buffer: b, pos: ember.lineStart(line) });
        }
      });
    }
    if (cands.length === 0) ember.userError("No compilation errors");
    const r = consultRead({ command: "consult-compile-error", prompt: "Go to error: ", candidates: cands, sort: false, requireMatch: true, category: "consult-compile-error", lookup: (c) => locs.get(c) });
    if (r?.value) {
      const loc = r.value as Location;
      ember.withCurrentBuffer(loc.buffer, () => ember.gotoChar(loc.pos));
      ember.call("switch-to-buffer", loc.buffer);
      ember.call("compile-goto-error");
    }
  },
});

// consult-theme.

ember.defineCommand({
  name: "consult-theme",
  doc: "Choose a theme and load it, previewing each.",
  run: () => {
    const dirs = ember.variable("load-path");
    const themes = new Set<string>();
    for (const d of Array.isArray(dirs) ? dirs.map(String) : []) {
      if (!ember.fileExists(d)) continue;
      for (const f of ember.directoryFiles(d, { match: "-theme\\.ts\\'" })) themes.add(f.replace(/-theme\.ts$/, ""));
    }
    const enabled = ember.variable("custom-enabled-themes");
    const saved = Array.isArray(enabled) ? enabled.map(String) : [];
    const r = consultRead({
      command: "consult-theme",
      prompt: "Theme: ",
      candidates: [...themes].sort(),
      requireMatch: true,
      category: "theme",
      default: saved[0],
      state: (action, cand) => {
        if (action === "preview" && typeof cand === "string") {
          for (const t of saved) ember.call("disable-theme", t);
          ember.callWithPrefix([4], "load-theme", cand);
        } else if (action === "return" && cand === undefined) {
          for (const t of [...themes]) if (!saved.includes(t)) ember.call("disable-theme", t);
          for (const t of saved) ember.call("enable-theme", t);
        }
      },
    });
    if (r) ember.callWithPrefix([4], "load-theme", r.cand);
  },
});
