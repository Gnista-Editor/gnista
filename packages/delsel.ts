// Delete Selection mode, after Emacs's delsel.el: typing replaces the
// selection. Emacs leaves it off by default, and so does E8.

// Commands that replace the active region rather than adding to it say so
// with their delete-selection property, as in Emacs; other packages' can too.
for (const command of ["self-insert-command", "newline", "yank"]) e8.put(command, "delete-selection", true);

e8.defineHook(
  "self-insert-uses-region-functions",
  "Functions that say whether typing this character uses the active region, as electric-pair-mode wraps it in a pair, so Delete Selection mode leaves it.",
);

function deleteSelectionBeforeCommand(): void {
  const command = e8.thisCommand();
  const mark = e8.mark();
  if (command === undefined || !e8.get(command, "delete-selection") || !e8.regionActive() || mark === undefined) {
    return;
  }
  if (command === "self-insert-command" && e8.runHookWithArgsUntilSuccess("self-insert-uses-region-functions") !== null) {
    return;
  }
  const point = e8.point();
  if (point !== mark) {
    e8.deleteRegion(Math.min(point, mark), Math.max(point, mark));
  }
}

e8.defineMinorMode({
  name: "delete-selection-mode",
  global: true,
  doc:
    "Typing replaces the selection, rather than inserting next to it.\n\n" +
    "While the region is active, typing, RET and C-y first delete it. DEL and <delete> " +
    "delete it whether or not this mode is on; see delete-active-region.",
  onChange: (enabled) => {
    if (enabled) {
      e8.addHook("pre-command-hook", deleteSelectionBeforeCommand);
    } else {
      e8.removeHook("pre-command-hook", deleteSelectionBeforeCommand);
    }
  },
});
