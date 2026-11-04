import { applyOnRegion } from "ansi-color";
import { PerBuffer, readPasswd, regexpQuote } from "subr";
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
  gnista.defineVariable({ name, doc, value: value as gnista.Value, local });
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
  lastInputStart: gnista.Marker;
  lastInputEnd: gnista.Marker;
  lastOutputStart: gnista.Marker;
}

const states = new PerBuffer<State>();

function state(buffer = gnista.bufferName()): State {
  let s = states.get(buffer);
  if (s === undefined) {
    s = {
      ring: [],
      index: undefined,
      stored: undefined,
      matching: "",
      lastInputStart: gnista.makeMarker(gnista.pointMax()),
      lastInputEnd: gnista.makeMarker(gnista.pointMax()),
      lastOutputStart: gnista.makeMarker(gnista.pointMax()),
    };
    states.set(buffer, s);
  }
  return s;
}

const nil = (v: unknown) => v === null || v === undefined || v === false;

/** The current buffer's process, or the error comint gives without one. */
function bufferProcess(): string {
  const p = gnista.getBufferProcess(gnista.bufferName());
  if (p === undefined) throw new Error("Current buffer has no process");
  return p;
}

const processMark = (p: string): number => gnista.markerPosition(gnista.processMark(p)!)!;

const PROMPT_REAR_NONSTICKY = ["field", "inhibit-line-move-field-capture", "read-only", "font-lock-face", "insert-in-front-hooks"];

/** Marks text as the program's output, the `output` field, as comint--mark-as-output. */
function markAsOutput(beg: number, end: number): void {
  if (beg >= end) return;
  gnista.withSilentModifications(() => {
    for (const [name, value] of [
      ["field", Symbol.for("output")],
      ["inhibit-line-move-field-capture", true],
      ["rear-nonsticky", PROMPT_REAR_NONSTICKY],
      ["front-sticky", ["field", "inhibit-line-move-field-capture"]],
    ] as const) {
      gnista.putTextProperty(beg, end, name, value as gnista.Value);
    }
  });
}

/**
 * Carriage returns delete back to the start of the line and backspaces the
 * character before, CR LF becoming LF, as a terminal shows them, in
 * output from start to end, as comint-carriage-motion.
 */
function carriageMotion(start: number, end: number): void {
  const text = gnista.bufferText(start, end);
  if (!/[\r\b]/.test(text)) return;
  gnista.letBind({ "inhibit-read-only": true, "inhibit-field-text-motion": true }, () => {
    const endMarker = gnista.makeMarker(end);
    let lbeg = gnista.lineBeginningPosition(start);
    let p = start;
    while (p < gnista.markerPosition(endMarker)!) {
      const c = gnista.bufferText(p, p + 1);
      if (c === "\b") {
        gnista.deleteRegion(p, p + 1);
        if (p > lbeg) {
          gnista.deleteRegion(p - 1, p);
          p--;
        }
      } else if (c === "\n") {
        p++;
        lbeg = p;
      } else if (c === "\r") {
        gnista.deleteRegion(p, p + 1);
        // CR LF is a line's end; a CR alone goes back to the line's start.
        if (gnista.bufferText(p, p + 1) !== "\n") {
          gnista.deleteRegion(lbeg, p);
          p = lbeg;
        }
      } else {
        p++;
      }
    }
    gnista.deleteMarker(endMarker);
  });
}

/** Moves the windows showing a buffer whose point is at `at` to `to`, as window-point-insertion-type t does. */
function advanceWindowPoints(buffer: string, at: number, to: number): void {
  for (const w of gnista.windowList()) {
    if (gnista.windowBuffer(w) === buffer && gnista.windowPoint(w) === at && w !== gnista.selectedWindow()) gnista.setWindowPoint(w, to);
  }
}

/**
 * Puts a process's output into its buffer at its mark, as comint-output-filter:
 * through comint-preoutput-filter-functions, marked as output, with carriage
 * motion done, then comint-output-filter-functions run, and the last line
 * left as the prompt.
 */
