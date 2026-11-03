// Links, after ol.el: the link point is on, and where an internal link's
// target is in the buffer, for org-open-at-point to follow.

import { ANGLE_LINK, at, COOKIE, entryEnd, type Heading, headingIndex, headings, LINK, PLAIN_LINK } from "org";
import { flag, folded } from "org-fold";
import { lineAt } from "org-macs";
import { allMatches, regexpQuote } from "subr";

export interface Link {
  start: number;
  end: number;
  path: string;
  description?: string;
}

/** The link point is on: a bracket link, an angle link or a plain one. */
export function linkHere(): Link | undefined {
  const line = lineAt();
  const text = ember.lineText(line);
  const p = ember.point();
  for (const m of allMatches(LINK, text)) {
    const start = at(line, text, m.index ?? 0);
    const end = at(line, text, (m.index ?? 0) + m[0].length);
    if (start <= p && p < end) return { start, end, path: m[1].replace(/\\([[\]\\])/g, "$1"), description: m[2] };
  }
  for (const re of [ANGLE_LINK, PLAIN_LINK]) {
    for (const m of allMatches(re, text)) {
      const start = at(line, text, m.index ?? 0);
      const end = at(line, text, (m.index ?? 0) + m[0].length);
      if (start <= p && p < end) return { start, end, path: m[0].replace(/^<|>$/g, "") };
    }
  }
  return undefined;
}

/** The title Org matches a heading link against: without its state, priority, cookies or tags. */
function bareTitle(h: Heading): string {
  return h.title.replace(new RegExp(COOKIE.source, "g"), "").replace(/\s+/g, " ").trim();
}

function searchHeading(title: string): Heading | undefined {
  const want = title.replace(/\s+/g, " ").trim();
  return headings().find((h) => bareTitle(h) === want);
}

/** Follows a link within the buffer: *Heading, #custom-id, a <<target>> or a heading's title. */
export function searchInBuffer(path: string): number {
  if (path.startsWith("*")) {
    const h = searchHeading(path.slice(1));
    if (!h) throw new Error(`No match for fuzzy expression: ${path}`);
    return h.start;
  }
  if (path.startsWith("#")) {
    const id = path.slice(1);
    const found = ember.search(`^[ \\t]*:CUSTOM_ID:[ \\t]+${regexpQuote(id)}[ \\t]*$`, { from: 0, regexp: true });
    if (!found) throw new Error(`No match for custom ID: ${id}`);
    const all = headings();
    const i = headingIndex(all, lineAt(found.start));
    return i === undefined ? found.start : all[i].start;
  }
  if (/^\d+$/.test(path)) return ember.lineStart(Math.min(Number(path) - 1, ember.lineCount() - 1));
  const target = ember.search(`<<${path}>>`, { from: 0 });
  if (target) return target.start;
  const h = searchHeading(path);
  if (h) return h.start;
  throw new Error(`No match for fuzzy expression: ${path}`);
}

export function jump(pos: number): void {
  ember.pushMark(ember.point());
  ember.gotoChar(pos);
  showContext(pos);
}

/** Shows the headings above a position if it is folded away, as org-fold-show-context does. */
function showContext(pos: number): void {
  const all = headings();
  const i = headingIndex(all, lineAt(pos));
  if (i !== undefined && folded(Math.max(0, all[i].start - 1), "outline")) {
    for (const h of all.slice(0, i + 1)) {
      if (h.start <= pos) flag(h.end, entryEnd(all, all.indexOf(h)), false);
    }
  }
}
