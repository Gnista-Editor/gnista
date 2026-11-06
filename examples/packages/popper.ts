// Popups, after popper.el 0.4.8 (https://github.com/karthink/popper):
// buffers that popper-reference-buffers names, such as *Messages* or help,
// are popups, which popper-toggle shows and hides, the last one first, and
// popper-cycle goes through, grouped by project if popper-group-function
// says so. Popper sets no keys; config.org puts popper-toggle on C-p.
//
// E8 has no display-buffer-alist, so popper-display-control t shows a
// popup as pop-to-buffer does, in the window display-buffer picks, rather
// than in a side window at the bottom of the frame.
//
// Copyright (C) 2023 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { current as projectCurrent } from "project";
import { PerBuffer } from "subr";

const defvar = (name: string, value: e8.Value, doc: string) => e8.defineVariable({ name, value, doc });
defvar(
  "popper-reference-buffers",
  ["\\*Messages\\*$"],
  "The buffers that are popups: regexps their names match, as strings; major modes, as names ending in -mode; or predicates, functions of a buffer's name. An entry [entry, \"hide\"] also keeps the popup from showing when it opens.",
);
defvar("popper-mode-line", [e8.intern(":propertize"), " POP", "face", "mode-line-emphasis"] as unknown as e8.Value, "What a popup's mode line shows first, nil for nothing.");
defvar("popper-mode-line-position", 0, "Where in the mode line popper-mode-line goes.");
defvar("popper-display-control", true, "Whether popper shows popups itself: t for all, user for those popper-toggle-type made, nil for none.");
defvar("popper-group-function", null, "A function of no arguments giving the group the current buffer's popups belong to, such as popper-group-by-project; nil for one group.");
e8.defineHook("popper-open-popup-hook", "Functions called in a popup's buffer when popper opens it.");

type Status = "popup" | "raised" | "user-popup" | "suppressed";
type Popup = { window: number | undefined; buffer: string };
type Group = string | undefined;

/** Each buffer's popper-popup-status. */
const status = new PerBuffer<Status>();
/** When each buffer was last seen in a window, for ordering the open popups, as buffer-display-time does. */
const displayTime = new PerBuffer<number>();
let clock = 0;

let open: Popup[] = [];
const buried = new Map<Group, Popup[]>();
let names: string[] = [];
let modes: string[] = [];
type Fn = string | ((...args: never[]) => e8.Value);
let predicates: Fn[] = [];
let suppressedNames: string[] = [];
let suppressedModes: string[] = [];
let suppressedPredicates: Fn[] = [];

const enabled = () => e8.variable("popper-mode") === true;
const live = (buffer: string) => e8.getBuffer(buffer) !== undefined;
const majorMode = (buffer: string) => String(e8.bufferLocalValue("major-mode", buffer) ?? "");

/** Whether a buffer is one popper-reference-buffers names, as popper-popup-p. */
function popupP(buffer: string): boolean {
  return (
    names.some((re) => e8.stringMatch(re, buffer) !== undefined) ||
    modes.includes(majorMode(buffer)) ||
    predicates.some((p) => e8.withCurrentBuffer(buffer, () => e8.funcall(p, buffer)) === true)
  );
}

/** Whether a popup is one to keep from showing, as popper--suppress-p. */
function suppressP(buffer: string): boolean {
  return (
    suppressedNames.some((re) => e8.stringMatch(re, buffer) !== undefined) ||
    suppressedModes.includes(majorMode(buffer)) ||
    suppressedPredicates.some((p) => e8.withCurrentBuffer(buffer, () => e8.funcall(p, buffer)) === true)
  );
}

/** The project the current buffer is in, to group popups by, as popper-group-by-project. */
e8.defun("popper-group-by-project", () => projectCurrent() ?? null);

/** The project, else the directory, the current buffer is in, as popper-group-by-directory. */
e8.defun("popper-group-by-directory", () => projectCurrent() ?? e8.expandFileName(String(e8.variable("default-directory") ?? ".")));