export function outputFilter(process: string, text: string): void {
  const buffer = gnista.processBuffer(process);
  if (buffer === undefined || !gnista.bufferLiveP(gnista.getBuffer(buffer))) return;
  gnista.withCurrentBuffer(buffer, () => {
    let string: string | undefined = text;
    for (const f of (gnista.variable("comint-preoutput-filter-functions") ?? []) as gnista.Value[]) {
      if (string === undefined) break;
      const result = gnista.funcall(f as string, string);
      string = typeof result === "string" ? result : undefined;
    }
    if (string === undefined || string === "") return;
    const s = state();
    gnista.letBind({ "inhibit-read-only": true }, () =>
      gnista.saveRestriction(() => {
        gnista.widen();
        const mark = processMark(process);
        const pointAtMark = gnista.point() === mark;
        const saved = gnista.makeMarker(gnista.point(), { advances: true });
        gnista.setMarker(s.lastOutputStart, mark);
        gnista.gotoChar(mark);
        gnista.insert(string!);
        gnista.setMarker(gnista.processMark(process)!, gnista.point());
        carriageMotion(gnista.markerPosition(s.lastOutputStart)!, gnista.point());
        gnista.setMarker(gnista.processMark(process)!, gnista.point());
        // ANSI colours, as ansi-color-process-output does first among comint-output-filter-functions.
        const ansi = gnista.variable("ansi-color-for-comint-mode");
        if (ansi === true || ansi === "filter") {
          applyOnRegion(gnista.markerPosition(s.lastOutputStart)!, processMark(process), ansi === "filter");
          gnista.gotoChar(processMark(process));
        }
        const end = gnista.point();
        gnista.gotoChar(pointAtMark ? end : gnista.markerPosition(saved)!);
        gnista.runHooks("comint-output-filter-functions", string!);
        markAsOutput(gnista.markerPosition(s.lastOutputStart)!, processMark(process));
        // The prompt: the output on the last line, with no newline after it.
        const promptStart = gnista.lineBeginningPosition(processMark(process));
        gnista.withSilentModifications(() => {
          if (!nil(gnista.variable("comint-prompt-read-only")) && promptStart < processMark(process)) {
            gnista.putTextProperty(promptStart, processMark(process), "read-only", true);
            gnista.putTextProperty(promptStart, processMark(process), "front-sticky", ["read-only"]);
          }
          if (promptStart < processMark(process)) gnista.addFaceTextProperty(promptStart, processMark(process), "comint-highlight-prompt");
        });
        advanceWindowPoints(buffer, mark, processMark(process));
        gnista.deleteMarker(saved);
      }),
    );
  });
}

/** Adds an input to the history unless it is only spaces, or the same as the last with comint-input-ignoredups. */
function addToHistory(input: string): void {
  if (/^\s*$/.test(input)) return;
  const s = state();
  if (!nil(gnista.variable("comint-input-ignoredups")) && s.ring[0] === input) return;
  s.ring.unshift(input);
  const size = Number(gnista.variable("comint-input-ring-size") ?? 500);
  if (s.ring.length > size) s.ring.length = size;
}

/** The input at point when it is before the process mark, as comint-get-old-input-default. */
function oldInput(): string {
  const bof = gnista.fieldBeginning();
  if (nil(gnista.charProperty(bof, "field"))) return gnista.fieldStringNoProperties(bof);
  const field = gnista.charProperty(bof, "field");
  gnista.call("comint-bol");
  return gnista.bufferSubstringNoProperties(gnista.point(), field === Symbol.for("output") ? gnista.lineEndPosition() : gnista.fieldEnd());
}

/** Sends the input after the process mark, or the old input at point, to the process, as comint-send-input. */
export function sendInput(noNewline = false, artificial = false): void {
  const proc = bufferProcess();
  gnista.widen();
  const pmark = processMark(proc);
  let input: string;
  if (gnista.point() >= pmark) {
    if (!nil(gnista.variable("comint-eol-on-send"))) gnista.gotoChar(gnista.fieldEnd());
    input = gnista.bufferSubstringNoProperties(pmark, gnista.point());
  } else {
    input = oldInput();
    gnista.gotoChar(pmark);
    gnista.insert(input);
  }
  gnista.letBind({ "inhibit-read-only": true }, () => {
    gnista.deleteRegion(pmark, gnista.point());
    gnista.insert(input);
  });
  if (!noNewline) gnista.insert("\n");
  addToHistory(input);
  const s = state();
  s.index = undefined;
  s.stored = undefined;
  const text = noNewline ? input : `${input}\n`;
  gnista.runHooks("comint-input-filter-functions", text);
  const end = noNewline ? gnista.point() : gnista.point() - 1;
  gnista.withSilentModifications(() => {
    if (end > pmark) gnista.addFaceTextProperty(pmark, end, "comint-highlight-input");
    if (!noNewline) {
      // The newline separates the input from the output after it.
      gnista.putTextProperty(end, end + 1, "rear-nonsticky", PROMPT_REAR_NONSTICKY);
      gnista.putTextProperty(end, end + 1, "field", Symbol.for("boundary"));
    }
  });
  gnista.setMarker(s.lastInputStart, pmark);
  gnista.setMarker(s.lastInputEnd, gnista.point());
  gnista.setMarker(gnista.processMark(proc)!, gnista.point());
  gnista.processSendString(proc, text);
  if (!artificial && !nil(gnista.variable("comint-process-echoes"))) gnista.setVariable("comint--echo-pending", text);
}

