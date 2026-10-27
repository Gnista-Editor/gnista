// Keyboard macros: F3, F4, C-x ( and C-x ), after Emacs's kmacro.el.
//
// Recording and replaying keys are editor primitives; this package provides
// the commands and the macro counter.

/** The counter F3 inserts while a macro is defined or run (Emacs's kmacro-counter). */
let counter = 0;

function startMacro(): void {
  if (ember.definingKbdMacro() || ember.executingKbdMacro()) {
    // Emacs only says so; it is not an error.
    ember.message("Already defining keyboard macro.");
    return;
  }
  ember.startKbdMacro();
  const arg = ember.prefixArg();
  counter = arg === null ? 0 : ember.prefixNumericValue(arg);
  ember.message("Defining kbd macro...");
}

function endMacro(): void {
  ember.endKbdMacro();
  ember.message("Keyboard macro defined");
}

function insertCounter(): void {
  ember.insert(String(counter));
  counter += ember.prefixNumericValue();
}

ember.defineCommand({
  name: "kmacro-start-macro",
  doc:
    "Start recording a keyboard macro: the keys typed until C-x ) or F4.\n\n" +
    "A prefix argument sets the macro counter's starting value, which is 0 otherwise.",
  run: startMacro,
});

ember.defineCommand({
  name: "kmacro-end-macro",
  doc: "Finish recording the keyboard macro.",
  run: endMacro,
});

ember.defineCommand({
  name: "kmacro-insert-counter",
  doc: "Insert the macro counter, then add the prefix argument to it, 1 by default.",
  run: insertCounter,
});

ember.defineCommand({
  name: "kmacro-start-macro-or-insert-counter",
  doc:
    "Start recording a keyboard macro, or insert the macro counter if one is being recorded or run.\n\n" +
    "So F3 starts a macro, and F3 inside it inserts 0, 1, 2 and so on each time the macro runs.",
  run: () => {
    if (ember.definingKbdMacro() || ember.executingKbdMacro()) {
      insertCounter();
    } else {
      startMacro();
    }
  },
});

ember.defineCommand({
  name: "kmacro-call-macro",
  doc:
    "Run the last keyboard macro, as many times as the prefix argument says.\n\n" +
    "An argument of 0 repeats it until it fails. The first error stops it.",
  run: () => ember.callLastKbdMacro(ember.prefixNumericValue()),
});

ember.defineCommand({
  name: "kmacro-end-or-call-macro",
  doc: "Finish recording the keyboard macro, or run the last one if none is being recorded.",
  run: () => {
    if (ember.definingKbdMacro()) {
      endMacro();
    } else {
      ember.callLastKbdMacro(ember.prefixNumericValue());
    }
  },
});

ember.defineCommand({
  name: "kmacro-end-and-call-macro",
  doc:
    "Finish recording the keyboard macro if one is being recorded, then run it.\n\n" +
    "Typing e again runs it again.",
  run: () => {
    if (ember.definingKbdMacro()) {
      endMacro();
    }
    ember.callLastKbdMacro(ember.prefixNumericValue());
    ember.setTransientMap({ e: "kmacro-end-and-call-macro" });
  },
});

ember.bindKey("<f3>", "kmacro-start-macro-or-insert-counter");
ember.bindKey("<f4>", "kmacro-end-or-call-macro");
ember.bindKey("C-x (", "kmacro-start-macro");
ember.bindKey("C-x )", "kmacro-end-macro");
ember.bindKey("C-x e", "kmacro-end-and-call-macro");
