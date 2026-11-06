// Sections, after magit-section.el from Magit 4
// (https://github.com/magit/magit): a buffer of nested sections, each a
// heading and its content, which TAB hides and shows. n and p move to the
// next and previous section, M-n and M-p to siblings, ^ to the parent,
// 1 to 4 show sections to that level. Magit's buffers are made of them.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { PerBuffer } from "subr";

e8.defineFace({
  name: "magit-section-heading",
  doc: "Face for section headings.",
  attributes: { extend: true, weight: "bold" },
  light: { foreground: "DarkGoldenrod4" },
  dark: { foreground: "LightGoldenrod2" },
});
e8.defineFace({
  name: "magit-section-highlight",
  doc: "Face for highlighting the current section.",
  attributes: { extend: true },
  light: { background: "grey95" },
  dark: { background: "grey20" },
});
e8.defineFace({ name: "magit-section-secondary-heading", doc: "Face for section headings of some secondary headings.", attributes: { extend: true, weight: "bold" } });
e8.defineFace({ name: "magit-section-heading-selection", doc: "Face for selected section headings.", attributes: { extend: true }, light: { foreground: "salmon4" }, dark: { foreground: "LightSalmon3" } });
e8.defineFace({ name: "magit-section-child-count", doc: "Face used for child counts at the end of some section headings.", attributes: {} });

/** A section of a buffer, as magit-section's objects: its kind and value, where it is, whether its content is hidden, and its children. */
export interface Section {
  type: string;
  value: unknown;
  start: number;
  /** Where the content starts, after the heading line. */
  content: number;
  end: number;
  hidden: boolean;
  children: Section[];
  parent?: Section;
  /** The overlay that hides the content. */
  overlay?: number;
}

/** Each buffer's root section, and the sections in order. */
const roots = new PerBuffer<{ root: Section; all: Section[] }>();
/** The section being inserted, the innermost first, while a buffer is made. */
const stack: Section[] = [];

/** The kinds of section hidden at first, as magit-section-initial-visibility-alist: [type, "show" | "hide"]. */
e8.defineVariable({
  name: "magit-section-initial-visibility-alist",
  doc: 'Whether sections of each type start hidden: [type, "show" or "hide"] pairs.',
  value: [["stashes", "hide"]],
});

function initiallyHidden(type: string, fallback: boolean): boolean {
  const alist = e8.variable("magit-section-initial-visibility-alist");
  const entry = Array.isArray(alist) ? (alist as string[][]).find((e) => e[0] === type) : undefined;
  return entry ? entry[1] === "hide" : fallback;
}

/** Visibility kept across refreshes, by the section's identity, as magit-section-cache-visibility does. */
const remembered = new PerBuffer<Map<string, boolean>>();
const identity = (s: Section): string => {
  const parts: string[] = [];
  for (let x: Section | undefined = s; x; x = x.parent) parts.unshift(`${x.type}:${typeof x.value === "string" ? x.value : ""}`);
  return parts.join("/");
};

/** Starts the buffer's sections afresh, as erase-buffer and magit-insert-section of the root do; BODY inserts them. */
export function insertRoot(type: string, body: () => void): Section {
  const buffer = e8.currentBuffer();
  const old = roots.get(buffer);
  const vis = remembered.get(buffer) ?? new Map<string, boolean>();
  if (old) for (const s of old.all) vis.set(identity(s), s.hidden);
  remembered.set(buffer, vis);
  for (const ov of e8.overlaysIn(e8.pointMin(), e8.pointMax())) {
    if (e8.overlayGet(ov, "magit-section") !== undefined) e8.deleteOverlay(ov);
  }
  e8.deleteRegion(e8.pointMin(), e8.pointMax());
  const root: Section = { type, value: undefined, start: e8.point(), content: e8.point(), end: 0, hidden: false, children: [] };
  stack.length = 0;
  stack.push(root);
  try {
    body();
  } finally {
    stack.length = 0;
  }
  root.end = e8.pointMax();
  const all: Section[] = [];
  const walk = (s: Section) => {
    for (const c of s.children) {
      all.push(c);
      walk(c);
    }
  };
  walk(root);
  roots.set(buffer, { root, all });
  for (const s of all) {
    const kept = vis.get(identity(s));
    if (kept !== undefined) s.hidden = kept;
    applyVisibility(s);
  }
  return root;
}

/**
 * Inserts a section of TYPE and VALUE, its heading and content inserted by
 * BODY, hidden at first if HIDDEN (or as the visibility alist says), as
 * magit-insert-section.
 */
