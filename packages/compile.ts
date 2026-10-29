// Compiling and finding errors, after Emacs's compile.el and grep.el, with
// next-error from simple.el. M-x compile runs a shell command, make -k by
// default, in the background, its output going into *compilation*, where
// the error messages it finds are highlighted; M-g n (next-error) visits
// the next one's file at its line, and M-g p the one before. M-x grep does
// the same for grep's hits, in *grep*. In those buffers RET visits the
// message at point, n and p visit the next and previous while keeping the
// buffer selected, M-n and M-p move between messages, g runs the command
// again, and C-c C-k kills it.

// --- Faces and variables ----------------------------------------------------

for (const [name, doc, attributes] of [
  ["compilation-error", "Error messages' file names in compilation buffers.", { foreground: "bad", bold: true }],
  ["compilation-warning", "Warnings' file names in compilation buffers.", { foreground: "warn", bold: true }],
  ["compilation-info", "Notes' file names, and grep's hits, in compilation buffers.", { foreground: "good" }],
  ["compilation-line-number", "Line numbers in compilation messages.", { foreground: "accent-ink" }],
  ["compilation-column-number", "Column numbers in compilation messages.", { foreground: "muted" }],
  ["compilation-mode-line-exit", "How a compilation that succeeded ended.", { foreground: "good", bold: true }],
  ["compilation-mode-line-fail", "How a compilation that failed ended.", { foreground: "bad", bold: true }],
  ["next-error", "The line next-error goes to, for a moment.", { inherit: "region" }],
  ["grep-match", "What grep matched.", { inherit: "match" }],
] as const) {
  ember.defineFace({ name, doc, attributes });
}

const defvar = (name: string, value: ember.Value, doc: string, local = false) => ember.defineVariable({ name, value, doc, local });
defvar("compile-command", "make -k ", "The command M-x compile offers to run.");
defvar("compilation-read-command", true, "Whether M-x compile asks for the command, rather than running compile-command.");
defvar("compilation-ask-about-save", true, "Whether M-x compile asks before saving modified buffers; if nil, it saves them without asking.");
defvar("compilation-scroll-output", false, "Whether the compilation buffer's window follows the output as it comes; first-error stops at the first error.");
defvar("compilation-always-kill", false, "Whether starting a compilation kills one still running without asking.");
defvar(
  "compilation-skip-threshold",
  1,
  "Which messages next-error and M-n go to: 2 errors only, 1 warnings and errors, 0 notes as well.",
);
defvar(
  "compilation-error-regexp-alist",
  ["gnu", "python-tracebacks-and-caml", "typescript-tsc-pretty", "cargo"],
  "The names of the message formats in compilation-error-regexp-alist-alist that compilation buffers look for.",
  true,
);
defvar("compilation-directory", null, "The directory the compilation ran in, which its messages' file names are relative to.", true);
defvar("compilation-arguments", null, "The command and mode of this compilation buffer's compilation, for recompile.", true);
defvar("compilation-error", "error", "What a message is called, in \"Past last error\".", true);
defvar("compilation-first-column", 1, "The number of a line's first column in messages: 1, or 0 for grep.", true);
defvar("compilation-environment", [], "Variables to set in the compilation's environment, as \"NAME=value\" strings.");
defvar("compilation-buffer-name-function", null, "A command naming the compilation buffer, or nil for *compilation*, *grep* and so on.");
defvar(
  "next-error-function",
  null,
  "The command that visits the next message's place in this buffer, as next-error uses it: given a count, \"t\" to start over, and the buffer's name.",
  true,
);
defvar("next-error-last-buffer", null, "The buffer next-error used last, which it uses again.");
defvar("next-error-highlight", 0.5, "How many seconds next-error highlights the line it goes to, t to keep it until the next command, or nil not to.");
defvar("next-error-verbose", true, "Whether next-error always says which buffer it used.");
defvar("grep-command", "grep --color=auto -nH --null -e ", "The command M-x grep offers to run.");
ember.defineHook("compilation-start-hook", "Run with the process just started, in its compilation buffer.");
ember.defineHook("compilation-finish-functions", "Called with the compilation buffer and how it ended, as \"finished\\n\", when a compilation ends.");
ember.defineHook("compilation-filter-hook", "Run in the compilation buffer after output is inserted.");
ember.defineHook("next-error-hook", "Run after next-error visits a message's place.");

