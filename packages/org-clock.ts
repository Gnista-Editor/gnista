// Clocking time on Org entries, after Org's org-clock.el: C-c C-x C-i
// starts a clock on the entry at point, a CLOCK: line in its LOGBOOK drawer,
// and the mode line shows how long it has run; C-c C-x C-o stops it,
// writing the end and the duration; C-c C-x C-q cancels it and C-c C-x C-j
// goes back to its entry.
//
// Copyright (C) 2004-2025 Free Software Foundation, Inc.
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { type DateTime, formatTimestamp, type Heading, headingIndex, headings, isDone, today } from "org";
import { toggleDrawerOrBlock } from "org-fold";
import { endOfMetaData } from "org-list";
import { lineAt, lineStartOrEnd } from "org-macs";

const defvar = (name: string, value: gnista.Value, doc: string) => gnista.defineVariable({ name, value, doc });
defvar("org-clock-into-drawer", true, "Whether CLOCK: lines go into a drawer: t for LOGBOOK, or org-log-into-drawer's drawer if that names one, or the drawer's name.");
defvar("org-clock-out-when-done", true, "Whether marking the clocked entry done stops the clock.");
defvar("org-clock-out-remove-zero-time-clocks", false, "Whether a clock stopped after no time is taken out.");
defvar("org-mode-line-string", "", "What the mode line shows of the running clock: its time and its entry's heading.");
gnista.defineHook("org-clock-in-hook", "Functions called when a clock starts.");
gnista.defineHook("org-clock-out-hook", "Functions called when a clock stops.");
gnista.defineHook("org-clock-cancel-hook", "Functions called when a clock is cancelled.");
gnista.defineFace({ name: "org-mode-line-clock", doc: "The running clock in the mode line.", attributes: { inherit: "mode-line" } });

/** The running clock: its CLOCK: line, its heading's title, and when it started. */
interface Clock {
  line: gnista.Marker;
  heading: gnista.Marker;
  title: string;
  start: number;
  /** Minutes clocked on the entry before, for the mode line, as org-clock-total-time. */
  before: number;
}

let clock: Clock | undefined;
/** Where the last clock ran, for C-c C-x C-j and C-c C-x C-x after it stops. */
let last: gnista.Marker | undefined;
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
  const into = gnista.variable("org-clock-into-drawer");
  if (typeof into === "string" && into !== "") return into;
  if (into === null || into === false) return undefined;
  const log = gnista.variable("org-log-into-drawer");
  return typeof log === "string" && log !== "" ? log : "LOGBOOK";
}

const CLOCK_LINE = /^[ \t]*CLOCK: \[(\d{4})-(\d\d)-(\d\d) \S+ (\d\d):(\d\d)\](?:--\[[^\]]*\] =>\s+(?:(\d+)d )?(\d+):(\d\d))?[ \t]*$/;

/** The heading point is in, or the error Org gives before the first. */
function headingHere(): [Heading[], number] {
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined) gnista.userError("Before first headline at position " + (gnista.point() + 1) + " in buffer " + gnista.bufferName());
  return [all, i];
}