export function insertSection(type: string, value: unknown, hidden: boolean, body: () => void): Section {
  const parent = stack[stack.length - 1];
  const s: Section = { type, value, start: e8.point(), content: e8.point(), end: e8.point(), hidden: initiallyHidden(type, hidden), children: [], parent };
  stack.push(s);
  try {
    body();
  } finally {
    stack.pop();
  }
  s.end = e8.point();
  if (s.content < s.start) s.content = s.start;
  parent?.children.push(s);
  return s;
}

/** Inserts the section's heading line, in magit-section-heading unless it has faces of its own, as magit-insert-heading. */
export function insertHeading(...parts: (string | e8.PropertizedString)[]): void {
  const s = stack[stack.length - 1];
  const text = parts.length === 1 && typeof parts[0] === "string" ? e8.propertize(parts[0], { face: "magit-section-heading" }) : e8.concat(...parts);
  e8.insert(text);
  if (!String(text).endsWith("\n")) e8.insert("\n");
  if (s) s.content = e8.point();
}

/** Hides or shows a section's content, as magit-section-hide and -show do with an invisible overlay. */
function applyVisibility(s: Section): void {
  if (s.overlay !== undefined) e8.deleteOverlay(s.overlay);
  s.overlay = undefined;
  if (s.hidden && s.end > s.content) {
    s.overlay = e8.makeOverlay(s.content, s.end, { invisible: true, "magit-section": true });
  }
}

/** The sections of the current buffer, root first. */
export function sections(): { root: Section; all: Section[] } | undefined {
  return roots.get(e8.currentBuffer());
}

/** Whether S shows: none of its parents is hidden. */
export const visibleP = (s: Section): boolean => {
  for (let p = s.parent; p; p = p.parent) if (p.hidden) return false;
  return true;
};

/** The innermost section at POS, as magit-section-at. */
export function sectionAt(pos = e8.point()): Section | undefined {
  const all = sections()?.all ?? [];
  let found: Section | undefined;
  for (const s of all) if (s.start <= pos && pos < Math.max(s.end, s.start + 1) && visibleP(s)) found = s;
  return found;
}

/** The section point is in, as magit-current-section. */
export const currentSection = (): Section | undefined => sectionAt();

/** Shows S's content, as magit-section-show. */
export function show(s: Section): void {
  s.hidden = false;
  applyVisibility(s);
}

/** Hides S's content, as magit-section-hide. */
export function hide(s: Section): void {
  s.hidden = true;
  applyVisibility(s);
  if (e8.point() >= s.content && e8.point() < s.end) e8.gotoChar(s.start);
}

/** Moves point to S's heading. */
export function gotoSection(s: Section): void {
  e8.gotoChar(s.start);
}

/** The sections that show, in buffer order. */
const visibleSections = (): Section[] => (sections()?.all ?? []).filter(visibleP);

e8.defineHook("magit-section-movement-hook", "Functions called after moving to a section.");

function moved(): void {
  e8.runHooks("magit-section-movement-hook");
}

