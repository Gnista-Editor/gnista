// Basic editing commands that Emacs writes in Lisp, after its simple.el.
// Ember loads this file at startup, before init.ts.

// Prefix arguments: C-u, M-<digit> and C--.
//
// A prefix command does nothing itself. It leaves a prefix argument for the
// next command and binds, for one key only, the keys that continue the
// argument: more digits, a minus sign, or another C-u. Any other key runs its
// command with the argument.

/** How the argument typed so far is shown in the echo area, such as "C-u 12-". */
function describeArgument(arg: ember.PrefixArg): string {
  if (Array.isArray(arg)) {
    const times = Math.max(1, Math.round(Math.log(Math.abs(arg[0])) / Math.log(4)));
    return Array(times).fill("C-u").join(" ") + (arg[0] < 0 ? " -" : "") + "-";
  }
  if (arg === "-") {
    return "C-u --";
  }
  return arg === null ? "" : `C-u ${arg}-`;
}

/** Leaves `arg` for the next command, and lets the next key continue it. */
function continueArgument(arg: ember.PrefixArg): void {
  ember.setPrefixArg(arg);
  const keys: { [keys: string]: ember.CommandName } = { "C-u": "universal-argument-more" };
  for (let digit = 0; digit <= 9; digit++) {
    keys[String(digit)] = "digit-argument";
  }
  // After digits, a minus sign is typed with the argument, as in Emacs:
  // C-u 3 - inserts three dashes.
  if (typeof arg !== "number") {
    keys["-"] = "negative-argument";
  }
  ember.setTransientMap(keys);
  ember.message(describeArgument(arg));
}

const universalArgument = ember.defineCommand({
  name: "universal-argument",
  doc:
    "Begin a prefix argument for the next command.\n\n" +
    "Digits or a minus sign typed after it make the argument; without them it is 4, " +
    "and each further C-u multiplies it by 4. Most commands repeat that many times.",
  run: () => continueArgument([4]),
});

ember.defineCommand({
  name: "universal-argument-more",
  doc:
    "Multiply the prefix argument by 4, as a second C-u does.\n\n" +
    "After digits, it ends the argument instead, so digits typed after it are inserted.",
  run: () => {
    const arg = ember.prefixArg();
    if (Array.isArray(arg)) {
      continueArgument([arg[0] * 4]);
    } else if (arg === "-") {
      continueArgument([-4]);
    } else {
      ember.setPrefixArg(arg);
    }
  },
});

const digitArgument = ember.defineCommand({
  name: "digit-argument",
  doc: "Add the digit typed to the prefix argument, as M-5 or the digits after C-u do.",
  run: () => {
    const digit = Number((ember.lastKey() ?? "").slice(-1));
    const arg = ember.prefixArg();
    let next: ember.PrefixArg;
    if (typeof arg === "number") {
      next = arg * 10 + (arg < 0 ? -digit : digit);
    } else if (arg === "-") {
      // A minus followed by 0 stays "-", so that -01 works.
      next = digit === 0 ? "-" : -digit;
    } else {
      next = digit;
    }
    continueArgument(next);
  },
});

const negativeArgument = ember.defineCommand({
  name: "negative-argument",
  doc: "Make the prefix argument negative, as C-- or M-- does.",
  run: () => {
    const arg = ember.prefixArg();
    continueArgument(typeof arg === "number" ? -arg : arg === "-" ? null : "-");
  },
});

ember.bindKey("C-u", universalArgument);
for (let digit = 0; digit <= 9; digit++) {
  for (const modifiers of ["M-", "C-", "C-M-"]) {
    ember.bindKey(`${modifiers}${digit}`, digitArgument);
  }
}
for (const keys of ["M--", "C--", "C-M--"]) {
  ember.bindKey(keys, negativeArgument);
}

// Yanking older kills: M-y.

const yankPop = ember.defineCommand({
  name: "yank-pop",
  doc:
    "Replace the text just yanked with an earlier kill.\n\n" +
    "Only right after C-y or M-y. Repeat it to go further back through the kill ring; " +
    "a prefix argument N goes N kills back at once, and a negative one goes forward.",
  run: () => {
    // Emacs 28 and later read a kill from the minibuffer when the last
    // command was not a yank; Ember does not do that yet. Like Emacs, it
    // fails first if there is nothing to choose from.
    if (ember.lastCommand() !== "yank") {
      ember.currentKill(0);
      throw new Error("Previous command was not a yank");
    }
    // So that another M-y can follow this one.
    ember.setThisCommand("yank");
    const point = ember.point();
    const mark = ember.mark();
    if (mark === undefined) {
      throw new Error("The mark is not set now, so there is no region");
    }
    const pointWasFirst = point < mark;
    const start = Math.min(point, mark);
    ember.deleteRegion(start, Math.max(point, mark));
    ember.setMark(start);
    ember.insert(ember.currentKill(ember.prefixNumericValue()));
    if (pointWasFirst) {
      const end = ember.point();
      ember.gotoChar(start);
      ember.setMark(end);
    }
  },
});
ember.bindKey("M-y", yankPop);