/** The minutes the entry's closed clocks add up to, as org-clock-sum-current-item. */
function clockedBefore(all: Heading[], i: number): number {
  const end = all[i + 1]?.start ?? gnista.bufferSize();
  let minutes = 0;
  for (let l = all[i].line + 1; l < gnista.lineCount() && gnista.lineStart(l) < end; l++) {
    const m = CLOCK_LINE.exec(gnista.lineText(l));
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
  const end = all[i + 1]?.start ?? gnista.bufferSize();
  const drawer = drawerName();
  if (drawer !== undefined) {
    const opener = new RegExp(`^[ \\t]*:${drawer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*$`, "i");
    for (let l = h.line + 1; l < gnista.lineCount() && gnista.lineStart(l) < end; l++) {
      if (opener.test(gnista.lineText(l))) return lineStartOrEnd(l + 1);
    }
  }
  // Without a drawer, before the entry's first CLOCK: line, if it has one.
  for (let l = h.line + 1; l < gnista.lineCount() && gnista.lineStart(l) < end; l++) {
    if (drawer === undefined && CLOCK_LINE.test(gnista.lineText(l))) return gnista.lineStart(l);
  }
  let at = endOfMetaData(h);
  if (at !== gnista.lineStart(lineAt(at))) {
    gnista.gotoChar(at);
    gnista.insert("\n");
    at = gnista.point();
  }
  if (drawer === undefined) return at;
  gnista.gotoChar(at);
  gnista.insert(`:${drawer}:\n:END:\n`);
  toggleDrawerOrBlock(lineAt(at), true);
  return gnista.lineStart(lineAt(at) + 1);
}

/** Shows the clock in every mode line, as org-clock-update-mode-line. */
function updateModeLine(): void {
  if (!clock) return;
  const minutes = Math.max(0, Math.floor((millis(now()) - clock.start) / 60000)) + clock.before;
  gnista.setVariable("org-mode-line-string", gnista.propertize(`[${durationFromMinutes(minutes)}] (${clock.title}) `, { face: "org-mode-line-clock" }));
  const global = gnista.variable("global-mode-string");
  const sym = gnista.intern("org-mode-line-string");
  const list = Array.isArray(global) ? global : [""];
  if (!list.includes(sym)) gnista.setVariable("global-mode-string", [...list, sym]);
}

/** Takes the clock out of the mode line. */
function clearModeLine(): void {
  const global = gnista.variable("global-mode-string");
  const sym = gnista.intern("org-mode-line-string");
  if (Array.isArray(global)) gnista.setVariable("global-mode-string", global.filter((v) => v !== sym));
  if (timer !== undefined) gnista.cancelTimer(timer);
  timer = undefined;
}

/** Whether a clock is running, as org-clocking-p. */
export const clockingP = (): boolean => clock !== undefined;

/** Where the running clock's entry is, its buffer and heading, or undefined. */
export function runningEntry(): { buffer: string; start: number } | undefined {
  const buffer = clock && gnista.markerBuffer(clock.heading);
  const start = clock && gnista.markerPosition(clock.heading);
  return buffer === undefined || start === undefined ? undefined : { buffer, start };
}

/** Starts a clock on the entry at point, stopping one running elsewhere, as org-clock-in. */
export function clockIn(): void {
  const [all, i] = headingHere();
  const h = all[i];
  if (clock) {
    const pos = gnista.markerPosition(clock.heading);
    if (gnista.markerBuffer(clock.heading) === gnista.bufferName() && pos === h.start) {
      gnista.message(`Clock continues in "${clock.title}"`);
      return;
    }
    clockOut();
  }
  const title = h.title.replace(/\[\[([^\]]*)\](?:\[([^\]]*)\])?\]/g, (_, l: string, d?: string) => d ?? l);
  const before = clockedBefore(all, i);
  const start = now();
  const stamp = `[${formatTimestamp(start, true)}]`;
  gnista.saveExcursion(() => {
    gnista.saveRestriction(() => {
      gnista.widen();
      const at = findPosition(headings(), headingIndex(headings(), h.line) as number);
      gnista.gotoChar(at);
      gnista.insert(`CLOCK: ${stamp}\n`);
      clock = { line: gnista.makeMarker(at), heading: gnista.makeMarker(h.start), title, start: millis(start), before };
    });
  });
  if (last) gnista.deleteMarker(last);
  last = gnista.makeMarker(h.start);
  updateModeLine();
  timer = gnista.runWithTimer(60, 60, updateModeLine);
  gnista.message(`Clock starts at ${stamp} - `);
  gnista.runHooks("org-clock-in-hook");
}

/** Stops the running clock, writing its end and duration, as org-clock-out. */
export function clockOut(failQuietly = false): void {
  if (!clock) {
    clearModeLine();
    if (failQuietly) return;
    gnista.userError("No active clock");
  }
  const running = clock;
  const buffer = gnista.markerBuffer(running.line);
  if (buffer === undefined) {
    clock = undefined;
    clearModeLine();
    gnista.signal("error", "Clock start time is gone");
  }
  const end = now();
  const te = `[${formatTimestamp(end, true)}]`;
  let removed = false;
  let minutes = 0;
  gnista.withCurrentBuffer(buffer, () => {
    gnista.saveExcursion(() => {
      gnista.saveRestriction(() => {
        gnista.widen();
        const line = lineAt(gnista.markerPosition(running.line) ?? 0);
        const m = /^([ \t]*CLOCK: \[[^\]]*\])/.exec(gnista.lineText(line));
        if (!m) gnista.signal("error", "Clock start time is gone");
        const from = gnista.lineStart(line) + m[1].length;
        minutes = Math.max(0, Math.floor((millis(end) - running.start) / 60000));
        gnista.deleteRegion(from, gnista.lineEnd(line));
        gnista.gotoChar(from);
        gnista.insert(`--${te} => ${String(Math.floor(minutes / 60)).padStart(2)}:${String(minutes % 60).padStart(2, "0")}`);
        if (minutes === 0 && gnista.variable("org-clock-out-remove-zero-time-clocks") === true) {
          removed = true;
          gnista.deleteRegion(gnista.lineStart(line), lineStartOrEnd(line + 1));
          removeEmptyDrawer(line);
        }
      });
    });
  });
  gnista.deleteMarker(running.line);
  gnista.deleteMarker(running.heading);
  clock = undefined;
  clearModeLine();
  gnista.message(`Clock stopped at ${te} after ${durationFromMinutes(minutes)}${removed ? " => LINE REMOVED" : ""}`);
  gnista.runHooks("org-clock-out-hook");
}

