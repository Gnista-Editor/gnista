// Indenting Org text by its outline, without changing it, after Org's
// org-indent.el: org-indent-mode gives each line a line-prefix that indents
// it under its heading, and headings one that lines their titles up, and
// hides all but the last star of each heading. org-startup-indented, or
// #+STARTUP: indent, turns it on when a file opens.
//
// Copyright (C) 2009-2025 Free Software Foundation, Inc.
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { itemParts } from "org-list";
import { PerBuffer } from "subr";

const defvar = (name: string, value: gnista.Value, doc: string) => gnista.defineVariable({ name, value, doc });
defvar("org-indent-indentation-per-level", 2, "How many columns each level of headings indents the text under it.");
defvar("org-indent-boundary-char", " ", "The character that ends the indentation of text, a space by default; | shows where it ends.");
defvar("org-indent-mode-turns-on-hiding-stars", true, "Whether org-indent-mode turns org-hide-leading-stars on.");
defvar("org-indent-mode-turns-off-org-adapt-indentation", true, "Whether org-indent-mode turns org-adapt-indentation off.");
gnista.defineHook("org-indent-post-buffer-init-functions", "Functions called with the buffer once org-indent-mode has indented all of it.");
gnista.defineFace({ name: "org-indent", doc: "The indentation org-indent-mode shows.", attributes: { inherit: "org-hide" } });

const DEEPEST = 50;

/** The line prefixes of text and headings at each level, as org-indent--compute-prefixes. */
function computePrefixes(): { text: gnista.PropertizedString[]; heading: gnista.PropertizedString[] } {
  const per = Number(gnista.variable("org-indent-indentation-per-level") ?? 2);
  const boundary = String(gnista.variable("org-indent-boundary-char") ?? " ").slice(0, 1) || " ";
  const text: gnista.PropertizedString[] = [];
  const heading: gnista.PropertizedString[] = [];
  for (let n = 0; n < DEEPEST; n++) {
    const indentation = per <= 0 ? 0 : n <= 1 ? 0 : (per - 1) * (n - 1);
    heading.push(gnista.propertize("*".repeat(indentation), { face: "org-indent" }));
    text.push(gnista.propertize(" ".repeat(per <= 0 ? 0 : n + indentation) + (per > 0 && n > 0 ? boundary : ""), { face: "org-indent" }));
  }
  return { text, heading };
}

let prefixes = computePrefixes();

/** The column where an item's text starts, as org-list-item-body-column: one after its bullet. */
function itemBodyColumn(text: string): number {
  const m = /^[ \t]*\S+/.exec(text);
  return m ? gnista.stringWidth(m[0].replace(/\t/g, " ".repeat(Number(gnista.variable("tab-width") ?? 8)))) + 1 : 0;
}

/** The wrap prefixes made so far, by kind, level and indentation, so each is made once. */
let wraps = new Map<string, gnista.PropertizedString>();

/** Gives a line its prefixes, as org-indent-set-line-properties. */
function setLineProperties(line: number, level: number, indentation: number, heading: boolean): void {
  const lvl = Math.min(level, DEEPEST - 1);
  const prefix = (heading ? prefixes.heading : prefixes.text)[lvl];
  const key = `${heading ? "h" : "t"}${lvl}:${indentation}`;
  let wrap = wraps.get(key);
  if (wrap === undefined) {
    wrap = gnista.propertize(String(prefix) + (heading ? `${"*".repeat(level)} ` : " ".repeat(indentation)), { face: "org-indent" });
    wraps.set(key, wrap);
  }
  const start = gnista.lineStart(line);
  const end = line + 1 < gnista.lineCount() ? gnista.lineStart(line + 1) : gnista.bufferSize();
  // Down to the next line, so that empty lines are indented too.
  if (end > start) {
    gnista.putTextProperty(start, end, "line-prefix", prefix);
    gnista.putTextProperty(start, end, "wrap-prefix", wrap);
  }
}