/** The group a buffer's popups are in, by popper-group-function. */
function groupOf(buffer?: string): Group {
  const fn = e8.variable("popper-group-function");
  if (fn === null || fn === undefined || fn === false) return undefined;
  const value = buffer === undefined ? e8.funcall(fn as Fn) : e8.withCurrentBuffer(buffer, () => e8.funcall(fn as Fn));
  return typeof value === "string" ? value : undefined;
}

const buriedIn = (group: Group): Popup[] => buried.get(group) ?? [];

/** The popups among `buffers`, most recently shown first, marking each, as popper--find-popups. */
function findPopups(buffers: string[]): Popup[] {
  const found: Popup[] = [];
  for (const buffer of buffers) {
    if (/^ \*Minibuf-\d+\*$/.test(buffer)) continue;
    const s = status.get(buffer);
    if (s === "raised" || !(s === "popup" || s === "user-popup" || popupP(buffer))) continue;
    status.set(buffer, s ?? (suppressP(buffer) ? "suppressed" : "popup"));
    found.push({ window: e8.windowList().find((w) => e8.windowBuffer(w) === buffer), buffer });
  }
  return found.sort((a, b) => (displayTime.get(b.buffer) ?? 0) - (displayTime.get(a.buffer) ?? 0));
}

/** A popup's mode line, with popper-mode-line in it, as popper--modified-mode-line. */
function modifiedModeLine(buffer: string): e8.Value {
  const line = e8.bufferLocalValue("mode-line-format", buffer) ?? null;
  const pop = e8.variable("popper-mode-line");
  if (pop === null || pop === undefined || pop === false || !Array.isArray(line)) return line;
  const base = e8.defaultValue("mode-line-format");
  if (!Array.isArray(base) || line.some((e) => JSON.stringify(e) === JSON.stringify(pop))) return line;
  const at = Number(e8.variable("popper-mode-line-position") ?? 0);
  return [...base.slice(0, at), pop, ...base.slice(at)];
}

/** Puts popups' mode lines back as they were, as popper--restore-mode-lines. */
function restoreModeLines(popups: Popup[]): void {
  for (const { buffer } of popups) {
    if (!live(buffer)) continue;
    e8.withCurrentBuffer(buffer, () => e8.killLocalVariable("mode-line-format"));
  }
}

/** Brings the lists of open and buried popups up to date with the windows, as popper--update-popups. */
function updatePopups(): void {
  const shown = [...new Set(e8.windowList().map((w) => e8.windowBuffer(w)).filter((b): b is string => b !== undefined))];
  for (const buffer of shown) if (!open.some((p) => p.buffer === buffer)) displayTime.set(buffer, ++clock);
  const now = findPopups(shown);
  const closed = open.filter((p) => !now.some((q) => q.buffer === p.buffer) && live(p.buffer) && (status.get(p.buffer) === "popup" || status.get(p.buffer) === "user-popup"));
  open = now;
  for (const { buffer } of now) {
    const group = groupOf(buffer);
    buried.set(group, buriedIn(group).filter((p) => p.buffer !== buffer));
  }
  for (const popup of closed) {
    const group = groupOf(popup.buffer);
    buried.set(group, [popup, ...buriedIn(group).filter((p) => p.buffer !== popup.buffer)]);
  }
  for (const { buffer } of open) {
    const line = modifiedModeLine(buffer);
    e8.withCurrentBuffer(buffer, () => {
      e8.makeLocalVariable("mode-line-format");
      e8.setVariable("mode-line-format", line);
    });
  }
}

/** The popups not in any window when popper-mode starts, as popper--find-buried-popups. */
function findBuriedPopups(): void {
  const shown = e8.windowList().map((w) => e8.windowBuffer(w));
  for (const popup of findPopups(e8.bufferList().filter((b) => !shown.includes(b)))) {
    const group = groupOf(popup.buffer);
    buried.set(group, [popup, ...buriedIn(group)]);
  }
}