const truthy = (v: ember.Value | undefined): boolean => v !== undefined && v !== null && v !== false;
const num = (name: string, fallback: number): number => {
  const v = ember.variable(name);
  return typeof v === "number" ? v : fallback;
};

// --- Message formats ---------------------------------------------------------

/** A message format: a regexp with named groups file, line, col and warn or info, and what a match is. */
type Format = { re: RegExp; type: 0 | 1 | 2 };

/**
 * The formats, as Emacs's compilation-error-regexp-alist-alist, written as
 * JavaScript regexps. cargo is rust-mode's, which Emacs leaves to it.
 */
const FORMATS: { [name: string]: Format } = {
  // [PROGRAM:]FILE:LINE[-ENDLINE][:COL[-ENDCOL]]: [warning|note|error] MESSAGE
  gnu: {
    re: new RegExp(
      "^(?:[A-Za-z][A-Za-z0-9.-]+: ?| +\\|)?" +
        "(?<file>(?:[^0-9\\n\\t ]|[0-9]+[^0-9\\n])(?:[^\\n :]| [^\\-/\\n]|:[^ \\n])*?): ?" +
        "(?<line>[0-9]+)(?:-[0-9]+(?:\\.[0-9]+)?|[.:](?<col>[0-9]+)(?:-(?:[0-9]+\\.)?[0-9]+)?)?:" +
        "(?: *(?<warn>FutureWarning|RuntimeWarning|Warning|warning|W:)" +
        "| *(?<info>Informational|informational|Information|information|Info|info|I:|instantiated from|required from|Note|note|\\[ skipping .+ \\])" +
        "| *(?:Error|error)|[0-9]?(?:[^0-9\\n]|$)|[0-9]{3})",
    ),
    type: 2,
  },
  "python-tracebacks-and-caml": {
    re: /^[ \t]*File ("?)(?<file>[^," \n\t<>]+)\1, lines? (?<line>[0-9]+)/,
    type: 2,
  },
  "typescript-tsc-pretty": {
    re: /^(?<file>[^\s:][^:\n]*):(?<line>[0-9]+):(?<col>[0-9]+) - (?:error|(?<warn>warning)|(?<info>info|message)) TS[0-9]+:/,
    type: 2,
  },
  cargo: { re: /^ *--> (?<file>[^:\n]+):(?<line>[0-9]+):(?<col>[0-9]+)/, type: 2 },
  // grep's, as grep-regexp-alist: FILE\0LINE: or FILE:LINE:.
  grep: { re: /^(?:(?<file>[^\0\n]+)\0(?<line>[0-9]+):|(?<file2>[^\n:]+?[^\n/:]):[\t ]*(?<line2>[1-9][0-9]*)[\t ]*:)/, type: 2 },
  "grep-binary": { re: /^Binary file (?<file>.+) matches/, type: 0 },
};

/** A message found in a compilation buffer: where it is, and where it points. */
type Message = {
  start: number;
  end: number;
  file: string;
  line: number;
  col?: number;
  type: 0 | 1 | 2;
};

/** Each compilation buffer's messages, in order, and how far it has been read. */
const buffers = new Map<string, { messages: Message[]; parsed: number; current?: number; started: number; matches: number }>();

function state(buffer = ember.bufferName()) {
  let s = buffers.get(buffer);
  if (s === undefined) {
    s = { messages: [], parsed: 0, started: Date.now(), matches: 0 };
    buffers.set(buffer, s);
  }
  return s;
}

