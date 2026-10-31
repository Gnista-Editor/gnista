import { applyOnRegion } from "ansi-color";
import { readPasswd, regexpQuote } from "subr";
import { isearchSearchFunDefault, isearchMessage, isearchMessagePrefix } from "isearch";

// Command interpreters in a buffer, after Emacs's comint.el: a program on
// a pseudo-terminal, its output marked as the `output` field and its prompt
// left for you to type after, input sent with RET and kept in a history
// (M-p, M-n), and the subjob signals on C-c C-c, C-c C-z and C-c C-\.
// Modes for shells and REPLs, as shell.ts's shell-mode, derive from it.

/** Emacs 30's comint-password-prompt-regexp, as it builds it from password-word-equivalents. */
const PASSWORD_PROMPT =
  "\\(^ *\\|\\( SMB\\|'s\\|Bad\\|C\\(?:VS\\|urrent\\)\\|Enter\\(?: \\(?:Auth\\|\\(?:sam\\|th\\)e\\)\\)?\\|Kerberos\\|LDAP\\|New\\|Old\\|PEM\\|Re\\(?:peat\\|type\\)\\|SUDO\\|UNIX\\|Verify\\|\\[sudo]\\|doas\\|enter\\(?: \\(?:auth\\|\\(?:sam\\|th\\)e\\)\\)?\\|login\\|new\\|old\\) +.*\\)\\(?:\\(?:adgangskode\\|contrase\\(?:\\(?:ny\\|ñ\\)a\\)\\|decryption key\\|encryption key\\|geslo\\|h\\(?:\\(?:asł\\|esl\\)o\\)\\|iphasiwedi\\|jelszó\\|l\\(?:ozinka\\|ösenord\\)\\|m\\(?:ot de passe\\|ật khẩu\\)\\|p\\(?:a\\(?:rola\\|s\\(?:ahitza\\|s\\(?: phrase\\|code\\|ord\\|phrase\\|wor[dt]\\)\\|vorto\\)\\)\\|in\\)\\|s\\(?:alasana\\|enha\\|laptažodis\\)\\|wachtwoord\\|лозинка\\|пароль\\|ססמה\\|كلمة السر\\|गुप्तशब्द\\|शब्दकूट\\|গুপ্তশব্দ\\|পাসওয়ার্ড\\|ਪਾਸਵਰਡ\\|પાસવર્ડ\\|ପ୍ରବେଶ ସଙ୍କେତ\\|கடவுச்சொல்\\|సంకేతపదము\\|ಗುಪ್ತಪದ\\|അടയാളവാക്ക്\\|රහස්පදය\\|ពាក្យសម្ងាត់\\|パスワード\\|密[码碼]\\|암호\\)\\|Response\\)\\(?:\\(?:, try\\)? *again\\| (empty for no passphrase)\\| (again)\\)?\\(?: [[:alpha:]]+ .+\\)?[[:blank:]]*[:：﹕︓៖][[:space:]]*\\'\\|^Enter encryption key: (repeat) *\\'\\|^([^)@ \t\n]+@[^)@ \t\n]+) Password: *\\'";

for (const [name, doc, value, local] of [
  ["comint-input-ring-size", "How many inputs a comint buffer keeps for M-p and M-n.", 500, false],
  ["comint-input-ignoredups", "Whether an input the same as the last one is left out of the history.", false, false],
  ["comint-prompt-read-only", "Whether the prompt is read-only, so it cannot be deleted by accident.", false, false],
  ["comint-eol-on-send", "Whether RET moves to the end of the input before sending it.", true, false],
  ["comint-process-echoes", "Whether the program echoes its input, which RET then takes out of its output.", false, true],
  ["comint-preoutput-filter-functions", "Functions each piece of output goes through before it is inserted; each returns the text to insert.", [], true],
  ["comint-password-prompt-regexp", "An Emacs regexp matching a program's prompts for a password, which comint then reads without showing it.", PASSWORD_PROMPT, false],
  ["comint-input-ring-file-name", "The file comint-read-input-ring reads the history from and comint-write-input-ring writes it to, or nil for none.", null, true],
  ["comint-input-ring-separator", "The regexp between inputs in the history file.", "\n", false],
  ["comint-input-history-ignore", "A regexp for entries of the history file to leave out.", "^#", false],
  ["comint-input-ring-file-prefix", "A regexp for what to skip at the start of each entry of the history file, such as zsh's time stamps.", null, true],
  ["comint-move-point-for-matching-input", "Where C-c M-r and C-c M-s leave point: after-input where it was, end-of-line at the end.", "after-input", false],
  ["comint-terminfo-terminal", "The terminal comint programs are told they run on, as TERM.", "dumb", false],
] as const) {
  ember.defineVariable({ name, doc, value: value as ember.Value, local });
}

/** What each comint buffer keeps: its input history and where it stands in it, and its markers. */
interface State {
  ring: string[];
  /** Where M-p and M-n are in the history, or undefined before the first. */
  index: number | undefined;
  /** What was typed before M-p, put back when going past the newest. */
  stored: string | undefined;
  /** The input C-c M-r and C-c M-s search the history for. */
  matching: string;
  lastInputStart: ember.Marker;
  lastInputEnd: ember.Marker;
  lastOutputStart: ember.Marker;
}

const states = new Map<string, State>();

