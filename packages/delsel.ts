// Delete Selection mode, after Emacs's delsel.el: typing replaces the
// selection. Emacs leaves it off by default, and so does Gnista.

// Commands that replace the active region rather than adding to it say so
// with their delete-selection property, as in Emacs; other packages' can too.
for (const command of ["self-insert-command", "newline", "yank"]) gnista.put(command, "delete-selection", true);

gnista.defineHook(
  "self-insert-uses-region-functions",
  "Functions that say whether typing this character uses the active region, as electric-pair-mode wraps it in a pair, so Delete Selection mode leaves it.",
);

function deleteSelectionBeforeCommand(): void {
  const command = gnista.thisCommand();
  const mark = gnista.mark();
  if (command === undefined || !gnista.get(command, "delete-selection") || !gnista.regionActive() || mark === undefined) {
    return;
  }
  if (command === "self-insert-command" && gnista.runHookWithArgsUntilSuccess("self-insert-uses-region-functions") !== null) {
    return;
  }
  const point = gnista.point();
  if (point !== mark) {
    gnista.deleteRegion(Math.min(point, mark), Math.max(point, mark));
  }
}

gnista.defineMinorMode({
  name: "delete-selection-mode",
  global: true,
  doc:
    "Typing replaces the selection, rather than inserting next to it.\n\n" +
    "While the region is active, typing, RET and C-y first delete it. DEL and <delete> " +
    "delete it whether or not this mode is on; see delete-active-region.",
  onChange: (enabled) => {
    if (enabled) {
      gnista.addHook("pre-command-hook", deleteSelectionBeforeCommand);
    } else {
      gnista.removeHook("pre-command-hook", deleteSelectionBeforeCommand);
    }
  },
});
