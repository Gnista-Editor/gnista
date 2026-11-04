// Consult for Org-roam, after consult-org-roam.el
// (https://github.com/jgru/consult-org-roam): with consult-org-roam-mode
// on, nodes are read with consult's preview, and consult-buffer lists the
// notes open under their titles in an "Org-roam" group of their own. Its
// commands choose among a note's backlinks or its forward links, find a
// file node, or search the notes with ripgrep.
//
// Copyright (C) 2022-2025 jgru
// Ported to Gnista in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { consultGrepDir, consultRead, consultRipgrep, consultSources, jumpState, sourceBuffer, type Source } from "consult";
import { backlinksOf, capture, forwardLinksOf, nodeAtPoint, nodeCandidates, orgRoamFileP, visitNode, type Node } from "org-roam";
import { truthy } from "subr";

gnista.defineVariable({ name: "consult-org-roam-grep-func", doc: 'The search consult-org-roam-search runs: "consult-grep" or "consult-ripgrep".', value: "consult-grep" });
gnista.defineVariable({ name: "consult-org-roam-buffer-narrow-key", doc: "The key that narrows consult-buffer to the notes open.", value: "n" });
gnista.defineVariable({ name: "consult-org-roam-buffer-enabled", doc: "Whether consult-buffer lists the notes open in a group of their own.", value: true });
gnista.defineVariable({ name: "consult-org-roam-buffer-after-buffers", doc: "Whether the notes come right after the buffers in consult-buffer, rather than last.", value: false });

/** Reads a node with consult, previewing it, as consult-org-roam-node-read. */
function consultNodeRead(initial: string | null, filter: ((n: Node) => boolean) | null, prompt?: string): Node | string {
  const byCandidate = nodeCandidates(filter ?? undefined);
  const result = consultRead({
    command: "consult-org-roam-node-read",
    prompt: prompt ?? "Node: ",
    candidates: [...byCandidate.keys()],
    initial: initial ?? undefined,
    sort: false,
    category: "org-roam-node",
    history: "org-roam-node-history",
    lookup: (c) => {
      const n = byCandidate.get(c);
      if (!n) return undefined;
      const buffer = gnista.bufferList().find((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName()) === n.file) ?? gnista.withCurrentBuffer(gnista.currentBuffer(), () => gnista.findFileNoselect(n.file));
      return { buffer, pos: gnista.withCurrentBuffer(buffer, () => gnista.lineStart(Math.min(n.line, gnista.lineCount() - 1))), node: n };
    },
    state: (() => {
      const jump = jumpState();
      return (action, cand) => (action === "return" ? jump("exit", undefined) : jump(action, cand));
    })(),
  });
  if (!result) return "";
  return byCandidate.get(result.cand) ?? result.cand.trim();
}

/** Visits NODE, or captures a new note of the title typed, as consult-org-roam--open-or-capture. */
function openOrCapture(chosen: Node | string, otherWindow: boolean): void {
  if (typeof chosen === "string") {
    if (chosen !== "") capture(chosen);
  } else visitNode(chosen, otherWindow);
}

gnista.defineCommand({
  name: "consult-org-roam-backlinks",
  doc: "Choose among the notes that link to the current one, previewing each. With a prefix argument, in another window.",
  params: [{ name: "other", kind: "prefix" }],
  run: (other: gnista.Value) => {
    const node = nodeAtPoint();
    if (!node) gnista.userError("Buffer does not contain org-roam-nodes");
    const ids = new Set(backlinksOf(node.id).map((l) => l.source));
    if (ids.size === 0) gnista.userError("No backlinks found");
    openOrCapture(consultNodeRead("", (n) => ids.has(n.id)), truthy(other));
  },
});

gnista.defineCommand({
  name: "consult-org-roam-forward-links",
  doc: "Choose among the notes the current buffer links to, previewing each. With a prefix argument, in another window.",
  params: [{ name: "other", kind: "prefix" }],
  run: (other: gnista.Value) => {
    const text = gnista.bufferSubstringNoProperties(gnista.pointMin(), gnista.pointMax());
    const ids = new Set([...text.matchAll(/\[\[id:([^\]\s]+)\]/g)].map((m) => m[1]));
    const node = nodeAtPoint();
    if (node) for (const l of forwardLinksOf(node.id)) ids.add(l.dest);
    if (ids.size === 0) gnista.userError("No forward links found");
    openOrCapture(consultNodeRead("", (n) => ids.has(n.id)), truthy(other));
  },
});