gnista.defineVariable({ name: "comint--echo-pending", doc: "Input the program will echo, to take out of its output.", value: null, local: true });

/** Takes the echo of the input sent out of the output, as comint-process-echoes asks. */
const dropEcho = gnista.defun("comint--drop-echo", (text: string) => {
  const pending = gnista.variable("comint--echo-pending");
  if (typeof pending !== "string") return text;
  gnista.setVariable("comint--echo-pending", null);
  return text.startsWith(pending) ? text.slice(pending.length) : text.replace(pending.replace(/\n$/, "\r\n"), "");
});

/** Starts a program in a buffer, on a terminal, with its output going through comint, as comint-exec. */
export function comintExec(buffer: string, name: string, command: string[], startfile?: string): string {
  const old = gnista.getBufferProcess(buffer);
  if (old !== undefined) gnista.deleteProcess(old);
  const directory = gnista.withCurrentBuffer(buffer, () => gnista.expandFileName("."));
  const width = gnista.windowList().find((w) => gnista.windowBuffer(w) === buffer);
  const size = width === undefined ? undefined : gnista.windowSize(width);
  const proc = gnista.makeProcess({
    name,
    buffer,
    command,
    directory,
    connectionType: "pty",
    env: {
      TERM: String(gnista.variable("comint-terminfo-terminal") ?? "dumb"),
      INSIDE_EMACS: "gnista,comint",
      ...(size ? { COLUMNS: String(size.width) } : {}),
    },
    filter: (p, text) => outputFilter(p, text),
  });
  if (size) gnista.setProcessWindowSize(proc, size.height, size.width);
  gnista.withCurrentBuffer(buffer, () => {
    gnista.gotoChar(gnista.pointMax());
    gnista.setMarker(gnista.processMark(proc)!, gnista.pointMax());
    if (startfile !== undefined) gnista.processSendString(proc, gnista.readTextFile(startfile) ?? "");
  });
  return proc;
}

/**
 * Makes `buffer` a comint buffer running `program`, unless one already
 * runs there, as make-comint-in-buffer, and returns the buffer.
 */
export function makeComintInBuffer(name: string, buffer: string | undefined, program: string, startfile?: string, ...args: string[]): string {
  const b = buffer ?? `*${name}*`;
  gnista.getBufferCreate(b);
  const running = gnista.getBufferProcess(b);
  if (running === undefined || !gnista.processLiveP(running)) {
    gnista.withCurrentBuffer(b, () => {
      if (gnista.variable("major-mode") !== "comint-mode" && !derivedFromComint()) gnista.call("comint-mode");
    });
    comintExec(b, name, [program, ...args], startfile);
  }
  return b;
}

/** Whether the current buffer's mode derives from comint-mode. */
function derivedFromComint(): boolean {
  return gnista.derivedModeP("comint-mode");
}

gnista.defineMajorMode({
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
  } as Record<string, gnista.CommandName>,
  setup: () => {
    state();
    gnista.addHook("isearch-mode-hook", historyIsearchSetup, { local: true });
    gnista.setVariable("comint-preoutput-filter-functions", [dropEcho]);
    gnista.setVariable("scroll-conservatively", 101);
  },
});

gnista.defineFace({ name: "comint-highlight-prompt", doc: "The prompt in a comint buffer.", attributes: { inherit: "minibuffer-prompt" } });
gnista.defineFace({ name: "comint-highlight-input", doc: "Input sent in a comint buffer.", attributes: { bold: true } });

gnista.defineCommand({
  name: "comint-send-input",
  doc: "Send the input after the prompt to the program, with a newline; before the prompt, send the old input at point again.",
  run: () => sendInput(),
});

