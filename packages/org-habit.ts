// Habits, after Org's org-habit.el: an entry with a STYLE property of habit
// and a repeating SCHEDULED date, as SCHEDULED: <2026-11-04 Wed .+1d>, shows
// in today's agenda with a graph of the last three weeks and the next: when
// it was done, and whether it was due, from the State notes its LOGBOOK
// keeps.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { type Heading, allKeywords, entryEnd, headings, isDone } from "org";
import { entryGet } from "org-list";

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("org-habit-graph-column", 40, "The column of the agenda where habits' graphs start.");
defvar("org-habit-preceding-days", 21, "How many days before today a habit's graph shows.");
defvar("org-habit-following-days", 7, "How many days after today a habit's graph shows.");
defvar("org-habit-show-habits", true, "Whether the agenda shows habits.");
defvar("org-habit-show-habits-only-for-today", true, "Whether habits show only on today in the agenda, not on the days after.");
defvar("org-habit-today-glyph", "!", "What marks today in a habit's graph.");
defvar("org-habit-completed-glyph", "*", "What marks a day the habit was done in its graph.");
defvar("org-habit-show-done-always-green", false, "Whether a day the habit was done shows green, however late it was.");

for (const [name, doc, light, dark] of [
  ["org-habit-clear-face", "Days before a habit is due.", "#8270f9", "blue"],
  ["org-habit-clear-future-face", "Days to come before a habit is due.", "#d6e4fc", "midnightblue"],
  ["org-habit-ready-face", "Days a habit should be done on.", "#4df946", "forestgreen"],
  ["org-habit-ready-future-face", "Days to come a habit should be done on.", "#acfca9", "darkgreen"],
  ["org-habit-alert-face", "The day a habit is due.", "#f5f946", "gold"],
  ["org-habit-alert-future-face", "A day to come a habit is due.", "#fafca9", "darkgoldenrod"],
  ["org-habit-overdue-face", "Days a habit is overdue.", "#f9372d", "firebrick"],
  ["org-habit-overdue-future-face", "Days to come a habit will be overdue.", "#fc9590", "darkred"],
] as const) {
  ember.defineFace({ name, doc, light: { background: light }, dark: { background: dark } });
}

/** A habit, as org-habit-parse-todo reads it: days counted from 1970. */
export interface Habit {
  scheduled: number;
  repeat: number;
  deadline?: number;
  deadlineRepeat?: number;
  done: number[];
  type: string;
}

const dayOf = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

/** Days a duration such as 1d or 2w is, as org-habit-duration-to-days. */
function durationToDays(n: number, unit: string): number {
  return Math.floor(n * ({ d: 1, w: 7, m: 30.4, y: 365.25 } as Record<string, number>)[unit]);
}

/** Whether a heading's entry is a habit, as org-is-habit-p. */
export function isHabit(h: Heading): boolean {
  return entryGet(h.line, "STYLE") === "habit";
}