function state(buffer = ember.bufferName()): State {
  let s = states.get(buffer);
  if (s === undefined) {
    s = {
      ring: [],
      index: undefined,
      stored: undefined,
      matching: "",
      lastInputStart: ember.makeMarker(ember.pointMax()),
      lastInputEnd: ember.makeMarker(ember.pointMax()),
      lastOutputStart: ember.makeMarker(ember.pointMax()),
    };
    states.set(buffer, s);
  }
  return s;
}

const nil = (v: unknown) => v === null || v === undefined || v === false;

/** The current buffer's process, or the error comint gives without one. */
function bufferProcess(): string {
  const p = ember.getBufferProcess(ember.bufferName());
  if (p === undefined) throw new Error("Current buffer has no process");
  return p;
}

const processMark = (p: string): number => ember.markerPosition(ember.processMark(p)!)!;

const PROMPT_REAR_NONSTICKY = ["field", "inhibit-line-move-field-capture", "read-only", "font-lock-face", "insert-in-front-hooks"];

/** Marks text as the program's output, the `output` field, as comint--mark-as-output. */
function markAsOutput(beg: number, end: number): void {
  if (beg >= end) return;
  for (const [name, value] of [
    ["field", Symbol.for("output")],
    ["inhibit-line-move-field-capture", true],
    ["rear-nonsticky", PROMPT_REAR_NONSTICKY],
    ["front-sticky", ["field", "inhibit-line-move-field-capture"]],
  ] as const) {
    ember.putTextProperty(beg, end, name, value as ember.Value);
  }
}

/**
 * Carriage returns delete back to the start of the line and backspaces the
 * character before, CR LF becoming LF, as a terminal shows them, in
 * output from start to end, as comint-carriage-motion.
 */
function carriageMotion(start: number, end: number): void {
  const text = ember.bufferText(start, end);
  if (!/[\r\b]/.test(text)) return;
  ember.letBind({ "inhibit-read-only": true, "inhibit-field-text-motion": true }, () => {
    const endMarker = ember.makeMarker(end);
    let lbeg = ember.lineBeginningPosition(start);
    let p = start;
    while (p < ember.markerPosition(endMarker)!) {
      const c = ember.bufferText(p, p + 1);
      if (c === "\b") {
        ember.deleteRegion(p, p + 1);
        if (p > lbeg) {
          ember.deleteRegion(p - 1, p);
          p--;
        }
      } else if (c === "\n") {
        p++;
        lbeg = p;
      } else if (c === "\r") {
        ember.deleteRegion(p, p + 1);
        // CR LF is a line's end; a CR alone goes back to the line's start.
        if (ember.bufferText(p, p + 1) !== "\n") {
          ember.deleteRegion(lbeg, p);
          p = lbeg;
        }
      } else {
        p++;
      }
    }
    ember.deleteMarker(endMarker);
  });
}

/** Moves the windows showing a buffer whose point is at `at` to `to`, as window-point-insertion-type t does. */
function advanceWindowPoints(buffer: string, at: number, to: number): void {
  for (const w of ember.windowList()) {
    if (ember.windowBuffer(w) === buffer && ember.windowPoint(w) === at && w !== ember.selectedWindow()) ember.setWindowPoint(w, to);
  }
}

/**
 * Puts a process's output into its buffer at its mark, as comint-output-filter:
 * through comint-preoutput-filter-functions, marked as output, with carriage
 * motion done, then comint-output-filter-functions run, and the last line
 * left as the prompt.
 */
export function outputFilter(process: string, text: string): void {
  const buffer = ember.processBuffer(process);
  if (buffer === undefined || !ember.bufferLiveP(ember.getBuffer(buffer))) return;
  ember.withCurrentBuffer(buffer, () => {
    let string: string | undefined = text;
    for (const f of (ember.variable("comint-preoutput-filter-functions") ?? []) as ember.Value[]) {
      if (string === undefined) break;
      const result = ember.funcall(f as string, string);
      string = typeof result === "string" ? result : undefined;
    }
    if (string === undefined || string === "") return;
    const s = state();
    ember.letBind({ "inhibit-read-only": true }, () =>
      ember.saveRestriction(() => {
        ember.widen();
        const mark = processMark(process);
        const pointAtMark = ember.point() === mark;
        const saved = ember.makeMarker(ember.point(), { advances: true });
        ember.setMarker(s.lastOutputStart, mark);
        ember.gotoChar(mark);
        ember.insert(string!);
        ember.setMarker(ember.processMark(process)!, ember.point());
        carriageMotion(ember.markerPosition(s.lastOutputStart)!, ember.point());
        ember.setMarker(ember.processMark(process)!, ember.point());
        // ANSI colours, as ansi-color-process-output does first among comint-output-filter-functions.
        const ansi = ember.variable("ansi-color-for-comint-mode");
        if (ansi === true || ansi === "filter") {
          applyOnRegion(ember.markerPosition(s.lastOutputStart)!, processMark(process), ansi === "filter");
          ember.gotoChar(processMark(process));
        }
        const end = ember.point();
        ember.gotoChar(pointAtMark ? end : ember.markerPosition(saved)!);
        ember.runHooks("comint-output-filter-functions", string!);
        markAsOutput(ember.markerPosition(s.lastOutputStart)!, processMark(process));
        // The prompt: the output on the last line, with no newline after it.
        const promptStart = ember.lineBeginningPosition(processMark(process));
        if (!nil(ember.variable("comint-prompt-read-only")) && promptStart < processMark(process)) {
          ember.putTextProperty(promptStart, processMark(process), "read-only", true);
          ember.putTextProperty(promptStart, processMark(process), "front-sticky", ["read-only"]);
        }
        if (promptStart < processMark(process)) ember.addFaceTextProperty(promptStart, processMark(process), "comint-highlight-prompt");
        advanceWindowPoints(buffer, mark, processMark(process));
        ember.deleteMarker(saved);
      }),
    );
  });
}