gnista.defineCommand({
  name: "comint-send-eof",
  doc: "Send what is typed, without a newline, then end of file, as C-d does at a terminal.",
  run: () => {
    sendInput(true, true);
    gnista.processSendEof(bufferProcess());
  },
});

gnista.defineCommand({
  name: "comint-delchar-or-maybe-eof",
  doc: "Delete the next character, or send end of file at the end of the buffer with nothing typed.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const proc = gnista.getBufferProcess(gnista.bufferName());
    if (gnista.point() === gnista.pointMax() && proc !== undefined && gnista.point() === processMark(proc)) gnista.call("comint-send-eof");
    else gnista.call("delete-char", arg);
  },
});

/** Replaces what is typed after the process mark with `text`. */
function replaceInput(text: string): void {
  const pmark = processMark(bufferProcess());
  gnista.letBind({ "inhibit-read-only": true }, () => {
    gnista.deleteRegion(pmark, gnista.pointMax());
    gnista.gotoChar(pmark);
    gnista.insert(text);
  });
}

/** Whether point is at the command line, after the process mark. */
const afterPmark = (): boolean => processMark(bufferProcess()) <= gnista.point();

/** The count to search with, as comint-search-arg: 0 starts again from the newest. */
function searchArg(arg: number): number {
  const s = state();
  if (!afterPmark()) gnista.userError("Not at command line");
  if (s.ring.length === 0) gnista.userError("Empty input ring");
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
  if (ring.length === 0) gnista.userError("No history");
  const len = ring.length;
  let arg = argIn;
  const motion = arg > 0 ? 1 : -1;
  const start = s.index !== undefined ? mod(s.index + motion, len) : arg >= 0 ? 0 : len - 1;
  let n = mod(start - motion, len);
  let tried = false;
  const matches = (i: number) => gnista.stringMatch(regexp, ring[i]!) !== undefined;
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
    gnista.message("Input restored");
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
  if (pos === undefined) gnista.userError("Not found");
  if (s.index !== undefined && restore && ((n < 0 && s.index < pos) || (n > 0 && s.index > pos))) {
    restoreInput();
    return;
  }
  if (s.index === undefined) s.stored = gnista.bufferSubstringNoProperties(processMark(bufferProcess()), gnista.pointMax());
  s.index = pos;
  gnista.message(`History item: ${pos + 1}`);
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
  const regexp = await gnista.readString(prompt, { history: "minibuffer-history-search-history" });
  if (regexp !== "") return regexp;
  const history = gnista.variable("minibuffer-history-search-history");
  return Array.isArray(history) && typeof history[0] === "string" ? history[0] : regexp;
}

gnista.defineCommand({
  name: "comint-previous-matching-input",
  doc: "Put the last input matching a regexp after the prompt; with a prefix argument, the Nth last, or the Nth next if negative.",
  params: [{ name: "n", kind: "count" }],
  run: async (n: number) => previousMatchingInput(await regexpArg("Previous input matching (regexp): "), n),
});

gnista.defineCommand({
  name: "comint-next-matching-input",
  doc: "Put the next input matching a regexp after the prompt; with a prefix argument, the Nth next, or the Nth last if negative.",
  params: [{ name: "n", kind: "count" }],
  run: async (n: number) => previousMatchingInput(await regexpArg("Next input matching (regexp): "), -n),
});

/** Goes `n` inputs back through those starting with what is typed before point, as comint-previous-matching-input-from-input. */
function matchingInputFromInput(n: number): void {
  const s = state();
  const opoint = gnista.point();
  const last = gnista.lastCommand();
  if (last !== "comint-previous-matching-input-from-input" && last !== "comint-next-matching-input-from-input") {
    s.matching = gnista.bufferSubstringNoProperties(processMark(bufferProcess()), gnista.point());
    s.index = undefined;
  }
  previousMatchingInput(`^${regexpQuote(s.matching)}`, n, true);
  if (gnista.variable("comint-move-point-for-matching-input") === "after-input") gnista.gotoChar(opoint);
}

gnista.defineCommand({
  name: "comint-previous-matching-input-from-input",
  doc: "Put the last input that starts with what is typed before point after the prompt; again, the one before.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => matchingInputFromInput(n),
});

gnista.defineCommand({
  name: "comint-next-matching-input-from-input",
  doc: "Put the next input that starts with what is typed before point after the prompt; again, the one after.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => matchingInputFromInput(-n),
});

