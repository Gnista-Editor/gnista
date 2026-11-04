// Date trees, after Org's org-datetree.el: headings for a year, its months
// or ISO weeks, and their days, kept in order, found or made for a date, as
// capture files entries under them.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { blankBeforeHeading, headings, subtreeRegion } from "org";
import { lineAt } from "org-macs";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Day {
  year: number;
  month: number;
  day: number;
}

const two = (n: number) => String(n).padStart(2, "0");

/** A date's ISO week and the year it belongs to, as calendar-iso-from-absolute gives them. */
export function isoWeek(d: Day): { year: number; week: number } {
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
  const weekday = date.getUTCDay() || 7;
  // The Thursday of the week decides its year.
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return { year, week: Math.ceil(((date.getTime() - start) / 86400000 + 1) / 7) };
}

/**
 * Inserts a date tree heading at point, as org-datetree-insert-line: the
 * blank lines before point go, and the heading goes on a line of its own at
 * `level`. Point ends at its start.
 */
function insertLine(level: number, title: string): void {
  let p = ember.point();
  let q = p;
  while (q > ember.pointMin() && /[ \t\n]/.test(ember.bufferText(q - 1, q))) q--;
  if (q < p) {
    ember.deleteRegion(q, p);
    p = q;
  }
  ember.gotoChar(p);
  if (blankBeforeHeading(false)) ember.insert("\n");
  ember.insert(`\n${"*".repeat(level)} ${title}\n`);
  ember.gotoChar(ember.point() - 1);
  ember.gotoChar(ember.lineStart(lineAt()));
}

/**
 * Finds the heading among those from point-min that `re` matches, its
 * group 1 the number to compare with `n`, or makes one in order, as
 * org-datetree--find-create. Returns where the heading starts.
 */
function findCreate(re: RegExp, n: number, level: number, title: string): number {
  const all = headings().filter((h) => h.start >= ember.pointMin() && h.start < ember.pointMax());
  let found: (typeof all)[number] | undefined;
  for (const h of all) {
    const m = re.exec(h.title);
    if (!m) continue;
    found = h;
    if (Number(m[1]) >= n) break;
    found = undefined;
  }
  if (found === undefined) {
    ember.gotoChar(ember.pointMax());
    if (ember.point() !== ember.lineStart(lineAt())) ember.insert("\n");
    insertLine(level, title);
  } else if (Number(re.exec(found.title)![1]) === n) {
    ember.gotoChar(found.start);
  } else {
    ember.gotoChar(found.start);
    insertLine(level, title);
  }
  return ember.point();
}

/** Narrows to the subtree of the heading at point, as org-narrow-to-subtree. */
function narrowToSubtree(): void {
  const all = headings();
  const i = all.findIndex((h) => h.start === ember.point());
  const [start, end] = subtreeRegion(all, i);
  ember.narrowToRegion(start, end);
}

/**
 * Finds or makes the heading for a date in the date tree between start and
 * end, its year headings at `base`, as org-datetree-find-date-create does
 * by day, org-datetree-find-month-create by month and
 * org-datetree-find-iso-week-create by week. Returns where it starts.
 */
export function findDateCreate(d: Day, grouping: "day" | "month" | "week", base: number, start: number, end: number): number {
  return ember.saveRestriction(() => {
    ember.narrowToRegion(start, end);
    ember.gotoChar(ember.pointMin());
    if (grouping === "week") {
      const { year, week } = isoWeek(d);
      findCreate(/^([12][0-9]{3})$/, year, base, String(year));
      narrowToSubtree();
      findCreate(new RegExp(`^${year}-W([0-5][0-9])$`), week, base + 1, `${year}-W${two(week)}`);
      narrowToSubtree();
    } else {
      findCreate(/^([12][0-9]{3})$/, d.year, base, String(d.year));
      narrowToSubtree();
      const first = new Date(Date.UTC(d.year, d.month - 1, 1));
      findCreate(new RegExp(`^${d.year}-([01][0-9]) \\w+$`), d.month, base + 1, `${d.year}-${two(d.month)} ${MONTHS[first.getUTCMonth()]}`);
      if (grouping === "month") return ember.point();
      narrowToSubtree();
    }
    const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
    return findCreate(new RegExp(`^${d.year}-${two(d.month)}-([0123][0-9]) \\w+$`), d.day, base + 2, `${d.year}-${two(d.month)}-${two(d.day)} ${DAYS[weekday]}`);
  });
}
