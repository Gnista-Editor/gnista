// Refiling, as org-refile.el does with its default targets.

import { copySubtree, type Heading, headings, lineAt, pasteSubtree, subtreeRegion } from "org";
import { entryHeading } from "org-list";
import { edDelete } from "org-macs";

/**
 * Where org-refile can file a subtree: as org-refile-targets of nil gives
 * them, the buffer's top-level headings that have a title, by their titles.
 */
function refileTargets(): { name: string; heading: Heading }[] {
  return ember.saveRestriction(() => {
    ember.widen();
    return headings()
      .filter((h) => h.level === 1 && h.title !== "")
      .map((h) => ({ name: h.title, heading: h }));
  });
}

/**
 * Files the subtree at point under a target heading, as its last child, as
 * org-refile does: copied there with org-paste-subtree, then deleted where
 * it was, unless `keep`.
 */
function refile(target: string, keep: boolean): void {
  const h = entryHeading();
  if (!h) throw new Error(`Before first headline at position ${ember.lineStart(lineAt()) + 1} in buffer ${ember.bufferName()}`);
  const t = refileTargets().find((x) => x.name === target);
  if (!t) throw new Error("Invalid target location");
  const all = headings();
  const i = all.findIndex((x) => x.start === h.start);
  const [start, end] = subtreeRegion(all, i);
  if (t.heading.start >= start && t.heading.start < end) throw new Error("Cannot refile to position inside the tree or region");
  const origin = ember.point();
  copySubtree(false, 1, false);
  const ti = all.findIndex((x) => x.start === t.heading.start);
  // After the target's subtree, at its next sibling or the end.
  const at = subtreeRegion(all, ti)[1];
  const before = ember.bufferSize();
  ember.gotoChar(at);
  if (ember.point() !== ember.lineStart(lineAt())) ember.call("newline");
  pasteSubtree(Math.max(1, t.heading.level + 1) as ember.PrefixArg);
  ember.popKill();
  // Back to the subtree where it was, after what was pasted before it.
  const moved = at <= start ? ember.bufferSize() - before : 0;
  ember.gotoChar(origin + moved);
  if (!keep) {
    edDelete(start + moved, end + moved);
    ember.gotoChar(start + moved);
  }
  const file = ember.bufferFileName() ?? ember.bufferName();
  ember.message(`${keep ? "Copy" : "Refile"} to "${t.name}" in file ${file}: done`);
}

ember.defineCommand({
  name: "org--refile-to",
  doc: "File the subtree at point under the target heading given, as org-refile does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Refile subtree to: " }],
  run: (target) => refile(target, false),
});

ember.defineCommand({
  name: "org--refile-copy-to",
  doc: "Copy the subtree at point under the target heading given, as org-refile-copy does once it has asked.",
  params: [{ name: "target", kind: "string", prompt: "Copy subtree to: " }],
  run: (target) => refile(target, true),
});

ember.defineCommand({
  name: "org--refile-goto",
  doc: "Go to the refile target given, as org-refile with C-u does.",
  params: [{ name: "target", kind: "string", prompt: "Goto: " }],
  run: (target) => {
    const t = refileTargets().find((x) => x.name === target);
    if (!t) throw new Error("Invalid target location");
    ember.gotoChar(t.heading.start);
  },
});

export const refileCommand = ember.defineCommand({
  name: "org-refile",
  doc:
    "Move the subtree at point under another heading, asking which: one of the buffer's top-level headings.\n\n" +
    "It goes in as that heading's last child. With C-u, go to the heading instead.",
  run: () => {
    const goto = Array.isArray(ember.prefixArg());
    if (!goto && !entryHeading()) {
      throw new Error(`Before first headline at position ${ember.lineStart(lineAt()) + 1} in buffer ${ember.bufferName()}`);
    }
    ember.callInteractively(goto ? "org--refile-goto" : "org--refile-to");
  },
});

export const refileCopyCommand = ember.defineCommand({
  name: "org-refile-copy",
  doc: "Copy the subtree at point under another heading, asking which, as org-refile does but keeping the original.",
  run: () => {
    if (!entryHeading()) {
      throw new Error(`Before first headline at position ${ember.lineStart(lineAt()) + 1} in buffer ${ember.bufferName()}`);
    }
    ember.callInteractively("org--refile-copy-to");
  },
});
