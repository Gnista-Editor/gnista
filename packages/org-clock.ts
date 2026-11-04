// Clocking time on Org entries, after Org's org-clock.el: C-c C-x C-i
// starts a clock on the entry at point, a CLOCK: line in its LOGBOOK drawer,
// and the mode line shows how long it has run; C-c C-x C-o stops it,
// writing the end and the duration; C-c C-x C-q cancels it and C-c C-x C-j
// goes back to its entry.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { type DateTime, formatTimestamp, type Heading, headingIndex, headings, isDone, today } from "org";
import { toggleDrawerOrBlock } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("org-clock-into-drawer", true, "Whether CLOCK: lines go into a drawer: t for LOGBOOK, or org-log-into-drawer's drawer if that names one, or the drawer's name.");
defvar("org-clock-out-when-done", true, "Whether marking the clocked entry done stops the clock.");
defvar("org-clock-out-remove-zero-time-clocks", false, "Whether a clock stopped after no time is taken out.");
defvar("org-mode-line-string", "", "What the mode line shows of the running clock: its time and its entry's heading.");
ember.defineHook("org-clock-in-hook", "Functions called when a clock starts.");
ember.defineHook("org-clock-out-hook", "Functions called when a clock stops.");
ember.defineHook("org-clock-cancel-hook", "Functions called when a clock is cancelled.");
ember.defineFace({ name: "org-mode-line-clock", doc: "The running clock in the mode line.", attributes: { inherit: "mode-line" } });

/** The running clock: its CLOCK: line, its heading's title, and when it started. */
interface Clock {
  line: ember.Marker;
  heading: ember.Marker;
  title: string;
  start: number;
  /** Minutes clocked on the entry before, for the mode line, as org-clock-total-time. */
  before: number;
}

let clock: Clock | undefined;
/** Where the last clock ran, for C-c C-x C-j and C-c C-x C-x after it stops. */
let last: ember.Marker | undefined;
let timer: number | undefined;

/** Now, or the day tests fix at noon, as an Org time. */
function now(): DateTime {
  return today(true);
}

/** An Org time as milliseconds, to count minutes between. */
function millis(t: DateTime): number {
  return new Date(t.year, t.month - 1, t.day, t.hour ?? 0, t.minute ?? 0).getTime();
}

/** Minutes as Org writes a duration: 0:05, or 1d 2:03 past a day, as org-duration-from-minutes. */
export function durationFromMinutes(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  const hm = `${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, "0")}`;
  return days > 0 ? `${days}d ${hm.padStart(5, "0")}` : hm;
}

/** The drawer CLOCK: lines go in, as org-clock-drawer-name: nil for none. */
function drawerName(): string | undefined {
  const into = ember.variable("org-clock-into-drawer");
  if (typeof into === "string" && into !== "") return into;
  if (into === null || into === false) return undefined;
  const log = ember.variable("org-log-into-drawer");
  return typeof log === "string" && log !== "" ? log : "LOGBOOK";
}

const CLOCK_LINE = /^[ \t]*CLOCK: \[(\d{4})-(\d\d)-(\d\d) \S+ (\d\d):(\d\d)\](?:--\[[^\]]*\] =>\s+(?:(\d+)d )?(\d+):(\d\d))?[ \t]*$/;

/** The heading point is in, or the error Org gives before the first. */
function headingHere(): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) ember.userError("Before first headline at position " + (ember.point() + 1) + " in buffer " + ember.bufferName());
  return [all, i];
}

/** The minutes the entry's closed clocks add up to, as org-clock-sum-current-item. */
function clockedBefore(all: Heading[], i: number): number {
  const end = all[i + 1]?.start ?? ember.bufferSize();
  let minutes = 0;
  for (let l = all[i].line + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
    const m = CLOCK_LINE.exec(ember.lineText(l));
    if (m && m[7] !== undefined) minutes += Number(m[6] ?? 0) * 1440 + Number(m[7]) * 60 + Number(m[8]);
  }
  return minutes;
}

/**
 * Where a new CLOCK: line goes, as org-clock-find-position: at the top of
 * the entry's drawer, which is made, folded, after its metadata if need be.
 * Returns the start of the line to put it before.
 */
