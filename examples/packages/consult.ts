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
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { jumpTo as bookmarkJumpTo } from "bookmark";
import { makeIndex, type IndexItem } from "imenu";
import { completingReadWithMetadata, type CompletionMetadata } from "minibuffer";
import { current as projectCurrent } from "project";
import { registerAlist, type RegisterValue } from "register";
import { truthy } from "subr";

gnista.defineVariable({ name: "consult-narrow-key", doc: 'The prefix key for narrowing, such as "<": "< b" narrows consult-buffer to buffers. Typing a narrowing key and SPC on empty input narrows too.', value: null });
gnista.defineVariable({ name: "consult-widen-key", doc: "The key that widens again; by default the narrow key twice.", value: null });
gnista.defineVariable({ name: "consult-preview-key", doc: 'When to preview: "any" key, keys such as ["S-<down>", "S-<up>"], or nil never; with [":debounce", seconds, ...] to wait first.', value: "any" });
gnista.defineVariable({ name: "consult-async-min-input", doc: "How many characters an async command such as consult-ripgrep needs before it searches.", value: 3 });
gnista.defineVariable({ name: "consult-async-split-style", doc: 'How async input splits into the search and a filter: "perl", #search#filter.', value: "perl" });
gnista.defineVariable({ name: "consult-line-start-from-top", doc: "Whether consult-line lists the lines from the top rather than from point.", value: false });
gnista.defineVariable({ name: "consult-line-numbers-widen", doc: "Whether line numbers count from the start of the whole buffer when it is narrowed.", value: true });
gnista.defineVariable({ name: "consult-point-placement", doc: 'Where consult-line puts point on the line: "match-beginning", "match-end" or "line-beginning".', value: "match-beginning" });
gnista.defineVariable({
  name: "consult-buffer-filter",
  doc: "Regexps of the names of buffers consult-buffer leaves out, unless narrowed to hidden ones.",
  value: ["\\` ", "\\`\\*Completions\\*\\'", "\\`\\*Flymake log\\*\\'", "\\`\\*Semantic SymRef\\*\\'", "\\`\\*vc\\*\\'", "\\`newsrc-dribble\\'", "\\`\\*tramp/.*\\*\\'"],
});
gnista.defineVariable({ name: "consult-ripgrep-args", doc: "The ripgrep command consult-ripgrep runs, before the pattern.", value: "rg --null --line-buffered --color=never --max-columns=1000 --path-separator / --smart-case --no-heading --with-filename --line-number --search-zip" });
gnista.defineVariable({ name: "consult-grep-args", doc: "The grep command consult-grep runs, before the pattern.", value: "grep --null --line-buffered --color=never --ignore-case --exclude-dir=.git --line-number -I -r" });
gnista.defineVariable({ name: "consult-find-args", doc: "The find command consult-find runs.", value: "find . -not ( -path */.[A-Za-z]* -prune )" });
gnista.defineVariable({ name: "consult-grep-max-columns", doc: "How much of a long matching line consult-grep shows.", value: 300 });
gnista.defineVariable({ name: "consult-mode-histories", doc: "The history of each mode, as [mode, history] pairs, for consult-history.", value: [["eshell-mode", "eshell-history-ring"], ["comint-mode", "comint-input-ring"], ["term-mode", "term-input-ring"]] });
gnista.defineHook("consult-after-jump-hook", "Functions called after consult jumps to a place.");

const faceSpecs: [string, gnista.FaceAttributes][] = [
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
for (const [name, attributes] of faceSpecs) gnista.defineFace({ name, doc: `Face consult uses: ${name.slice(8).replace(/-/g, " ")}.`, attributes });

type Text = string | gnista.PropertizedString;

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
  previewKey?: gnista.Value;
  prompt?: string;
  keymap?: string | gnista.Keymap;
  initial?: string;
  [key: string]: unknown;
}
const customizations = new Map<string, Customization>();

/** Sets options for commands or sources, as consult-customize: consultCustomize(["consult-line"], { prompt: "Search: " }). */
export function consultCustomize(names: string[], options: Customization): void {
  for (const n of names) customizations.set(n, { ...customizations.get(n), ...options });
}
gnista.defun("consult-customize", (names: string[], options: Customization) => consultCustomize(names, options));

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
  narrow?: { keys: [string, string][]; predicate: (cand: string, key: string) => boolean; visible?: (cand: string) => boolean };
  keymap?: string | gnista.Keymap;
  /** The command, for consult-customize. */
  command?: string;
  previewKey?: gnista.Value;
}

/** The window previews show in: the one selected when the prompt opened, as minibuffer-selected-window. */
let previewWindow = 0;

/** The narrowing of the open consult prompt, by minibuffer depth. */
const narrowing = new Map<number, { options: ReadOptions; key?: string; prompt: string; overlay?: number }>();

gnista.defineKeymap("consult-narrow-map");

/** Whether a candidate shows, as narrowed. */
function narrowed(options: ReadOptions, cand: string): boolean {
  const n = narrowing.get(gnista.minibufferDepth());
  if (!options.narrow) return true;
  // Widened, a hidden source's candidates stay out, as consult--multi hides them.
  if (!n?.key) return options.narrow.visible?.(cand) ?? true;
  return options.narrow.predicate(cand, n.key);
}

/** Narrows to KEY, or widens with none, as consult-narrow: the prompt says what it is narrowed to. */
function narrow(key: string | undefined): void {
  const n = narrowing.get(gnista.minibufferDepth());
  if (!n) return;
  n.key = key;
  const name = key ? n.options.narrow?.keys.find(([k]) => k === key)?.[1] : undefined;
  // " [Buffer]" before the prompt's last character, as consult--narrow-indicator shows it.
  if (n.overlay !== undefined) gnista.deleteOverlay(n.overlay);
  n.overlay = undefined;
  if (name) {
    const end = gnista.minibufferPromptEnd();
    n.overlay = gnista.makeOverlay(Math.max(gnista.pointMin(), end - 1), end);
    gnista.overlayPut(n.overlay, "before-string", gnista.propertize(` [${name}]`, { face: "consult-narrow-indicator" }));
  }
  gnista.refreshCompletionTable();
  if (gnista.fboundp("vertico--refresh")) gnista.funcall("vertico--refresh");
}

const narrowCommand = gnista.defineCommand({
  name: "consult-narrow",
  doc: "Narrow the candidates to the kind the key typed names, or widen.",
  run: () => {
    const keys = gnista.thisCommandKeysVector();
    const key = keys[keys.length - 1];
    const n = narrowing.get(gnista.minibufferDepth());
    narrow(n?.key === key ? undefined : key);
  },
});

