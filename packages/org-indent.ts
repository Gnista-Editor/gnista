// Indenting Org text by its outline, without changing it, after Org's
// org-indent.el: org-indent-mode gives each line a line-prefix that indents
// it under its heading, and headings one that lines their titles up, and
// hides all but the last star of each heading. org-startup-indented, or
// #+STARTUP: indent, turns it on when a file opens.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to Ember in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { itemParts } from "org-list";
import { PerBuffer } from "subr";

const defvar = (name: string, value: ember.Value, doc: string) => ember.defineVariable({ name, value, doc });
defvar("org-indent-indentation-per-level", 2, "How many columns each level of headings indents the text under it.");
defvar("org-indent-boundary-char", " ", "The character that ends the indentation of text, a space by default; | shows where it ends.");
defvar("org-indent-mode-turns-on-hiding-stars", true, "Whether org-indent-mode turns org-hide-leading-stars on.");
defvar("org-indent-mode-turns-off-org-adapt-indentation", true, "Whether org-indent-mode turns org-adapt-indentation off.");
ember.defineHook("org-indent-post-buffer-init-functions", "Functions called with the buffer once org-indent-mode has indented all of it.");
ember.defineFace({ name: "org-indent", doc: "The indentation org-indent-mode shows.", attributes: { inherit: "org-hide" } });

const DEEPEST = 50;

/** The line prefixes of text and headings at each level, as org-indent--compute-prefixes. */
function computePrefixes(): { text: ember.PropertizedString[]; heading: ember.PropertizedString[] } {
  const per = Number(ember.variable("org-indent-indentation-per-level") ?? 2);
  const boundary = String(ember.variable("org-indent-boundary-char") ?? " ").slice(0, 1) || " ";
  const text: ember.PropertizedString[] = [];
  const heading: ember.PropertizedString[] = [];
  for (let n = 0; n < DEEPEST; n++) {
    const indentation = per <= 0 ? 0 : n <= 1 ? 0 : (per - 1) * (n - 1);
    heading.push(ember.propertize("*".repeat(indentation), { face: "org-indent" }));
    text.push(ember.propertize(" ".repeat(per <= 0 ? 0 : n + indentation) + (per > 0 && n > 0 ? boundary : ""), { face: "org-indent" }));
  }
  return { text, heading };
}

let prefixes = computePrefixes();

/** The column where an item's text starts, as org-list-item-body-column: one after its bullet. */
function itemBodyColumn(text: string): number {
  const m = /^[ \t]*\S+/.exec(text);
  return m ? ember.stringWidth(m[0].replace(/\t/g, " ".repeat(Number(ember.variable("tab-width") ?? 8)))) + 1 : 0;
}

/** The wrap prefixes made so far, by kind, level and indentation, so each is made once. */
let wraps = new Map<string, ember.PropertizedString>();

/** Gives a line its prefixes, as org-indent-set-line-properties. */
function setLineProperties(line: number, level: number, indentation: number, heading: boolean): void {
  const lvl = Math.min(level, DEEPEST - 1);
  const prefix = (heading ? prefixes.heading : prefixes.text)[lvl];
  const key = `${heading ? "h" : "t"}${lvl}:${indentation}`;
  let wrap = wraps.get(key);
  if (wrap === undefined) {
    wrap = ember.propertize(String(prefix) + (heading ? `${"*".repeat(level)} ` : " ".repeat(indentation)), { face: "org-indent" });
    wraps.set(key, wrap);
  }
  const start = ember.lineStart(line);
  const end = line + 1 < ember.lineCount() ? ember.lineStart(line + 1) : ember.bufferSize();
  // Down to the next line, so that empty lines are indented too.
  if (end > start) {
    ember.putTextProperty(start, end, "line-prefix", prefix);
    ember.putTextProperty(start, end, "wrap-prefix", wrap);
  }
}

/** A line's indentation, as current-indentation measures it. */
function indentationOf(text: string): number {
  const tab = Number(ember.variable("tab-width") ?? 8);
  let col = 0;
  for (const c of text) {
    if (c === " ") col++;
    else if (c === "\t") col = (Math.floor(col / tab) + 1) * tab;
    else break;
  }
  return col;
}

const HEADING = /^(\*+)[ \t]/;

/** The level of the heading a line is under, 0 before the first, as org-current-level. */
function levelAt(line: number): number {
  for (let l = line; l >= 0; l--) {
    const m = HEADING.exec(ember.lineText(l));
    if (m) return m[1].length;
  }
  return 0;
}

/**
 * Gives the lines from beg to end their prefixes, as
 * org-indent-add-properties. With a deadline, a time in milliseconds, it
 * stops when the deadline passes and returns where it stopped.
 */
export function addProperties(beg: number, end: number, deadline?: number): number | undefined {
  return ember.saveRestriction(() => {
    ember.widen();
    return ember.withSilentModifications(() => {
      const first = ember.lineOf(beg);
      const last = ember.lineOf(Math.min(end, ember.bufferSize()));
      let level = levelAt(first);
      for (let l = first; l <= last && ember.lineStart(l) < ember.bufferSize(); l++) {
        if (deadline !== undefined && (l - first) % 64 === 63 && Date.now() > deadline) return ember.lineStart(l);
        const text = ember.lineText(l);
        const m = HEADING.exec(text);
        if (m) {
          level = m[1].length;
          setLineProperties(l, level, 0, true);
        } else if (itemParts(l) !== undefined) {
          setLineProperties(l, level, itemBodyColumn(text), false);
        } else {
          setLineProperties(l, level, indentationOf(text), false);
        }
      }
      return undefined;
    });
  });
}

/** Where each buffer's first indenting has got to, as org-indent--initial-marker. */
const initial = new PerBuffer<ember.Marker>();