function findPosition(all: Heading[], i: number): number {
  const h = all[i];
  const end = all[i + 1]?.start ?? ember.bufferSize();
  const drawer = drawerName();
  if (drawer !== undefined) {
    const opener = new RegExp(`^[ \\t]*:${drawer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*$`, "i");
    for (let l = h.line + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
      if (opener.test(ember.lineText(l))) return lineStartOrEnd(l + 1);
    }
  }
  // Without a drawer, before the entry's first CLOCK: line, if it has one.
  for (let l = h.line + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
    if (drawer === undefined && CLOCK_LINE.test(ember.lineText(l))) return ember.lineStart(l);
  }
  let at = endOfMetaData(h);
  if (at !== ember.lineStart(lineAt(at))) {
    ember.gotoChar(at);
    ember.insert("\n");
    at = ember.point();
  }
  if (drawer === undefined) return at;
  ember.gotoChar(at);
  ember.insert(`:${drawer}:\n:END:\n`);
  toggleDrawerOrBlock(lineAt(at), true);
  return ember.lineStart(lineAt(at) + 1);
}

/** Shows the clock in every mode line, as org-clock-update-mode-line. */
function updateModeLine(): void {
  if (!clock) return;
  const minutes = Math.max(0, Math.floor((millis(now()) - clock.start) / 60000)) + clock.before;
  ember.setVariable("org-mode-line-string", ember.propertize(`[${durationFromMinutes(minutes)}] (${clock.title}) `, { face: "org-mode-line-clock" }));
  const global = ember.variable("global-mode-string");
  const sym = ember.intern("org-mode-line-string");
  const list = Array.isArray(global) ? global : [""];
  if (!list.includes(sym)) ember.setVariable("global-mode-string", [...list, sym]);
}

/** Takes the clock out of the mode line. */
function clearModeLine(): void {
  const global = ember.variable("global-mode-string");
  const sym = ember.intern("org-mode-line-string");
  if (Array.isArray(global)) ember.setVariable("global-mode-string", global.filter((v) => v !== sym));
  if (timer !== undefined) ember.cancelTimer(timer);
  timer = undefined;
}

/** Whether a clock is running, as org-clocking-p. */
export const clockingP = (): boolean => clock !== undefined;

/** Where the running clock's entry is, its buffer and heading, or undefined. */
export function runningEntry(): { buffer: string; start: number } | undefined {
  const buffer = clock && ember.markerBuffer(clock.heading);
  const start = clock && ember.markerPosition(clock.heading);
  return buffer === undefined || start === undefined ? undefined : { buffer, start };
}

/** Starts a clock on the entry at point, stopping one running elsewhere, as org-clock-in. */
export function clockIn(): void {
  const [all, i] = headingHere();
  const h = all[i];
  if (clock) {
    const pos = ember.markerPosition(clock.heading);
    if (ember.markerBuffer(clock.heading) === ember.bufferName() && pos === h.start) {
      ember.message(`Clock continues in "${clock.title}"`);
      return;
    }
    clockOut();
  }
  const title = h.title.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, l: string, d?: string) => d ?? l);
  const before = clockedBefore(all, i);
  const start = now();
  const stamp = `[${formatTimestamp(start, true)}]`;
  ember.saveExcursion(() => {
    ember.saveRestriction(() => {
      ember.widen();
      const at = findPosition(headings(), headingIndex(headings(), h.line) as number);
      ember.gotoChar(at);
      ember.insert(`CLOCK: ${stamp}\n`);
      clock = { line: ember.makeMarker(at), heading: ember.makeMarker(h.start), title, start: millis(start), before };
    });
  });
  if (last) ember.deleteMarker(last);
  last = ember.makeMarker(h.start);
  updateModeLine();
  timer = ember.runWithTimer(60, 60, updateModeLine);
  ember.message(`Clock starts at ${stamp} - `);
  ember.runHooks("org-clock-in-hook");
}

/** Stops the running clock, writing its end and duration, as org-clock-out. */
export function clockOut(failQuietly = false): void {
  if (!clock) {
    clearModeLine();
    if (failQuietly) return;
    ember.userError("No active clock");
  }
  const running = clock;
  const buffer = ember.markerBuffer(running.line);
  if (buffer === undefined) {
    clock = undefined;
    clearModeLine();
    ember.signal("error", "Clock start time is gone");
  }
  const end = now();
  const te = `[${formatTimestamp(end, true)}]`;
  let removed = false;
  let minutes = 0;
  ember.withCurrentBuffer(buffer, () => {
    ember.saveExcursion(() => {
      ember.saveRestriction(() => {
        ember.widen();
        const line = lineAt(ember.markerPosition(running.line) ?? 0);
        const m = /^([ \t]*CLOCK: \[[^\]]*\])/.exec(ember.lineText(line));
        if (!m) ember.signal("error", "Clock start time is gone");
        const from = ember.lineStart(line) + m[1].length;
        minutes = Math.max(0, Math.floor((millis(end) - running.start) / 60000));
        ember.deleteRegion(from, ember.lineEnd(line));
        ember.gotoChar(from);
        ember.insert(`--${te} => ${String(Math.floor(minutes / 60)).padStart(2)}:${String(minutes % 60).padStart(2, "0")}`);
        if (minutes === 0 && ember.variable("org-clock-out-remove-zero-time-clocks") === true) {
          removed = true;
          ember.deleteRegion(ember.lineStart(line), lineStartOrEnd(line + 1));
          removeEmptyDrawer(line);
        }
      });
    });
  });
  ember.deleteMarker(running.line);
  ember.deleteMarker(running.heading);
  clock = undefined;
  clearModeLine();
  ember.message(`Clock stopped at ${te} after ${durationFromMinutes(minutes)}${removed ? " => LINE REMOVED" : ""}`);
  ember.runHooks("org-clock-out-hook");
}