/** SPC after a narrowing key on empty input narrows, as consult--narrow-space; else it inserts a space. */
const narrowSpace = gnista.defineCommand({
  name: "consult-narrow-space",
  doc: "Narrow by the key typed before, if the input is just one narrowing key; else insert a space.",
  run: () => {
    const n = narrowing.get(gnista.minibufferDepth());
    const input = gnista.minibufferContents();
    if (n?.options.narrow?.keys.some(([k]) => k === input)) {
      gnista.deleteRegion(gnista.minibufferPromptEnd(), gnista.pointMax());
      narrow(input);
    } else {
      gnista.insert(" ");
    }
  },
});

/** DEL on empty input widens, as consult--narrow-delete; else it deletes. */
const narrowDelete = gnista.defineCommand({
  name: "consult-narrow-delete",
  doc: "Widen, on empty input; else delete the character before point.",
  run: () => {
    const n = narrowing.get(gnista.minibufferDepth());
    if (n?.key && gnista.minibufferContents() === "") narrow(undefined);
    else gnista.call("delete-backward-char", 1);
  },
});

/** The selected candidate of the open prompt, as consult--completion-candidate-hook finds it: vertico's, or the input. */
function selectedCandidate(): string | undefined {
  if (gnista.fboundp("vertico--candidate")) return gnista.funcall("vertico--candidate") as string | undefined;
  return gnista.minibufferContents();
}

/** The keys that preview, and how long to wait first, as consult--preview-key-normalize. */
function previewKeys(value: gnista.Value): { any: boolean; keys: string[]; debounce: number } {
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
  const previewKey = custom.previewKey ?? options.previewKey ?? gnista.variable("consult-preview-key");
  const keymap = custom.keymap ?? options.keymap;
  const state = options.state;
  const lookup = options.lookup ?? ((c: string) => c);
  const { any, keys, debounce } = previewKeys(previewKey as gnista.Value);
  const depth = gnista.minibufferDepth() + 1;
  const origWindow = gnista.selectedWindow();
  previewWindow = origWindow;
  let last: string | undefined;
  let timer: number | undefined;
  const preview = () => {
    const cand = selectedCandidate();
    if (cand === last) return;
    last = cand;
    const value = cand === undefined ? undefined : lookup(cand, gnista.minibufferContents());
    previewWindow = origWindow;
    // Showing another buffer in the window keeps the minibuffer's current.
    gnista.withCurrentBuffer(gnista.currentBuffer(), () => state?.("preview", value));
  };
  const postCommand = () => {
    if (!state) return;
    if (!any && !keys.includes(gnista.thisCommandKeys())) return;
    if (debounce > 0) {
      if (timer !== undefined) gnista.cancelTimer(timer);
      timer = gnista.runWithTimer(debounce, null, () => {
        timer = undefined;
        if (gnista.minibufferDepth() === depth) preview();
      });
    } else {
      preview();
    }
  };
  const setup = () => {
    if (gnista.minibufferDepth() !== depth) return;
    gnista.removeHook("minibuffer-setup-hook", setup);
    narrowing.set(depth, { options, prompt });
    if (options.narrow) {
      const map = gnista.makeSparseKeymap();
      const nk = gnista.variable("consult-narrow-key");
      for (const [k] of options.narrow.keys) if (typeof nk === "string") gnista.defineKey(map, `${nk} ${k}`, narrowCommand);
      gnista.defineKey(map, "SPC", narrowSpace);
      gnista.defineKey(map, "DEL", narrowDelete);
      gnista.composeLocalMap(map);
    }
    if (keymap) gnista.composeLocalMap(keymap);
    gnista.addHook("post-command-hook", postCommand, { local: true });
    state?.("setup", undefined);
    if (any && debounce === 0) preview();
  };
  gnista.addHook("minibuffer-setup-hook", setup);
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
    gnista.removeHook("minibuffer-setup-hook", setup);
    if (timer !== undefined) gnista.cancelTimer(timer);
    narrowing.delete(depth);
    state?.("exit", undefined);
    state?.("return", undefined);
    throw e;
  }
  gnista.removeHook("minibuffer-setup-hook", setup);
  if (timer !== undefined) gnista.cancelTimer(timer);
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
  if (gnista.bufferName() !== loc.buffer) gnista.call("switch-to-buffer", loc.buffer);
  else gnista.pushMark(gnista.point());
  if (loc.pos < gnista.pointMin() || loc.pos > gnista.pointMax()) gnista.widen();
  gnista.gotoChar(loc.pos);
  gnista.runHooks("consult-after-jump-hook");
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
      if (!loc || !gnista.bufferLiveP(gnista.getBuffer(loc.buffer))) return;
      const window = previewWindow;
      const oldBuffer = gnista.windowBuffer(window)!;
      const oldPoint = gnista.windowPoint(window);
      const oldStart = gnista.windowStart(window);
      if (oldBuffer !== loc.buffer) gnista.setWindowBuffer(window, loc.buffer);
      gnista.withCurrentBuffer(loc.buffer, () => {
        const line = [gnista.lineBeginningPosition(loc.pos), gnista.lineEndPosition(loc.pos) + 1] as const;
        const overlays = [gnista.makeOverlay(line[0], Math.min(line[1], gnista.pointMax()))];
        gnista.overlayPut(overlays[0], "face", "consult-preview-line");
        gnista.overlayPut(overlays[0], "priority", 1);
        for (const [a, b] of loc.matches ?? []) {
          const ov = gnista.makeOverlay(loc.pos + a, loc.pos + b);
          gnista.overlayPut(ov, "face", "consult-preview-match");
          gnista.overlayPut(ov, "priority", 2);
          overlays.push(ov);
        }
        restore.push(() => {
          if (gnista.bufferLiveP(gnista.getBuffer(loc.buffer))) gnista.withCurrentBuffer(loc.buffer, () => overlays.forEach((o) => gnista.deleteOverlay(o)));
        });
      });
      gnista.setWindowPoint(window, loc.pos);
      restore.push(() => {
        if (!gnista.windowList().includes(window)) return;
        if (oldBuffer !== loc.buffer && gnista.bufferLiveP(gnista.getBuffer(oldBuffer))) gnista.setWindowBuffer(window, oldBuffer);
        gnista.setWindowStart(window, oldStart);
        gnista.setWindowPoint(window, oldPoint);
      });
      gnista.runHooks("consult-after-jump-hook");
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
  const width = String(gnista.lineCount()).length;
  return (cands) =>
    cands.map((c) => {
      const line = lines.get(c) ?? 0;
      return [c, gnista.propertize(`${String(line).padStart(width)} `, { face: line < currLine ? "consult-line-number-wrapped" : "consult-line-number-prefix" }), ""];
    });
}

