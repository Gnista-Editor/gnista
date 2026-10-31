// Basic functions packages share, after Emacs's subr.el and subr-x.el.
// Import them by feature name, as Lisp requires subr-x:
//
//   import { truthy, forwardLine } from "subr";

/** Whether a value counts as true, as anything but nil does in Emacs: not null, undefined or false. */
export const truthy = (v: ember.Value | undefined): boolean => v !== undefined && v !== null && v !== false;

/** A variable's value as a number, or `fallback` if it is not one. */
export function numberValue(name: string, fallback: number): number {
  const v = ember.variable(name);
  return typeof v === "number" ? v : fallback;
}

/** A regexp matching `s` itself, as Emacs's regexp-quote. */
export const regexpQuote = (s: string): string => s.replace(/[[*.\\?+^$]/g, "\\$&");

/** How many characters a string has, as buffer positions count them, not UTF-16 units. */
export function charCount(s: string): number {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length;
}

/**
 * Moves point `n` lines forward, back if negative, to the start of a line,
 * as Emacs's forward-line: within the accessible text, returning how many
 * lines it fell short.
 */
export function forwardLine(n: number): number {
  const start = ember.point();
  const line = ember.lineOf(start);
  const first = ember.lineOf(ember.pointMin());
  const last = ember.lineOf(ember.pointMax());
  if (n <= 0) {
    ember.gotoChar(Math.max(ember.pointMin(), ember.lineStart(Math.max(first, line + n))));
    return Math.min(0, line + n - first);
  }
  if (line + n <= last) {
    ember.gotoChar(ember.lineStart(line + n));
    return 0;
  }
  ember.gotoChar(ember.pointMax());
  let shortfall = n - (last - line);
  if (ember.point() !== start && ember.bufferText(ember.point() - 1, ember.point()) !== "\n") shortfall--;
  return shortfall;
}

ember.defineCommand({
  name: "delete-minibuffer-contents",
  doc: "Delete all the input in the minibuffer, leaving the prompt.",
  run: () => {
    ember.deleteRegion(ember.minibufferPromptEnd(), ember.pointMax());
  },
});

ember.defineVariable({
  name: "read-hide-char",
  doc: "The character read-passwd shows in place of each character of a password; * when nil.",
  value: null,
});
ember.defineVariable({
  name: "read-passwd--hide-password",
  doc: "Whether the password being read is shown as read-hide-char rather than as typed.",
  value: true,
});

/** Shows each character of the input as read-hide-char, or as typed while visible, as read-passwd--hide-password. */
function hidePassword(): void {
  const hide = truthy(ember.variable("read-passwd--hide-password"));
  const shown = String(ember.variable("read-hide-char") ?? "*");
  const [beg, end] = [ember.minibufferPromptEnd(), ember.pointMax()];
  if (beg === end) return;
  // One string for the whole input: Ember joins adjacent display strings
  // that are equal, where Emacs keeps each character's own string apart.
  ember.letBind({ "inhibit-read-only": true }, () => {
    if (hide) ember.putTextProperty(beg, end, "display", shown.repeat(end - beg));
    else ember.removeTextProperty(beg, end, "display");
    ember.putTextProperty(beg, end, "help-echo", "C-u: Clear password\nTAB: Toggle password visibility");
  });
}

ember.defineCommand({
  name: "read-passwd-toggle-visibility",
  doc: "Show the password being read as typed, or hide it again.",
  run: () => {
    ember.setVariable("read-passwd--hide-password", !truthy(ember.variable("read-passwd--hide-password")));
    hidePassword();
  },
});

ember.defineMinorMode({
  name: "read-passwd-mode",
  doc: "Hide the password being read in the minibuffer: C-u clears it and TAB shows or hides it.",
  bindings: { "C-u": "delete-minibuffer-contents", TAB: "read-passwd-toggle-visibility" },
  onChange: (on) => {
    ember.setVariable("read-passwd--hide-password", false);
    if (on) ember.call("read-passwd-toggle-visibility");
  },
});

/**
 * Reads a password in the minibuffer, as Emacs's read-passwd: what is
 * typed shows as read-hide-char, is kept in no history and is left out
 * of recent-keys, and the minibuffer is emptied afterwards. With
 * `confirm`, reads it twice and starts over until both agree.
 */
export async function readPasswd(prompt: string, confirm = false, def?: string): Promise<string> {
  if (confirm) {
    for (;;) {
      const first = await readPasswd(prompt, false, def);
      const second = await readPasswd("Confirm password: ", false, def);
      if (first === second) return first;
      ember.message("Password not repeated accurately; please start over");
      await ember.sitFor(1);
    }
  }
  const setup = () => {
    ember.removeHook("minibuffer-setup-hook", setup);
    for (const name of ["inhibit--record-char", "show-paren-mode"]) ember.makeLocalVariable(name);
    ember.setVariable("inhibit--record-char", true);
    ember.setVariable("show-paren-mode", false);
    ember.call("read-passwd-mode");
    ember.addHook("post-command-hook", hidePassword, { local: true });
  };
  ember.addHook("minibuffer-setup-hook", setup);
  try {
    return await ember.letBind({ "enable-recursive-minibuffers": true }, () => ember.readString(prompt, { default: def, history: "t" }));
  } finally {
    ember.removeHook("minibuffer-setup-hook", setup);
  }
}
