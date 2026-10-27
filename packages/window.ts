// Commands for windows, after Emacs's window.el. The primitives they use,
// splitting, deleting and selecting windows, are in the core.

const splitBelow = ember.defineCommand({
  name: "split-window-below",
  doc:
    "Split the selected window into two, one above the other.\n\n" +
    "The selected window stays on top and the new one below shows the same buffer at the same place.",
  run: () => {
    ember.splitWindow(undefined, "below");
  },
});

const splitRight = ember.defineCommand({
  name: "split-window-right",
  doc:
    "Split the selected window into two, side by side.\n\n" +
    "The selected window stays on the left and the new one on the right shows the same buffer at the same place.",
  run: () => {
    ember.splitWindow(undefined, "right");
  },
});

const otherWindow = ember.defineCommand({
  name: "other-window",
  doc:
    "Select another window, the next in cyclic order.\n\n" +
    "A prefix argument says how many windows on to go; a negative one goes back.",
  run: () => {
    const windows = ember.windowList();
    const count = ember.prefixNumericValue(ember.prefixArg());
    const i = windows.indexOf(ember.selectedWindow());
    const n = windows.length;
    ember.selectWindow(windows[(((i + count) % n) + n) % n]);
  },
});

const deleteWindow = ember.defineCommand({
  name: "delete-window",
  doc:
    "Delete the selected window, giving its space to its neighbour.\n\n" +
    "The most recently used of the other windows is selected.",
  run: () => ember.deleteWindow(),
});

const deleteOtherWindows = ember.defineCommand({
  name: "delete-other-windows",
  doc: "Make the selected window fill the frame, deleting the others.",
  run: () => {
    const selected = ember.selectedWindow();
    for (const window of ember.windowList()) {
      if (window !== selected) ember.deleteWindow(window);
    }
  },
});

ember.bindKey("C-x 2", splitBelow);
ember.bindKey("C-x 3", splitRight);
ember.bindKey("C-x o", otherWindow);
ember.bindKey("C-x 0", deleteWindow);
ember.bindKey("C-x 1", deleteOtherWindows);