/** The buffer's non-blank lines as candidates, from point's line on unless TOP, as consult--line-candidates. */
function lineCandidates(top: boolean, currLine: number): { cands: string[]; locs: Map<string, Location>; lines: Map<string, number> } {
  const buffer = gnista.bufferName();
  const cands: string[] = [];
  const locs = new Map<string, Location>();
  const lines = new Map<string, number>();
  const first = gnista.lineOf(gnista.pointMin());
  const last = gnista.lineOf(gnista.pointMax());
  let n = 0;
  let defaultAt = -1;
  for (let line = first; line <= last; line++) {
    const text = gnista.lineText(line);
    if (/^\s*$/.test(text)) continue;
    const cand = text + tofu(n++);
    cands.push(cand);
    locs.set(cand, { buffer, pos: gnista.lineStart(line) });
    lines.set(cand, line + 1);
    if (defaultAt < 0 && line + 1 >= currLine) defaultAt = cands.length - 1;
  }
  if (cands.length === 0) gnista.userError("No lines");
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
      re = gnista.emacsRegexp(w, { caseFold: !/\p{Lu}/u.test(w) });
    } catch {
      continue;
    }
    const m = re.exec(text);
    if (m) matches.push([m.index, m.index + m[0].length]);
  }
  matches.sort((a, b) => a[0] - b[0]);
  const place = String(gnista.variable("consult-point-placement"));
  const offset = matches.length === 0 || place === "line-beginning" ? 0 : place === "match-end" ? matches[0][1] : matches[0][0];
  return { ...loc, pos: loc.pos + offset, matches: matches.map(([a, b]) => [a - offset, b - offset]) };
}