/**
 * Indents the rest of a buffer for at most 50 milliseconds, then lets
 * typing in, carrying on by a timer until it is done, as org-indent's agent
 * does in idle time.
 */
function initializeBuffer(buffer: ember.Buffer): void {
  if (!ember.bufferLiveP(buffer)) return;
  ember.withCurrentBuffer(buffer, () => {
    const marker = initial.get(buffer);
    if (ember.variable("org-indent-mode") !== true || marker === undefined) return;
    const from = ember.markerPosition(marker) ?? 0;
    const stopped = addProperties(from, ember.bufferSize(), Date.now() + 50);
    if (stopped === undefined) {
      ember.deleteMarker(marker);
      initial.delete(buffer);
      ember.runHooks("org-indent-post-buffer-init-functions", buffer);
    } else {
      ember.setMarker(marker, stopped);
      ember.runWithTimer(0.05, null, () => initializeBuffer(buffer));
    }
  });
}

/** Takes the prefixes off, as org-indent-remove-properties. */
function removeProperties(beg: number, end: number): void {
  ember.withSilentModifications(() => {
    ember.removeTextProperty(beg, end, "line-prefix");
    ember.removeTextProperty(beg, end, "wrap-prefix");
  });
}

/** Whether a change starts on or deletes a heading, as org-indent-notify-modified-headline records. */
let modifiedHeadline = false;

function notifyModifiedHeadline(beg: number, end: number): void {
  if (ember.variable("org-indent-mode") !== true) return;
  const first = ember.lineOf(beg);
  const last = ember.lineOf(end);
  const m = HEADING.exec(ember.lineText(first));
  modifiedHeadline = (m !== null && beg < ember.lineStart(first) + m[0].length) ||
    Array.from({ length: last - first }, (_, i) => first + 1 + i).some((l) => HEADING.test(ember.lineText(l)));
}

/** Gives the lines a change touched their prefixes again, up to the next heading if it touched one, as org-indent-refresh-maybe. */
function refreshMaybe(beg: number, end: number): void {
  if (ember.variable("org-indent-mode") !== true) return;
  ember.saveRestriction(() => {
    ember.widen();
    const first = ember.lineOf(beg);
    const last = ember.lineOf(Math.min(end, ember.bufferSize()));
    let touched = modifiedHeadline;
    for (let l = first; !touched && l <= last; l++) touched = HEADING.test(ember.lineText(l));
    if (touched) {
      let next = last + 1;
      while (next < ember.lineCount() && !HEADING.test(ember.lineText(next))) next++;
      modifiedHeadline = false;
      addProperties(beg, next < ember.lineCount() ? ember.lineStart(next) : ember.bufferSize());
    } else {
      addProperties(beg, end);
    }
  });
}

export const orgIndentMode = ember.defineMinorMode({
  name: "org-indent-mode",
  lighter: " Ind",
  doc:
    "Indent Org text under its headings, as it shows, without changing it: each line gets a line-prefix, " +
    "and long lines continue at the text's indentation. Turns org-hide-leading-stars on, so each heading shows its last star.",
  onChange: (enabled) => {
    if (enabled) {
      ember.makeLocalVariable("indent-tabs-mode");
      ember.setVariable("indent-tabs-mode", false);
      if (ember.variable("org-indent-mode-turns-off-org-adapt-indentation") === true && ember.variable("org-adapt-indentation") !== "headline-data") {
        ember.makeLocalVariable("org-adapt-indentation");
        ember.setVariable("org-adapt-indentation", null);
      }
      if (ember.variable("org-indent-mode-turns-on-hiding-stars") === true) {
        ember.makeLocalVariable("org-hide-leading-stars");
        ember.setVariable("org-hide-leading-stars", true);
      }
      prefixes = computePrefixes();
      wraps = new Map();
      ember.addHook("after-change-functions", refreshMaybe, { local: true });
      ember.addHook("before-change-functions", notifyModifiedHeadline, { local: true });
      ember.saveRestriction(() => {
        ember.widen();
        removeProperties(ember.pointMin(), ember.pointMax());
      });
      const old = initial.get(ember.currentBuffer());
      if (old !== undefined) ember.deleteMarker(old);
      initial.set(ember.currentBuffer(), ember.makeMarker(0));
      initializeBuffer(ember.currentBuffer());
    } else {
      const marker = initial.get(ember.currentBuffer());
      if (marker !== undefined) ember.deleteMarker(marker);
      initial.delete(ember.currentBuffer());
      ember.killLocalVariable("org-adapt-indentation");
      ember.killLocalVariable("org-hide-leading-stars");
      ember.removeHook("after-change-functions", refreshMaybe, { local: true });
      ember.removeHook("before-change-functions", notifyModifiedHeadline, { local: true });
      ember.saveRestriction(() => {
        ember.widen();
        removeProperties(ember.pointMin(), ember.pointMax());
      });
    }
    ember.call("font-lock-flush");
  },
});

ember.defineCommand({
  name: "org-indent-indent-buffer",
  doc: "Give the whole buffer org-indent-mode's indentation again.",
  run: () => {
    if (!ember.derivedModeP("org-mode")) ember.signal("error", "Not in Org mode");
    ember.message("Setting buffer indentation.  It may take a few seconds...");
    removeProperties(ember.pointMin(), ember.pointMax());
    addProperties(ember.pointMin(), ember.pointMax());
    ember.message("Indentation of buffer set.");
  },
});

// Text copied out of an indented buffer leaves the prefixes behind, as
// org-indent-remove-properties-from-string sees to in Org.
const excluded = ember.variable("yank-excluded-properties");
if (Array.isArray(excluded)) ember.setVariable("yank-excluded-properties", [...excluded, "line-prefix", "wrap-prefix"]);
