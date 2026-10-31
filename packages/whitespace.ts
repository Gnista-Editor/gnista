// Cleaning up whitespace, after Emacs's whitespace.el: whitespace-cleanup
// takes away empty lines at the start and end of the buffer and spaces at
// the ends of lines, and makes indentation and the spaces around tabs use
// tabs or spaces as indent-tabs-mode says. The visual whitespace-mode is
// not here yet.

import { tabifyRegion, untabifyRegion } from "simple";

ember.defineVariable({
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

const has = (kind: string): boolean => ((ember.variable("whitespace-style") ?? []) as string[]).includes(kind);
const tabsMode = (): boolean => {
  const v = ember.variable("indent-tabs-mode");
  return v !== false && v !== null && v !== undefined;
};

/** One of a pair of regexps, for tabs or spaces, with tab-width in it, as whitespace-regexp. */
function regexpFor(pair: [string, string], kind?: "tab" | "space"): string {
  const tabs = kind === "tab" || (kind === undefined && tabsMode());
  return (tabs ? pair[0] : pair[1]).replace("%d", String(Number(ember.variable("tab-width") ?? 8)));
}

/** Calls `action` on group `index` of each match of `regexp` from start to end, as whitespace-replace-action. */
function replaceAction(action: (b: number, e: number) => void, start: number, end: ember.Marker, regexp: string, index: number): void {
  ember.gotoChar(start);
  while (ember.reSearchForward(regexp, { bound: ember.markerPosition(end)!, noerror: true }) !== undefined) {
    const [b, e] = [ember.matchBeginning(index)!, ember.matchEnd(index)!];
    ember.gotoChar(e);
    action(b, e);
  }
}

const deleteRegion = (b: number, e: number) => {
  ember.deleteRegion(b, e);
};

/** Fixes the whitespace problems whitespace-style names from start to end but empty lines, as whitespace-cleanup-region. */
function cleanupRegion(startIn: number, endIn: number): void {
  if (ember.bufferReadOnly()) {
    ember.message(`Can't cleanup region: ${ember.bufferName()} is read-only`);
    return;
  }
  const start = Math.min(startIn, endIn);
  const end = ember.makeMarker(Math.max(startIn, endIn));
  ember.letBind({ "overwrite-mode": null }, () =>
    ember.saveExcursion(() => {
      if (has("indentation")) {
        const regexp = regexpFor(INDENTATION);
        ember.gotoChar(start);
        while (ember.reSearchForward(regexp, { bound: ember.markerPosition(end)!, noerror: true }) !== undefined) {
          const indentation = ember.currentIndentation();
          ember.gotoChar(ember.matchBeginning(0)!);
          ember.call("delete-horizontal-space");
          if (ember.point() !== ember.lineEndPosition()) ember.indentTo(indentation);
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
  ember.deleteMarker(end);
}

ember.defineCommand({
  name: "whitespace-cleanup-region",
  doc: "Fix the whitespace problems whitespace-style names in the region, but empty lines at the buffer's start and end.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
  ],
  run: (start: number, end: number) => cleanupRegion(start, end),
});

ember.defineCommand({
  name: "whitespace-cleanup",
  doc:
    "Fix the whitespace problems whitespace-style names: empty lines at the start and end of the buffer, spaces at the " +
    "ends of lines, and indentation and spaces around tabs that disagree with indent-tabs-mode. With the region active, only there.",
  run: () => {
    if (ember.bufferReadOnly()) {
      ember.message(`Can't cleanup: ${ember.bufferName()} is read-only`);
      return;
    }
    const mark = ember.mark();
    if (ember.regionActive() && mark !== undefined) {
      cleanupRegion(Math.min(mark, ember.point()), Math.max(mark, ember.point()));
      return;
    }
    ember.saveExcursion(() => {
      if (has("empty")) {
        ember.gotoChar(ember.pointMin());
        if (ember.lookingAt(EMPTY_AT_BOB)) ember.deleteRegion(ember.matchBeginning(1)!, ember.matchEnd(1)!);
        if (ember.reSearchForward(EMPTY_AT_EOB, { noerror: true }) !== undefined) ember.deleteRegion(ember.matchBeginning(1)!, ember.matchEnd(1)!);
      }
    });
    cleanupRegion(ember.pointMin(), ember.pointMax());
  },
});