/** Takes a popup's window away, as popper--delete-popup: it quits, as quit-window does. */
function deletePopup(window: number | undefined): void {
  if (window === undefined || !e8.windowList().includes(window)) return;
  const selected = e8.selectedWindow();
  e8.selectWindow(window);
  e8.call("quit-window");
  if (selected !== window && e8.windowList().includes(selected)) e8.selectWindow(selected);
}

/** Hides the last popup opened, as popper-close-latest. */
function closeLatest(): void {
  if (!enabled()) e8.userError("Popper-mode not active!");
  const latest = open[0];
  if (latest === undefined) {
    e8.message("No open popups!");
    return;
  }
  const group = groupOf(latest.buffer);
  if (!buriedIn(group).some((p) => p.buffer === latest.buffer)) buried.set(group, [{ window: undefined, buffer: latest.buffer }, ...buriedIn(group)]);
  open = open.slice(1);
  deletePopup(latest.window);
}

/** Shows the last popup hidden in a group, as popper-open-latest. */
function openLatest(group: Group): void {
  if (!enabled()) e8.userError("Popper-mode not active!");
  const id = e8.variable("popper-group-function") ? group : undefined;
  for (;;) {
    const list = buriedIn(id);
    if (list.length === 0) {
      e8.message(id !== undefined ? `No buried popups for group ${id}` : "No buried popups");
      return;
    }
    const [next, ...rest] = list;
    buried.set(id, rest);
    if (!live(next.buffer)) continue;
    if (e8.variable("popper-display-control") === true) e8.call("pop-to-buffer", next.buffer);
    else e8.call("display-buffer", next.buffer);
    e8.withCurrentBuffer(next.buffer, () => e8.runHooks("popper-open-popup-hook"));
    return;
  }
}

/** Hides every open popup, as popper--bury-all. */
function buryAll(): void {
  while (open.length > 0) closeLatest();
}

/** Shows every hidden popup of the current group, as popper--open-all. */
function openAll(): void {
  const group = groupOf();
  while (buriedIn(group).length > 0) openLatest(group);
}

/** Keeps popups that should not show from showing, as popper--suppress-popups. */
function suppressPopups(): void {
  let changed = false;
  for (const { window, buffer } of open) {
    if (status.get(buffer) !== "suppressed" || window === undefined) continue;
    changed = true;
    status.set(buffer, "popup");
    const previous = e8.windowPrevBuffers(window).find(([b]) => b !== buffer && live(b));
    if (previous !== undefined) {
      const selected = e8.selectedWindow();
      e8.selectWindow(window);
      e8.call("switch-to-buffer", previous[0]);
      if (e8.windowList().includes(selected)) e8.selectWindow(selected);
    } else deletePopup(window);
    e8.message(`Popup suppressed: ${buffer}`);
  }
  if (changed) updatePopups();
}

/** Sorts popper-reference-buffers into names, modes and predicates, as popper--set-reference-vars. */
function setReferenceVars(): void {
  names = [];
  modes = [];
  predicates = [];
  suppressedNames = [];
  suppressedModes = [];
  suppressedPredicates = [];
  const insert = (entry: e8.Value, hide: boolean) => {
    if (Array.isArray(entry)) {
      insert(entry[0], entry[1] === "hide");
      return;
    }
    if (typeof entry === "string" && /^[\w-]+-mode$/i.test(entry)) (hide ? suppressedModes : modes).push(entry);
    else if (typeof entry === "string") (hide ? suppressedNames : names).push(entry);
    else if (typeof entry === "function") (hide ? suppressedPredicates : predicates).push(entry as Fn);
    if (hide) insert(entry, false);
  };
  const list = e8.variable("popper-reference-buffers");
  for (const entry of Array.isArray(list) ? list : []) insert(entry, false);
}

const onConfigurationChange = () => {
  updatePopups();
  suppressPopups();
};