/** Runs `f` in a buffer of its own, killed afterwards, as with-temp-buffer. */
function withTempBuffer<T>(f: () => T): T {
  const name = gnista.generateNewBufferName(" *temp*");
  gnista.getBufferCreate(name);
  try {
    return gnista.withCurrentBuffer(name, f);
  } finally {
    gnista.call("kill-buffer", name);
  }
}

/**
 * Reads the buffer's history from comint-input-ring-file-name, newest last
 * in the file, as comint-read-input-ring: entries are split by
 * comint-input-ring-separator, and those matching comint-input-history-ignore
 * are left out. With `silent`, says nothing if the file cannot be read.
 */
export function readInputRing(silent = false): void {
  const file = gnista.variable("comint-input-ring-file-name");
  if (typeof file !== "string" || file === "") return;
  if (!gnista.fileReadableP(gnista.expandFileName(file))) {
    if (!silent) gnista.message(`Cannot read history file ${file}`);
    return;
  }
  const size = Number(gnista.variable("comint-input-ring-size") ?? 500);
  const separator = String(gnista.variable("comint-input-ring-separator") ?? "\n");
  const prefix = gnista.variable("comint-input-ring-file-prefix");
  const ignore = String(gnista.variable("comint-input-history-ignore") ?? "^#");
  const ignoredups = !nil(gnista.variable("comint-input-ignoredups"));
  const ring: string[] = [];
  withTempBuffer(() => {
    gnista.insertFileContents(gnista.expandFileName(file));
    gnista.gotoChar(gnista.pointMax());
    while (ring.length < size && gnista.reSearchBackward(separator, { noerror: true }) !== undefined) {
      const end = gnista.matchBeginning(0)!;
      gnista.gotoChar(gnista.reSearchBackward(separator, { noerror: true }) !== undefined ? gnista.matchEnd(0)! : gnista.pointMin());
      if (typeof prefix === "string" && prefix !== "" && gnista.lookingAt(prefix)) gnista.gotoChar(gnista.matchEnd(0)!);
      const history = gnista.bufferSubstringNoProperties(gnista.point(), end);
      if (gnista.stringMatch(ignore, history) === undefined && (!ignoredups || ring.length === 0 || ring[0] !== history)) ring.push(history);
    }
  });
  const s = state();
  s.ring = ring;
  s.index = undefined;
}
gnista.defun("comint-read-input-ring", (silent?: boolean) => readInputRing(Boolean(silent)));

/** Writes the buffer's history to comint-input-ring-file-name, oldest first, as comint-write-input-ring. */
export function writeInputRing(): void {
  const file = gnista.variable("comint-input-ring-file-name");
  const s = state();
  if (typeof file !== "string" || file === "" || s.ring.length === 0) return;
  const path = gnista.expandFileName(file);
  if (!gnista.fileWritableP(path)) {
    gnista.message(`Cannot write history file ${file}`);
    return;
  }
  const separator = String(gnista.variable("comint-input-ring-separator") ?? "\n");
  gnista.writeTextFile(path, [...s.ring].reverse().map((input) => input + separator).join(""));
}
gnista.defun("comint-write-input-ring", () => writeInputRing());

// Isearch in the input history, as comint.el's: M-r searches back through
// the inputs sent before for a regexp, each match put after the prompt in
// turn, the prompt showing the search's own.

gnista.defineVariable({
  name: "comint-history-isearch",
  doc: "Whether C-r and C-M-r search the input history rather than the buffer: t always, dwim when the search starts at the command line, nil never. M-r searches the history whatever it says.",
  value: false,
});

/** Where the input on point's line starts, after the prompt, as comint-line-beginning-position. */
const lineBeginningPosition = (): number => gnista.constrainToField(gnista.lineBeginningPosition(), gnista.lineEndPosition());