/** Adds an input to the history unless it is only spaces, or the same as the last with comint-input-ignoredups. */
function addToHistory(input: string): void {
  if (/^\s*$/.test(input)) return;
  const s = state();
  if (!nil(ember.variable("comint-input-ignoredups")) && s.ring[0] === input) return;
  s.ring.unshift(input);
  const size = Number(ember.variable("comint-input-ring-size") ?? 500);
  if (s.ring.length > size) s.ring.length = size;
}

/** The input at point when it is before the process mark, as comint-get-old-input-default. */
function oldInput(): string {
  const bof = ember.fieldBeginning();
  if (nil(ember.charProperty(bof, "field"))) return ember.fieldStringNoProperties(bof);
  const field = ember.charProperty(bof, "field");
  ember.call("comint-bol");
  return ember.bufferSubstringNoProperties(ember.point(), field === Symbol.for("output") ? ember.lineEndPosition() : ember.fieldEnd());
}

/** Sends the input after the process mark, or the old input at point, to the process, as comint-send-input. */
export function sendInput(noNewline = false, artificial = false): void {
  const proc = bufferProcess();
  ember.widen();
  const pmark = processMark(proc);
  let input: string;
  if (ember.point() >= pmark) {
    if (!nil(ember.variable("comint-eol-on-send"))) ember.gotoChar(ember.fieldEnd());
    input = ember.bufferSubstringNoProperties(pmark, ember.point());
  } else {
    input = oldInput();
    ember.gotoChar(pmark);
    ember.insert(input);
  }
  ember.letBind({ "inhibit-read-only": true }, () => {
    ember.deleteRegion(pmark, ember.point());
    ember.insert(input);
  });
  if (!noNewline) ember.insert("\n");
  addToHistory(input);
  const s = state();
  s.index = undefined;
  s.stored = undefined;
  const text = noNewline ? input : `${input}\n`;
  ember.runHooks("comint-input-filter-functions", text);
  const end = noNewline ? ember.point() : ember.point() - 1;
  if (end > pmark) ember.addFaceTextProperty(pmark, end, "comint-highlight-input");
  if (!noNewline) {
    // The newline separates the input from the output after it.
    ember.putTextProperty(end, end + 1, "rear-nonsticky", PROMPT_REAR_NONSTICKY);
    ember.putTextProperty(end, end + 1, "field", Symbol.for("boundary"));
  }
  ember.setMarker(s.lastInputStart, pmark);
  ember.setMarker(s.lastInputEnd, ember.point());
  ember.setMarker(ember.processMark(proc)!, ember.point());
  ember.processSendString(proc, text);
  if (!artificial && !nil(ember.variable("comint-process-echoes"))) ember.setVariable("comint--echo-pending", text);
}

ember.defineVariable({ name: "comint--echo-pending", doc: "Input the program will echo, to take out of its output.", value: null, local: true });

/** Takes the echo of the input sent out of the output, as comint-process-echoes asks. */
const dropEcho = ember.defun("comint--drop-echo", (text: string) => {
  const pending = ember.variable("comint--echo-pending");
  if (typeof pending !== "string") return text;
  ember.setVariable("comint--echo-pending", null);
  return text.startsWith(pending) ? text.slice(pending.length) : text.replace(pending.replace(/\n$/, "\r\n"), "");
});

/** Starts a program in a buffer, on a terminal, with its output going through comint, as comint-exec. */
export function comintExec(buffer: string, name: string, command: string[], startfile?: string): string {
  const old = ember.getBufferProcess(buffer);
  if (old !== undefined) ember.deleteProcess(old);
  const directory = ember.withCurrentBuffer(buffer, () => ember.expandFileName("."));
  const width = ember.windowList().find((w) => ember.windowBuffer(w) === buffer);
  const size = width === undefined ? undefined : ember.windowSize(width);
  const proc = ember.makeProcess({
    name,
    buffer,
    command,
    directory,
    connectionType: "pty",
    env: {
      TERM: String(ember.variable("comint-terminfo-terminal") ?? "dumb"),
      INSIDE_EMACS: "ember,comint",
      ...(size ? { COLUMNS: String(size.width) } : {}),
    },
    filter: (p, text) => outputFilter(p, text),
  });
  if (size) ember.setProcessWindowSize(proc, size.height, size.width);
  ember.withCurrentBuffer(buffer, () => {
    ember.gotoChar(ember.pointMax());
    ember.setMarker(ember.processMark(proc)!, ember.pointMax());
    if (startfile !== undefined) ember.processSendString(proc, ember.readTextFile(startfile) ?? "");
  });
  return proc;
}

/**
 * Makes `buffer` a comint buffer running `program`, unless one already
 * runs there, as make-comint-in-buffer, and returns the buffer.
 */
export function makeComintInBuffer(name: string, buffer: string | undefined, program: string, startfile?: string, ...args: string[]): string {
  const b = buffer ?? `*${name}*`;
  ember.getBufferCreate(b);
  const running = ember.getBufferProcess(b);
  if (running === undefined || !ember.processLiveP(running)) {
    ember.withCurrentBuffer(b, () => {
      if (ember.variable("major-mode") !== "comint-mode" && !derivedFromComint()) ember.call("comint-mode");
    });
    comintExec(b, name, [program, ...args], startfile);
  }
  return b;
}