e8.defineMinorMode({
  name: "popper-mode",
  global: true,
  doc: "Treat the buffers popper-reference-buffers names as popups, which popper-toggle shows and hides and popper-cycle goes through.",
  onChange: (on) => {
    if (on) {
      setReferenceVars();
      findBuriedPopups();
      updatePopups();
      e8.addHook("window-configuration-change-hook", onConfigurationChange);
    } else {
      e8.removeHook("window-configuration-change-hook", onConfigurationChange);
      for (const popups of buried.values()) restoreModeLines(popups);
      restoreModeLines(open);
      buried.clear();
      open = [];
      names = [];
      modes = [];
      predicates = [];
      suppressedNames = [];
      suppressedModes = [];
      suppressedPredicates = [];
    }
  },
});

e8.defineCommand({
  name: "popper-toggle",
  doc:
    "Show the last popup hidden, or hide the last one shown.\n\n" +
    "With C-u, show the next popup as well as the one open; with C-u C-u, hide every popup, or show every one of the group when none is open.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const n = typeof arg === "number" ? arg : Array.isArray(arg) ? Number(arg[0]) : 1;
    const group = groupOf();
    if (open.length > 0) {
      if (n === 4) openLatest(group);
      else if (n === 16) buryAll();
      else closeLatest();
    } else if (n === 16) openAll();
    else openLatest(group);
  },
});

const cycle = (num: number) => {
  const group = num !== 0 ? groupOf() : undefined;
  if (open.length === 0) {
    openLatest(group);
    return;
  }
  if (buriedIn(group).length === 0) {
    // A new cycle: hide everything first.
    buryAll();
    return;
  }
  closeLatest();
  const list = buriedIn(group);
  buried.set(group, num > 0 ? [...list.slice(1), list[0]] : [list[list.length - 1], ...list.slice(0, -1)]);
  openLatest(group);
};

e8.defineCommand({
  name: "popper-cycle",
  doc: "Hide the open popup and show the next, one at a time; backwards for a negative count, and among the popups of no group for 0.",
  params: [{ name: "num", kind: "count" }],
  run: (num: number) => cycle(num),
});

e8.defineCommand({
  name: "popper-cycle-backwards",
  doc: "Hide the open popup and show the one before it.",
  params: [{ name: "num", kind: "count" }],
  run: (num: number) => cycle(-num),
});

/** Makes a popup a regular buffer, as popper-raise-popup. */
function raise(buffer: string): void {
  if (popupP(buffer)) status.set(buffer, "raised");
  else status.delete(buffer);
  e8.withCurrentBuffer(buffer, () => e8.killLocalVariable("mode-line-format"));
  const window = e8.windowList().find((w) => e8.windowBuffer(w) === buffer);
  deletePopup(window);
  e8.call("pop-to-buffer", buffer);
}

/** Makes a regular buffer a popup, as popper-lower-to-popup. */
function lower(buffer: string): void {
  status.set(buffer, popupP(buffer) ? "popup" : "user-popup");
  const window = e8.windowList().find((w) => e8.windowBuffer(w) === buffer);
  deletePopup(window);
  e8.call("pop-to-buffer", buffer);
  updatePopups();
}

e8.defineCommand({
  name: "popper-toggle-type",
  doc: "Make the current buffer a popup if it is a regular buffer, or a regular buffer if it is a popup.",
  run: () => {
    const buffer = e8.bufferName();
    const s = status.get(buffer);
    if (s === "popup" || s === "user-popup") raise(buffer);
    else lower(buffer);
  },
});

e8.defineCommand({
  name: "popper-kill-latest-popup",
  doc: "Kill the last popup shown, and take its window away.",
  run: () => {
    const latest = open[0];
    if (latest === undefined) {
      e8.message("No open popups!");
      return;
    }
    open = open.slice(1);
    deletePopup(latest.window);
    e8.call("kill-buffer", latest.buffer);
  },
});