/** The start of the line the prompt is on. */
const promptLineStart = (): number => gnista.lineBeginningPosition(lineBeginningPosition());

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
function historyIsearchSearch(): (string: string, bound?: gnista.Value, noerror?: gnista.Value) => number | undefined {
  return (string, bound, noerror) => {
    const searchFun = isearchSearchFunDefault();
    const forward = gnista.variable("isearch-forward") === true;
    const s = state();
    // Lazy highlighting searches with a bound: not in the prompt or the output.
    if (typeof bound === "number" && forward && !afterPmark()) gnista.gotoChar(processMark(bufferProcess()));
    const here = searchFun(string, forward ? bound : lineBeginningPosition(), noerror);
    if (here !== undefined) return here;
    if (typeof bound === "number") return undefined;
    // Then put the inputs before or after this one in, one by one, and search each.
    return gnista.conditionCase(
      () => {
        for (;;) {
          if (forward) {
            if (s.index === undefined) gnista.signal("error", "End of history; no next item");
            previousInput(-1);
            gnista.gotoChar(lineBeginningPosition());
          } else {
            if (s.index === s.ring.length - 1) gnista.signal("error", "Beginning of history; no preceding item");
            previousInput(1);
            gnista.gotoChar(gnista.pointMax());
          }
          gnista.setVariable("isearch-barrier", gnista.point());
          gnista.setVariable("isearch-opoint", gnista.point());
          const found = searchFun(string, forward ? undefined : lineBeginningPosition(), noerror);
          if (found !== undefined) return gnista.point();
        }
      },
      { error: () => undefined },
    );
  };
}

/** Shows the search's prompt over the program's while the search succeeds, as comint-history-isearch-message. */
function historyIsearchMessage(cqHack?: gnista.Value, ellipsis?: gnista.Value): void {
  if (gnista.variable("isearch-success") !== true || truthyValue(gnista.variable("isearch-error"))) {
    isearchMessage(truthyValue(cqHack), truthyValue(ellipsis));
    return;
  }
  const buffer = gnista.bufferName();
  const start = promptLineStart();
  const end = lineBeginningPosition();
  let o = messageOverlays.get(buffer);
  if (o !== undefined && gnista.overlayStart(o) !== undefined) gnista.moveOverlay(o, start, end);
  else {
    o = gnista.makeOverlay(start, end);
    gnista.overlayPut(o, "evaporate", true);
    messageOverlays.set(buffer, o);
  }
  gnista.overlayPut(o, "display", isearchMessagePrefix(truthyValue(ellipsis)));
  const index = state().index;
  if (index !== undefined && !truthyValue(ellipsis)) gnista.message(`History item: ${index + 1}`);
  else gnista.message("");
}

/** Wraps a failing search round to the newest input or the oldest, as comint-history-isearch-wrap. */
function historyIsearchWrap(): void {
  const forward = gnista.variable("isearch-forward") === true;
  if (forward) gotoInput(state().ring.length - 1);
  else gotoInput(undefined);
  gnista.gotoChar(forward ? lineBeginningPosition() : gnista.pointMax());
}

/** Keeps where the search is in the history with each of its states, as comint-history-isearch-push-state. */
function historyIsearchPushState(): (cmd: gnista.Value) => void {
  const index = state().index;
  return () => gotoInput(index);
}

const truthyValue = (v: gnista.Value | undefined) => v !== undefined && v !== null && v !== false;

const searchVariables: [string, gnista.Value][] = [
  ["isearch-search-fun-function", historyIsearchSearch as unknown as gnista.Value],
  ["isearch-message-function", historyIsearchMessage as unknown as gnista.Value],
  ["isearch-wrap-function", historyIsearchWrap as unknown as gnista.Value],
  ["isearch-push-state-function", historyIsearchPushState as unknown as gnista.Value],
];

/** Makes a search that starts here search the history, as comint-history-isearch-setup on isearch-mode-hook. */
function historyIsearchSetup(): void {
  const how = gnista.variable("comint-history-isearch");
  const proc = gnista.getBufferProcess(gnista.bufferName());
  if (proc === undefined) return;
  // Not where the prompt is empty, as in a finished shell's buffer.
  if (promptLineStart() === lineBeginningPosition()) return;
  if (!(how === true || (how === "dwim" && afterPmark()))) return;
  gnista.setVariable("isearch-message-prefix-add", "history ");
  for (const [name, value] of searchVariables) {
    gnista.makeLocalVariable(name);
    gnista.setVariable(name, value);
  }
  gnista.makeLocalVariable("isearch-lazy-count");
  gnista.setVariable("isearch-lazy-count", false);
  gnista.addHook("isearch-mode-end-hook", historyIsearchEnd, { local: true });
}

/** What comint-history-isearch was before M-r set it, put back as the search ends, as custom-reevaluate-setting does. */
let savedHowToSearch: gnista.Value | undefined;