/** Whether the current buffer's mode derives from comint-mode. */
function derivedFromComint(): boolean {
  return ember.derivedModeP("comint-mode");
}

ember.defineMajorMode({
  name: "comint-mode",
  modeName: "Comint",
  doc:
    "The major mode for interacting with a program on a terminal: what you type after its prompt goes to it with RET.\n\n" +
    "M-p and M-n go through the inputs sent before, C-c C-c interrupts the job running, C-c C-d sends end of file, " +
    "and C-c C-o deletes the last output.",
  bindings: {
    RET: "comint-send-input",
    "C-d": "comint-delchar-or-maybe-eof",
    "M-p": "comint-previous-input",
    "M-n": "comint-next-input",
    "M-r": "comint-history-isearch-backward-regexp",
    "C-c M-r": "comint-previous-matching-input-from-input",
    "C-c M-s": "comint-next-matching-input-from-input",
    "C-<up>": "comint-previous-input",
    "C-<down>": "comint-next-input",
    "C-c C-a": "comint-bol-or-process-mark",
    "C-c C-u": "comint-kill-input",
    "C-c C-w": "backward-kill-word",
    "C-c C-c": "comint-interrupt-subjob",
    "C-c C-z": "comint-stop-subjob",
    "C-c C-\\": "comint-quit-subjob",
    "C-c C-m": "comint-copy-old-input",
    "C-c C-o": "comint-delete-output",
    "C-c M-o": "comint-clear-buffer",
    "C-c C-r": "comint-show-output",
    "C-c C-e": "comint-show-maximum-output",
    "C-c C-n": "comint-next-prompt",
    "C-c C-p": "comint-previous-prompt",
    "C-c C-d": "comint-send-eof",
  } as Record<string, ember.CommandName>,
  setup: () => {
    state();
    ember.addHook("isearch-mode-hook", historyIsearchSetup, { local: true });
    ember.setVariable("comint-preoutput-filter-functions", [dropEcho]);
    ember.setVariable("scroll-conservatively", 101);
  },
});

ember.defineFace({ name: "comint-highlight-prompt", doc: "The prompt in a comint buffer.", attributes: { inherit: "minibuffer-prompt" } });
ember.defineFace({ name: "comint-highlight-input", doc: "Input sent in a comint buffer.", attributes: { bold: true } });

ember.defineCommand({
  name: "comint-send-input",
  doc: "Send the input after the prompt to the program, with a newline; before the prompt, send the old input at point again.",
  run: () => sendInput(),
});

ember.defineCommand({
  name: "comint-send-eof",
  doc: "Send what is typed, without a newline, then end of file, as C-d does at a terminal.",
  run: () => {
    sendInput(true, true);
    ember.processSendEof(bufferProcess());
  },
});

ember.defineCommand({
  name: "comint-delchar-or-maybe-eof",
  doc: "Delete the next character, or send end of file at the end of the buffer with nothing typed.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const proc = ember.getBufferProcess(ember.bufferName());
    if (ember.point() === ember.pointMax() && proc !== undefined && ember.point() === processMark(proc)) ember.call("comint-send-eof");
    else ember.call("delete-char", arg);
  },
});

/** Replaces what is typed after the process mark with `text`. */
function replaceInput(text: string): void {
  const pmark = processMark(bufferProcess());
  ember.letBind({ "inhibit-read-only": true }, () => {
    ember.deleteRegion(pmark, ember.pointMax());
    ember.gotoChar(pmark);
    ember.insert(text);
  });
}

/** Whether point is at the command line, after the process mark. */
const afterPmark = (): boolean => processMark(bufferProcess()) <= ember.point();

