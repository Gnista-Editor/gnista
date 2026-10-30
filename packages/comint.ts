import { applyOnRegion } from "ansi-color";

// Command interpreters in a buffer, after Emacs's comint.el: a program on
// a pseudo-terminal, its output marked as the `output` field and its prompt
// left for you to type after, input sent with RET and kept in a history
// (M-p, M-n), and the subjob signals on C-c C-c, C-c C-z and C-c C-\.
// Modes for shells and REPLs, as shell.ts's shell-mode, derive from it.

for (const [name, doc, value, local] of [
  ["comint-input-ring-size", "How many inputs a comint buffer keeps for M-p and M-n.", 500, false],
  ["comint-input-ignoredups", "Whether an input the same as the last one is left out of the history.", false, false],
  ["comint-prompt-read-only", "Whether the prompt is read-only, so it cannot be deleted by accident.", false, false],
  ["comint-eol-on-send", "Whether RET moves to the end of the input before sending it.", true, false],
  ["comint-process-echoes", "Whether the program echoes its input, which RET then takes out of its output.", false, true],
  ["comint-preoutput-filter-functions", "Functions each piece of output goes through before it is inserted; each returns the text to insert.", [], true],
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

/** Goes `arg` inputs back in the history, forward if negative, as comint-previous-input. */
function previousInput(arg: number): void {
  const s = state();
  if (s.ring.length === 0) throw new Error("Empty input ring");
  const pmark = processMark(bufferProcess());
  if (s.index === undefined) {
    s.stored = ember.bufferSubstringNoProperties(pmark, ember.pointMax());
    if (arg < 0) {
      // Going forward from the newest wraps to the oldest, as Emacs's ring does.
      s.index = s.ring.length + arg;
    } else {
      s.index = arg - 1;
    }
  } else if ((arg < 0 && s.index === 0) || (arg > 0 && s.index === s.ring.length - 1)) {
    if (s.stored !== undefined && arg < 0) {
      replaceInput(s.stored);
      s.index = undefined;
      return;
    }
    s.index = (((s.index + arg) % s.ring.length) + s.ring.length) % s.ring.length;
  } else {
    s.index = Math.max(0, Math.min(s.ring.length - 1, s.index + arg));
  }
  replaceInput(s.ring[s.index]!);
  ember.message(`History item: ${s.index + 1}`);
}

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