const faceFor = (type: number): string => (type === 2 ? "compilation-error" : type === 1 ? "compilation-warning" : "compilation-info");

/** Finds the messages in the lines output has completed, highlighting them, as compilation--parse-region. */
function parseNewLines(): void {
  const s = state();
  const formats = (ember.variable("compilation-error-regexp-alist") as ember.Value[] | null ?? [])
    .filter((n): n is string => typeof n === "string" && FORMATS[n] !== undefined)
    .map((n) => FORMATS[n]);
  const grep = ember.derivedModeP("grep-mode");
  let line = ember.lineOf(s.parsed);
  const last = ember.lineCount() - 1;
  while (line < last) {
    const start = ember.lineStart(line);
    const text = ember.lineText(line);
    for (const f of formats) {
      const m = f.re.exec(text);
      if (m === null || m.groups === undefined) continue;
      const g = m.groups;
      const file = g.file ?? g.file2;
      if (file === undefined) continue;
      const lineNo = Number(g.line ?? g.line2 ?? 1);
      let type: 0 | 1 | 2 = g.warn !== undefined ? 1 : g.info !== undefined ? 0 : f.type;
      // cargo says what it is on the line before the arrow.
      if (f === FORMATS.cargo && line > 0) {
        for (let l = line - 1; l >= 0 && l >= line - 3; l--) {
          const t = ember.lineText(l);
          if (/^warning/.test(t)) type = 1;
          if (/^(?:note|help)/.test(t)) type = 0;
          if (/^(?:warning|error|note|help)/.test(t)) break;
        }
      }
      const fileAt = start + m.index + m[0].indexOf(file);
      s.messages.push({ start, end: ember.lineEnd(line), file, line: lineNo, col: g.col === undefined ? undefined : Number(g.col), type });
      if (grep) s.matches++;
      ember.putTextProperty(fileAt, fileAt + file.length, "face", grep ? "compilation-info" : faceFor(type));
      const lineText = String(lineNo);
      const lineAt = text.indexOf(lineText, fileAt - start + file.length);
      if (lineAt >= 0) ember.putTextProperty(start + lineAt, start + lineAt + lineText.length, "face", "compilation-line-number");
      break;
    }
    line++;
  }
  s.parsed = ember.lineStart(last);
}

