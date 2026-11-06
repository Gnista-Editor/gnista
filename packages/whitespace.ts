// Cleaning up whitespace, after Emacs's whitespace.el: whitespace-cleanup
// takes away empty lines at the start and end of the buffer and spaces at
// the ends of lines, and makes indentation and the spaces around tabs use
// tabs or spaces as indent-tabs-mode says. The visual whitespace-mode is
// not here yet.

import { tabifyRegion, untabifyRegion } from "simple";

e8.defineVariable({
  name: "whitespace-style",
  doc: "The kinds of whitespace problem whitespace-cleanup fixes: empty, indentation, trailing, space-after-tab and space-before-tab, or their ::tab and ::space forms.",
  value: [
    "face", "tabs", "spaces", "trailing", "lines", "space-before-tab", "newline", "indentation", "empty",
    "space-after-tab", "space-mark", "tab-mark", "newline-mark", "missing-newline-at-eof",
  ],
});

const EMPTY_AT_BOB = "\\`\\([ \t\n]*\\(?:\n\\|$\\)\\)";
const EMPTY_AT_EOB = "^\\([ \t\n]+\\)\\'";
const TRAILING = "\\([\t \u00a0]+\\)$";
const SPACE_BEFORE_TAB = "\\( +\\)\\(\t+\\)";
const SPACE_AFTER_TAB: [string, string] = ["\t+\\(\\( \\{%d,\\}\\)+\\)", "\\(\t+\\) \\{%d,\\}"];
const INDENTATION: [string, string] = ["^\t*\\(\\( \\{%d\\}\\)+\\)[^\n\t]", "^ *\\(\t+\\)."];

const has = (kind: string): boolean => ((e8.variable("whitespace-style") ?? []) as string[]).includes(kind);
const tabsMode = (): boolean => {
  const v = e8.variable("indent-tabs-mode");
  return v !== false && v !== null && v !== undefined;
};

/** One of a pair of regexps, for tabs or spaces, with tab-width in it, as whitespace-regexp. */
function regexpFor(pair: [string, string], kind?: "tab" | "space"): string {
  const tabs = kind === "tab" || (kind === undefined && tabsMode());
  return (tabs ? pair[0] : pair[1]).replace("%d", String(Number(e8.variable("tab-width") ?? 8)));
}

/** Calls `action` on group `index` of each match of `regexp` from start to end, as whitespace-replace-action. */
function replaceAction(action: (b: number, e: number) => void, start: number, end: e8.Marker, regexp: string, index: number): void {
  e8.gotoChar(start);
  while (e8.reSearchForward(regexp, { bound: e8.markerPosition(end)!, noerror: true }) !== undefined) {
    const [b, e] = [e8.matchBeginning(index)!, e8.matchEnd(index)!];
    e8.gotoChar(e);
    action(b, e);
  }
}

const deleteRegion = (b: number, e: number) => {
  e8.deleteRegion(b, e);
};

/** Fixes the whitespace problems whitespace-style names from start to end but empty lines, as whitespace-cleanup-region. */
function cleanupRegion(startIn: number, endIn: number): void {
  if (e8.bufferReadOnly()) {
    e8.message(`Can't cleanup region: ${e8.bufferName()} is read-only`);
    return;
  }
  const start = Math.min(startIn, endIn);
  const end = e8.makeMarker(Math.max(startIn, endIn));
  e8.letBind({ "overwrite-mode": null }, () =>
    e8.saveExcursion(() => {
      if (has("indentation")) {
        const regexp = regexpFor(INDENTATION);
        e8.gotoChar(start);
        while (e8.reSearchForward(regexp, { bound: e8.markerPosition(end)!, noerror: true }) !== undefined) {
          const indentation = e8.currentIndentation();
          e8.gotoChar(e8.matchBeginning(0)!);
          e8.call("delete-horizontal-space");
          if (e8.point() !== e8.lineEndPosition()) e8.indentTo(indentation);
        }
      } else if (has("indentation::tab")) {
        replaceAction(tabifyRegion, start, end, regexpFor(INDENTATION, "tab"), 0);
      } else if (has("indentation::space")) {
        replaceAction(untabifyRegion, start, end, regexpFor(INDENTATION, "space"), 0);
      }
      if (has("trailing")) replaceAction(deleteRegion, start, end, TRAILING, 1);
      if (has("space-after-tab")) replaceAction(tabsMode() ? tabifyRegion : untabifyRegion, start, end, regexpFor(SPACE_AFTER_TAB), 1);
      else if (has("space-after-tab::tab")) replaceAction(tabifyRegion, start, end, regexpFor(SPACE_AFTER_TAB, "tab"), 1);
      else if (has("space-after-tab::space")) replaceAction(untabifyRegion, start, end, regexpFor(SPACE_AFTER_TAB, "space"), 1);
      if (has("space-before-tab")) replaceAction(tabsMode() ? tabifyRegion : untabifyRegion, start, end, SPACE_BEFORE_TAB, tabsMode() ? 0 : 2);
      else if (has("space-before-tab::tab")) replaceAction(tabifyRegion, start, end, SPACE_BEFORE_TAB, 0);
      else if (has("space-before-tab::space")) replaceAction(untabifyRegion, start, end, SPACE_BEFORE_TAB, 2);
    }),
  );
  e8.deleteMarker(end);
}

e8.defineCommand({
  name: "whitespace-cleanup-region",
  doc: "Fix the whitespace problems whitespace-style names in the region, but empty lines at the buffer's start and end.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
  ],
  run: (start: number, end: number) => cleanupRegion(start, end),
});

e8.defineCommand({
  name: "whitespace-cleanup",
  doc:
    "Fix the whitespace problems whitespace-style names: empty lines at the start and end of the buffer, spaces at the " +
    "ends of lines, and indentation and spaces around tabs that disagree with indent-tabs-mode. With the region active, only there.",
  run: () => {
    if (e8.bufferReadOnly()) {
      e8.message(`Can't cleanup: ${e8.bufferName()} is read-only`);
      return;
    }
    const mark = e8.mark();
    if (e8.regionActive() && mark !== undefined) {
      cleanupRegion(Math.min(mark, e8.point()), Math.max(mark, e8.point()));
      return;
    }
    e8.saveExcursion(() => {
      if (has("empty")) {
        e8.gotoChar(e8.pointMin());
        if (e8.lookingAt(EMPTY_AT_BOB)) e8.deleteRegion(e8.matchBeginning(1)!, e8.matchEnd(1)!);
        if (e8.reSearchForward(EMPTY_AT_EOB, { noerror: true }) !== undefined) e8.deleteRegion(e8.matchBeginning(1)!, e8.matchEnd(1)!);
      }
    });
    cleanupRegion(e8.pointMin(), e8.pointMax());
  },
});