/** Takes away the clock drawer the line before `line` opened, if it is now empty, as org-remove-empty-drawer-at. */
function removeEmptyDrawer(line: number): void {
  const drawer = drawerName();
  if (drawer === undefined || line < 1) return;
  if (new RegExp(`^[ \\t]*:${drawer}:[ \\t]*$`, "i").test(gnista.lineText(line - 1)) && /^[ \t]*:END:[ \t]*$/i.test(gnista.lineText(line))) {
    gnista.deleteRegion(gnista.lineStart(line - 1), lineStartOrEnd(line + 1));
  }
}

gnista.defineCommand({
  name: "org-clock-in",
  doc: "Start a clock on the entry point is in: a CLOCK: line in its LOGBOOK drawer, the time shown in the mode line. A clock running elsewhere stops first.",
  run: () => clockIn(),
});

gnista.defineCommand({
  name: "org-clock-out",
  doc: "Stop the running clock, writing when it stopped and how long it ran.",
  run: () => clockOut(),
});

gnista.defineCommand({
  name: "org-clock-cancel",
  doc: "Cancel the running clock, taking its CLOCK: line away.",
  run: () => {
    if (!clock) {
      gnista.message("No active clock");
      return;
    }
    const running = clock;
    const buffer = gnista.markerBuffer(running.line);
    if (buffer !== undefined) {
      gnista.withCurrentBuffer(buffer, () => {
        gnista.saveExcursion(() => {
          const line = lineAt(gnista.markerPosition(running.line) ?? 0);
          if (/^[ \t]*CLOCK: \[[^\]]*\][ \t]*$/.test(gnista.lineText(line))) {
            gnista.deleteRegion(gnista.lineStart(line), lineStartOrEnd(line + 1));
            removeEmptyDrawer(line);
          }
        });
      });
    }
    gnista.deleteMarker(running.line);
    gnista.deleteMarker(running.heading);
    clock = undefined;
    clearModeLine();
    gnista.message("Clock canceled");
    gnista.runHooks("org-clock-cancel-hook");
  },
});

gnista.defineCommand({
  name: "org-clock-goto",
  doc: "Go to the entry with the running clock, or the last one clocked.",
  run: () => {
    const target = clock?.heading ?? last;
    const buffer = target === undefined ? undefined : gnista.markerBuffer(target);
    if (target === undefined || buffer === undefined) gnista.userError("No active or recent clock task");
    gnista.call("switch-to-buffer", buffer);
    gnista.gotoChar(gnista.markerPosition(target) ?? 0);
    gnista.message(clock ? "Clock is running" : "No running clock, this is the most recently clocked task");
  },
});

gnista.defineCommand({
  name: "org-clock-in-last",
  doc: "Start a clock again on the entry clocked last.",
  run: () => {
    if (clock) {
      gnista.message(`Already clocking in on "${clock.title}"`);
      return;
    }
    const buffer = last === undefined ? undefined : gnista.markerBuffer(last);
    if (last === undefined || buffer === undefined) gnista.userError("No last clock");
    gnista.withCurrentBuffer(buffer, () => {
      gnista.saveExcursion(() => {
        gnista.gotoChar(gnista.markerPosition(last!) ?? 0);
        clockIn();
      });
    });
  },
});

// Marking the clocked entry done stops its clock, as org-clock-out-if-current does.
gnista.addHook("org-after-todo-state-change-hook", () => {
  if (!clock || gnista.variable("org-clock-out-when-done") !== true) return;
  const all = headings();
  const i = headingIndex(all, lineAt());
  if (i === undefined || gnista.markerBuffer(clock.heading) !== gnista.bufferName() || gnista.markerPosition(clock.heading) !== all[i].start) return;
  if (isDone(all[i].todo)) clockOut(true);
});

// Before exiting, a running clock is offered to be stopped and its file saved, as org-clock-kill-emacs-query.
gnista.addHook("kill-emacs-query-functions", () => {
  const buffer = clock && gnista.markerBuffer(clock.line);
  if (buffer !== undefined && gnista.yesOrNoP("Clock out and save? ")) {
    clockOut();
    gnista.withCurrentBuffer(buffer, () => gnista.call("save-buffer"));
  }
  return true;
});

for (const [keys, command] of [
  ["C-c C-x C-i", "org-clock-in"],
  ["C-c C-x C-o", "org-clock-out"],
  ["C-c C-x C-q", "org-clock-cancel"],
  ["C-c C-x C-j", "org-clock-goto"],
  ["C-c C-x C-x", "org-clock-in-last"],
] as const) {
  gnista.defineKey("org-mode-map", keys, command);
}