/** Puts the search back as it was, as comint-history-isearch-end on isearch-mode-end-hook. */
function historyIsearchEnd(): void {
  const o = messageOverlays.get(gnista.bufferName());
  if (o !== undefined) gnista.deleteOverlay(o);
  messageOverlays.delete(gnista.bufferName());
  gnista.setVariable("isearch-message-prefix-add", null);
  for (const [name] of searchVariables) gnista.killLocalVariable(name);
  gnista.killLocalVariable("isearch-lazy-count");
  // So the search leaves no mark behind.
  gnista.setVariable("isearch-opoint", gnista.point());
  gnista.removeHook("isearch-mode-end-hook", historyIsearchEnd, { local: true });
  if (gnista.variable("isearch-suspended") !== true && savedHowToSearch !== undefined) {
    gnista.setVariable("comint-history-isearch", savedHowToSearch);
    savedHowToSearch = undefined;
  }
}

gnista.defineCommand({
  name: "comint-history-isearch-backward",
  doc: "Search back through the input history for a string, incrementally: each match is put after the prompt.",
  run: () => {
    savedHowToSearch ??= gnista.variable("comint-history-isearch") ?? false;
    gnista.setVariable("comint-history-isearch", true);
    gnista.call("isearch-backward");
  },
});

gnista.defineCommand({
  name: "comint-history-isearch-backward-regexp",
  doc: "Search back through the input history for a regular expression, incrementally: each match is put after the prompt.",
  run: () => {
    savedHowToSearch ??= gnista.variable("comint-history-isearch") ?? false;
    gnista.setVariable("comint-history-isearch", true);
    gnista.call("isearch-backward-regexp");
  },
});

gnista.defineCommand({
  name: "comint-previous-input",
  doc: "Put the input sent before this one after the prompt, or as many back as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => previousInput(arg),
});

gnista.defineCommand({
  name: "comint-next-input",
  doc: "Put the input sent after this one after the prompt, or as many on as the prefix argument says.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => previousInput(-arg),
});

gnista.defineCommand({
  name: "comint-bol",
  doc: "Go to the start of the line, after the prompt if there is one.",
  run: () => {
    gnista.gotoChar(gnista.lineBeginningPosition());
    gnista.gotoChar(gnista.constrainToField(gnista.point(), gnista.lineEndPosition()));
  },
});

gnista.defineCommand({
  name: "comint-bol-or-process-mark",
  doc: "Go to the start of the input on this line; again, to the process mark.",
  run: () => {
    if (gnista.lastCommand() === "comint-bol-or-process-mark") gnista.gotoChar(processMark(bufferProcess()));
    else gnista.call("comint-bol");
  },
});

gnista.defineCommand({
  name: "comint-kill-input",
  doc: "Kill what is typed after the prompt, up to point.",
  run: () => {
    const pmark = processMark(bufferProcess());
    if (gnista.point() > pmark) gnista.killRegion(pmark, gnista.point());
  },
});

gnista.defineCommand({
  name: "comint-copy-old-input",
  doc: "Copy the input at point to after the prompt, to send again.",
  run: () => {
    const input = oldInput();
    gnista.gotoChar(processMark(bufferProcess()));
    gnista.insert(input);
  },
});

/** Throws away what is typed but not sent, as comint-skip-input before a signal. */
function skipInput(): void {
  const proc = bufferProcess();
  const pmark = processMark(proc);
  gnista.gotoChar(gnista.pointMax());
  if (gnista.point() > pmark) {
    gnista.insert("  ");
    gnista.setMarker(gnista.processMark(proc)!, gnista.point());
  }
}

for (const [name, doc, signal] of [
  ["comint-interrupt-subjob", "Interrupt the job running in the program, as C-c does at a terminal.", "INT"],
  ["comint-stop-subjob", "Stop the job running in the program, as C-z does at a terminal.", "TSTP"],
  ["comint-quit-subjob", "Send a quit signal to the job running in the program, as C-\\ does at a terminal.", "QUIT"],
] as const) {
  gnista.defineCommand({
    name,
    doc,
    run: () => {
      if (signal === "INT") skipInput();
      const proc = bufferProcess();
      const fn = { INT: gnista.interruptProcess, TSTP: gnista.stopProcess, QUIT: gnista.quitProcess }[signal];
      fn(proc, gnista.processTtyName(proc) !== undefined);
    },
  });
}