/** A line's indentation, as current-indentation measures it. */
function indentationOf(text: string): number {
  const tab = Number(gnista.variable("tab-width") ?? 8);
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
    const m = HEADING.exec(gnista.lineText(l));
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
  return gnista.saveRestriction(() => {
    gnista.widen();
    return gnista.withSilentModifications(() => {
      const first = gnista.lineOf(beg);
      const last = gnista.lineOf(Math.min(end, gnista.bufferSize()));
      let level = levelAt(first);
      for (let l = first; l <= last && gnista.lineStart(l) < gnista.bufferSize(); l++) {
        if (deadline !== undefined && (l - first) % 64 === 63 && Date.now() > deadline) return gnista.lineStart(l);
        const text = gnista.lineText(l);
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
const initial = new PerBuffer<gnista.Marker>();

/**
 * Indents the rest of a buffer for at most 50 milliseconds, then lets
 * typing in, carrying on by a timer until it is done, as org-indent's agent
 * does in idle time.
 */
function initializeBuffer(buffer: gnista.Buffer): void {
  if (!gnista.bufferLiveP(buffer)) return;
  gnista.withCurrentBuffer(buffer, () => {
    const marker = initial.get(buffer);
    if (gnista.variable("org-indent-mode") !== true || marker === undefined) return;
    const from = gnista.markerPosition(marker) ?? 0;
    const stopped = addProperties(from, gnista.bufferSize(), Date.now() + 50);
    if (stopped === undefined) {
      gnista.deleteMarker(marker);
      initial.delete(buffer);
      gnista.runHooks("org-indent-post-buffer-init-functions", buffer);
    } else {
      gnista.setMarker(marker, stopped);
      gnista.runWithTimer(0.05, null, () => initializeBuffer(buffer));
    }
  });
}

/** Takes the prefixes off, as org-indent-remove-properties. */
function removeProperties(beg: number, end: number): void {
  gnista.withSilentModifications(() => {
    gnista.removeTextProperty(beg, end, "line-prefix");
    gnista.removeTextProperty(beg, end, "wrap-prefix");
  });
}

/** Whether a change starts on or deletes a heading, as org-indent-notify-modified-headline records. */
let modifiedHeadline = false;

function notifyModifiedHeadline(beg: number, end: number): void {
  if (gnista.variable("org-indent-mode") !== true) return;
  const first = gnista.lineOf(beg);
  const last = gnista.lineOf(end);
  const m = HEADING.exec(gnista.lineText(first));
  modifiedHeadline = (m !== null && beg < gnista.lineStart(first) + m[0].length) ||
    Array.from({ length: last - first }, (_, i) => first + 1 + i).some((l) => HEADING.test(gnista.lineText(l)));
}

/** Gives the lines a change touched their prefixes again, up to the next heading if it touched one, as org-indent-refresh-maybe. */
function refreshMaybe(beg: number, end: number): void {
  if (gnista.variable("org-indent-mode") !== true) return;
  gnista.saveRestriction(() => {
    gnista.widen();
    const first = gnista.lineOf(beg);
    const last = gnista.lineOf(Math.min(end, gnista.bufferSize()));
    let touched = modifiedHeadline;
    for (let l = first; !touched && l <= last; l++) touched = HEADING.test(gnista.lineText(l));
    if (touched) {
      let next = last + 1;
      while (next < gnista.lineCount() && !HEADING.test(gnista.lineText(next))) next++;
      modifiedHeadline = false;
      addProperties(beg, next < gnista.lineCount() ? gnista.lineStart(next) : gnista.bufferSize());
    } else {
      addProperties(beg, end);
    }
  });
}

export const orgIndentMode = gnista.defineMinorMode({
  name: "org-indent-mode",
  lighter: " Ind",
  doc:
    "Indent Org text under its headings, as it shows, without changing it: each line gets a line-prefix, " +
    "and long lines continue at the text's indentation. Turns org-hide-leading-stars on, so each heading shows its last star.",
  onChange: (enabled) => {
    if (enabled) {
      gnista.makeLocalVariable("indent-tabs-mode");
      gnista.setVariable("indent-tabs-mode", false);
      if (gnista.variable("org-indent-mode-turns-off-org-adapt-indentation") === true && gnista.variable("org-adapt-indentation") !== "headline-data") {
        gnista.makeLocalVariable("org-adapt-indentation");
        gnista.setVariable("org-adapt-indentation", null);
      }
      if (gnista.variable("org-indent-mode-turns-on-hiding-stars") === true) {
        gnista.makeLocalVariable("org-hide-leading-stars");
        gnista.setVariable("org-hide-leading-stars", true);
      }
      prefixes = computePrefixes();
      wraps = new Map();
      gnista.addHook("after-change-functions", refreshMaybe, { local: true });
      gnista.addHook("before-change-functions", notifyModifiedHeadline, { local: true });
      gnista.saveRestriction(() => {
        gnista.widen();
        removeProperties(gnista.pointMin(), gnista.pointMax());
      });
      const old = initial.get(gnista.currentBuffer());
      if (old !== undefined) gnista.deleteMarker(old);
      initial.set(gnista.currentBuffer(), gnista.makeMarker(0));
      initializeBuffer(gnista.currentBuffer());
    } else {
      const marker = initial.get(gnista.currentBuffer());
      if (marker !== undefined) gnista.deleteMarker(marker);
      initial.delete(gnista.currentBuffer());
      gnista.killLocalVariable("org-adapt-indentation");
      gnista.killLocalVariable("org-hide-leading-stars");
      gnista.removeHook("after-change-functions", refreshMaybe, { local: true });
      gnista.removeHook("before-change-functions", notifyModifiedHeadline, { local: true });
      gnista.saveRestriction(() => {
        gnista.widen();
        removeProperties(gnista.pointMin(), gnista.pointMax());
      });
    }
    gnista.call("font-lock-flush");
  },
});

gnista.defineCommand({
  name: "org-indent-indent-buffer",
  doc: "Give the whole buffer org-indent-mode's indentation again.",
  run: () => {
    if (!gnista.derivedModeP("org-mode")) gnista.signal("error", "Not in Org mode");
    gnista.message("Setting buffer indentation.  It may take a few seconds...");
    removeProperties(gnista.pointMin(), gnista.pointMax());
    addProperties(gnista.pointMin(), gnista.pointMax());
    gnista.message("Indentation of buffer set.");
  },
});

// Text copied out of an indented buffer leaves the prefixes behind, as
// org-indent-remove-properties-from-string sees to in Org.
const excluded = gnista.variable("yank-excluded-properties");
if (Array.isArray(excluded)) gnista.setVariable("yank-excluded-properties", [...excluded, "line-prefix", "wrap-prefix"]);