gnista.defineCommand({
  name: "consult-org-roam-file-find",
  doc: "Find a file node, previewing each. With a prefix argument, in another window.",
  params: [{ name: "other", kind: "prefix" }],
  run: (other: gnista.Value) => openOrCapture(consultNodeRead("", (n) => n.level === 0), truthy(other)),
});

gnista.defineCommand({
  name: "consult-org-roam-search",
  doc: "Search the notes, the .org files of org-roam-directory, as you type, with consult-org-roam-grep-func.",
  run: () => {
    const grep = String(gnista.variable("consult-org-roam-grep-func") ?? "consult-grep");
    const dir = String(gnista.variable("org-roam-directory"));
    const [argsVar, extra] = grep === "consult-ripgrep" ? ["consult-ripgrep-args", " --glob *.org"] : ["consult-grep-args", " --include *.org"];
    const old = String(gnista.variable(argsVar));
    const root = gnista.fileNameAsDirectory(gnista.expandFileName(dir));
    gnista.letBind({ [argsVar]: old + extra }, () => (grep === "consult-ripgrep" ? consultRipgrep(root) : consultGrepDir(root)));
  },
});

// Notes open as a source of consult-buffer, as consult-org-roam-buffer.el.

/** The title a note's buffer shows under: its #+title, as org-roam's files table has it, else its name. */
function bufferTitle(b: string): string {
  return gnista.withCurrentBuffer(b, () => {
    for (let l = 0; l < Math.min(gnista.lineCount(), 50); l++) {
      const m = /^#\+title:[ \t]*(.*?)[ \t]*$/i.exec(gnista.lineText(l));
      if (m) return m[1];
      if (/^\*+\s/.test(gnista.lineText(l))) break;
    }
    return b;
  });
}

const roamBuffers = (): string[] => gnista.bufferList().filter((b) => orgRoamFileP(gnista.withCurrentBuffer(b, () => gnista.bufferFileName())));

const titles = new Map<string, string>();
const roamSource: Source = {
  name: "Org-roam",
  narrow: "n",
  category: "org-roam-buffer",
  items: () => {
    titles.clear();
    for (const b of roamBuffers()) {
      let t = bufferTitle(b);
      while (titles.has(t)) t += "​";
      titles.set(t, b);
    }
    return [...titles.keys()];
  },
  action: (t) => gnista.call("switch-to-buffer", titles.get(t) ?? t),
  preview: (t) => {
    const b = titles.get(t);
    if (b) gnista.setWindowBuffer(gnista.selectedWindow(), b);
  },
};

const plainItems = sourceBuffer.items;

/** Puts the notes' source in consult-buffer, as consult-org-roam-buffer-setup, and leaves them out of the buffers. */
function bufferSetup(on: boolean): void {
  const sources = gnista.variable("consult-buffer-sources");
  const list = (Array.isArray(sources) ? sources.map(String) : []).filter((s) => s !== "org-roam-buffer-source");
  if (on) {
    roamSource.narrow = String(gnista.variable("consult-org-roam-buffer-narrow-key") ?? "n");
    consultSources.set("org-roam-buffer-source", roamSource);
    sourceBuffer.items = () => {
      const roam = new Set(roamBuffers());
      return plainItems().filter((b) => !roam.has(b));
    };
    const at = list.indexOf("consult--source-buffer");
    if (truthy(gnista.variable("consult-org-roam-buffer-after-buffers")) && at >= 0) list.splice(at + 1, 0, "org-roam-buffer-source");
    else list.push("org-roam-buffer-source");
  } else {
    sourceBuffer.items = plainItems;
  }
  gnista.setDefault("consult-buffer-sources", list);
}

gnista.defineMinorMode({
  name: "consult-org-roam-mode",
  global: true,
  lighter: " cor",
  doc: "Read Org-roam's nodes with consult's preview, and list the notes open in consult-buffer.",
  onChange: (enabled) => {
    if (enabled) {
      if (truthy(gnista.variable("consult-org-roam-buffer-enabled"))) bufferSetup(true);
      gnista.adviceAdd("org-roam-node-read", "override", consultNodeRead, { name: "consult-org-roam" });
    } else {
      bufferSetup(false);
      gnista.adviceRemove("org-roam-node-read", "consult-org-roam");
    }
  },
});
