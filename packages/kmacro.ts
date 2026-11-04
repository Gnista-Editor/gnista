// Keyboard macros: F3, F4, C-x ( and C-x ), after Emacs's kmacro.el.
//
// Recording and replaying keys are editor primitives; this package provides
// the commands and the macro counter.

/** The counter F3 inserts while a macro is defined or run (Emacs's kmacro-counter). */
let counter = 0;

function startMacro(): void {
  if (gnista.definingKbdMacro() || gnista.executingKbdMacro()) {
    // Emacs only says so; it is not an error.
    gnista.message("Already defining keyboard macro.");
    return;
  }
  gnista.startKbdMacro();
  const arg = gnista.prefixArg();
  counter = arg === null ? 0 : gnista.prefixNumericValue(arg);
  gnista.message("Defining kbd macro...");
}

function endMacro(): void {
  gnista.endKbdMacro();
  gnista.message("Keyboard macro defined");
}

function insertCounter(): void {
  gnista.insert(String(counter));
  counter += gnista.prefixNumericValue();
}

gnista.defineCommand({
  name: "kmacro-start-macro",
  doc:
    "Start recording a keyboard macro: the keys typed until C-x ) or F4.\n\n" +
    "A prefix argument sets the macro counter's starting value, which is 0 otherwise.",
  run: startMacro,
});

gnista.defineCommand({
  name: "kmacro-end-macro",
  doc: "Finish recording the keyboard macro.",
  run: endMacro,
});

gnista.defineCommand({
  name: "kmacro-insert-counter",
  doc: "Insert the macro counter, then add the prefix argument to it, 1 by default.",
  run: insertCounter,
});

gnista.defineCommand({
  name: "kmacro-start-macro-or-insert-counter",
  doc:
    "Start recording a keyboard macro, or insert the macro counter if one is being recorded or run.\n\n" +
    "So F3 starts a macro, and F3 inside it inserts 0, 1, 2 and so on each time the macro runs.",
  run: () => {
    if (gnista.definingKbdMacro() || gnista.executingKbdMacro()) {
      insertCounter();
    } else {
      startMacro();
    }
  },
});

gnista.defineCommand({
  name: "kmacro-call-macro",
  doc:
    "Run the last keyboard macro, as many times as the prefix argument says.\n\n" +
    "An argument of 0 repeats it until it fails. The first error stops it.",
  run: () => gnista.callLastKbdMacro(gnista.prefixNumericValue()),
});

gnista.defineCommand({
  name: "kmacro-end-or-call-macro",
  doc: "Finish recording the keyboard macro, or run the last one if none is being recorded.",
  run: () => {
    if (gnista.definingKbdMacro()) {
      endMacro();
    } else {
      gnista.callLastKbdMacro(gnista.prefixNumericValue());
    }
  },
});

gnista.defineCommand({
  name: "kmacro-end-and-call-macro",
  doc:
    "Finish recording the keyboard macro if one is being recorded, then run it.\n\n" +
    "Typing e again runs it again.",
  run: () => {
    if (gnista.definingKbdMacro()) {
      endMacro();
    }
    gnista.callLastKbdMacro(gnista.prefixNumericValue());
    gnista.setTransientMap({ e: "kmacro-end-and-call-macro" });
  },
});

gnista.bindKey("<f3>", "kmacro-start-macro-or-insert-counter");
gnista.bindKey("<f4>", "kmacro-end-or-call-macro");
gnista.bindKey("C-x (", "kmacro-start-macro");
gnista.bindKey("C-x )", "kmacro-end-macro");
gnista.bindKey("C-x e", "kmacro-end-and-call-macro");