/** A habit's schedule and when it was done, as org-habit-parse-todo; undefined if it is not one. */
export function parseHabit(h: Heading): Habit | undefined {
  if (!isHabit(h)) return undefined;
  const all = headings();
  const i = all.findIndex((x) => x.start === h.start);
  const end = entryEnd(all, i);
  const lines: string[] = [];
  for (let l = h.line + 1; l < ember.lineCount() && ember.lineStart(l) < end; l++) lines.push(ember.lineText(l));
  const sched = /SCHEDULED:[ \t]*<(\d{4})-(\d\d)-(\d\d)[^>\n]*?([.+]?\+)(\d+)([dwmy])(?:\/(\d+)([dwmy]))?[^>\n]*>/.exec(lines.join("\n"));
  if (!sched) ember.signal("error", `Habit ${h.title} has no scheduled repeat period or has an incorrect one`);
  const scheduled = dayOf(Number(sched[1]), Number(sched[2]), Number(sched[3]));
  const repeat = durationToDays(Number(sched[5]), sched[6]);
  if (repeat <= 0) ember.signal("error", `Habit ${h.title} scheduled repeat period is less than 1d`);
  const habit: Habit = { scheduled, repeat, done: [], type: sched[4] };
  if (sched[7] !== undefined) {
    habit.deadlineRepeat = durationToDays(Number(sched[7]), sched[8]);
    habit.deadline = scheduled + (habit.deadlineRepeat - repeat);
  }
  // The State notes into a done state, newest first, as many as the graph can show.
  const done = allKeywords().filter((k) => isDone(k)).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`^[ \\t]*-[ \\t]+State "(?:${done})".*\\[(\\d{4})-(\\d\\d)-(\\d\\d)[^\\]]*\\]`);
  const max = Number(ember.variable("org-habit-preceding-days") ?? 21) + Number(ember.variable("org-habit-following-days") ?? 7);
  for (const line of lines) {
    const m = re.exec(line);
    if (m && habit.done.length < max) habit.done.push(dayOf(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return habit;
}

/** The day a habit is due by, as org-habit-deadline. */
function deadlineOf(habit: Habit): number {
  return habit.deadline ?? (habit.deadlineRepeat !== undefined ? habit.scheduled + habit.repeat - 1 : habit.scheduled);
}

/** How urgent a habit is, as org-habit-get-urgency: the more overdue, the more. */
export function habitUrgency(habit: Habit, now: number): number {
  let pri = 1000 + (now - habit.scheduled) * 10;
  const deadline = deadlineOf(habit);
  if (habit.scheduled !== deadline && now === deadline) pri += 50;
  const slip = now - (deadline - 1);
  return pri + (slip > 0 ? slip * 100 : slip * 10);
}

type Faces = [string, string];

/** The faces for a day of a habit, as org-habit-get-faces: blue before it is due, then green, yellow and red. */
function facesFor(habit: Habit, day: number, scheduledDays: number | undefined, done: boolean): Faces {
  const scheduled = scheduledDays ?? habit.scheduled;
  const deadline = scheduledDays !== undefined ? scheduledDays + ((habit.deadlineRepeat ?? habit.repeat) - habit.repeat) : deadlineOf(habit);
  if (day < scheduled) return ["org-habit-clear-face", "org-habit-clear-future-face"];
  if (day < deadline) return ["org-habit-ready-face", "org-habit-ready-future-face"];
  if (day === deadline) return done ? ["org-habit-ready-face", "org-habit-ready-future-face"] : ["org-habit-alert-face", "org-habit-alert-future-face"];
  if (ember.variable("org-habit-show-done-always-green") === true && done) return ["org-habit-ready-face", "org-habit-ready-future-face"];
  return ["org-habit-overdue-face", "org-habit-overdue-future-face"];
}

/** A habit's graph from `start` to `end`, today `now`, as org-habit-build-graph: each day's glyph and face. */
export function buildGraph(habit: Habit, start: number, now: number, end: number): { text: string; faces: string[] } {
  const all = [...habit.done].sort((a, b) => a - b);
  let doneDates = all;
  let lastDone: number | undefined;
  while (doneDates.length > 0 && doneDates[0] < start) {
    lastDone = doneDates[0];
    doneDates = doneDates.slice(1);
  }
  const chars: string[] = [];
  const faces: string[] = [];
  for (let day = start; day < end; day++) {
    const past = day < now;
    const today = day === now;
    const done = doneDates.length > 0 && day === doneDates[0];
    let pair: Faces;
    if (past && lastDone === undefined && !(habit.scheduled < now)) {
      pair = all.length > 0 && all[0] === day ? ["org-habit-ready-face", "org-habit-ready-future-face"] : ["org-habit-clear-face", "org-habit-clear-future-face"];
    } else {
      let scheduledDays: number | undefined;
      if (past && lastDone !== undefined) {
        if (doneDates.length === 0) scheduledDays = habit.scheduled;
        else if (habit.type === ".+") scheduledDays = lastDone + habit.repeat;
        else if (habit.type === "+") scheduledDays = habit.scheduled - doneDates.length * habit.repeat;
        else {
          const first = all[0];
          const shift = (((habit.scheduled - first) % habit.repeat) + habit.repeat) % habit.repeat;
          let s = (shift === 0 ? habit.repeat : shift) + first;
          if (first !== lastDone) {
            for (const d of all.slice(1)) {
              s += (1 + Math.floor(Math.max(d - s, 0) / habit.repeat)) * habit.repeat;
              if (d === lastDone) break;
            }
          }
          scheduledDays = s;
        }
      }
      pair = facesFor(habit, day, scheduledDays, done);
    }
    let marked = false;
    let glyph = " ";
    if (done) {
      glyph = String(ember.variable("org-habit-completed-glyph") ?? "*");
      marked = true;
      while (doneDates.length > 0 && doneDates[0] === day) {
        lastDone = doneDates[0];
        doneDates = doneDates.slice(1);
      }
    } else if (today) glyph = String(ember.variable("org-habit-today-glyph") ?? "!");
    let face = past || today ? pair[0] : pair[1];
    if (past && face !== "org-habit-overdue-face" && !marked) face = pair[1];
    chars.push(glyph);
    faces.push(face);
  }
  return { text: chars.join(""), faces };
}