/** The count to search with, as comint-search-arg: 0 starts again from the newest. */
function searchArg(arg: number): number {
  const s = state();
  if (!afterPmark()) ember.userError("Not at command line");
  if (s.ring.length === 0) ember.userError("Empty input ring");
  if (arg === 0) {
    s.index = undefined;
    return 1;
  }
  return arg;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * The index of the input matching `regexp` `arg` places along the history
 * from where M-p and M-n are, as comint-previous-matching-input-string-position:
 * back for a positive `arg`, forward for a negative one, round the ring.
 */
function matchingPosition(regexp: string, argIn: number): number | undefined {
  const s = state();
  const ring = s.ring;
  if (ring.length === 0) ember.userError("No history");
  const len = ring.length;
  let arg = argIn;
  const motion = arg > 0 ? 1 : -1;
  const start = s.index !== undefined ? mod(s.index + motion, len) : arg >= 0 ? 0 : len - 1;
  let n = mod(start - motion, len);
  let tried = false;
  const matches = (i: number) => ember.stringMatch(regexp, ring[i]!) !== undefined;
  while (arg !== 0 && !tried) {
    const prev = n;
    n = mod(n + motion, len);
    while (n < len && !tried && !matches(n)) {
      n = mod(n + motion, len);
      tried = n === prev;
    }
    arg += arg > 0 ? -1 : 1;
  }
  return matches(n) ? n : undefined;
}

/** Puts back what was typed before going through the history, as comint-restore-input. */
function restoreInput(): void {
  const s = state();
  if (s.index === undefined) return;
  replaceInput("");
  if ((s.stored ?? "") !== "") {
    replaceInput(s.stored!);
    ember.message("Input restored");
  }
  s.index = undefined;
}

/**
 * Puts the input matching `regexp` `n` places back in the history after
 * the prompt, forward if negative, as comint-previous-matching-input; with
 * `restore`, wrapping round puts back what was typed instead.
 */
function previousMatchingInput(regexp: string, nIn: number, restore = false): void {
  const n = searchArg(nIn);
  const s = state();
  const pos = matchingPosition(regexp, n);
  if (pos === undefined) ember.userError("Not found");
  if (s.index !== undefined && restore && ((n < 0 && s.index < pos) || (n > 0 && s.index > pos))) {
    restoreInput();
    return;
  }
  if (s.index === undefined) s.stored = ember.bufferSubstringNoProperties(processMark(bufferProcess()), ember.pointMax());
  s.index = pos;
  ember.message(`History item: ${pos + 1}`);
  replaceInput(s.ring[pos]!);
}

/** Goes `arg` inputs back in the history, forward if negative, as comint-previous-input. */
function previousInput(arg: number): void {
  const s = state();
  if (
    s.index !== undefined &&
    ((arg < 0 && s.index === 0) || (arg > 0 && s.index === s.ring.length - 1)) &&
    s.stored !== undefined
  ) {
    restoreInput();
  } else {
    previousMatchingInput(".", arg);
  }
}

/** Reads a regexp to search the history for, as comint-regexp-arg: empty means the last one. */
async function regexpArg(prompt: string): Promise<string> {
  const regexp = await ember.readString(prompt, { history: "minibuffer-history-search-history" });
  if (regexp !== "") return regexp;
  const history = ember.variable("minibuffer-history-search-history");
  return Array.isArray(history) && typeof history[0] === "string" ? history[0] : regexp;
}

ember.defineCommand({
  name: "comint-previous-matching-input",
  doc: "Put the last input matching a regexp after the prompt; with a prefix argument, the Nth last, or the Nth next if negative.",
  params: [{ name: "n", kind: "count" }],
  run: async (n: number) => previousMatchingInput(await regexpArg("Previous input matching (regexp): "), n),
});

ember.defineCommand({
  name: "comint-next-matching-input",
  doc: "Put the next input matching a regexp after the prompt; with a prefix argument, the Nth next, or the Nth last if negative.",
  params: [{ name: "n", kind: "count" }],
  run: async (n: number) => previousMatchingInput(await regexpArg("Next input matching (regexp): "), -n),
});

/** Goes `n` inputs back through those starting with what is typed before point, as comint-previous-matching-input-from-input. */
function matchingInputFromInput(n: number): void {
  const s = state();
  const opoint = ember.point();
  const last = ember.lastCommand();
  if (last !== "comint-previous-matching-input-from-input" && last !== "comint-next-matching-input-from-input") {
    s.matching = ember.bufferSubstringNoProperties(processMark(bufferProcess()), ember.point());
    s.index = undefined;
  }
  previousMatchingInput(`^${regexpQuote(s.matching)}`, n, true);
  if (ember.variable("comint-move-point-for-matching-input") === "after-input") ember.gotoChar(opoint);
}

ember.defineCommand({
  name: "comint-previous-matching-input-from-input",
  doc: "Put the last input that starts with what is typed before point after the prompt; again, the one before.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => matchingInputFromInput(n),
});

ember.defineCommand({
  name: "comint-next-matching-input-from-input",
  doc: "Put the next input that starts with what is typed before point after the prompt; again, the one after.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => matchingInputFromInput(-n),
});

/** Runs `f` in a buffer of its own, killed afterwards, as with-temp-buffer. */
function withTempBuffer<T>(f: () => T): T {
  const name = ember.generateNewBufferName(" *temp*");
  ember.getBufferCreate(name);
  try {
    return ember.withCurrentBuffer(name, f);
  } finally {
    ember.call("kill-buffer", name);
  }
}

/**
 * Reads the buffer's history from comint-input-ring-file-name, newest last
 * in the file, as comint-read-input-ring: entries are split by
 * comint-input-ring-separator, and those matching comint-input-history-ignore
 * are left out. With `silent`, says nothing if the file cannot be read.
 */
export function readInputRing(silent = false): void {
  const file = ember.variable("comint-input-ring-file-name");
  if (typeof file !== "string" || file === "") return;
  if (!ember.fileReadableP(ember.expandFileName(file))) {
    if (!silent) ember.message(`Cannot read history file ${file}`);
    return;
  }
  const size = Number(ember.variable("comint-input-ring-size") ?? 500);
  const separator = String(ember.variable("comint-input-ring-separator") ?? "\n");
  const prefix = ember.variable("comint-input-ring-file-prefix");
  const ignore = String(ember.variable("comint-input-history-ignore") ?? "^#");
  const ignoredups = !nil(ember.variable("comint-input-ignoredups"));
  const ring: string[] = [];
  withTempBuffer(() => {
    ember.insertFileContents(ember.expandFileName(file));
    ember.gotoChar(ember.pointMax());
    while (ring.length < size && ember.reSearchBackward(separator, { noerror: true }) !== undefined) {
      const end = ember.matchBeginning(0)!;
      ember.gotoChar(ember.reSearchBackward(separator, { noerror: true }) !== undefined ? ember.matchEnd(0)! : ember.pointMin());
      if (typeof prefix === "string" && prefix !== "" && ember.lookingAt(prefix)) ember.gotoChar(ember.matchEnd(0)!);
      const history = ember.bufferSubstringNoProperties(ember.point(), end);
      if (ember.stringMatch(ignore, history) === undefined && (!ignoredups || ring.length === 0 || ring[0] !== history)) ring.push(history);
    }
  });
  const s = state();
  s.ring = ring;
  s.index = undefined;
}
ember.defun("comint-read-input-ring", (silent?: boolean) => readInputRing(Boolean(silent)));

/** Writes the buffer's history to comint-input-ring-file-name, oldest first, as comint-write-input-ring. */
export function writeInputRing(): void {
  const file = ember.variable("comint-input-ring-file-name");
  const s = state();
  if (typeof file !== "string" || file === "" || s.ring.length === 0) return;
  const path = ember.expandFileName(file);
  if (!ember.fileWritableP(path)) {
    ember.message(`Cannot write history file ${file}`);
    return;
  }
  const separator = String(ember.variable("comint-input-ring-separator") ?? "\n");
  ember.writeTextFile(path, [...s.ring].reverse().map((input) => input + separator).join(""));
}
ember.defun("comint-write-input-ring", () => writeInputRing());

// Isearch in the input history, as comint.el's: M-r searches back through
// the inputs sent before for a regexp, each match put after the prompt in
// turn, the prompt showing the search's own.

ember.defineVariable({
  name: "comint-history-isearch",
  doc: "Whether C-r and C-M-r search the input history rather than the buffer: t always, dwim when the search starts at the command line, nil never. M-r searches the history whatever it says.",
  value: false,
});

/** Where the input on point's line starts, after the prompt, as comint-line-beginning-position. */
const lineBeginningPosition = (): number => ember.constrainToField(ember.lineBeginningPosition(), ember.lineEndPosition());

/** The start of the line the prompt is on. */
const promptLineStart = (): number => ember.lineBeginningPosition(lineBeginningPosition());

/** The overlay that shows the search's prompt over the program's, as comint-history-isearch-message-overlay. */
const messageOverlays = new Map<string, number>();

/** Puts the input `pos` places back in the history after the prompt, or what was typed for undefined, as comint-goto-input. */
function gotoInput(pos: number | undefined): void {
  const s = state();
  if (s.index === undefined) s.stored = oldInput();
  s.index = pos;
  if (pos !== undefined && s.ring.length > 0) replaceInput(s.ring[pos]!);
  else replaceInput(s.stored ?? "");
}

/** The function isearch searches the history with, as comint-history-isearch-search gives. */
function historyIsearchSearch(): (string: string, bound?: ember.Value, noerror?: ember.Value) => number | undefined {
  return (string, bound, noerror) => {
    const searchFun = isearchSearchFunDefault();
    const forward = ember.variable("isearch-forward") === true;
    const s = state();
    // Lazy highlighting searches with a bound: not in the prompt or the output.
    if (typeof bound === "number" && forward && !afterPmark()) ember.gotoChar(processMark(bufferProcess()));
    const here = searchFun(string, forward ? bound : lineBeginningPosition(), noerror);
    if (here !== undefined) return here;
    if (typeof bound === "number") return undefined;
    // Then put the inputs before or after this one in, one by one, and search each.
    return ember.conditionCase(
      () => {
        for (;;) {
          if (forward) {
            if (s.index === undefined) ember.signal("error", "End of history; no next item");
            previousInput(-1);
            ember.gotoChar(lineBeginningPosition());
          } else {
            if (s.index === s.ring.length - 1) ember.signal("error", "Beginning of history; no preceding item");
            previousInput(1);
            ember.gotoChar(ember.pointMax());
          }
          ember.setVariable("isearch-barrier", ember.point());
          ember.setVariable("isearch-opoint", ember.point());
          const found = searchFun(string, forward ? undefined : lineBeginningPosition(), noerror);
          if (found !== undefined) return ember.point();
        }
      },
      { error: () => undefined },
    );
  };
}

/** Shows the search's prompt over the program's while the search succeeds, as comint-history-isearch-message. */
function historyIsearchMessage(cqHack?: ember.Value, ellipsis?: ember.Value): void {
  if (ember.variable("isearch-success") !== true || truthyValue(ember.variable("isearch-error"))) {
    isearchMessage(truthyValue(cqHack), truthyValue(ellipsis));
    return;
  }
  const buffer = ember.bufferName();
  const start = promptLineStart();
  const end = lineBeginningPosition();
  let o = messageOverlays.get(buffer);
  if (o !== undefined && ember.overlayStart(o) !== undefined) ember.moveOverlay(o, start, end);
  else {
    o = ember.makeOverlay(start, end);
    ember.overlayPut(o, "evaporate", true);
    messageOverlays.set(buffer, o);
  }
  ember.overlayPut(o, "display", isearchMessagePrefix(truthyValue(ellipsis)));
  const index = state().index;
  if (index !== undefined && !truthyValue(ellipsis)) ember.message(`History item: ${index + 1}`);
  else ember.message("");
}

/** Wraps a failing search round to the newest input or the oldest, as comint-history-isearch-wrap. */
function historyIsearchWrap(): void {
  const forward = ember.variable("isearch-forward") === true;
  if (forward) gotoInput(state().ring.length - 1);
  else gotoInput(undefined);
  ember.gotoChar(forward ? lineBeginningPosition() : ember.pointMax());
}

/** Keeps where the search is in the history with each of its states, as comint-history-isearch-push-state. */
function historyIsearchPushState(): (cmd: ember.Value) => void {
  const index = state().index;
  return () => gotoInput(index);
}

const truthyValue = (v: ember.Value | undefined) => v !== undefined && v !== null && v !== false;

const searchVariables: [string, ember.Value][] = [
  ["isearch-search-fun-function", historyIsearchSearch as unknown as ember.Value],
  ["isearch-message-function", historyIsearchMessage as unknown as ember.Value],
  ["isearch-wrap-function", historyIsearchWrap as unknown as ember.Value],
  ["isearch-push-state-function", historyIsearchPushState as unknown as ember.Value],
];

/** Makes a search that starts here search the history, as comint-history-isearch-setup on isearch-mode-hook. */
function historyIsearchSetup(): void {
  const how = ember.variable("comint-history-isearch");
  const proc = ember.getBufferProcess(ember.bufferName());
  if (proc === undefined) return;
  // Not where the prompt is empty, as in a finished shell's buffer.
  if (promptLineStart() === lineBeginningPosition()) return;
  if (!(how === true || (how === "dwim" && afterPmark()))) return;
  ember.setVariable("isearch-message-prefix-add", "history ");
  for (const [name, value] of searchVariables) {
    ember.makeLocalVariable(name);
    ember.setVariable(name, value);
  }
  ember.makeLocalVariable("isearch-lazy-count");
  ember.setVariable("isearch-lazy-count", false);
  ember.addHook("isearch-mode-end-hook", historyIsearchEnd, { local: true });
}

/** What comint-history-isearch was before M-r set it, put back as the search ends, as custom-reevaluate-setting does. */
let savedHowToSearch: ember.Value | undefined;

/** Puts the search back as it was, as comint-history-isearch-end on isearch-mode-end-hook. */
function historyIsearchEnd(): void {
  const o = messageOverlays.get(ember.bufferName());
  if (o !== undefined) ember.deleteOverlay(o);
  messageOverlays.delete(ember.bufferName());
  ember.setVariable("isearch-message-prefix-add", null);
  for (const [name] of searchVariables) ember.killLocalVariable(name);
  ember.killLocalVariable("isearch-lazy-count");
  // So the search leaves no mark behind.
  ember.setVariable("isearch-opoint", ember.point());
  ember.removeHook("isearch-mode-end-hook", historyIsearchEnd, { local: true });
  if (ember.variable("isearch-suspended") !== true && savedHowToSearch !== undefined) {
    ember.setVariable("comint-history-isearch", savedHowToSearch);
    savedHowToSearch = undefined;
  }
}

ember.defineCommand({
  name: "comint-history-isearch-backward",
  doc: "Search back through the input history for a string, incrementally: each match is put after the prompt.",
  run: () => {
    savedHowToSearch ??= ember.variable("comint-history-isearch") ?? false;
    ember.setVariable("comint-history-isearch", true);
    ember.call("isearch-backward");
  },
});

ember.defineCommand({
  name: "comint-history-isearch-backward-regexp",
  doc: "Search back through the input history for a regular expression, incrementally: each match is put after the prompt.",
  run: () => {
    savedHowToSearch ??= ember.variable("comint-history-isearch") ?? false;
    ember.setVariable("comint-history-isearch", true);
    ember.call("isearch-backward-regexp");
  },
});

ember.defineCommand({
  name: "comint-previous-input",
  doc: "Put the input sent before this one after the prompt, or as many back as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => previousInput(arg),
});

ember.defineCommand({
  name: "comint-next-input",
  doc: "Put the input sent after this one after the prompt, or as many on as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => previousInput(-arg),
});

ember.defineCommand({
  name: "comint-bol",
  doc: "Go to the start of the line, after the prompt if there is one.",
  run: () => {
    ember.gotoChar(ember.lineBeginningPosition());
    ember.gotoChar(ember.constrainToField(ember.point(), ember.lineEndPosition()));
  },
});

ember.defineCommand({
  name: "comint-bol-or-process-mark",
  doc: "Go to the start of the input on this line; again, to the process mark.",
  run: () => {
    if (ember.lastCommand() === "comint-bol-or-process-mark") ember.gotoChar(processMark(bufferProcess()));
    else ember.call("comint-bol");
  },
});

ember.defineCommand({
  name: "comint-kill-input",
  doc: "Kill what is typed after the prompt, up to point.",
  run: () => {
    const pmark = processMark(bufferProcess());
    if (ember.point() > pmark) ember.killRegion(pmark, ember.point());
  },
});

ember.defineCommand({
  name: "comint-copy-old-input",
  doc: "Copy the input at point to after the prompt, to send again.",
  run: () => {
    const input = oldInput();
    ember.gotoChar(processMark(bufferProcess()));
    ember.insert(input);
  },
});

/** Throws away what is typed but not sent, as comint-skip-input before a signal. */
function skipInput(): void {
  const proc = bufferProcess();
  const pmark = processMark(proc);
  ember.gotoChar(ember.pointMax());
  if (ember.point() > pmark) {
    ember.insert("  ");
    ember.setMarker(ember.processMark(proc)!, ember.point());
  }
}

for (const [name, doc, signal] of [
  ["comint-interrupt-subjob", "Interrupt the job running in the program, as C-c does at a terminal.", "INT"],
  ["comint-stop-subjob", "Stop the job running in the program, as C-z does at a terminal.", "TSTP"],
  ["comint-quit-subjob", "Send a quit signal to the job running in the program, as C-\\ does at a terminal.", "QUIT"],
] as const) {
  ember.defineCommand({
    name,
    doc,
    run: () => {
      if (signal === "INT") skipInput();
      const proc = bufferProcess();
      const fn = { INT: ember.interruptProcess, TSTP: ember.stopProcess, QUIT: ember.quitProcess }[signal];
      fn(proc, ember.processTtyName(proc) !== undefined);
    },
  });
}

ember.defineCommand({
  name: "comint-delete-output",
  doc: "Delete the output of the last input, leaving the prompt; with a prefix argument, kill it.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill: ember.PrefixArg) => {
    const proc = bufferProcess();
    const s = state();
    ember.letBind({ "inhibit-read-only": true }, () =>
      ember.saveExcursion(() => {
        const pmark = ember.lineBeginningPosition(processMark(proc));
        const from = ember.markerPosition(s.lastInputEnd)!;
        if (kill !== null) ember.killNew(ember.bufferSubstringNoProperties(from, pmark));
        const prompt = ember.bufferSubstringNoProperties(pmark, processMark(proc));
        ember.deleteRegion(from, processMark(proc));
        ember.gotoChar(from);
        ember.setMarker(ember.processMark(proc)!, from);
        outputFilter(proc, `*** output flushed ***\n${prompt}`);
      }),
    );
  },
});