/** The same keys in each mode built on magit-section-mode, as magit-section-mode-map. */
export const sectionCommands = {
  toggle: e8.defineCommand({
    name: "magit-section-toggle",
    doc: "Toggle visibility of the body of the current section.",
    run: () => {
      const s = currentSection();
      if (!s || s.content >= s.end) return;
      if (s.hidden) show(s);
      else hide(s);
    },
  }),
  forward: e8.defineCommand({
    name: "magit-section-forward",
    doc: "Move to the beginning of the next visible section.",
    run: () => {
      // The next in buffer order that shows: the first child of an expanded
      // section, else the next sibling, else the parent's next sibling.
      const here = currentSection();
      const vis = visibleSections();
      const next = here ? vis[vis.indexOf(here) + 1] : vis.find((s) => s.start > e8.point());
      if (!next) e8.userError("No next section");
      gotoSection(next);
      moved();
    },
  }),
  backward: e8.defineCommand({
    name: "magit-section-backward",
    doc: "Move to the beginning of the current section, or if that is already the case, the previous visible section.",
    run: () => {
      const here = currentSection();
      if (here && e8.point() > here.start) {
        gotoSection(here);
        moved();
        return;
      }
      const prev = [...visibleSections()].reverse().find((s) => s.start < e8.point());
      if (!prev) e8.userError("No previous section");
      gotoSection(prev);
      moved();
    },
  }),
  up: e8.defineCommand({
    name: "magit-section-up",
    doc: "Move to the beginning of the parent section.",
    run: () => {
      const parent = currentSection()?.parent;
      if (!parent || !parent.parent) e8.userError("No parent section");
      gotoSection(parent);
      moved();
    },
  }),
  forwardSibling: e8.defineCommand({
    name: "magit-section-forward-sibling",
    doc: "Move to the beginning of the next sibling section, or the next section if there is none.",
    run: () => {
      const s = currentSection();
      const siblings = s?.parent?.children ?? [];
      const next = s ? siblings[siblings.indexOf(s) + 1] : undefined;
      if (next) gotoSection(next);
      else e8.call("magit-section-forward" as e8.CommandName);
      moved();
    },
  }),
  backwardSibling: e8.defineCommand({
    name: "magit-section-backward-sibling",
    doc: "Move to the beginning of the previous sibling section, or the previous section if there is none.",
    run: () => {
      const s = currentSection();
      const siblings = s?.parent?.children ?? [];
      const prev = s ? siblings[siblings.indexOf(s) - 1] : undefined;
      if (prev) gotoSection(prev);
      else e8.call("magit-section-backward" as e8.CommandName);
      moved();
    },
  }),
  cycle: e8.defineCommand({
    name: "magit-section-cycle",
    doc: "Cycle the visibility of the current section and its children: all hidden, the children's headings, everything.",
    run: () => {
      const s = currentSection();
      if (!s) return;
      if (s.hidden) {
        show(s);
        for (const c of s.children) hide(c);
      } else if (s.children.some((c) => c.hidden)) {
        const all = (x: Section) => {
          show(x);
          x.children.forEach(all);
        };
        all(s);
      } else {
        hide(s);
      }
    },
  }),
  cycleGlobal: e8.defineCommand({
    name: "magit-section-cycle-global",
    doc: "Cycle the visibility of all sections: top-level headings only, or everything.",
    run: () => {
      const top = sections()?.root.children ?? [];
      const anyHidden = top.some((s) => s.hidden);
      for (const s of top) (anyHidden ? show : hide)(s);
    },
  }),
};

/** Shows the sections to LEVEL and hides those below, as magit-section-show-level. */
function showLevel(level: number): void {
  const walk = (s: Section, depth: number) => {
    if (depth >= level) hide(s);
    else show(s);
    for (const c of s.children) walk(c, depth + 1);
  };
  for (const s of sections()?.root.children ?? []) walk(s, 1);
}
const levels = [1, 2, 3, 4].map((n) =>
  e8.defineCommand({ name: `magit-section-show-level-${n}-all`, doc: `Show the sections to level ${n}, hiding those below.`, run: () => showLevel(n) }),
);

/** Highlights the section point is in, as magit-section-update-highlight. */
let highlight: { buffer: e8.Buffer; overlay: number } | undefined;
function updateHighlight(): void {
  if (highlight && e8.bufferLiveP(highlight.buffer)) e8.withCurrentBuffer(highlight.buffer, () => e8.deleteOverlay(highlight!.overlay));
  highlight = undefined;
  const s = currentSection();
  if (!s) return;
  // A diff's lines keep their own colours, as Magit gives them highlight
  // variants rather than the section's face: only other sections' bodies light up.
  const diff = s.type === "file" || s.type === "hunk";
  const overlay = e8.makeOverlay(s.start, diff || s.hidden ? s.content : Math.max(s.content, s.end), { face: "magit-section-highlight", priority: -1, "magit-section": true });
  highlight = { buffer: e8.currentBuffer(), overlay };
}

export const magitSectionMode = e8.defineMajorMode({
  name: "magit-section-mode",
  modeName: "Magit-Sections",
  parent: "special-mode",
  doc: "Parent major mode of buffers made of sections, as Magit's are.",
  bindings: {
    TAB: sectionCommands.toggle,
    "C-<tab>": sectionCommands.cycle,
    "<backtab>": sectionCommands.cycleGlobal,
    "S-<tab>": sectionCommands.cycleGlobal,
    "^": sectionCommands.up,
    p: sectionCommands.backward,
    n: sectionCommands.forward,
    "M-p": sectionCommands.backwardSibling,
    "M-n": sectionCommands.forwardSibling,
    "1": levels[0],
    "2": levels[1],
    "3": levels[2],
    "4": levels[3],
  },
  setup: () => {
    for (const [name, value] of [
      ["truncate-lines", true],
      ["buffer-read-only", true],
    ] as const) {
      e8.makeLocalVariable(name);
      e8.setVariable(name, value);
    }
    e8.addHook("post-command-hook", updateHighlight, { local: true });
  },
});