export const consultLine = gnista.defineCommand({
  name: "consult-line",
  doc: "Search for a matching line, previewing it, and go to the match. The lines start from point's, or the top with a prefix argument.",
  params: [{ name: "start", kind: "prefix" }],
  run: (start: gnista.Value) => {
    const currLine = gnista.lineOf(gnista.point()) + 1;
    const top = truthy(start) !== truthy(gnista.variable("consult-line-start-from-top"));
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
gnista.defineVariable({ name: "consult--line-history", doc: "Input consult-line was given.", value: [] });

// consult-goto-line.

export const consultGotoLine = gnista.defineCommand({
  name: "consult-goto-line",
  doc: "Read a line number, previewing it as it is typed, and go to it. With a prefix argument, go there at once.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.Value) => {
    if (typeof arg === "number") {
      gnista.gotoChar(gnista.lineStart(Math.max(0, Math.min(arg - 1, gnista.lineCount() - 1))));
      return;
    }
    const buffer = gnista.bufferName();
    const origin = gnista.point();
    const window = gnista.selectedWindow();
    let overlay: number | undefined;
    const show = (input: string) => {
      if (overlay !== undefined) gnista.withCurrentBuffer(buffer, () => gnista.deleteOverlay(overlay!));
      overlay = undefined;
      const m = /^\s*(\d+)(?::(\d+))?\s*$/.exec(input);
      if (!m) return;
      gnista.withCurrentBuffer(buffer, () => {
        const line = Math.max(0, Math.min(Number(m[1]) - 1, gnista.lineCount() - 1));
        const pos = Math.min(gnista.lineStart(line) + Number(m[2] ?? 0), gnista.lineEnd(line));
        overlay = gnista.makeOverlay(gnista.lineStart(line), Math.min(gnista.lineEnd(line) + 1, gnista.pointMax()));
        gnista.overlayPut(overlay, "face", "consult-preview-line");
        gnista.setWindowPoint(window, pos);
      });
    };
    const setup = () => {
      gnista.removeHook("minibuffer-setup-hook", setup);
      gnista.addHook("post-command-hook", () => show(gnista.minibufferContents()), { local: true });
    };
    gnista.addHook("minibuffer-setup-hook", setup);
    let answer: string;
    try {
      answer = gnista.readString("Go to line: ");
    } finally {
      gnista.removeHook("minibuffer-setup-hook", setup);
      if (overlay !== undefined) gnista.withCurrentBuffer(buffer, () => gnista.deleteOverlay(overlay!));
      gnista.setWindowPoint(window, origin);
    }
    const m = /^\s*(\d+)(?::(\d+))?\s*$/.exec(answer);
    if (!m) gnista.userError("Please enter a number");
    const line = Math.max(0, Math.min(Number(m[1]) - 1, gnista.lineCount() - 1));
    gnista.pushMark(origin);
    gnista.gotoChar(Math.min(gnista.lineStart(line) + Number(m[2] ?? 0), gnista.lineEnd(line)));
    gnista.runHooks("consult-after-jump-hook");
  },
});

// consult-outline.

/** The headings of the buffer, as outline-regexp finds them, as consult--outline-candidates. */
function outlineCandidates(): { cands: string[]; locs: Map<string, Location>; levels: Map<string, number>; lines: Map<string, number> } {
  const buffer = gnista.bufferName();
  const regexp = `^\\(?:${String(gnista.variable("outline-regexp") ?? "[*\f]+")}\\)`;
  const re = gnista.emacsRegexp(regexp);
  const cands: string[] = [];
  const locs = new Map<string, Location>();
  const levels = new Map<string, number>();
  const lines = new Map<string, number>();
  const last = gnista.lineOf(gnista.pointMax());
  let n = 0;
  for (let line = gnista.lineOf(gnista.pointMin()); line <= last; line++) {
    const text = gnista.lineText(line);
    const m = re.exec(text);
    if (!m || m.index !== 0) continue;
    const cand = text + tofu(n++);
    cands.push(cand);
    locs.set(cand, { buffer, pos: gnista.lineStart(line) });
    levels.set(cand, m[0].replace(/\s+$/, "").length);
    lines.set(cand, line + 1);
  }
  if (cands.length === 0) gnista.userError("No headings");
  return { cands, locs, levels, lines };
}

export const consultOutline = gnista.defineCommand({
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

export const consultImenu = gnista.defineCommand({
  name: "consult-imenu",
  doc: "Jump to a place the buffer's imenu index has, previewing it, grouped as the index groups them.",
  run: () => {
    const buffer = gnista.bufferName();
    const items = imenuItems(makeIndex());
    if (items.length === 0) gnista.userError("No imenu items");
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
gnista.defineVariable({ name: "consult-imenu--history", doc: "Items consult-imenu went to.", value: [] });

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
  const filter = gnista.variable("consult-buffer-filter");
  return Array.isArray(filter) && filter.some((r) => gnista.stringMatch(String(r), name) !== undefined);
};

/** Buffers, the selected window's first left out, then the most recently used, as consult--buffer-query with :sort visibility. */
function buffersByVisibility(): string[] {
  const current = gnista.bufferName();
  const visible = new Set(gnista.windowList().map((w) => gnista.windowBuffer(w)));
  const all = gnista.bufferList();
  const hidden = all.filter((b) => !visible.has(b));
  const shown = all.filter((b) => visible.has(b) && b !== current);
  return [...hidden, ...shown, ...(all.includes(current) ? [current] : [])];
}

const previewBuffer = (b: string) => {
  if (gnista.bufferLiveP(gnista.getBuffer(b))) gnista.setWindowBuffer(previewWindow, b);
};
const switchTo = (b: string) => gnista.call("switch-to-buffer", b);
const visitFile = (f: string) => gnista.call("find-file", gnista.expandFileName(f));

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
  items: () => buffersByVisibility().filter((b) => !bufferFiltered(b) && gnista.withCurrentBuffer(b, () => gnista.bufferModified() && gnista.bufferFileName() !== undefined)),
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
  enabled: () => truthy(gnista.variable("recentf-mode")),
  items: () => {
    const open = new Set(gnista.bufferList().map((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName())).filter(Boolean).map((f) => gnista.expandFileName(f!)));
    const list = gnista.variable("recentf-list");
    return (Array.isArray(list) ? list.map(String) : []).filter((f) => !open.has(gnista.expandFileName(f))).map((f) => gnista.abbreviateFileName(gnista.expandFileName(f)));
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
    const alist = gnista.variable("bookmark-alist");
    return Array.isArray(alist) ? (alist as gnista.Value[]).filter(Array.isArray).map((b) => String((b as gnista.Value[])[0])) : [];
  },
  action: (b) => bookmarkJumpTo(b, "switch-to-buffer"),
};
const projectRoot = (): string | undefined => projectCurrent();
const inProject = (file: string | undefined, root: string): boolean => file !== undefined && gnista.expandFileName(file).startsWith(gnista.expandFileName(root));
export const sourceProjectBuffer: Source = {
  name: "Project Buffer",
  narrow: "b",
  category: "buffer",
  face: "consult-buffer",
  history: "buffer-name-history",
  enabled: () => projectRoot() !== undefined,
  items: () => {
    const root = projectRoot()!;
    return buffersByVisibility().filter((b) => !bufferFiltered(b) && inProject(gnista.withCurrentBuffer(b, () => gnista.bufferFileName() ?? String(gnista.variable("default-directory") ?? "")), root));
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
  enabled: () => projectRoot() !== undefined && truthy(gnista.variable("recentf-mode")),
  items: () => {
    const root = gnista.expandFileName(projectRoot()!);
    return sourceRecentFile.items().filter((f) => inProject(f, root)).map((f) => gnista.expandFileName(f).slice(root.length));
  },
  action: (f) => visitFile(gnista.expandFileName(f, projectRoot())),
};
const sourceProjectBufferHidden: Source = { ...sourceProjectBuffer, hidden: true, narrow: "p", name: "Project Buffer" };
const sourceProjectRecentFileHidden: Source = { ...sourceProjectRecentFile, hidden: true, narrow: "p", name: "Project File" };

gnista.defineVariable({
  name: "consult-buffer-sources",
  doc: "The sources consult-buffer draws on, by the names consultSources has them.",
  value: ["consult--source-hidden-buffer", "consult--source-modified-buffer", "consult--source-buffer", "consult--source-recent-file", "consult--source-bookmark", "consult--source-project-buffer-hidden", "consult--source-project-recent-file-hidden"],
});
gnista.defineVariable({
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
    narrow: { keys, predicate: (c, k) => visible(c, k), visible: (c) => visible(c, undefined) },
    group: (c, transform) => (transform ? c : (items.get(c)?.source.name ?? "")),
    annotate: (c) => {
      const entry = items.get(c);
      if (!entry) return undefined;
      const fn = gnista.funcall("completion-metadata-get", "category");
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
          const old = gnista.windowBuffer(window)!;
          const [pt, start] = [gnista.windowPoint(window), gnista.windowStart(window)];
          entry.source.preview(entry.item);
          restorePreview = () => {
            if (gnista.windowList().includes(window) && gnista.bufferLiveP(gnista.getBuffer(old))) {
              gnista.setWindowBuffer(window, old);
              gnista.setWindowStart(window, start);
              gnista.setWindowPoint(window, pt);
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
  const v = gnista.variable(variable);
  return Array.isArray(v) ? v.map(String) : [];
};

export const consultBuffer = gnista.defineCommand({
  name: "consult-buffer",
  doc: "Switch to a buffer, or a recent file or bookmark as a buffer to be, previewing buffers; b, f, m and p narrow to buffers, files, bookmarks and the project's.",
  run: () => consultMulti(sourceNames("consult-buffer-sources"), { prompt: "Switch to: ", history: "consult--buffer-history", command: "consult-buffer" }),
});
gnista.defineVariable({ name: "consult--buffer-history", doc: "Buffers and files consult-buffer switched to.", value: [] });

gnista.defineCommand({
  name: "consult-buffer-other-window",
  doc: "Switch to a buffer as consult-buffer does, in another window.",
  run: () => {
    gnista.call("other-window");
    if (gnista.windowList().length === 1) gnista.call("split-window-below");
    gnista.call(consultBuffer);
  },
});

gnista.defineCommand({
  name: "consult-buffer-other-frame",
  doc: "Switch to a buffer as consult-buffer does, in another frame.",
  run: () => {
    gnista.call("make-frame-command");
    gnista.call(consultBuffer);
  },
});

gnista.defineCommand({
  name: "consult-project-buffer",
  doc: "Switch to one of the project's buffers or recent files, as consult-buffer does.",
  run: () => {
    if (projectRoot() === undefined) gnista.userError("No project found");
    consultMulti(sourceNames("consult-project-buffer-sources"), { prompt: "Switch to: ", history: "consult--buffer-history", command: "consult-project-buffer" });
  },
});

gnista.defineCommand({
  name: "consult-recent-file",
  doc: "Visit a recently visited file.",
  run: () => {
    const list = gnista.variable("recentf-list");
    const files = (Array.isArray(list) ? list.map(String) : []).map((f) => gnista.abbreviateFileName(gnista.expandFileName(f)));
    const r = consultRead({ command: "consult-recent-file", prompt: "Find recent file: ", candidates: files, sort: false, requireMatch: true, category: "file", history: "file-name-history" });
    if (r) visitFile(r.cand);
  },
});

gnista.defineCommand({
  name: "consult-bookmark",
  doc: "Jump to a bookmark, or set one of a new name.",
  run: () => {
    const names = sourceBookmark.items();
    const r = consultRead({ command: "consult-bookmark", prompt: "Bookmark: ", candidates: names, category: "bookmark", history: "bookmark-history" });
    if (!r) return;
    if (names.includes(r.cand)) bookmarkJumpTo(r.cand, "switch-to-buffer");
    else gnista.callInteractively("bookmark-set");
  },
});

// consult-yank-pop and its kin.

/** The kill ring as candidates, newest first, without duplicates. */
function killRingCandidates(): string[] {
  const seen = new Set<string>();
  return gnista.killRing().filter((k) => k !== "" && !seen.has(k) && (seen.add(k), true));
}

/** Previews TEXT inserted at point, or in place of the text the last yank put, as consult--yank-state. */
function yankState(replace: boolean): State {
  let overlay: number | undefined;
  const buffer = gnista.bufferName();
  const [start, end] = replace && gnista.mark() !== undefined ? [Math.min(gnista.mark()!, gnista.point()), Math.max(gnista.mark()!, gnista.point())] : [gnista.point(), gnista.point()];
  return (action, cand) => {
    if (action === "preview" || action === "exit") {
      if (overlay !== undefined) gnista.withCurrentBuffer(buffer, () => gnista.deleteOverlay(overlay!));
      overlay = undefined;
    }
    if (action === "preview" && typeof cand === "string") {
      gnista.withCurrentBuffer(buffer, () => {
        overlay = gnista.makeOverlay(start, end);
        gnista.overlayPut(overlay, start === end ? "before-string" : "display", gnista.propertize(cand, { face: "consult-preview-insertion" }));
      });
    }
  };
}

function readKill(prompt: string, replace: boolean): string | undefined {
  const cands = killRingCandidates();
  if (cands.length === 0) gnista.userError("Kill ring is empty");
  const r = consultRead({ command: "consult-yank-pop", prompt, candidates: cands.map((c) => c.replace(/\n/g, "↲")), sort: false, requireMatch: true, category: "kill-ring", state: undefined });
  if (!r) return undefined;
  return cands.find((c) => c.replace(/\n/g, "↲") === r.cand) ?? r.cand;
}

gnista.defineCommand({
  name: "consult-yank-from-kill-ring",
  doc: "Choose text from the kill ring and yank it.",
  run: () => {
    const text = readKill("Yank from kill-ring: ", false);
    if (text === undefined) return;
    gnista.pushMark(gnista.point());
    gnista.insert(text);
  },
});

gnista.defineCommand({
  name: "consult-yank-pop",
  doc: "After a yank, replace the text yanked with text chosen from the kill ring; otherwise yank text chosen from it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.Value) => {
    const afterYank = gnista.variable("last-command") === "yank" || gnista.lastCommand?.() === "yank";
    if (afterYank && arg !== null) {
      gnista.callWithPrefix(typeof arg === "number" ? arg : 1, "yank-pop");
      return;
    }
    const text = readKill("Yank from kill-ring: ", afterYank);
    if (text === undefined) return;
    if (afterYank && gnista.mark() !== undefined) {
      gnista.deleteRegion(Math.min(gnista.mark()!, gnista.point()), Math.max(gnista.mark()!, gnista.point()));
    } else {
      gnista.pushMark(gnista.point());
    }
    gnista.insert(text);
    void yankState;
  },
});

// consult-history.

gnista.defineCommand({
  name: "consult-history",
  doc: "Insert an element of the minibuffer's history, or the mode's, chosen with completion.",
  run: () => {
    const info = gnista.minibufferInfo();
    const name = info?.history;
    const hist = name ? gnista.variable(name) : undefined;
    const items = Array.isArray(hist) ? [...new Set(hist.map(String))] : [];
    if (items.length === 0) gnista.userError("History is empty");
    gnista.letBind({ "enable-recursive-minibuffers": true }, () => {
      const r = consultRead({ command: "consult-history", prompt: "History: ", candidates: items, sort: false, category: "consult-history" });
      if (!r) return;
      if (info) gnista.deleteRegion(gnista.minibufferPromptEnd(), gnista.pointMax());
      gnista.insert(r.cand);
    });
  },
});

// consult-complex-command and consult-mode-command.

gnista.defineCommand({
  name: "consult-complex-command",
  doc: "Run again a command run before with arguments it read, chosen from command-history.",
  run: () => {
    const hist = gnista.variable("command-history");
    const items = Array.isArray(hist) ? hist.map(String) : [];
    if (items.length === 0) gnista.userError("Command history is empty");
    const r = consultRead({ command: "consult-complex-command", prompt: "Command: ", candidates: items, sort: false, category: "expression" });
    if (r) gnista.callWithPrefix(items.indexOf(r.cand) + 1, "repeat-complex-command" as gnista.CommandName);
  },
});

gnista.defineCommand({
  name: "consult-mode-command",
  doc: "Run a command of the major mode or the minor modes on, grouped by mode; l, g and m narrow to local, global and major mode commands.",
  run: () => {
    const modes = [String(gnista.variable("major-mode")), ...gnista.localMinorModes()];
    const cands: string[] = [];
    const group = new Map<string, string>();
    for (const mode of modes) {
      const prefix = mode.replace(/-mode$/, "");
      for (const c of gnista.commandNames()) {
        if (c.startsWith(`${prefix}-`) && !group.has(c)) {
          group.set(c, mode);
          cands.push(c);
        }
      }
    }
    if (cands.length === 0) gnista.userError("No commands for the modes on");
    const r = consultRead({
      command: "consult-mode-command",
      prompt: "Mode command: ",
      candidates: cands,
      category: "command",
      requireMatch: true,
      history: "extended-command-history",
      group: (c, transform) => (transform ? c : (group.get(c) ?? "")),
    });
    if (r) gnista.callInteractively(r.cand as gnista.CommandName);
  },
});

// consult-ripgrep, consult-grep and consult-find: searching as you type.

/** The async part of the input and the filter after it, as consult--async-split with the perl style: #search#filter. */
function asyncSplit(input: string): { search: string; filterAt: number } {
  const style = String(gnista.variable("consult-async-split-style"));
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
    if (proc && gnista.processLiveP(proc)) gnista.deleteProcess(proc);
    proc = undefined;
  };
  // Output comes in another buffer's time: the minibuffer's list is redone in it.
  const refresh = () => {
    if (gnista.minibufferDepth() === 0) return;
    const minibuffer = gnista.windowBuffer(gnista.minibufferWindow());
    if (minibuffer === undefined) return;
    gnista.withCurrentBuffer(minibuffer, () => {
      gnista.refreshCompletionTable();
      if (gnista.fboundp("vertico--refresh")) gnista.funcall("vertico--refresh");
    });
  };
  const table = (input: string): string[] => {
    const { search } = asyncSplit(input);
    if (search !== searching) {
      searching = search;
      stop();
      lines = [];
      partial = "";
      const min = Number(gnista.variable("consult-async-min-input") ?? 3);
      const command = [...search].length >= min ? build(search) : undefined;
      if (command) {
        proc = gnista.makeProcess({
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
  const root = gnista.fileNameAsDirectory(gnista.expandFileName(dir));
  const locs = new Map<string, [string, number, number]>();
  const { table, stop } = asyncTable(
    makeCommand,
    (line) => {
      const nul = line.indexOf("\0");
      const m = nul >= 0 ? /^(\d+):(.*)$/s.exec(line.slice(nul + 1)) : /^(.*?):(\d+):(.*)$/s.exec(line);
      if (!m) return undefined;
      const [file, num, text] = nul >= 0 ? [line.slice(0, nul), m[1], m[2]] : [m[1], m[2], m[3]];
      const max = Number(gnista.variable("consult-grep-max-columns") ?? 300);
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
    const file = gnista.expandFileName(loc[0], root);
    const existing = gnista.bufferList().find((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName()) === file);
    // Visited without leaving the minibuffer's buffer current.
    const buffer = existing ?? gnista.withCurrentBuffer(gnista.currentBuffer(), () => gnista.findFileNoselect(file));
    const pos = gnista.withCurrentBuffer(buffer, () => gnista.lineStart(Math.max(0, Math.min(loc[1] - 1, gnista.lineCount() - 1))));
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
        return transform ? `${gnista.propertize(m[2], { face: "consult-line-number" })}:${m[3]}` : m[1];
      },
      lookup,
      state,
    });
  } finally {
    stop();
  }
}
gnista.defineVariable({ name: "consult--grep-history", doc: "Searches consult-grep and consult-ripgrep made.", value: [] });

/** The directory a search runs in: the project's root, or with a prefix argument one read, as consult--directory-prompt. */
function searchDirectory(arg: gnista.Value): string {
  if (arg !== null && arg !== undefined && arg !== false) return gnista.readFileName("Search in directory: ", { dir: String(gnista.variable("default-directory")) });
  return projectRoot() ?? String(gnista.variable("default-directory"));
}

/** Searches DIR with ripgrep as you type, as consult-ripgrep with a directory. */
export function consultRipgrep(dir: string, initial?: string): void {
  consultGrep(`Ripgrep (${gnista.abbreviateFileName(dir)}): `, (search) => [...splitArgs(String(gnista.variable("consult-ripgrep-args"))), "-e", search, "."], dir, initial);
}

/** Searches DIR with grep as you type, as consult-grep with a directory. */
export function consultGrepDir(dir: string, initial?: string): void {
  consultGrep(`Grep (${gnista.abbreviateFileName(dir)}): `, (search) => [...splitArgs(String(gnista.variable("consult-grep-args"))), "-e", search, "."], dir, initial);
}

gnista.defineCommand({
  name: "consult-ripgrep",
  doc: "Search the project's files with ripgrep as you type, previewing each match; #search#filter filters the matches. A prefix argument asks for the directory.",
  params: [{ name: "dir", kind: "prefix" }],
  run: (arg: gnista.Value) => consultRipgrep(searchDirectory(arg)),
});

gnista.defineCommand({
  name: "consult-grep",
  doc: "Search the project's files with grep as you type, previewing each match; #search#filter filters the matches. A prefix argument asks for the directory.",
  params: [{ name: "dir", kind: "prefix" }],
  run: (arg: gnista.Value) => consultGrepDir(searchDirectory(arg)),
});

gnista.defineCommand({
  name: "consult-find",
  doc: "Find a file under the project's root whose name matches as you type, and visit it.",
  params: [{ name: "dir", kind: "prefix" }],
  run: (arg: gnista.Value) => {
    const dir = gnista.fileNameAsDirectory(gnista.expandFileName(searchDirectory(arg)));
    const { table, stop } = asyncTable((search) => [...splitArgs(String(gnista.variable("consult-find-args"))), "-ipath", `*${search}*`], (l) => (l.startsWith("./") ? l.slice(2) : l), dir);
    try {
      const r = consultRead({ command: "consult-find", prompt: `Find (${gnista.abbreviateFileName(dir)}): `, candidates: table, boundaries: (i) => asyncSplit(i).filterAt, initial: "#", sort: false, requireMatch: true, category: "file" });
      if (r) {
        const { filterAt } = asyncSplit(r.cand);
        visitFile(gnista.expandFileName(r.cand.slice(filterAt) || r.cand, dir));
      }
    } finally {
      stop();
    }
  },
});

// consult-mark and consult-global-mark.

gnista.defineCommand({
  name: "consult-mark",
  doc: "Jump to a mark in the buffer's mark ring, previewing each.",
  run: () => {
    const buffer = gnista.bufferName();
    const marks = [gnista.mark(), ...gnista.markRing()].filter((m): m is number => typeof m === "number");
    if (marks.length === 0) gnista.userError("No marks");
    const locs = new Map<string, Location>();
    const lines = new Map<string, number>();
    const cands = [...new Set(marks)].map((pos, i) => {
      const line = gnista.lineOf(pos);
      const cand = gnista.lineText(line) + tofu(i);
      locs.set(cand, { buffer, pos });
      lines.set(cand, line + 1);
      return cand;
    });
    consultRead({ command: "consult-mark", prompt: "Go to mark: ", candidates: cands, affixate: linePrefix(lines, 0), sort: false, requireMatch: true, category: "consult-location", lookup: (c) => locs.get(c), state: jumpState() });
  },
});

// consult-compile-error, after consult-compile.el.

gnista.defineCommand({
  name: "consult-compile-error",
  doc: "Jump to an error in the compilation buffers, previewing each.",
  run: () => {
    const locs = new Map<string, Location>();
    const cands: string[] = [];
    for (const b of gnista.bufferList()) {
      if (gnista.bufferLocalValue("major-mode", b) !== "compilation-mode" && gnista.bufferLocalValue("major-mode", b) !== "grep-mode") continue;
      gnista.withCurrentBuffer(b, () => {
        const last = gnista.lineOf(gnista.pointMax());
        for (let line = 0; line <= last; line++) {
          const text = gnista.lineText(line);
          const m = /^([^:\s][^:\n]*):(\d+)(?::(\d+))?:/.exec(text);
          if (!m) continue;
          const cand = text + tofu(cands.length);
          cands.push(cand);
          locs.set(cand, { buffer: b, pos: gnista.lineStart(line) });
        }
      });
    }
    if (cands.length === 0) gnista.userError("No compilation errors");
    const r = consultRead({ command: "consult-compile-error", prompt: "Go to error: ", candidates: cands, sort: false, requireMatch: true, category: "consult-compile-error", lookup: (c) => locs.get(c) });
    if (r?.value) {
      const loc = r.value as Location;
      gnista.withCurrentBuffer(loc.buffer, () => gnista.gotoChar(loc.pos));
      gnista.call("switch-to-buffer", loc.buffer);
      gnista.call("compile-goto-error");
    }
  },
});

// consult-theme.

gnista.defineCommand({
  name: "consult-theme",
  doc: "Choose a theme and load it, previewing each.",
  run: () => {
    const dirs = gnista.variable("load-path");
    const themes = new Set<string>();
    for (const d of Array.isArray(dirs) ? dirs.map(String) : []) {
      if (!gnista.fileExists(d)) continue;
      for (const f of gnista.directoryFiles(d, { match: "-theme\\.ts\\'" })) themes.add(f.replace(/-theme\.ts$/, ""));
    }
    const enabled = gnista.variable("custom-enabled-themes");
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
          for (const t of saved) gnista.call("disable-theme", t);
          gnista.callWithPrefix([4], "load-theme", cand);
        } else if (action === "return" && cand === undefined) {
          for (const t of [...themes]) if (!saved.includes(t)) gnista.call("disable-theme", t);
          for (const t of saved) gnista.call("enable-theme", t);
        }
      },
    });
    if (r) gnista.callWithPrefix([4], "load-theme", r.cand);
  },
});

// consult-flymake, after consult-flymake.el: the buffer's diagnostics, as
// eglot's overlays mark them.

gnista.defineCommand({
  name: "consult-flymake",
  doc: "Jump to a diagnostic in the buffer, previewing each; e, w and n narrow to errors, warnings and notes.",
  run: () => {
    const buffer = gnista.bufferName();
    const kinds = new Map<string, string>([["flymake-error", "e"], ["flymake-warning", "w"], ["flymake-note", "n"]]);
    const found = gnista
      .overlaysIn(gnista.pointMin(), gnista.pointMax())
      .filter((o) => gnista.overlayGet(o, "flymake-diagnostic") !== undefined)
      .sort((a, b) => gnista.overlayStart(a)! - gnista.overlayStart(b)!);
    if (found.length === 0) gnista.userError("No flymake errors");
    const locs = new Map<string, Location>();
    const kind = new Map<string, string>();
    const cands = found.map((o, i) => {
      const pos = gnista.overlayStart(o)!;
      const face = String(gnista.overlayGet(o, "face"));
      const type = face === "flymake-warning" ? "warning" : face === "flymake-note" ? "note" : "error";
      const line = gnista.lineOf(pos) + 1;
      const col = pos - gnista.lineBeginningPosition(pos);
      const cand = `${String(line).padStart(4)}:${String(col).padEnd(3)} ${gnista.propertize(type.padEnd(7), { face })} ${String(gnista.overlayGet(o, "flymake-diagnostic"))}${tofu(i)}`;
      locs.set(cand, { buffer, pos, matches: [[0, Math.max(1, gnista.overlayEnd(o)! - pos)]] });
      kind.set(cand, kinds.get(face) ?? "e");
      return cand;
    });
    consultRead({
      command: "consult-flymake",
      prompt: "Flymake diagnostic: ",
      candidates: cands,
      sort: false,
      requireMatch: true,
      category: "consult-flymake-error",
      history: "consult-flymake--history",
      narrow: { keys: [["e", "Error"], ["w", "Warning"], ["n", "Note"]], predicate: (c, k) => kind.get(c) === k },
      lookup: (c) => locs.get(c),
      state: jumpState(),
    });
  },
});
gnista.defineVariable({ name: "consult-flymake--history", doc: "Diagnostics consult-flymake went to.", value: [] });

// consult-xref, after consult-xref.el: set xref-show-xrefs-function and
// xref-show-definitions-function to "consult-xref" to choose a place with
// preview rather than in *xref*.

/** Reads one of XREFS, grouped by file, previewing each, and goes to it, as consult-xref. */
export function consultXref(xrefs: { file: string; line: number; col: number; summary: string; group: string }[]): void {
  const locs = new Map<string, { file: string; line: number; col: number }>();
  const groups = new Map<string, string>();
  const cands = xrefs.map((x, i) => {
    const cand = `${gnista.propertize(String(x.line), { face: "consult-line-number" })}: ${x.summary}${tofu(i)}`;
    const plain = String(cand);
    locs.set(plain, x);
    groups.set(plain, x.group || gnista.abbreviateFileName(x.file));
    return plain;
  });
  const lookup = (c: string): Location | undefined => {
    const x = locs.get(c);
    if (!x) return undefined;
    const buffer = gnista.withCurrentBuffer(gnista.currentBuffer(), () => gnista.findFileNoselect(x.file));
    const pos = gnista.withCurrentBuffer(buffer, () => Math.min(gnista.lineStart(Math.max(0, x.line - 1)) + x.col, gnista.lineEnd(Math.max(0, x.line - 1))));
    return { buffer, pos };
  };
  consultRead({
    command: "consult-xref",
    prompt: "Go to xref: ",
    candidates: cands,
    sort: false,
    requireMatch: true,
    category: "consult-xref",
    history: "consult-xref--history",
    group: (c, transform) => (transform ? c : (groups.get(c) ?? "")),
    lookup,
    state: jumpState(),
  });
}
gnista.defun("consult-xref", consultXref);
gnista.defineVariable({ name: "consult-xref--history", doc: "Places consult-xref went to.", value: [] });

// consult-global-mark.

gnista.defineCommand({
  name: "consult-global-mark",
  doc: "Jump to a mark of the global mark ring, in any buffer, previewing each.",
  run: () => {
    const marks = gnista.globalMarkRing();
    if (marks.length === 0) gnista.userError("No marks");
    const locs = new Map<string, Location>();
    const cands = marks.map(([buffer, pos], i) => {
      const line = gnista.withCurrentBuffer(buffer, () => gnista.lineText(gnista.lineOf(pos)));
      const cand = `${line}${tofu(i)}`;
      locs.set(cand, { buffer, pos });
      return cand;
    });
    consultRead({
      command: "consult-global-mark",
      prompt: "Go to global mark: ",
      candidates: cands,
      sort: false,
      requireMatch: true,
      category: "consult-location",
      group: (c, transform) => (transform ? c : (locs.get(c)?.buffer ?? "")),
      lookup: (c) => locs.get(c),
      state: jumpState(),
    });
  },
});

// consult-line-multi and consult-imenu-multi: across the project's buffers.

/** The buffers of the project, or every buffer with a prefix argument, as consult--buffer-query. */
function projectBuffers(all: boolean, mode?: string): string[] {
  const root = all ? undefined : projectRoot();
  return gnista.bufferList().filter((b) => {
    if (bufferFiltered(b)) return false;
    if (mode && gnista.bufferLocalValue("major-mode", b) !== mode) return false;
    if (!root) return all || b === gnista.bufferName();
    const file = gnista.withCurrentBuffer(b, () => gnista.bufferFileName() ?? String(gnista.variable("default-directory") ?? ""));
    return inProject(file, root);
  });
}

gnista.defineCommand({
  name: "consult-line-multi",
  doc: "Search for a matching line in the project's buffers, or every buffer with a prefix argument, previewing each.",
  params: [{ name: "query", kind: "prefix" }],
  run: (query: gnista.Value) => {
    const buffers = projectBuffers(query !== null && query !== undefined);
    const locs = new Map<string, Location>();
    const lines = new Map<string, number>();
    const cands: string[] = [];
    for (const b of buffers) {
      gnista.withCurrentBuffer(b, () => {
        const last = gnista.lineOf(gnista.pointMax());
        for (let line = 0; line <= last; line++) {
          const text = gnista.lineText(line);
          if (/^\s*$/.test(text)) continue;
          const cand = text + tofu(cands.length);
          cands.push(cand);
          locs.set(cand, { buffer: b, pos: gnista.lineStart(line) });
          lines.set(cand, line + 1);
        }
      });
    }
    if (cands.length === 0) gnista.userError("No lines");
    consultRead({
      command: "consult-line-multi",
      prompt: "Go to line: ",
      candidates: cands,
      affixate: linePrefix(lines, 0),
      sort: false,
      requireMatch: true,
      category: "consult-location",
      history: "consult--line-multi-history",
      group: (c, transform) => (transform ? c : (locs.get(c)?.buffer ?? "")),
      lookup: (c, input) => lineMatch(locs.get(c), c, input),
      state: jumpState(),
    });
  },
});
gnista.defineVariable({ name: "consult--line-multi-history", doc: "Input consult-line-multi was given.", value: [] });

gnista.defineCommand({
  name: "consult-imenu-multi",
  doc: "Jump to an imenu item of the project's buffers in this major mode, or every buffer with a prefix argument, grouped by buffer.",
  params: [{ name: "query", kind: "prefix" }],
  run: (query: gnista.Value) => {
    const mode = String(gnista.variable("major-mode"));
    const buffers = projectBuffers(query !== null && query !== undefined, mode);
    const locs = new Map<string, Location>();
    const cands: string[] = [];
    for (const b of buffers) {
      const items = gnista.withCurrentBuffer(b, () => imenuItems(makeIndex()));
      for (const [name, pos] of items) {
        const cand = name + tofu(cands.length);
        cands.push(cand);
        locs.set(cand, { buffer: b, pos });
      }
    }
    if (cands.length === 0) gnista.userError("No imenu items");
    consultRead({
      command: "consult-imenu-multi",
      prompt: "Go to item: ",
      candidates: cands,
      sort: false,
      requireMatch: true,
      category: "imenu",
      history: "consult-imenu--history",
      group: (c, transform) => (transform ? c : (locs.get(c)?.buffer ?? "")),
      lookup: (c) => locs.get(c),
      state: jumpState(),
    });
  },
});

// consult-isearch-history: in isearch, M-e.

gnista.defineCommand({
  name: "consult-isearch-history",
  doc: "Read a string searched for before and search for it again: in isearch, it becomes the search string.",
  run: () => {
    const regexp = truthy(gnista.variable("isearch-regexp"));
    const ring = gnista.variable(regexp ? "regexp-search-ring" : "search-ring");
    const items = Array.isArray(ring) ? [...new Set(ring.map(String))] : [];
    if (items.length === 0) gnista.userError("History is empty");
    const searching = truthy(gnista.variable("isearch-mode"));
    const r = gnista.letBind({ "enable-recursive-minibuffers": true }, () =>
      consultRead({ command: "consult-isearch-history", prompt: "I-search: ", candidates: items, sort: false, category: "consult-isearch" }),
    );
    if (!r) return;
    // The string goes in as typed, as isearch reads the keys after M-e.
    if (searching) {
      gnista.setVariable("isearch-string", "");
      gnista.setVariable("isearch-message", "");
    } else {
      gnista.call("isearch-forward");
    }
    for (const ch of r.cand) gnista.unreadKeys(ch === " " ? "SPC" : ch);
  },
});

// Registers, after consult-register.el.

/** What a register holds, for the list, as consult-register-format: a line, its text's start, or what it is. */
function registerDescription(value: RegisterValue): { text: string; kind: string; loc?: Location } {
  switch (value.kind) {
    case "position": {
      const buffer = gnista.markerBuffer(value.marker);
      const pos = gnista.markerPosition(value.marker);
      if (buffer === undefined || pos === undefined) return { text: "(killed buffer)", kind: "p" };
      const line = gnista.withCurrentBuffer(buffer, () => gnista.lineText(gnista.lineOf(pos)));
      return { text: `${buffer}: ${line}`, kind: "p", loc: { buffer, pos } };
    }
    case "window":
      return { text: "Window configuration", kind: "w" };
    case "number":
      return { text: String(value.value), kind: "n" };
    case "rectangle":
      return { text: `Rectangle: ${value.lines.join("↲")}`, kind: "t" };
    default:
      return { text: String(value.text).replace(/\n/g, "↲"), kind: "t" };
  }
}

/** Uses the register R as its kind says: goes to a place, restores windows, or inserts the rest, as consult-register-load. */
function loadRegister(r: string, value: RegisterValue): void {
  gnista.unreadKeys(r === " " ? "SPC" : r);
  gnista.call(value.kind === "position" || value.kind === "window" ? "jump-to-register" : ("insert-register" as gnista.CommandName));
}

gnista.defineCommand({
  name: "consult-register",
  doc: "Load a register chosen from a list of them, previewing places; n, p, t and w narrow to numbers, positions, text and windows.",
  run: () => {
    const regs = registerAlist();
    if (regs.length === 0) gnista.userError("All registers are empty");
    const byCand = new Map<string, [string, RegisterValue, ReturnType<typeof registerDescription>]>();
    const cands = regs.map(([r, v]) => {
      const d = registerDescription(v);
      const cand = `${gnista.propertize(r === " " ? "SPC" : r, { face: "consult-key" })} ${d.text}`;
      byCand.set(String(cand), [r, v, d]);
      return String(cand);
    });
    const jump = jumpState();
    const result = consultRead({
      command: "consult-register",
      prompt: "Register: ",
      candidates: cands,
      sort: false,
      requireMatch: true,
      category: "multi-category",
      narrow: { keys: [["n", "Number"], ["p", "Position"], ["t", "Text"], ["w", "Window"]], predicate: (c, k) => byCand.get(c)?.[2].kind === k },
      lookup: (c) => byCand.get(c),
      state: (action, cand) => {
        const entry = cand as [string, RegisterValue, ReturnType<typeof registerDescription>] | undefined;
        if (action === "preview") jump("preview", entry?.[2].loc);
        else if (action === "exit") jump("exit", undefined);
      },
    });
    if (result?.value) {
      const [r, v] = result.value as [string, RegisterValue];
      loadRegister(r, v);
    }
  },
});

gnista.defineCommand({
  name: "consult-register-load",
  doc: "Load a register: go to its place or restore its windows, or insert its text or number.",
  run: () => {
    const key = gnista.readKey("Load register: ");
    const r = key === "SPC" ? " " : key;
    const value = new Map(registerAlist()).get(r);
    if (!value) gnista.userError(`Register ${key} is empty`);
    loadRegister(r, value);
  },
});

gnista.defineCommand({
  name: "consult-register-store",
  doc: "Store in a register: the region's text if it is active, else point; with a numeric prefix argument, the number.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: gnista.Value) => {
    const key = gnista.readKey("Store register: ");
    gnista.unreadKeys(key);
    if (typeof arg === "number") gnista.callWithPrefix(arg, "number-to-register" as gnista.CommandName);
    else if (gnista.regionActive()) gnista.call("copy-to-register" as gnista.CommandName);
    else gnista.call("point-to-register" as gnista.CommandName);
  },
});