ember.defineCommand({
  name: "comint-clear-buffer",
  doc: "Delete everything before the last prompt.",
  run: () => {
    const proc = bufferProcess();
    ember.letBind({ "inhibit-read-only": true }, () => {
      const start = ember.lineBeginningPosition(processMark(proc));
      ember.deleteRegion(ember.pointMin(), start);
    });
  },
});

ember.defineCommand({
  name: "comint-show-output",
  doc: "Put the start of the last output at the top of the window, with point at the input before it.",
  run: () => {
    const s = state();
    ember.gotoChar(ember.markerPosition(s.lastInputStart)!);
    ember.callWithPrefix(0, "recenter");
    ember.gotoChar(ember.lineBeginningPosition(ember.markerPosition(s.lastInputStart)!));
  },
});

ember.defineCommand({
  name: "comint-show-maximum-output",
  doc: "Go to the end of the buffer, showing as much output as fits.",
  run: () => {
    ember.gotoChar(ember.pointMax());
    ember.callWithPrefix(-1, "recenter");
  },
});

/** Goes to the start of the nth next input field, back if negative, as comint-next-prompt. */
function nextPrompt(nIn: number): void {
  let n = nIn;
  let pos = ember.point();
  let inputPos: number | undefined;
  while (n !== 0) {
    const prev = pos;
    pos = n > 0 ? ember.nextSingleCharPropertyChange(pos, "field") : ember.previousSingleCharPropertyChange(pos, "field");
    if (pos === prev) {
      if (n > 0) inputPos = ember.pointMax();
      n = 0;
    } else if (nil(ember.charProperty(pos, "field"))) {
      n += n < 0 ? 1 : -1;
      inputPos = pos;
    }
  }
  if (inputPos !== undefined) ember.gotoChar(inputPos);
}

