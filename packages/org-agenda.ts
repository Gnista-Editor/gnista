// The agenda, after Emacs's org-agenda.el: the week's scheduled items,
// deadlines and timestamps from org-agenda-files, and the list of TODO
// items, in the *Org Agenda* buffer, whose keys act on the entries they show.

import { type DateTime, type Heading, PLANNING, allKeywords, at, entryEnd, headings, isDone, today } from "org";
import { allMatches } from "org-macs";
import { charCount } from "subr";

ember.defineVariable({
  name: "org-agenda-files",
  doc: "The files the agenda collects entries from, as a list of file names.",
  value: [],
});
ember.defineVariable({
  name: "org-deadline-warning-days",
  doc: "How many days ahead today's agenda warns of a deadline.",
  value: 14,
});

const AGENDA = "*Org Agenda*";
const AGENDA_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const AGENDA_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A day as a count of days, for comparing and stepping through dates. */
function dayNumber(d: DateTime): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86400000);
}

function dayFromNumber(n: number): DateTime {
  const t = new Date(n * 86400000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** The ISO week number of a day, as the agenda shows it. */
function isoWeekOf(n: number): number {
  const wd = (new Date(n * 86400000).getUTCDay() + 6) % 7;
  const thursday = n - wd + 3;
  const year = new Date(thursday * 86400000).getUTCFullYear();
  return Math.floor((thursday - Math.floor(Date.UTC(year, 0, 1) / 86400000)) / 7) + 1;
}

/** An active timestamp's day and repeater, from text such as <2026-10-28 Wed +1w>. */
function activeTimestamp(text: string): { day: number; repeat?: [number, string] } | undefined {
  const m = /^<(\d{4})-(\d{2})-(\d{2})[^>\n]*>/.exec(text);
  if (!m) return undefined;
  const day = dayNumber({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  const r = /(?:\.\+|\+\+|\+)(\d+)([dwmy])/.exec(m[0]);
  return { day, repeat: r ? [Number(r[1]), r[2]] : undefined };
}

/** Whether a timestamp falls on a day, counting its repeats on or after its date. */
function occursOn(ts: { day: number; repeat?: [number, string] }, day: number): boolean {
  if (day === ts.day) return true;
  if (!ts.repeat || day < ts.day) return false;
  const [n, unit] = ts.repeat;
  if (unit === "d" || unit === "w") return (day - ts.day) % (unit === "w" ? 7 * n : n) === 0;
  const a = dayFromNumber(ts.day);
  const b = dayFromNumber(day);
  if (a.day !== b.day) return false;
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  return unit === "m" ? months % n === 0 : a.month === b.month && (b.year - a.year) % n === 0;
}

/** A heading's priority as org-get-priority gives it: 1000 for the default B, more for A. */
function priorityValue(h: Heading): number {
  const p = h.priority ?? "B";
  return 1000 * ("C".charCodeAt(0) - p.charCodeAt(0));
}

/**
 * One line of the agenda: its text, how urgent it is, and the entry it
 * shows: where in it the line points, as Org's org-marker (a scheduled
 * item's timestamp, say), and its heading, as org-hd-marker. The line's
 * category and leader are kept to write it again when the entry changes.
 */
interface AgendaItem {
  text: string;
  urgency: number;
  buffer: string;
  /** Where the line points and the heading, when the agenda was made. */
  pos: number;
  heading: number;
  cat: string;
  leader: string;
  removeTimestamp: boolean;
  /** Markers at `pos` and `heading`, once the agenda shows the line, so they follow edits there. */
  marks?: { pos: ember.Marker; heading: ember.Marker };
}

/** Where the line's entry is now: its marker's place, as Org's org-marker follows edits. */
function posOf(item: AgendaItem): number {
  return (item.marks && ember.markerPosition(item.marks.pos)) ?? item.pos;
}

/** Where the entry's heading is now, as org-hd-marker. */
function headingOf(item: AgendaItem): number {
  return (item.marks && ember.markerPosition(item.marks.heading)) ?? item.heading;
}

/** The buffer's category, as org-get-category gives it: #+CATEGORY, or the file's name. */
function category(): string {
  for (let l = 0; l < ember.lineCount(); l++) {
    const m = /^#\+CATEGORY:[ \t]*(\S.*?)[ \t]*$/i.exec(ember.lineText(l));
    if (m) return m[1];
  }
  const file = ember.bufferFileName();
  return file ? (file.split("/").pop() ?? file).replace(/\.[^.]*$/, "") : "???";
}

/**
 * An agenda line for a heading, as org-agenda-format-item makes one: the
 * category, padded with its colon to 12 columns, a leader such as
 * "Scheduled: ", the heading's text without its tags, and the tags against
 * the window's right edge.
 */
function agendaLine(h: Heading, cat: string, leader: string, removeTimestamp: boolean): string {
  let text = ember.lineText(h.line).replace(/^\*+[ \t]+/, "");
  if (h.tagsAt !== undefined) text = text.slice(0, text.length - (ember.lineEnd(h.line) - h.tagsAt) - 0).replace(/[ \t]+$/, "");
  if (removeTimestamp) text = text.replace(/<\d{4}-\d{2}-\d{2}[^>\n]*>/, "");
  const line = `  ${`${cat}:`.padEnd(12)}${leader === "" ? "" : `${leader} `}${text}`;
  if (h.tags.length === 0) return line;
  const tags = `:${h.tags.join(":")}:`;
  const width = (ember.windowSize()?.width ?? 80) - 1;
  return line + " ".repeat(Math.max(1, width - charCount(line) - charCount(tags))) + tags;
}

/** The buffers of org-agenda-files, visited if need be. */
function agendaBuffers(): string[] {
  const files = ember.variable("org-agenda-files");
  if (!Array.isArray(files) || files.length === 0) return [];
  return (files as string[]).map((file) => ember.findFileNoselect(String(file)));
}

/** A heading's planning timestamps: when it is scheduled and due, and where those timestamps are. */
function planningOf(h: Heading): {
  scheduled?: number;
  deadline?: number;
  scheduledRepeat?: [number, string];
  scheduledAt?: number;
  deadlineAt?: number;
} {
  const line = h.line + 1;
  if (line >= ember.lineCount() || !PLANNING.test(ember.lineText(line))) return {};
  const text = ember.lineText(line);
  const out: ReturnType<typeof planningOf> = {};
  const s = /SCHEDULED:[ \t]*(<[^>\n]*>)/.exec(text);
  const d = /DEADLINE:[ \t]*(<[^>\n]*>)/.exec(text);
  const st = s && activeTimestamp(s[1]);
  if (s && st) {
    [out.scheduled, out.scheduledRepeat] = [st.day, st.repeat];
    out.scheduledAt = at(line, text, (s.index ?? 0) + s[0].length - s[1].length);
  }
  const dt = d && activeTimestamp(d[1]);
  if (d && dt) {
    out.deadline = dt.day;
    out.deadlineAt = at(line, text, (d.index ?? 0) + d[0].length - d[1].length);
  }
  return out;
}

/** A heading as the agenda reads it, once for every day it shows: its planning, its priority and its entry's active timestamps. */
interface Scanned {
  h: Heading;
  done: boolean;
  plan: ReturnType<typeof planningOf>;
  priority: number;
  /** The entry's active timestamps but its planning line's, in order: where each is, and whether it is in the heading. */
  stamps: { ts: { day: number; repeat?: [number, string] }; pos: number; inHeading: boolean }[];
}

/** The current buffer's headings as the agenda reads them, and its category. */
function scanBuffer(): { cat: string; entries: Scanned[] } {
  const all = headings();
  const stamp = /<\d{4}-\d{2}-\d{2}[^>\n]*>/g;
  const entries = all.map((h, i): Scanned => {
    const stamps: Scanned["stamps"] = [];
    const end = entryEnd(all, i);
    for (let l = h.line; l < ember.lineCount() && ember.lineStart(l) < end; l++) {
      if (l === h.line + 1 && PLANNING.test(ember.lineText(l))) continue;
      const text = ember.lineText(l);
      if (!text.includes("<")) continue;
      for (const m of allMatches(stamp, text)) {
        const ts = activeTimestamp(m[0]);
        if (ts) stamps.push({ ts, pos: at(l, text, m.index), inHeading: l === h.line });
      }
    }
    return { h, done: isDone(h.todo), plan: planningOf(h), priority: priorityValue(h), stamps };
  });
  return { cat: category(), entries };
}

/** The items for a day from the current buffer, scanned once, as org-agenda-get-day-entries collects them. */
function dayItems(scan: { cat: string; entries: Scanned[] }, day: number, today: number, buffer: string): AgendaItem[] {
  const cat = scan.cat;
  const warning = Number(ember.variable("org-deadline-warning-days") ?? 14);
  const deadlines: AgendaItem[] = [];
  const scheduled: AgendaItem[] = [];
  const stamps: AgendaItem[] = [];
  for (const { h, done, plan, priority, stamps: found } of scan.entries) {
    if (plan.deadline !== undefined) {
      const diff = plan.deadline - day;
      let leader: string | undefined;
      if (diff === 0) leader = "Deadline:  ";
      else if (day === today && !done && diff > 0 && diff <= warning) leader = `In ${String(diff).padStart(3)} d.: `;
      else if (day === today && !done && diff < 0) leader = `${String(-diff).padStart(2)} d. ago: `;
      if (leader !== undefined) {
        const item = { cat, leader, removeTimestamp: false, buffer, pos: plan.deadlineAt ?? h.start, heading: h.start };
        deadlines.push({ ...item, text: agendaLine(h, cat, leader, false), urgency: priority - (day === today ? diff : 0) });
      }
    }
    if (plan.scheduled !== undefined) {
      // A repeater's later dates show only after today; up to today, the
      // item counts from its base date, as org-agenda-get-scheduled has it.
      const ts = { day: plan.scheduled, repeat: plan.scheduledRepeat };
      const diff = day - plan.scheduled;
      const onDay = day === plan.scheduled || (day > today && occursOn(ts, day));
      const past = day === today && plan.scheduled < today && !done;
      if ((onDay && !(done && plan.scheduled !== day)) || past) {
        const leader = past ? `Sched.${String(diff).padStart(2)}x: ` : "Scheduled: ";
        const item = { cat, leader, removeTimestamp: false, buffer, pos: plan.scheduledAt ?? h.start, heading: h.start };
        scheduled.push({ ...item, text: agendaLine(h, cat, leader, false), urgency: 99 + (past ? diff : 0) + priority });
      }
    }
    // The first active timestamp in the heading and its entry on the day.
    const stamp = found.find((s) => occursOn(s.ts, day));
    if (stamp) {
      const item = { cat, leader: "", removeTimestamp: stamp.inHeading, buffer, pos: stamp.pos, heading: h.start };
      stamps.push({ ...item, text: agendaLine(h, cat, "", stamp.inHeading), urgency: priority });
    }
  }
  return [...deadlines, ...scheduled, ...stamps];
}

/** Sorts a day's items by urgency, most urgent first, keeping their order otherwise. */
function byUrgency(items: AgendaItem[]): AgendaItem[] {
  return items.map((item, k) => ({ item, k })).sort((a, b) => b.item.urgency - a.item.urgency || a.k - b.k).map((x) => x.item);
}

/** What the agenda buffer shows, for its keys to act on and g to rebuild. */
let agendaView: { kind: "week"; start: number } | { kind: "todo" } = { kind: "todo" };
let agendaLines: (AgendaItem | undefined)[] = [];

/** Puts lines into the agenda buffer and shows it, as org-agenda-prepare and org-agenda-finalize do. */
function showAgenda(lines: { text: string; item?: AgendaItem }[], pointLine: number): void {
  ember.getBufferCreate(AGENDA);
  ember.withCurrentBuffer(AGENDA, () => {
    ember.setReadOnly(false);
    ember.deleteRegion(0, ember.bufferSize());
    ember.insert(lines.map((l) => l.text).join("\n") + "\n");
    if (ember.variable("major-mode") !== "org-agenda-mode") ember.call("org-agenda-mode");
    ember.setReadOnly(true);
    ember.gotoChar(ember.lineStart(pointLine));
  });
  // The lines' markers, made in the entries' buffers, as Org makes
  // org-marker and org-hd-marker; the last agenda's are freed.
  for (const old of agendaLines) {
    if (old?.marks) {
      ember.deleteMarker(old.marks.pos);
      ember.deleteMarker(old.marks.heading);
    }
  }
  agendaLines = lines.map((l) => l.item);
  for (const item of agendaLines) {
    if (item && ember.getBuffer(item.buffer)) {
      item.marks = {
        pos: ember.makeMarker(item.pos, { buffer: item.buffer }),
        heading: ember.makeMarker(item.heading, { buffer: item.buffer }),
      };
    }
  }
  if (ember.windowBuffer() !== AGENDA) {
    // As org-agenda-window-setup's reorganize-frame: this window and the agenda's.
    if (!ember.windowList().some((w) => ember.windowBuffer(w) === AGENDA)) ember.call("delete-other-windows");
    ember.call("pop-to-buffer", AGENDA);
  }
  fitAgendaWindow(lines.length);
}

/**
 * Fits the agenda's window to its lines, between half and three quarters
 * of the frame, as org-agenda-window-frame-fractions has it.
 */
function fitAgendaWindow(lines: number): void {
  const windows = ember.windowList();
  if (windows.length < 2) return;
  const frame = windows.reduce((sum, w) => sum + (ember.windowSize(w)?.fullWidth ? (ember.windowSize(w)?.totalHeight ?? 0) : 0), 0) + 1;
  const wanted = Math.min(Math.floor(frame * 0.75), Math.max(Math.floor(frame * 0.5), lines + 1));
  const now = ember.windowSize()?.totalHeight ?? wanted;
  if (wanted !== now) ember.resizeWindow(undefined, wanted - now);
}

/** The week's agenda from a day, as org-agenda-list shows it for org-agenda-span week. */
function weekAgenda(start: number): void {
  const today = dayNumber(today_());
  const buffers = agendaBuffers();
  const lines: { text: string; item?: AgendaItem }[] = [{ text: `Week-agenda (W${String(isoWeekOf(start)).padStart(2, "0")}):` }];
  let pointLine = 0;
  // Each file read once for the week, not once a day.
  const scans = new Map(buffers.map((buffer) => [buffer, ember.withCurrentBuffer(buffer, scanBuffer)]));
  for (let day = start; day < start + 7; day++) {
    const d = dayFromNumber(day);
    const wd = new Date(day * 86400000).getUTCDay();
    if (day === today) pointLine = lines.length;
    const week = wd === 1 ? ` W${String(isoWeekOf(day)).padStart(2, "0")}` : "";
    lines.push({ text: `${AGENDA_DAYS[wd].padEnd(10)} ${String(d.day).padStart(2)} ${AGENDA_MONTHS[d.month - 1]} ${d.year}${week}` });
    const items: AgendaItem[] = [];
    for (const buffer of buffers) items.push(...ember.withCurrentBuffer(buffer, () => dayItems(scans.get(buffer)!, day, today, buffer)));
    for (const item of byUrgency(items)) lines.push({ text: item.text, item });
  }
  agendaView = { kind: "week", start };
  showAgenda(lines, pointLine);
}

/** Today, as the agenda counts it. */
function today_(): DateTime {
  return today();
}

/** The week org-agenda-list starts with: the Monday on or before today. */
function weekStart(day: number): number {
  return day - ((new Date(day * 86400000).getUTCDay() + 6) % 7);
}

/** The TODO items that are not done, as org-todo-list shows them. */
function todoList(): void {
  const buffers = agendaBuffers();
  const items: AgendaItem[] = [];
  const keywords = new Set<string>();
  for (const buffer of buffers) {
    ember.withCurrentBuffer(buffer, () => {
      const cat = category();
      for (const k of allKeywords()) keywords.add(k);
      for (const h of headings()) {
        if (h.todo === undefined || isDone(h.todo)) continue;
        const item = { cat, leader: "", removeTimestamp: false, buffer, pos: h.start, heading: h.start };
        items.push({ ...item, text: agendaLine(h, cat, "", false), urgency: 1 + priorityValue(h) });
      }
    });
  }
  const sorted = [...keywords].sort();
  const lines: { text: string; item?: AgendaItem }[] = [
    { text: "Global list of TODO items of type: ALL" },
    { text: `Press \u2018N r\u2019 (e.g. \u20180 r\u2019) to search again: (0)[ALL] ${sorted.map((k, i) => `(${i + 1})${k}`).join(" ")}` },
  ];
  for (const item of byUrgency(items)) lines.push({ text: item.text, item });
  agendaView = { kind: "todo" };
  showAgenda(lines, 0);
}

function redoAgenda(): void {
  const line = ember.lineOf(ember.point());
  if (agendaView.kind === "week") weekAgenda(agendaView.start);
  else todoList();
  ember.gotoChar(ember.lineStart(Math.min(line, ember.lineCount() - 1)));
}

const agendaList = ember.defineCommand({
  name: "org-agenda-list",
  doc: "Show the week's agenda: what is scheduled, due and timestamped each day, from org-agenda-files.",
  run: () => weekAgenda(weekStart(dayNumber(today_()))),
});

const todoListCommand = ember.defineCommand({
  name: "org-todo-list",
  doc: "Show the TODO items that are not done in org-agenda-files, most urgent first.",
  run: () => todoList(),
});

ember.defineCommand({
  name: "org-agenda",
  doc: "Show an agenda view, asking which by its key: a for the week's agenda, t for the TODO list.",
  params: [{ name: "key", kind: "string", prompt: "Agenda view (a: week, t: TODO list): " }],
  run: (key) => {
    if (key === "a") weekAgenda(weekStart(dayNumber(today_())));
    else if (key === "t") todoList();
    else throw new Error(`No agenda view ${key}`);
  },
});

/** The entry the agenda line at point shows, or Org's error if it shows none. */
function agendaItemHere(): AgendaItem {
  const item = agendaLines[ember.lineOf(ember.point())];
  if (!item) throw new Error("Command not allowed in this line");
  return item;
}

const agendaNext = ember.defineCommand({
  name: "org-agenda-next-line",
  doc: "Move to the next line of the agenda.",
  run: () => ember.callWithPrefix(ember.prefixArg(), "next-line"),
});
const agendaPrevious = ember.defineCommand({
  name: "org-agenda-previous-line",
  doc: "Move to the previous line of the agenda.",
  run: () => ember.callWithPrefix(ember.prefixArg(), "previous-line"),
});

const agendaSwitchTo = ember.defineCommand({
  name: "org-agenda-switch-to",
  doc: "Go to the entry the agenda line at point shows, in this window.",
  run: () => {
    const item = agendaItemHere();
    ember.call("switch-to-buffer", item.buffer);
    ember.gotoChar(posOf(item));
  },
});

const agendaGoto = ember.defineCommand({
  name: "org-agenda-goto",
  doc: "Show the entry the agenda line at point shows in another window, and go there.",
  run: () => {
    const item = agendaItemHere();
    ember.call("pop-to-buffer", item.buffer);
    ember.pushMark(ember.point());
    ember.gotoChar(posOf(item));
    // At the heading's title, as org-agenda-goto leaves it.
    const heading = headingOf(item);
    const h = headings().find((x) => x.start === heading);
    if (h) ember.gotoChar(h.titleAt);
  },
});

const agendaTodo = ember.defineCommand({
  name: "org-agenda-todo",
  doc: "Change the TODO state of the entry the agenda line at point shows, as C-c C-t does there.",
  run: () => {
    const item = agendaItemHere();
    ember.withCurrentBuffer(item.buffer, () => {
      ember.gotoChar(headingOf(item));
      ember.callWithPrefix(ember.prefixArg(), "org-todo");
    });
    // The lines showing the entry are written again where they are, as
    // org-agenda-change-all-lines does, rather than the agenda rebuilt.
    const heading = headingOf(item);
    ember.withCurrentBuffer(AGENDA, () => ember.letBind({ "inhibit-read-only": true }, () => {
      const point = ember.point();
      for (const [l, other] of agendaLines.entries()) {
        if (!other || other.buffer !== item.buffer || headingOf(other) !== heading) continue;
        const text = ember.withCurrentBuffer(item.buffer, () => {
          const h = headings().find((x) => x.start === heading);
          return h ? agendaLine(h, other.cat, other.leader, other.removeTimestamp) : other.text;
        });
        other.text = text;
        ember.deleteRegion(ember.lineStart(l), ember.lineEnd(l));
        ember.gotoChar(ember.lineStart(l));
        ember.insert(text);
      }
      ember.gotoChar(point);
    }));
  },
});

const agendaRedo = ember.defineCommand({
  name: "org-agenda-redo",
  doc: "Rebuild the agenda from the files, as they are now.",
  run: () => redoAgenda(),
});

/** Which day of the week view point's line is under, counting from 0. */
function agendaDayIndex(): number {
  let index = -1;
  for (let l = 1; l <= ember.lineOf(ember.point()); l++) if (agendaLines[l] === undefined) index++;
  return Math.max(0, index);
}

/** Moves the week view by weeks, to the same day of the week, as org-agenda-later does. */
function shiftWeek(weeks: number): void {
  if (agendaView.kind !== "week") throw new Error("Not allowed in this agenda");
  const index = agendaDayIndex();
  weekAgenda(agendaView.start + 7 * weeks);
  let seen = -1;
  for (let l = 1; l < agendaLines.length; l++) {
    if (agendaLines[l] === undefined && ++seen === index) {
      ember.gotoChar(ember.lineStart(l));
      break;
    }
  }
}

const agendaLater = ember.defineCommand({
  name: "org-agenda-later",
  doc: "Show the next week in the agenda.",
  run: () => shiftWeek(ember.prefixNumericValue()),
});
const agendaEarlier = ember.defineCommand({
  name: "org-agenda-earlier",
  doc: "Show the week before in the agenda.",
  run: () => shiftWeek(-ember.prefixNumericValue()),
});
const agendaToday = ember.defineCommand({
  name: "org-agenda-goto-today",
  doc: "Show the week with today in it, and go to today.",
  run: () => {
    if (agendaView.kind !== "week") throw new Error("Not allowed in this agenda");
    weekAgenda(weekStart(dayNumber(today_())));
  },
});

const agendaQuit = ember.defineCommand({
  name: "org-agenda-quit",
  doc: "Leave the agenda: its window goes, or another buffer takes its place.",
  run: () => {
    if (ember.windowList().length > 1) ember.deleteWindow();
    else ember.call("switch-to-buffer", "");
  },
});

ember.defineMajorMode({
  name: "org-agenda-mode",
  modeName: "Org-Agenda",
  doc:
    "The mode of the *Org Agenda* buffer. n and p move between lines, RET goes to an entry and TAB shows it in " +
    "another window, t changes its TODO state, g rebuilds the agenda, f and b move a week, . goes to today, " +
    "and q leaves.",
  bindings: {
    n: agendaNext,
    p: agendaPrevious,
    RET: agendaSwitchTo,
    TAB: agendaGoto,
    t: agendaTodo,
    g: agendaRedo,
    r: agendaRedo,
    f: agendaLater,
    b: agendaEarlier,
    ".": agendaToday,
    q: agendaQuit,
    x: agendaQuit,
  },
});

void agendaList;
void todoListCommand;
