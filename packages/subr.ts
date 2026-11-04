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

/** A JavaScript regexp's source matching `s` itself, for a package's own regexps; regexpQuote is for Emacs's. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The matches of a global regexp in a string, as `text.matchAll(re)` gives
 * them, without the copy of the regexp that matchAll makes on each call,
 * which QuickJS builds by compiling it again.
 */
export function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const from = re.lastIndex;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    found.push(m);
    if (m[0] === "") re.lastIndex += re.unicode && (text.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
  }
  re.lastIndex = from;
  return found;
}

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

ember.defineCommand({
  name: "undefined",
  doc: "Beep and say the keys typed do nothing here, as keys bound to this command, to hide a binding, do.",
  run: () => {
    ember.ding();
    ember.message(`${ember.thisSingleCommandKeys()} is undefined`);
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

/**
 * A string that can be put in left-to-right text without the right-to-left
 * text in it taking the punctuation after it along, as Emacs's
 * bidi-string-mark-left-to-right: with an invisible left-to-right mark
 * after it if it has a right-to-left character.
 */
export function bidiStringMarkLeftToRight(str: string): string | ember.PropertizedString {
  if (typeof str !== "string") ember.signal("wrong-type-argument", "Wrong type argument: stringp", [str]);
  return ember.stringMatch("\\cR", str) === undefined ? str : ember.concat(str, ember.propertize("\u200e", { invisible: true }));
}

/**
 * State a package keeps for each buffer, as a buffer-local variable holds
 * it: found by the buffer, given as a name or a buffer object, through its
 * id, so it follows a buffer that is renamed, and forgotten when the
 * buffer is killed.
 */
/**
 * A global mode that turns a buffer's mode on in every buffer, and in those
 * made later as their major modes start, as easy-mmode's
 * define-globalized-minor-mode does with a function that turns MODE on.
 */
export function defineGlobalizedMinorMode(name: string, mode: ember.CommandName, doc: string): ember.DefinedCommand {
  const turnOn = () => {
    if (ember.variable(name) === true && !ember.bufferName().startsWith(" ") && ember.variable(mode) !== true) ember.callWithPrefix(1, mode);
  };
  return ember.defineMinorMode({
    name,
    global: true,
    doc,
    onChange: (enabled) => {
      for (const b of ember.bufferList()) {
        if (b.startsWith(" ")) continue;
        ember.withCurrentBuffer(b, () => {
          if (enabled) turnOn();
          else if (ember.variable(mode) === true) ember.callWithPrefix(-1, mode);
        });
      }
      if (enabled) ember.addHook("after-change-major-mode-hook", turnOn);
      else ember.removeHook("after-change-major-mode-hook", turnOn);
    },
  });
}

/** Where a program is along PATH, as executable-find. */
export function executableFind(program: string): string | undefined {
  if (program.includes("/")) return ember.fileExecutableP(ember.expandFileName(program)) ? program : undefined;
  for (const dir of (ember.getenv("PATH") ?? "").split(":")) {
    if (dir && ember.fileExecutableP(`${dir}/${program}`)) return `${dir}/${program}`;
  }
  return undefined;
}

export class PerBuffer<T> {
  private readonly values = new Map<number, T>();

  constructor() {
    perBufferValues.push(this.values);
  }

  private static id(buffer: string | ember.Buffer): number | undefined {
    return typeof buffer === "string" ? ember.getBuffer(buffer)?.id : buffer.id;
  }

  get(buffer: string | ember.Buffer): T | undefined {
    const id = PerBuffer.id(buffer);
    return id === undefined ? undefined : this.values.get(id);
  }

  has(buffer: string | ember.Buffer): boolean {
    const id = PerBuffer.id(buffer);
    return id !== undefined && this.values.has(id);
  }

  set(buffer: string | ember.Buffer, value: T): void {
    const id = PerBuffer.id(buffer);
    if (id !== undefined) this.values.set(id, value);
  }

  delete(buffer: string | ember.Buffer): void {
    const id = PerBuffer.id(buffer);
    if (id !== undefined) this.values.delete(id);
  }
}

const perBufferValues: Map<number, unknown>[] = [];

ember.addHook("kill-buffer-hook", () => {
  const id = ember.currentBuffer().id;
  for (const values of perBufferValues) values.delete(id);
});