// --- Running a compilation ---------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The time as (substring (current-time-string) 0 19) writes it: "Wed Oct 29 21:05:00". */
function timeString(d = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Runs `fn` with the buffer writable, as inhibit-read-only. */
function writable<T>(fn: () => T): T {
  const was = ember.bufferReadOnly();
  ember.setReadOnly(false);
  try {
    return fn();
  } finally {
    ember.setReadOnly(was);
  }
}

/** The mode's name without -mode, as it goes in the -*- line: compilation or grep. */
const modeStem = (mode: string): string => mode.replace(/-mode$/, "");

/** Strips the colour codes programs write, which a dumb terminal would not show. */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** What a compilation's end says, as compilation-exit-message-function or grep-exit-message. */
function exitMessage(event: string, matches: number, grep: boolean): string {
  if (!grep) return event;
  const code = /code (\d+)/.exec(event)?.[1];
  if (event === "finished\n") return `finished with ${matches} match${matches === 1 ? "" : "es"} found\n`;
  if (code === "1") return "finished with no matches found\n";
  return event;
}

/**
 * Starts a compilation of `command` in a buffer of `mode`, as
 * compilation-start: the buffer is cleared and headed with the command,
 * shown, and filled as the output comes.
 */
function compilationStart(command: string, mode: string, directory: string): void {
  const modeName = mode === "grep-mode" ? "Grep" : "Compilation";
  const bufferName = `*${modeStem(mode)}*`;
  const existing = ember.getBufferProcess(bufferName);
  const start = () => {
    if (existing !== undefined && ember.processStatus(existing) === "run") ember.deleteProcess(existing);
    ember.getBufferCreate(bufferName);
    ember.withCurrentBuffer(bufferName, () => {
      writable(() => ember.deleteRegion(0, ember.bufferSize()));
      ember.call(mode as ember.CommandName);
      ember.setVariable("default-directory", directory);
      ember.setVariable("compilation-directory", directory);
      ember.setVariable("compilation-arguments", [command, mode]);
      buffers.set(bufferName, { messages: [], parsed: 0, started: Date.now(), matches: 0 });
      writable(() => {
        ember.insert(
          `-*- mode: ${modeStem(mode)}; default-directory: ${JSON.stringify(ember.abbreviateFileName(directory))} -*-\n` +
            `${modeName} started at ${timeString()}\n\n${command}\n`,
        );
      });
      state().parsed = ember.bufferSize();
      ember.setBufferModified(false);
      ember.gotoChar(truthy(ember.variable("compilation-scroll-output")) ? ember.bufferSize() : 0);
    });
    ember.setVariable("next-error-last-buffer", bufferName);
    const env: { [k: string]: string } = { INSIDE_EMACS: "ember,compile" };
    for (const e of (ember.variable("compilation-environment") as ember.Value[] | null) ?? []) {
      if (typeof e === "string" && e.includes("=")) env[e.slice(0, e.indexOf("="))] = e.slice(e.indexOf("=") + 1);
    }
    const proc = ember.makeProcess({
      name: modeStem(mode),
      buffer: bufferName,
      command: ["/bin/sh", "-c", command],
      directory,
      env,
      filter: (p, output) => compilationFilter(p, output),
      sentinel: (p, event) => compilationSentinel(p, event, modeName),
    });
    ember.withCurrentBuffer(bufferName, () => ember.runHooks("compilation-start-hook", proc));
    ember.call("display-buffer", bufferName);
  };
  if (existing !== undefined && ember.processStatus(existing) === "run" && !truthy(ember.variable("compilation-always-kill"))) {
    ember.yesOrNoP(`A ${modeStem(mode)} process is running; kill it? `, (yes) => {
      if (!yes) throw new Error(`Cannot have two processes in ‘${bufferName}’ at once`);
      start();
    });
    return;
  }
  start();
}

/** Inserts output at the process mark, as compilation-filter, and finds the messages in it. */
function compilationFilter(proc: string, output: string): void {
  const buffer = ember.processBuffer(proc);
  if (buffer === undefined || !ember.bufferList().includes(buffer)) return;
  ember.withCurrentBuffer(buffer, () => {
    const mark = ember.processMark(proc)!;
    const at = ember.markerPosition(mark) ?? ember.bufferSize();
    const moving = ember.point() === at;
    const point = ember.makeMarker();
    const text = stripAnsi(output);
    writable(() => {
      ember.gotoChar(at);
      ember.insert(text);
      ember.setMarker(mark, ember.point());
    });
    ember.gotoChar(moving ? ember.markerPosition(mark)! : ember.markerPosition(point)!);
    ember.setMarker(point, null);
    parseNewLines();
    // grep separates the file name with a NUL, shown as a colon, as grep-mode's display property does.
    if (ember.derivedModeP("grep-mode")) writable(() => ember.substCharInRegion(at, ember.markerPosition(mark)!, "\0", ":"));
    ember.setBufferModified(false);
    ember.runHooks("compilation-filter-hook");
  });
}

/** Notes how the compilation ended, as compilation-handle-exit. */
function compilationSentinel(proc: string, event: string, modeName: string): void {
  const buffer = ember.processBuffer(proc);
  if (buffer === undefined || !ember.bufferList().includes(buffer)) return;
  let message = "";
  ember.withCurrentBuffer(buffer, () => {
    // Output not yet ended by a newline is a line too.
    if (ember.bufferSize() > 0 && ember.bufferText(ember.bufferSize() - 1, ember.bufferSize()) !== "\n") {
      writable(() => {
        ember.gotoChar(ember.bufferSize());
        ember.insert("\n");
      });
    }
    parseNewLines();
    const s = state();
    const status = exitMessage(event, s.matches, ember.derivedModeP("grep-mode"));
    const point = ember.makeMarker();
    writable(() => {
      ember.gotoChar(ember.bufferSize());
      const from = ember.point();
      ember.insert(`\n${modeName} ${status.replace(/\n$/, "")} at ${timeString()}, duration ${duration(Date.now() - s.started)}\n`);
      const failed = !event.startsWith("finished") && !(ember.derivedModeP("grep-mode") && /code 1\n/.test(event));
      ember.putTextProperty(from + 1, from + 1 + modeName.length, "face", "compilation-info");
      const word = from + 2 + modeName.length;
      ember.putTextProperty(word, word + status.replace(/\n$/, "").length, "face", failed ? "compilation-error" : "compilation-info");
    });
    ember.gotoChar(ember.markerPosition(point)!);
    ember.setMarker(point, null);
    ember.setBufferModified(false);
    message = `${modeName} ${status.replace(/\n$/, "")}`;
  });
  ember.message(message);
  ember.runHooks("compilation-finish-functions", buffer, event);
}

/** The directory a buffer's commands run in, ending in a slash. */
const currentDirectory = (): string => ember.fileNameAsDirectory(ember.expandFileName("."));

/** Saves modified buffers, asking as compilation-ask-about-save says, then runs `then`. */
function saveThen(then: () => void): void {
  if (truthy(ember.variable("compilation-ask-about-save"))) {
    ember.call("save-some-buffers");
  } else {
    ember.callWithPrefix([4], "save-some-buffers");
  }
  ember.afterPrompts(then);
}

ember.defineCommand({
  name: "compile",
  doc:
    "Run a shell command in the background, make -k by default, showing its output in *compilation*, where error messages are found and highlighted. " +
    "M-g n (next-error) then visits each error's place in turn. Asks to save modified buffers first.",
  params: [{
    name: "command",
    prompt: "Compile command: ",
    initial: () => String(ember.variable("compile-command") ?? ""),
    history: "compile-history",
  }],
  run: (command: string) => {
    const directory = currentDirectory();
    ember.setDefault("compile-command", command);
    saveThen(() => compilationStart(command, "compilation-mode", directory));
  },
});

ember.defineCommand({
  name: "recompile",
  doc: "Run the last compilation again, or this buffer's, in the directory it ran in.",
  run: () => {
    const args = ember.variable("compilation-arguments");
    const command = Array.isArray(args) && typeof args[0] === "string" ? args[0] : String(ember.variable("compile-command") ?? "");
    const mode = Array.isArray(args) && typeof args[1] === "string" ? args[1] : "compilation-mode";
    const dir = ember.variable("compilation-directory");
    const directory = typeof dir === "string" ? dir : currentDirectory();
    saveThen(() => compilationStart(command, mode, directory));
  },
});

ember.defineCommand({
  name: "kill-compilation",
  doc: "Kill the compilation this buffer shows, or the last one.",
  run: () => {
    const buffer = ember.derivedModeP("compilation-mode") ? ember.bufferName() : String(ember.variable("next-error-last-buffer") ?? "*compilation*");
    const proc = ember.getBufferProcess(buffer);
    if (proc === undefined || ember.processStatus(proc) !== "run") {
      throw new Error(`The ${buffer.replace(/^\*|\*$/g, "")} process is not running`);
    }
    ember.interruptProcess(proc);
  },
});

// --- Moving among messages and visiting them ------------------------------------

/** The messages next-error goes to: those at least as serious as compilation-skip-threshold says. */
const counted = (m: Message): boolean => m.type >= num("compilation-skip-threshold", 1);

/**
 * The message `n` messages on from position `from` in the current
 * compilation buffer, as compilation-next-error: forward past messages at
 * or before it, back to ones before it. Throws as Emacs does at the ends.
 */
function nthMessage(n: number, from: number): Message {
  const s = state();
  const word = String(ember.variable("compilation-error") ?? "error");
  const list = s.messages.filter(counted);
  // From the message containing `from`, if any.
  const here = s.messages.findIndex((m) => m.start <= from && from <= m.end);
  const pos = here >= 0 ? s.messages[here].start : from;
  if (n === 0) {
    const m = s.messages.find((m) => m.start <= from && from <= m.end);
    if (m === undefined) throw new Error(`No ${word} here`);
    return m;
  }
  if (n > 0) {
    const after = list.filter((m) => m.start > pos);
    if (after.length < n) {
      const running = ember.getBufferProcess(ember.bufferName()) !== undefined;
      throw new Error(running ? `No more ${word}s yet` : `Past last ${word}`);
    }
    return after[n - 1];
  }
  const before = list.filter((m) => m.start < pos);
  if (before.length < -n) throw new Error(`Moved back before first ${word}`);
  return before[before.length + n];
}

function compilationNextError(n: number): void {
  if (!ember.derivedModeP("compilation-mode")) throw new Error("Not in a compilation buffer");
  ember.gotoChar(nthMessage(n, ember.point()).start);
}

ember.defineCommand({
  name: "compilation-next-error",
  doc: "Move to the next error message, or as many as the prefix argument says, without visiting it.",
  run: () => compilationNextError(ember.prefixNumericValue(ember.prefixArg())),
});
ember.defineCommand({
  name: "compilation-previous-error",
  doc: "Move to the error message before, or as many back as the prefix argument says, without visiting it.",
  run: () => compilationNextError(-ember.prefixNumericValue(ember.prefixArg())),
});

/** The file a message names, relative to the directory its compilation ran in. */
function messageFile(m: Message): string {
  const dir = ember.variable("compilation-directory");
  const base = typeof dir === "string" ? dir : currentDirectory();
  return ember.expandFileName(m.file.startsWith("/") || m.file.startsWith("~") ? m.file : base + m.file);
}

let highlight: number | undefined;
let highlightBuffer: string | undefined;

function clearHighlight(): void {
  if (highlight !== undefined && highlightBuffer !== undefined && ember.bufferList().includes(highlightBuffer)) {
    const o = highlight;
    ember.withCurrentBuffer(highlightBuffer, () => ember.deleteOverlay(o));
  }
  highlight = undefined;
}

/**
 * Shows a message's place: its compilation buffer with point on it, and
 * its file at its line and column, as compilation-goto-locus.
 */
function gotoLocus(compilation: string, m: Message): void {
  const file = ember.withCurrentBuffer(compilation, () => messageFile(m));
  if (!ember.fileExists(file)) throw new Error(`Cannot find file ${file}`);
  const firstColumn = ember.withCurrentBuffer(compilation, () => num("compilation-first-column", 1));
  const fromCompilation = ember.windowBuffer() === compilation;
  let window = ember.windowList().find((w) => ember.windowBuffer(w) === compilation);
  if (!(fromCompilation && window !== undefined)) {
    ember.call("display-buffer", compilation);
    window = ember.windowList().find((w) => ember.windowBuffer(w) === compilation);
  }
  // The message at the top of its window's view, point on it.
  if (window !== undefined) {
    const selected = ember.selectedWindow();
    ember.selectWindow(window);
    ember.gotoChar(m.start);
    ember.selectWindow(selected);
  }
  const target = ember.findFileNoselect(file);
  if (fromCompilation || ember.selectedWindow() === window) ember.call("pop-to-buffer", target);
  else ember.call("switch-to-buffer", target);
  ember.gotoChar(ember.lineStart(Math.min(m.line - 1, ember.lineCount() - 1)));
  if (m.col !== undefined) ember.moveToColumn(Math.max(0, m.col - firstColumn));
  // The line flashes, as next-error-highlight says.
  clearHighlight();
  const secs = ember.variable("next-error-highlight");
  if (truthy(secs)) {
    const line = ember.lineOf(ember.point());
    highlight = ember.makeOverlay(ember.lineStart(line), ember.lineEnd(line), { face: "next-error", priority: 1000 });
    highlightBuffer = ember.bufferName();
    if (typeof secs === "number") ember.runWithTimer(secs, null, clearHighlight);
  }
}

/** Moves `n` messages in a compilation buffer and visits the place, as compilation-next-error-function. */
function compilationNextErrorFunction(n: number, reset: boolean, buffer: string): void {
  const m = ember.withCurrentBuffer(buffer, () => {
    const s = state();
    if (reset) s.current = undefined;
    const from = s.current ?? (n === 0 ? ember.point() : 0);
    const found = nthMessage(n, from);
    s.current = found.start;
    return found;
  });
  gotoLocus(buffer, m);
}

ember.defineCommand({
  name: "compilation-next-error-function",
  doc:
    "Visit the place of the message `count` messages on in compilation buffer `buffer`, from the start if `reset` is t. " +
    "This is next-error-function in compilation buffers; next-error calls it from the buffer it was typed in.",
  params: [{ name: "count", prompt: "Count: " }, { name: "reset", prompt: "Reset: " }, { name: "buffer", prompt: "Buffer: " }],
  run: (count: string, reset: string, buffer: string) => compilationNextErrorFunction(Number(count) || 0, reset === "t", buffer),
});

/** Whether a buffer has messages next-error can go to, as next-error-buffer-p. */
const nextErrorBuffer = (b: string): boolean =>
  ember.bufferList().includes(b) && ember.withCurrentBuffer(b, () => typeof ember.variable("next-error-function") === "string");

/** The buffer next-error uses, as next-error-find-buffer. */
function findNextErrorBuffer(): string {
  const last = ember.variable("next-error-last-buffer");
  if (typeof last === "string" && nextErrorBuffer(last)) return last;
  if (nextErrorBuffer(ember.bufferName())) return ember.bufferName();
  const any = ember.bufferList().find(nextErrorBuffer);
  if (any !== undefined) return any;
  throw new Error("No buffers contain error message locations");
}

/** Goes to the `n`th next message's place, as next-error. */
function nextError(n: number, reset: boolean, select = true): void {
  const buffer = findNextErrorBuffer();
  const selected = ember.selectedWindow();
  const fn = ember.withCurrentBuffer(buffer, () => String(ember.variable("next-error-function")));
  // Called from here, not in that buffer, so the windows it changes stay changed.
  ember.call(fn as ember.CommandName, String(n), reset ? "t" : "", buffer);
  const previous = ember.variable("next-error-last-buffer");
  ember.setVariable("next-error-last-buffer", buffer);
  ember.runHooks("next-error-hook");
  if (truthy(ember.variable("next-error-verbose")) || previous !== buffer) {
    const which = reset ? "First" : n === 0 ? "Current" : n < 0 ? "Previous" : "Next";
    ember.message(`${which} locus from ${buffer}`);
  }
  if (!select) ember.selectWindow(selected);
}

const prefixCount = (): [number, boolean] => {
  const arg = ember.prefixArg();
  return Array.isArray(arg) ? [1, true] : [ember.prefixNumericValue(arg), false];
};

ember.defineCommand({
  name: "next-error",
  doc:
    "Visit the place of the next error message, or grep hit, in the compilation or grep buffer used last: its file, at its line. " +
    "With a prefix argument, that many on; plain C-u starts again from the first.",
  run: () => {
    const [n, reset] = prefixCount();
    nextError(n, reset);
  },
});
ember.defineCommand({
  name: "previous-error",
  doc: "Visit the place of the error message before, or as many back as the prefix argument says.",
  run: () => nextError(-ember.prefixNumericValue(ember.prefixArg()), false),
});
ember.defineCommand({
  name: "first-error",
  doc: "Visit the place of the first error message.",
  run: () => nextError(ember.prefixNumericValue(ember.prefixArg()), true),
});
ember.defineCommand({
  name: "next-error-no-select",
  doc: "Show the next error message's place, keeping this window selected.",
  run: () => nextError(ember.prefixNumericValue(ember.prefixArg()), false, false),
});
ember.defineCommand({
  name: "previous-error-no-select",
  doc: "Show the place of the error message before, keeping this window selected.",
  run: () => nextError(-ember.prefixNumericValue(ember.prefixArg()), false, false),
});

ember.defineCommand({
  name: "compile-goto-error",
  doc: "Visit the place of the error message at point.",
  run: () => {
    if (!ember.derivedModeP("compilation-mode")) throw new Error("Not in a compilation buffer");
    const m = nthMessage(0, ember.point());
    state().current = m.start;
    ember.setVariable("next-error-last-buffer", ember.bufferName());
    gotoLocus(ember.bufferName(), m);
  },
});

ember.defineCommand({
  name: "compilation-display-error",
  doc: "Show the place of the error message at point in another window, keeping this one selected.",
  run: () => {
    const window = ember.selectedWindow();
    ember.call("compile-goto-error");
    ember.selectWindow(window);
  },
});

// --- The modes ------------------------------------------------------------------

ember.defineMajorMode({
  name: "compilation-mode",
  modeName: "Compilation",
  doc:
    "The mode of *compilation*: the output of a compilation, its error messages highlighted. " +
    "RET visits the message at point, n and p the next and previous, M-n and M-p move between them, g runs the compilation again, and C-c C-k kills it.",
  bindings: {
    RET: "compile-goto-error",
    "C-c C-c": "compile-goto-error",
    "C-o": "compilation-display-error",
    "C-c C-k": "kill-compilation",
    "M-n": "compilation-next-error",
    "M-p": "compilation-previous-error",
    TAB: "compilation-next-error",
    "<backtab>": "compilation-previous-error",
    n: "next-error-no-select",
    p: "previous-error-no-select",
    g: "recompile",
    q: "quit-window",
    SPC: "scroll-up-command",
    DEL: "scroll-down-command",
  },
  setup: () => {
    ember.setReadOnly(true);
    ember.setVariable("next-error-function", "compilation-next-error-function");
    ember.setVariable("truncate-lines", false);
  },
});

ember.defineMajorMode({
  name: "grep-mode",
  modeName: "Grep",
  parent: "compilation-mode",
  doc: "The mode of *grep*: grep's hits, each a place next-error can visit. RET visits the hit at point, n and p the next and previous, g runs the search again.",
  setup: () => {
    ember.setVariable("compilation-error-regexp-alist", ["grep", "grep-binary"]);
    ember.setVariable("compilation-error", "grep hit");
    ember.setVariable("compilation-first-column", 0);
  },
});

ember.defineCommand({
  name: "grep",
  doc:
    "Run grep, with the arguments you give, in the background, showing its hits in *grep*. " +
    "M-g n (next-error) then visits each in turn.",
  params: [{
    name: "command",
    prompt: "Run grep (like this): ",
    initial: () => String(ember.variable("grep-command") ?? ""),
    history: "grep-history",
  }],
  run: (command: string) => compilationStart(command, "grep-mode", currentDirectory()),
});

for (const [keys, command] of [
  ["C-x `", "next-error"],
  ["M-g n", "next-error"],
  ["M-g M-n", "next-error"],
  ["M-g p", "previous-error"],
  ["M-g M-p", "previous-error"],
] as const) {
  ember.bindKey(keys, command);
}