/** Takes away the clock drawer the line before `line` opened, if it is now empty, as org-remove-empty-drawer-at. */
function removeEmptyDrawer(line: number): void {
  const drawer = drawerName();
  if (drawer === undefined || line < 1) return;
  if (new RegExp(`^[ \\t]*:${drawer}:[ \\t]*$`, "i").test(ember.lineText(line - 1)) && /^[ \t]*:END:[ \t]*$/i.test(ember.lineText(line))) {
    ember.deleteRegion(ember.lineStart(line - 1), lineStartOrEnd(line + 1));
  }
}

ember.defineCommand({
  name: "org-clock-in",
  doc: "Start a clock on the entry point is in: a CLOCK: line in its LOGBOOK drawer, the time shown in the mode line. A clock running elsewhere stops first.",
  run: () => clockIn(),
});

ember.defineCommand({
  name: "org-clock-out",
  doc: "Stop the running clock, writing when it stopped and how long it ran.",
  run: () => clockOut(),
});

ember.defineCommand({
  name: "org-clock-cancel",
  doc: "Cancel the running clock, taking its CLOCK: line away.",
  run: () => {
    if (!clock) {
      ember.message("No active clock");
      return;
    }
    const running = clock;
    const buffer = ember.markerBuffer(running.line);
    if (buffer !== undefined) {
      ember.withCurrentBuffer(buffer, () => {
        ember.saveExcursion(() => {
          const line = lineAt(ember.markerPosition(running.line) ?? 0);
          if (/^[ \t]*CLOCK: \[[^\]]*\][ \t]*$/.test(ember.lineText(line))) {
            ember.deleteRegion(ember.lineStart(line), lineStartOrEnd(line + 1));
            removeEmptyDrawer(line);
          }
        });
      });
    }
    ember.deleteMarker(running.line);
    ember.deleteMarker(running.heading);
    clock = undefined;
    clearModeLine();
    ember.message("Clock canceled");
    ember.runHooks("org-clock-cancel-hook");
  },
});

ember.defineCommand({
  name: "org-clock-goto",
  doc: "Go to the entry with the running clock, or the last one clocked.",
  run: () => {
    const target = clock?.heading ?? last;
    const buffer = target === undefined ? undefined : ember.markerBuffer(target);
    if (target === undefined || buffer === undefined) ember.userError("No active or recent clock task");
    ember.call("switch-to-buffer", buffer);
    ember.gotoChar(ember.markerPosition(target) ?? 0);
    ember.message(clock ? "Clock is running" : "No running clock, this is the most recently clocked task");
  },
});

ember.defineCommand({
  name: "org-clock-in-last",
  doc: "Start a clock again on the entry clocked last.",
  run: () => {
    if (clock) {
      ember.message(`Already clocking in on "${clock.title}"`);
      return;
    }
    const buffer = last === undefined ? undefined : ember.markerBuffer(last);
    if (last === undefined || buffer === undefined) ember.userError("No last clock");
    ember.withCurrentBuffer(buffer, () => {
      ember.saveExcursion(() => {
        ember.gotoChar(ember.markerPosition(last!) ?? 0);
        clockIn();
      });
    });
  },
});

// Marking the clocked entry done stops its clock, as org-clock-out-if-current does.
ember.addHook("org-after-todo-state-change-hook", () => {
  if (!clock || ember.variable("org-clock-out-when-done") !== true) return;
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined || ember.markerBuffer(clock.heading) !== ember.bufferName() || ember.markerPosition(clock.heading) !== all[i].start) return;
  if (isDone(all[i].todo)) clockOut(true);
});

for (const [keys, command] of [
  ["C-c C-x C-i", "org-clock-in"],
  ["C-c C-x C-o", "org-clock-out"],
  ["C-c C-x C-q", "org-clock-cancel"],
  ["C-c C-x C-j", "org-clock-goto"],
  ["C-c C-x C-x", "org-clock-in-last"],
] as const) {
  ember.defineKey("org-mode-map", keys, command);
}