gnista.defineCommand({
  name: "comint-delete-output",
  doc: "Delete the output of the last input, leaving the prompt; with a prefix argument, kill it.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill: gnista.PrefixArg) => {
    const proc = bufferProcess();
    const s = state();
    gnista.letBind({ "inhibit-read-only": true }, () =>
      gnista.saveExcursion(() => {
        const pmark = gnista.lineBeginningPosition(processMark(proc));
        const from = gnista.markerPosition(s.lastInputEnd)!;
        if (kill !== null) gnista.killNew(gnista.bufferSubstringNoProperties(from, pmark));
        const prompt = gnista.bufferSubstringNoProperties(pmark, processMark(proc));
        gnista.deleteRegion(from, processMark(proc));
        gnista.gotoChar(from);
        gnista.setMarker(gnista.processMark(proc)!, from);
        outputFilter(proc, `*** output flushed ***\n${prompt}`);
      }),
    );
  },
});

gnista.defineCommand({
  name: "comint-clear-buffer",
  doc: "Delete everything before the last prompt.",
  run: () => {
    const proc = bufferProcess();
    gnista.letBind({ "inhibit-read-only": true }, () => {
      const start = gnista.lineBeginningPosition(processMark(proc));
      gnista.deleteRegion(gnista.pointMin(), start);
    });
  },
});

gnista.defineCommand({
  name: "comint-show-output",
  doc: "Put the start of the last output at the top of the window, with point at the input before it.",
  run: () => {
    const s = state();
    gnista.gotoChar(gnista.markerPosition(s.lastInputStart)!);
    gnista.callWithPrefix(0, "recenter");
    gnista.gotoChar(gnista.lineBeginningPosition(gnista.markerPosition(s.lastInputStart)!));
  },
});

gnista.defineCommand({
  name: "comint-show-maximum-output",
  doc: "Go to the end of the buffer, showing as much output as fits.",
  run: () => {
    gnista.gotoChar(gnista.pointMax());
    gnista.callWithPrefix(-1, "recenter");
  },
});

/** Goes to the start of the nth next input field, back if negative, as comint-next-prompt. */
function nextPrompt(nIn: number): void {
  let n = nIn;
  let pos = gnista.point();
  let inputPos: number | undefined;
  while (n !== 0) {
    const prev = pos;
    pos = n > 0 ? gnista.nextSingleCharPropertyChange(pos, "field") : gnista.previousSingleCharPropertyChange(pos, "field");
    if (pos === prev) {
      if (n > 0) inputPos = gnista.pointMax();
      n = 0;
    } else if (nil(gnista.charProperty(pos, "field"))) {
      n += n < 0 ? 1 : -1;
      inputPos = pos;
    }
  }
  if (inputPos !== undefined) gnista.gotoChar(inputPos);
}

gnista.defineCommand({
  name: "comint-next-prompt",
  doc: "Go to the input after the next prompt, or as many on as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => nextPrompt(n),
});

gnista.defineCommand({
  name: "comint-previous-prompt",
  doc: "Go to the input after the previous prompt, or as many back as the prefix argument says.",
  params: [{ name: "n", kind: "count" }],
  shiftSelect: true,
  run: (n: number) => nextPrompt(-n),
});

// Keep the history-forgetting hook from treating killed buffers' state as live.
gnista.addHook("kill-buffer-hook", () => {
  states.delete(gnista.bufferName());
});

/**
 * Reads a line without showing it and sends it to the buffer's process, as
 * comint-send-invisible: for passwords, which then go in no history.
 */
export async function sendInvisible(prompt = "Non-echoed text: "): Promise<void> {
  const buffer = gnista.bufferName();
  const proc = gnista.getBufferProcess(buffer);
  if (proc === undefined) throw new Error(`Buffer ${buffer} has no process`);
  const prefix = gnista.windowBuffer() === buffer ? "" : `(In buffer ${buffer}) `;
  const str = await readPasswd(prefix + prompt);
  if (gnista.processLiveP(proc)) gnista.processSendString(proc, `${str}\n`);
}

gnista.defineCommand({
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
  const regexp = gnista.variable("comint-password-prompt-regexp");
  if (typeof regexp !== "string" || gnista.stringMatch(regexp, string.replaceAll("\r", ""), { caseFold: true }) === undefined) return;
  if (promptDepth >= 10) {
    gnista.message("Password prompt recursion too deep");
    return;
  }
  if (gnista.getBufferProcess(gnista.bufferName()) === undefined) return;
  const prompt = string.replace(/^[ \n\r\t\v\f\b\x07]+/, "").replace(/\n+$/, "");
  promptDepth++;
  sendInvisible(prompt).finally(() => promptDepth--);
};
gnista.addHook("comint-output-filter-functions", watchForPasswordPrompt);