ember.defineCommand({
  name: "comint-next-prompt",
  doc: "Go to the input after the next prompt, or as many on as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => nextPrompt(n),
});

ember.defineCommand({
  name: "comint-previous-prompt",
  doc: "Go to the input after the previous prompt, or as many back as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => nextPrompt(-n),
});

// Keep the history-forgetting hook from treating killed buffers' state as live.
ember.addHook("kill-buffer-hook", () => {
  states.delete(ember.bufferName());
});

/**
 * Reads a line without showing it and sends it to the buffer's process, as
 * comint-send-invisible: for passwords, which then go in no history.
 */
export async function sendInvisible(prompt = "Non-echoed text: "): Promise<void> {
  const buffer = ember.bufferName();
  const proc = ember.getBufferProcess(buffer);
  if (proc === undefined) throw new Error(`Buffer ${buffer} has no process`);
  const prefix = ember.windowBuffer() === buffer ? "" : `(In buffer ${buffer}) `;
  const str = await readPasswd(prefix + prompt);
  if (ember.processLiveP(proc)) ember.processSendString(proc, `${str}\n`);
}

ember.defineCommand({
  name: "comint-send-invisible",
  doc: "Read a line without showing it, as a password, and send it to the buffer's process.",
  run: () => sendInvisible(),
});

/** How deep password prompts have nested, so a program that keeps asking cannot recurse without end. */
let promptDepth = 0;

/**
 * Reads a password when the program's output ends in a prompt for one, as
 * comint-watch-for-password-prompt, the last of comint-output-filter-functions.
 */
export const watchForPasswordPrompt = (string: string): void => {
  const regexp = ember.variable("comint-password-prompt-regexp");
  if (typeof regexp !== "string" || ember.stringMatch(regexp, string.replaceAll("\r", ""), { caseFold: true }) === undefined) return;
  if (promptDepth >= 10) {
    ember.message("Password prompt recursion too deep");
    return;
  }
  if (ember.getBufferProcess(ember.bufferName()) === undefined) return;
  const prompt = string.replace(/^[ \n\r\t\v\f\b\x07]+/, "").replace(/\n+$/, "");
  promptDepth++;
  sendInvisible(prompt).finally(() => promptDepth--);
};
ember.addHook("comint-output-filter-functions", watchForPasswordPrompt);
