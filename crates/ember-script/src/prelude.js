// Builds the `ember` global from the native functions. Runs once, before any user script.
"use strict";
(() => {
  const native = globalThis.__ember;
  delete globalThis.__ember;

  // Hook ids by function, so a function can be removed by passing it again.

  // Major modes by name, for building a mode on its parent.
  const majorModes = new Map();
  const isTrue = (value) => value !== null && value !== undefined && value !== false;
  // "delete-selection-mode" is called "Delete-Selection mode" in messages, as in Emacs.
  const prettyName = (name) =>
    name
      .replace(/-mode$/, "")
      .split("-")
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join("-");

  function bindAll(keymap, bindings) {
    for (const [keys, command] of Object.entries(bindings ?? {})) {
      native.bindKey(String(keys), String(command), keymap);
    }
  }

  // Turns on a major mode, as Emacs's define-derived-mode does: clear the
  // buffer's own variables, set up each mode from the root down, then run
  // their hooks, parent's first.
  function enterMajorMode(name) {
    const chain = [];
    for (let mode = majorModes.get(name); mode; mode = mode.parent === null ? undefined : majorModes.get(mode.parent)) {
      chain.unshift(mode);
    }
    native.killAllLocalVariables();
    for (const mode of chain) {
      native.setVariable("major-mode", mode.name);
      native.setVariable("mode-name", mode.modeName);
      native.useLocalMap(mode.keymap);
      native.setSyntaxTable(mode.syntaxTable);
      if (mode.setup) mode.setup();
    }
    for (const mode of chain) native.runHooks(`${mode.name}-hook`);
    native.runHooks("after-change-major-mode-hook");
  }

  /**
   * A buffer as an object, as Emacs's buffer objects: it keeps referring to
   * the buffer when it is renamed, and is the same object each time. Where
   * a buffer's name is taken, its current name is used.
   */
  const buffers = new Map();
  class Buffer {
    constructor(id) {
      Object.defineProperty(this, "__emberBufferId", { value: id });
      Object.freeze(this);
    }
    get id() {
      return this.__emberBufferId;
    }
    /** Its name now, or undefined once it is killed. */
    get name() {
      return native.bufferNameOf(this.__emberBufferId) ?? undefined;
    }
    get live() {
      return this.name !== undefined;
    }
    toString() {
      return this.name ?? "#<killed buffer>";
    }
    /** As Emacs prints a buffer, for help and messages that show values. */
    toJSON() {
      return this.live ? `#<buffer ${this.name}>` : "#<killed buffer>";
    }
  }
  globalThis.__emberBuffer = (id) => {
    let b = buffers.get(id);
    if (b === undefined) {
      b = new Buffer(id);
      buffers.set(id, b);
    }
    return b;
  };
  /**
   * A string with text properties, as Emacs's propertized strings: its
   * `string`, and `properties` as [start, end, {name: value}] runs counted
   * in characters. It reads as its string wherever a string is wanted.
   */
  class PropertizedString {
    constructor(string, properties = []) {
      Object.defineProperty(this, "__emberText", { value: true, enumerable: false });
      this.string = String(string);
      this.properties = properties;
      Object.freeze(this);
    }
    toString() {
      return this.string;
    }
  }
  globalThis.__emberText = (string, runs) => new PropertizedString(string, runs);

  /**
   * A marker as an object, as Emacs's markers are: once nothing refers to
   * it, the collector frees it and the editor forgets it, as Emacs's GC
   * unchains unreferenced markers, so code need not delete markers itself.
   */
  const markersFreed = new FinalizationRegistry((id) => native.deleteMarker(id));
  class Marker {
    constructor(id) {
      Object.defineProperty(this, "__emberMarkerId", { value: id });
      // What deleting it early unregisters it with: not the marker itself,
      // which the registry would keep alive.
      Object.defineProperty(this, "__emberMarkerToken", { value: {} });
      Object.freeze(this);
    }
    get id() {
      return this.__emberMarkerId;
    }
    /** Where it is, or undefined if it points nowhere. */
    get position() {
      return native.markerPosition(this.__emberMarkerId) ?? undefined;
    }
    valueOf() {
      return this.position;
    }
  }
  /** A marker's id, from a marker or the number a process mark is. */
  const markerId = (m) => (m instanceof Marker ? m.id : m);

  /** Makes the buffer with an id current again, if it is still live, as save-current-buffer does. */
  const backTo = (id) => {
    const name = native.bufferNameOf(id);
    if (name !== null && name !== undefined) native.setCurrentBuffer(name);
  };
  /** A buffer's name from a name or a buffer object, as functions that take a buffer accept either. */
  const nameOf = (b) => (b instanceof Buffer ? (b.live ? b.name : ember.signal("error", "Selecting deleted buffer")) : String(b));

  const isPromise = (v) => v !== null && typeof v === "object" && typeof v.then === "function";

  /**
   * Runs `body`, then `cleanup`, even if `body` throws, as unwind-protect.
   * If `body` returns a promise, as an async function waiting on a prompt
   * does, `cleanup` runs once it settles: what `body` bound stays bound
   * while it waits, as a Lisp let stays bound in a recursive edit.
   */
  function unwindProtect(body, cleanup) {
    let result;
    try {
      result = body();
    } catch (e) {
      cleanup();
      throw e;
    }
    if (!isPromise(result)) {
      cleanup();
      return result;
    }
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (e) => {
        cleanup();
        throw e;
      },
    );
  }

  /**
   * Opens a prompt or question with `open(answer, quit)`. With a `then`
   * function, it gets the answer, as the callback form; otherwise the
   * answer comes as a promise, which C-g rejects with `quit`, as quitting
   * read-from-minibuffer signals it in Emacs.
   */
  function answering(then, open) {
    if (typeof then === "function") return open(then, undefined);
    return new Promise((resolve, reject) => {
      open(resolve, () => {
        const e = new Error("Quit");
        e.symbol = "quit";
        e.data = [];
        e.conditions = ["quit"];
        reject(e);
      });
    });
  }

  /**
   * Moves over the characters in `set`, as skip-chars-forward reads it: a
   * leading ^ for those not in it, a-z for ranges, \\ quoting. Returns how
   * far it went.
   */
  function skipChars(set, limit, dir) {
    const not = set.startsWith("^");
    const body = not ? set.slice(1) : set;
    const singles = new Set();
    const ranges = [];
    for (let i = 0; i < body.length; i++) {
      let c = body[i];
      if (c === "\\" && i + 1 < body.length) c = body[++i];
      if (body[i + 1] === "-" && i + 2 < body.length) {
        ranges.push([c, body[i + 2]]);
        i += 2;
      } else {
        singles.add(c);
      }
    }
    const inSet = (c) => singles.has(c) || ranges.some(([a, b]) => c >= a && c <= b);
    const start = native.point();
    let p = start;
    if (dir > 0) {
      while (p < limit && inSet(native.bufferText(p, p + 1)) !== not) p++;
    } else {
      while (p > limit && inSet(native.bufferText(p - 1, p)) !== not) p--;
    }
    native.gotoChar(p);
    return p - start;
  }

  /** Emacs regexps translated to JavaScript, by source and case folding. */
  const regexps = new Map();
  const CLASSES = {
    alnum: "\\p{L}\\p{N}", alpha: "\\p{L}", digit: "0-9", xdigit: "0-9A-Fa-f", space: "\\s", blank: " \\t",
    upper: "\\p{Lu}", lower: "\\p{Ll}", word: "\\p{L}\\p{N}", punct: "\\p{P}\\p{S}", cntrl: "\\x00-\\x1f",
    graph: "\\p{L}\\p{N}\\p{P}\\p{S}", print: "\\p{L}\\p{N}\\p{P}\\p{S} ", ascii: "\\x00-\\x7f", nonascii: "\\u0080-\\u{10ffff}",
  };
  /** An Emacs regexp as JavaScript source: groups and alternatives backslashed, brackets with literal backslashes. */
  function translateEmacsRegexp(re) {
    let out = "";
    for (let i = 0; i < re.length; i++) {
      const c = re[i];
      if (c === "\\" && i + 1 < re.length) {
        const n = re[++i];
        if (n === "(") {
          // \(?: shy groups, and \(?N: numbered ones as plain groups.
          const m = /^\?(\d*):/.exec(re.slice(i + 1));
          out += m ? (m[1] === "" ? "(?:" : "(") : "(";
          if (m) i += m[0].length;
        } else if (")|{}".includes(n)) out += n;
        else if (n === "'") out += "(?![\\s\\S])";
        else if (n === "`") out += "(?<![\\s\\S])";
        else if (n === "w") out += "[\\p{L}\\p{N}]";
        else if (n === "W") out += "[^\\p{L}\\p{N}]";
        else if (n === "b" || n === "B") out += "\\" + n;
        else if (n === "<") out += "(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])";
        else if (n === ">") out += "(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}])";
        else if (n === "_" && (re[i + 1] === "<" || re[i + 1] === ">")) {
          out += re[++i] === "<" ? "(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])" : "(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])";
        } else if (n === "s" || n === "S") {
          // Syntax classes, as the standard table has them.
          const k = re[++i];
          const set = k === "-" || k === " " ? "\\s" : k === "w" ? "\\p{L}\\p{N}" : k === "_" ? "_\\-+*/&|<>=" : k === "." ? "\\p{P}" : "\\s";
          out += n === "s" ? `[${set}]` : `[^${set}]`;
        } else if (/[1-9]/.test(n)) out += "\\" + n;
        else out += /[A-Za-z0-9]/.test(n) ? n : "\\" + n;
      } else if ("(){}|/".includes(c)) {
        out += "\\" + c;
      } else if (c === "[") {
        // A bracket expression: ] first is literal, backslash is literal, [:class:] named.
        let j = i + 1;
        let body = "";
        if (re[j] === "^") {
          body += "^";
          j++;
        }
        if (re[j] === "]") {
          body += "\\]";
          j++;
        }
        while (j < re.length && re[j] !== "]") {
          const cls = /^\[:(\w+):\]/.exec(re.slice(j));
          if (cls) {
            body += CLASSES[cls[1]] ?? "";
            j += cls[0].length;
          } else {
            body += "\\[]".includes(re[j]) ? "\\" + re[j] : re[j];
            j++;
          }
        }
        out += `[${body}]`;
        i = j;
      } else {
        out += c;
      }
    }
    return out;
  }

  /** Functions named for code to call by name, as Emacs's defun makes them, apart from commands. */
  const functions = new Map();

  globalThis.ember = Object.freeze({
    defineCommand(definition) {
      if (typeof definition !== "object" || definition === null) {
        throw new TypeError("defineCommand takes an object: { name, doc, params, run }");
      }
      const { name, doc = "", params = [], run, shiftSelect = false } = definition;
      if (typeof name !== "string" || name === "") {
        throw new TypeError("A command needs a name");
      }
      if (typeof run !== "function") {
        throw new TypeError(`Command ${name} needs a run function`);
      }
      native.defineCommand(
        name,
        String(doc),
        params.map((p) => ({
          name: String(p.name),
          kind: p.kind ?? "string",
          prompt: typeof p.prompt === "function" ? p.prompt : p.prompt ?? `${p.name}: `,
          initial: p.initial ?? null,
          collection: typeof p.collection === "function" ? (...args) => [...p.collection(...args)].map(String) : null,
          requireMatch: Boolean(p.requireMatch),
          history: p.history === undefined ? null : String(p.history),
        })),
        run,
        Boolean(shiftSelect),
      );
      return name;
    },
    bindKey: (keys, command, keymap = "global-map") => native.bindKey(String(keys), String(command), String(keymap)),
    call: (name, ...args) => native.call(String(name), ...args),
    callInteractively: (name) => native.callInteractively(String(name)),
    callWithPrefix: (prefix, name, ...args) => native.callWithPrefix(prefix ?? null, String(name), ...args),
    message: (text, { log = true } = {}) => native.message(String(text), Boolean(log)),
    insert: (text) => (text instanceof PropertizedString ? native.insertText(text) : native.insert(String(text))),
    PropertizedString,
    propertize(string, properties = {}) {
      const s = String(string);
      const n = [...s].length;
      return new PropertizedString(s, n > 0 && Object.keys(properties).length > 0 ? [[0, n, { ...properties }]] : []);
    },
    bufferSubstring: (start, end) => native.bufferSubstring(start, end),
    insertBeforeMarkers: (text) => native.insertBeforeMarkers(text instanceof PropertizedString ? text : String(text)),
    insertAndInherit: (text) => native.insertAndInherit(text instanceof PropertizedString ? text : String(text)),
    currentColumn: () => native.currentColumn(),
    undoAutoAmalgamate: () => native.undoAutoAmalgamate(),
    moveToColumn: (column) => native.moveToColumn(Math.max(0, Math.floor(Number(column)))),
    point: () => native.point(),
    gotoChar: (position) => native.gotoChar(position),
    // Omitted arguments must not reach the native function as undefined.
    bufferText: (start, end) =>
      end === undefined
        ? start === undefined ? native.bufferText() : native.bufferText(start)
        : native.bufferText(start ?? 0, end),
    deleteRegion: (start, end) => native.deleteRegion(start, end),
    bufferName: (buffer) => (buffer === undefined ? native.bufferName() : ember.getBuffer(buffer)?.name),
    currentBuffer: () => globalThis.__emberBuffer(native.bufferIdOf()),
    getBuffer(buffer) {
      if (buffer instanceof Buffer) return buffer.live ? buffer : undefined;
      const id = native.bufferIdOf(String(buffer));
      return id === null || id === undefined ? undefined : globalThis.__emberBuffer(id);
    },
    bufferLiveP: (buffer) => buffer instanceof Buffer && buffer.live,
    mark: () => native.mark(),
    prefixArg: () => native.prefixArg(),
    prefixNumericValue: (arg = native.prefixArg()) =>
      arg === null ? 1 : arg === "-" ? -1 : Array.isArray(arg) ? arg[0] : arg,
    setPrefixArg: (arg) => native.setPrefixArg(arg ?? null),
    lastKey: () => native.lastKey(),
    currentKill: (n = 0, { properties = false } = {}) => (properties ? native.currentKillText(n) : native.currentKill(n)),
    insertForYank: (text) => native.insertForYank(text instanceof PropertizedString ? text : String(text)),
    popKill: () => native.popKill() ?? undefined,
    lastCommand: () => native.lastCommand(),
    setThisCommand: (name) => native.setThisCommand(String(name)),
    setMark: (position) => native.setMark(position ?? undefined),
    repeatLastCommand: (arg) => native.repeatLastCommand(arg ?? null),
    startKbdMacro: () => native.startKbdMacro(),
    endKbdMacro: () => native.endKbdMacro(),
    callLastKbdMacro: (count = 1) => native.callLastKbdMacro(count),
    definingKbdMacro: () => native.definingKbdMacro(),
    executingKbdMacro: () => native.executingKbdMacro(),
    defineVariable({ name, doc = "", value = null, local = false }) {
      native.defineVariable(String(name), String(doc), value, Boolean(local));
    },
    variable: (name) => native.variable(String(name)),
    setVariable: (name, value) => native.setVariable(String(name), value ?? null),
    defaultValue: (name) => native.defaultValue(String(name)),
    setDefault: (name, value) => native.setDefault(String(name), value ?? null),
    makeLocalVariable: (name) => native.makeLocalVariable(String(name)),
    killLocalVariable: (name) => native.killLocalVariable(String(name)),
    isLocalVariable: (name) => native.isLocalVariable(String(name)),
    variableDocumentation: (name) => native.variableDocumentation(String(name)),
    variableSource: (name) => native.variableSource(String(name)),
    isHook: (name) => native.isHook(String(name)),
    killAllLocalVariables: () => native.killAllLocalVariables(),
    defineHook: (name, doc = "") => native.defineHook(String(name), String(doc)),
    addHook(hook, run, { local = false, depth, append = false } = {}) {
      if (typeof run !== "function") throw new TypeError("addHook takes a function");
      native.addHook(String(hook), run, Number(depth ?? (append ? 90 : 0)), Boolean(local));
    },
    removeHook(hook, run, { local = false } = {}) {
      if (typeof run === "function") native.removeHook(String(hook), run, Boolean(local));
    },
    runHooks: (hook, ...args) => native.runHooks(String(hook), args),
    runHookWithArgsUntilSuccess: (hook, ...args) => native.runHookUntil(String(hook), args, true),
    runHookWithArgsUntilFailure: (hook, ...args) => native.runHookUntil(String(hook), args, false),
    defineKeymap: (name, parent = null) => native.defineKeymap(String(name), parent === null ? null : String(parent)),
    useLocalMap: (name) => native.useLocalMap(name ?? undefined),
    enabledMinorModes: () => native.enabledMinorModes(),
    documentation: (name) => native.documentation(String(name)),
    commandSource: (name) => native.commandSource(String(name)),
    showHelp: (text) => native.showHelp(String(text)),
    bufferFileName: () => native.bufferFileName(),
    bufferList: () => native.bufferList(),
    yesOrNoP: (question, then) => answering(then, (answer, quit) => native.ask("yes-or-no", String(question), [], answer, quit)),
    yOrNP: (question, then) => answering(then, (answer, quit) => native.ask("y-or-n", String(question), [], answer, quit)),
    readAnswer: (question, answers, then) =>
      answering(then, (answer, quit) => native.ask("answer", String(question), answers.map(String), answer, quit)),
    readCharChoice: (prompt, chars, then) =>
      answering(then, (answer, quit) => native.ask("char", String(prompt), [...String(chars)], answer, quit)),
    completingRead(prompt, collection, then, options) {
      if (typeof then !== "function") [then, options] = [undefined, then];
      options ??= {};
      return answering(then, (answer, quit) =>
        native.read(options.kind ?? "string", String(prompt), {
          collection: options.kind ? undefined : [...collection].map(String),
          category: options.category,
          requireMatch: Boolean(options.requireMatch),
          initial: options.initial,
          default: options.default,
          history: options.history,
        }, answer, quit));
    },
    readFileName(prompt, then, options) {
      if (typeof then !== "function") [then, options] = [undefined, then];
      options ??= {};
      return answering(then, (answer, quit) =>
        native.read("file", String(prompt), {
          dir: options.dir,
          default: options.default,
          initial: options.initial,
          requireMatch: Boolean(options.mustMatch),
          history: options.history,
        }, answer, quit));
    },
    readString(prompt, then, options) {
      if (typeof then !== "function") [then, options] = [undefined, then];
      options ??= {};
      return answering(then, (answer, quit) =>
        native.read("string", String(prompt), {
          initial: options.initial,
          default: options.default,
          history: options.history,
        }, answer, quit));
    },
    minibufferInfo: () => native.minibufferInfo() ?? undefined,
    completionAllSortedCompletions: (options = {}) => native.completionAllSortedCompletions(Boolean(options.atEnd)) ?? undefined,
    completionTryCompletion: (input, names) =>
      native.completionTryCompletion(String(input), names === undefined ? undefined : [...names].map(String)) ?? undefined,
    cacheAllSortedCompletions: (completions) => native.cacheAllSortedCompletions(completions.map(String)),
    setMinibufferOverlay: (overlay) => {
      if (overlay == null) return native.setMinibufferOverlay(undefined, [], []);
      const pieces = (overlay.after ?? []).map((p) => typeof p === "string" ? { text: p } : p);
      native.setMinibufferOverlay(
        String(overlay.before ?? ""),
        pieces.map((p) => String(p.text)),
        pieces.map((p) => p.face == null ? [] : [p.face].flat().map(String)),
      );
    },
    composeLocalMap: (name) => native.composeLocalMap(String(name)),
    fileDirectoryP: (file) => native.fileDirectoryP(String(file)),
    fileAttributes: (file) => native.fileAttributes(String(file)) ?? undefined,
    directoryFiles: (dir) => native.directoryFiles(String(dir)),
    copyFile: (from, to, { okIfExists = false, keepTime = false } = {}) =>
      native.copyFile(String(from), String(to), Boolean(okIfExists), Boolean(keepTime)),
    copyDirectory: (from, to, { keepTime = false } = {}) => native.copyDirectory(String(from), String(to), Boolean(keepTime)),
    renameFile: (from, to, { okIfExists = false } = {}) => native.renameFile(String(from), String(to), Boolean(okIfExists)),
    deleteFile: (file, { trash = false } = {}) => native.deleteFile(String(file), Boolean(trash)),
    makeDirectory: (dir, { parents = false } = {}) => native.makeDirectory(String(dir), Boolean(parents)),
    deleteDirectory: (dir, { recursive = false, trash = false } = {}) =>
      native.deleteDirectory(String(dir), Boolean(recursive), Boolean(trash)),
    abbreviateFileName: (file) => native.abbreviateFileName(String(file)),
    readTextFile: (file) => native.readTextFile(String(file)),
    killNew: (text) => native.killNew(String(text)),
    messages: () => native.messages(),
    projectFiles: (root, { ignores = [] } = {}) => native.projectFiles(String(root), ignores.map(String)),
    stringMatch: (regexp, text, { caseFold = false } = {}) => native.stringMatch(String(regexp), String(text), Boolean(caseFold)) ?? undefined,
    writeTextFile: (file, text, { mode } = {}) => native.writeTextFile(String(file), String(text), mode ?? undefined),
    fileNameDirectory: (file) => {
      const i = String(file).lastIndexOf("/");
      return i < 0 ? undefined : String(file).slice(0, i + 1);
    },
    fileNameNondirectory: (file) => String(file).slice(String(file).lastIndexOf("/") + 1),
    fileNameAsDirectory: (file) => (String(file) === "" ? "./" : String(file).endsWith("/") ? String(file) : `${file}/`),
    directoryFileName: (file) => (String(file).length > 1 ? String(file).replace(/\/+$/, "") || "/" : String(file)),
    whereIs: (command) => native.whereIs(String(command)) ?? undefined,
    frameSize: () => {
      const [columns, lines, maxMiniWindowLines] = native.frameSize();
      return { columns, lines, maxMiniWindowLines };
    },
    runWithTimer: (secs, repeat, fn) => native.runWithTimer(Number(secs), repeat ?? null, false, fn),
    runWithIdleTimer: (secs, repeat, fn) => native.runWithTimer(Number(secs), repeat ? 1 : null, true, fn),
    cancelTimer: (id) => native.cancelTimer(id),
    writeVisitedFile: () => native.writeVisitedFile(),
    revertToVisitedFile: () => native.revertToVisitedFile(),
    recoverFromAutoSave: () => native.recoverFromAutoSave(),
    visitedFileChanged: () => native.visitedFileChanged(),
    setVisitedFileName: (file, { alongWithFile = false } = {}) => native.setVisitedFileName(String(file), Boolean(alongWithFile)),
    expandFileName: (file) => native.expandFileName(String(file)),
    fileExists: (file) => native.fileExists(String(file)),
    autoSaveFileName: (file) => native.autoSaveFileName(String(file)),
    hasNewerAutoSave: (file) => native.hasNewerAutoSave(String(file)),
    doAutoSave: ({ quiet = false } = {}) => native.doAutoSave(Boolean(quiet)),
    setAutoSave: (on) => native.setAutoSave(Boolean(on)),
    autoSaving: () => native.autoSaving(),
    killEmacs: () => native.killEmacs(),
    commandExists: (name) => native.commandExists(String(name)),
    thisCommand: () => native.thisCommand(),
    calledInteractively: () => native.calledInteractively(),
    pushMark: (position, options = {}) => native.pushMark(position, Boolean(options.activate)),
    activateMark: () => native.activateMark(),
    deactivateMark: () => native.deactivateMark(),
    keepMarkActive: (fn) => {
      const changed = native.takeChanged();
      try {
        return fn();
      } finally {
        native.takeChanged();
        native.setChanged(changed);
      }
    },
    regionActive: () => native.regionActive(),

    splitWindow: (window, side = "below", size) => native.splitWindow(window ?? null, side === "right", size ?? null),
    deleteWindow: (window) => native.deleteWindow(window ?? null),
    selectWindow: (window) => native.selectWindow(window),
    selectedWindow: () => native.selectedWindow(),
    windowList: () => native.windowList(),
    lastMouseEvent() {
      const event = native.lastMouseEvent();
      if (event === null || event === undefined) return undefined;
      const start = event.start && { window: event.start.window, position: event.start.position ?? undefined };
      return { window: event.window, position: event.position ?? undefined, start };
    },
    screenLine: (position) => native.screenLine(position),
    windowBuffer: (window) => native.windowBuffer(window ?? native.selectedWindow()) ?? undefined,
    makeFrame: (buffer) => native.makeFrame(buffer === undefined || buffer === null ? null : nameOf(buffer)),
    deleteFrame: (frame) => native.deleteFrame(frame ?? null),
    selectFrame: (frame) => native.selectFrame(frame),
    selectedFrame: () => native.selectedFrame(),
    frameList: () => native.frameList(),
    getBufferCreate: (name) => native.getBufferCreate(nameOf(name)),
    setReadOnly: (on) => native.setReadOnly(Boolean(on)),
    bufferReadOnly: () => native.bufferReadOnly(),
    withCurrentBuffer: (name, fn) => {
      const old = native.bufferIdOf();
      native.setCurrentBuffer(nameOf(name));
      return unwindProtect(fn, () => backTo(old));
    },
    findFileNoselect: (file) => native.findFileNoselect(file),
    setWindowBuffer: (window, buffer) => native.setWindowBuffer(window ?? native.selectedWindow(), nameOf(buffer)),
    windowSize: (window) => {
      const size = native.windowSize(window ?? native.selectedWindow());
      return size
        ? { width: size[0], height: size[1], totalWidth: size[2], totalHeight: size[3], fullWidth: size[4] === 1 }
        : undefined;
    },
    windowUseTime: (window) => native.windowUseTime(window ?? native.selectedWindow()) ?? undefined,
    resizeWindow: (window, delta, horizontal = false, apply = true) =>
      native.resizeWindow(window ?? null, delta, horizontal, apply),
    balanceWindows: () => native.balanceWindows(),

    search(pattern, options = {}) {
      const { from, regexp = false, backward = false, bound, caseFold } = options;
      return native.search(String(pattern), from ?? null, Boolean(regexp), Boolean(backward), bound ?? null, caseFold ?? null) ?? undefined;
    },
    matchData: () => native.matchData() ?? undefined,
    replaceMatch(replacement, options = {}) {
      const [start, end] = native.replaceMatch(String(replacement), Boolean(options.literal), Boolean(options.fixedCase));
      return { start, end };
    },
    foldCaseFor: (pattern, interactive = false) => native.foldCaseFor(String(pattern), Boolean(interactive)),
    setOverridingMap: (keymap) => native.setOverridingMap(keymap ?? null),
    overridingMap: () => native.overridingMap() ?? undefined,
    setKeymapDefault: (keymap, command) => native.setKeymapDefault(String(keymap), command ?? null),
    remapCommand: (keymap, from, to) => native.remapCommand(String(keymap), String(from), to === null ? null : String(to)),
    stringWidth: (text) => native.stringWidth(String(text)),
    unreadKeys: (keys) => native.unreadKeys(String(keys)),

    treesitLanguages: () => native.treesitLanguages(),
    treesitLanguageAvailable: (language) => native.treesitLanguages().includes(String(language)),
    treesitParserCreate: (language) => native.treesitSetLanguage(String(language)),
    treesitParserDelete: () => native.treesitSetLanguage(null),
    treesitLanguage: () => native.treesitLanguage() ?? undefined,
    treesitNodeAt: (pos) => native.treesitNodeAt(pos) ?? undefined,

    putTextProperty: (start, end, name, value) => native.putTextProperty(start, end, String(name), value ?? null),
    removeTextProperty: (start, end, name) => native.removeTextProperty(start, end, String(name)),
    addFaceTextProperty: (start, end, face, { append = false } = {}) =>
      native.addFaceTextProperty(start, end, String(face), Boolean(append)),
    textPropertiesAt: (pos) => native.textPropertiesAt(pos),
    getTextProperty: (pos, name) => native.textPropertiesAt(pos)[String(name)],
    charProperty: (pos, name) => native.charProperty(pos, String(name)),
    nextPropertyChange: (pos) => native.nextPropertyChange(pos),
    nextCharPropertyChange: (pos) => native.nextCharPropertyChange(pos),
    makeOverlay(start, end, properties = {}, options = {}) {
      const id = native.makeOverlay(start, end, options.frontAdvance === true, options.rearAdvance === true);
      for (const [name, value] of Object.entries(properties)) native.overlayPut(id, name, value ?? null);
      return id;
    },
    killRegion: (beg, end) => native.killRegion(beg, end),
    letBind(bindings, fn) {
      // As let: a variable local in the current buffer is bound there, any
      // other in its default value; each is restored where it was bound.
      const restore = [];
      const unbind = () => {
        for (const undo of restore.reverse()) undo();
      };
      return unwindProtect(() => {
        for (const [name, value] of Object.entries(bindings)) {
          if (native.isHook(name)) throw new TypeError(`letBind cannot bind the hook ${name} yet`);
          if (native.isLocalVariable(name)) {
            const buffer = native.bufferIdOf();
            const old = native.variable(name);
            restore.push(() => {
              const there = native.bufferNameOf(buffer);
              if (there === null || there === undefined) return;
              const back = native.bufferIdOf();
              native.setCurrentBuffer(there);
              try {
                native.setVariable(name, old ?? null);
              } finally {
                backTo(back);
              }
            });
            native.setVariable(name, value ?? null);
          } else {
            const old = native.defaultValue(name);
            restore.push(() => native.setDefault(name, old ?? null));
            native.setDefault(name, value ?? null);
          }
        }
        return fn();
      }, unbind);
    },
    emacsRegexp(regexp, { caseFold = false } = {}) {
      const key = `${caseFold ? "i" : "c"}${regexp}`;
      let re = regexps.get(key);
      if (re === undefined) {
        try {
          re = new RegExp(translateEmacsRegexp(String(regexp)), caseFold ? "imu" : "mu");
        } catch (e) {
          ember.signal("invalid-regexp", `Invalid regexp: ${e instanceof Error ? e.message : e}`, [String(regexp)]);
        }
        regexps.set(key, re);
      }
      re.lastIndex = 0;
      return re;
    },
    lookingAt: (regexp, pos, { caseFold } = {}) => native.lookingAt(String(regexp), pos ?? undefined, caseFold ?? undefined),
    reSearchForward(regexp, { bound, noerror = false, caseFold } = {}) {
      const m = ember.search(regexp, { regexp: true, bound, caseFold });
      if (m === undefined) {
        if (noerror) return undefined;
        ember.signal("search-failed", `Search failed: "${regexp}"`, [String(regexp)]);
      }
      native.gotoChar(m.end);
      return m.end;
    },
    reSearchBackward(regexp, { bound, noerror = false, caseFold } = {}) {
      const m = ember.search(regexp, { regexp: true, backward: true, bound, caseFold });
      if (m === undefined) {
        if (noerror) return undefined;
        ember.signal("search-failed", `Search failed: "${regexp}"`, [String(regexp)]);
      }
      native.gotoChar(m.start);
      return m.start;
    },
    matchBeginning: (n = 0) => native.matchData()?.groups[n]?.[0] ?? undefined,
    matchEnd: (n = 0) => native.matchData()?.groups[n]?.[1] ?? undefined,
    matchString(n = 0) {
      const g = native.matchData()?.groups[n];
      return g ? native.bufferText(g[0], g[1]) : undefined;
    },
    signal(symbol, message, data = []) {
      const e = new Error(String(message));
      e.symbol = String(symbol);
      e.data = data;
      e.conditions = native.errorConditions(String(symbol));
      throw e;
    },
    userError: (message) => ember.signal("user-error", message),
    defineError: (symbol, parent = "error") => native.defineError(String(symbol), String(parent)),
    errorConditions: (e) =>
      e instanceof Error && Array.isArray(e.conditions) ? e.conditions : e instanceof Error && typeof e.symbol === "string" ? native.errorConditions(e.symbol) : ["error"],
    conditionCase(fn, handlers) {
      const handle = (e) => {
        // Engine errors are bugs to see, not conditions to handle, unless asked for by name.
        const conditions = ember.errorConditions(e);
        for (const c of conditions) {
          if (Object.prototype.hasOwnProperty.call(handlers, c)) {
            return handlers[c]({
              symbol: e?.symbol ?? "error",
              data: e?.data ?? [],
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
        throw e;
      };
      let result;
      try {
        result = fn();
      } catch (e) {
        return handle(e);
      }
      return isPromise(result) ? result.then(undefined, handle) : result;
    },
    unwindProtect,
    ignoreErrors(fn) {
      return ember.conditionCase(fn, { error: () => undefined });
    },
    defun(name, fn) {
      if (typeof fn !== "function") throw new TypeError("defun takes a name and a function");
      functions.set(String(name), fn);
      native.defun(String(name), fn);
      return String(name);
    },
    fboundp: (name) => native.fboundp(String(name)),
    symbolFunction: (name) => functions.get(String(name)) ?? native.symbolFunction(String(name)),
    funcall(f, ...args) {
      if (typeof f === "function") return f(...args);
      // A script's own function is called directly, so it can take objects;
      // others, and commands, through the editor.
      const fn = functions.get(String(f));
      if (fn !== undefined) return fn(...args);
      return native.funcall(String(f), args);
    },
    charAfter: (pos) => {
      const p = pos ?? native.point();
      return p >= native.pointMin() && p < native.pointMax() ? native.bufferText(p, p + 1) : undefined;
    },
    charBefore: (pos) => {
      const p = (pos ?? native.point()) - 1;
      return p >= native.pointMin() && p < native.pointMax() ? native.bufferText(p, p + 1) : undefined;
    },
    lineBeginningPosition: (pos) => native.lineStart(native.lineOf(pos ?? native.point())),
    lineEndPosition: (pos) => native.lineEnd(native.lineOf(pos ?? native.point())),
    currentIndentation: (pos) => {
      const tab = Number(native.variable("tab-width") ?? 8) || 8;
      let col = 0;
      for (const c of native.lineText(native.lineOf(pos ?? native.point()))) {
        if (c === " ") col++;
        else if (c === "\t") col += tab - (col % tab);
        else break;
      }
      return col;
    },
    indentTo(column) {
      const now = native.currentColumn();
      if (now >= column) return now;
      const tab = Number(native.variable("tab-width") ?? 8);
      let text = "";
      let col = now;
      if (native.variable("indent-tabs-mode") !== false && tab > 0) {
        while (Math.floor(col / tab) < Math.floor(column / tab)) {
          text += "\t";
          col = (Math.floor(col / tab) + 1) * tab;
        }
      }
      native.insert(text + " ".repeat(column - col));
      return column;
    },
    indentLineTo(column) {
      // As indent.el's: to the indentation's end, then only what must change.
      const start = native.lineStart(native.lineOf(native.point()));
      const ws = /^[ \t]*/.exec(native.lineText(native.lineOf(start)))[0].length;
      native.gotoChar(start + ws);
      const cur = native.currentColumn();
      const tab = Number(native.variable("tab-width") ?? 8) || 8;
      if (cur < column) {
        if (column - Math.floor(cur / tab) * tab >= tab) {
          let a = native.point();
          while (a > start && native.bufferText(a - 1, a) === " ") a--;
          native.deleteRegion(a, native.point());
          native.gotoChar(a);
        }
        ember.indentTo(column);
      } else if (cur > column) {
        native.gotoChar(start);
        native.moveToColumn(column);
        if (native.currentColumn() > column) {
          // Inside a tab: the indentation is made again.
          native.deleteRegion(start, start + ws);
          native.gotoChar(start);
          ember.indentTo(column);
        } else {
          native.deleteRegion(native.point(), start + ws);
        }
      }
    },
    skipCharsForward: (chars, limit) => skipChars(String(chars), limit ?? native.pointMax(), 1),
    skipCharsBackward: (chars, limit) => skipChars(String(chars), limit ?? native.pointMin(), -1),
    saveExcursion(fn) {
      const buffer = native.bufferIdOf();
      const marker = native.makeMarker(native.point(), undefined, false);
      return unwindProtect(fn, () => {
        const p = native.markerPosition(marker);
        native.deleteMarker(marker);
        backTo(buffer);
        if (native.bufferIdOf() === buffer && p !== undefined && p !== null) native.gotoChar(p);
      });
    },
    afterPrompts: (fn) => native.afterPrompts(fn),
    makeProcess({ name, buffer, command, directory, env, filter, sentinel, stderr = true }) {
      if (!Array.isArray(command) || command.length === 0) throw new TypeError("makeProcess needs a command: [program, ...args]");
      const pairs = env === undefined ? undefined : Object.entries(env).map(([k, v]) => [String(k), String(v)]);
      return native.makeProcess(
        String(name),
        buffer === undefined || buffer === null ? undefined : nameOf(buffer),
        command.map(String),
        { directory: directory ?? undefined, env: pairs, stderr: stderr !== false },
        filter ?? undefined,
        sentinel ?? undefined,
      );
    },
    processStatus: (name) => native.processInfo(String(name))?.status,
    processExitStatus: (name) => native.processInfo(String(name))?.exitStatus ?? undefined,
    processBuffer: (name) => native.processInfo(String(name))?.buffer ?? undefined,
    processMark: (name) => native.processInfo(String(name))?.mark ?? undefined,
    processCommand: (name) => native.processInfo(String(name))?.command,
    processId: (name) => native.processInfo(String(name))?.pid ?? undefined,
    processQueryOnExitFlag: (name) => native.processInfo(String(name))?.queryOnExit ?? false,
    setProcessQueryOnExitFlag: (name, query) => native.setProcessQueryOnExitFlag(String(name), Boolean(query)),
    processList: () => native.processList(),
    getBufferProcess: (buffer) => native.getBufferProcess(nameOf(buffer)) ?? undefined,
    processSendString: (name, text) => native.processSendString(String(name), String(text)),
    processSendEof: (name) => native.processSendEof(String(name)),
    interruptProcess: (name) => native.signalProcess(String(name), 2),
    killProcess: (name) => native.signalProcess(String(name), 9),
    signalProcess: (name, signal) => native.signalProcess(String(name), signal),
    deleteProcess: (name) => native.deleteProcess(String(name)),
    callProcess: (command, { directory, input } = {}) =>
      native.callProcess(command.map(String), directory ?? undefined, input === undefined ? undefined : String(input)),
    windowStart: () => native.windowStart(),
    prepareChangeGroup: () => native.prepareChangeGroup(),
    cancelChangeGroup: (handle) => native.cancelChangeGroup(handle),
    acceptChangeGroup: (handle) => native.acceptChangeGroup(handle),
    atomicChangeGroup(fn) {
      const handle = native.prepareChangeGroup();
      try {
        const result = fn();
        native.acceptChangeGroup(handle);
        return result;
      } catch (e) {
        native.cancelChangeGroup(handle);
        throw e;
      }
    },
    makeSyntaxTable: (name, parent) => native.makeSyntaxTable(String(name), parent === undefined ? undefined : String(parent)),
    modifySyntaxEntry: (chars, descriptor, table) =>
      native.modifySyntaxEntry(String(chars), String(descriptor), table === undefined ? undefined : String(table)),
    syntaxTable: () => native.syntaxTable(),
    setSyntaxTable: (name) => native.setSyntaxTable(String(name)),
    syntaxEntry: (c) => native.syntaxEntry(String(c)) ?? undefined,
    charSyntax: (c) => (native.syntaxEntry(String(c)) ?? " ")[0],
    matchingParen: (c) => {
      const d = native.syntaxEntry(String(c)) ?? "";
      return "()".includes(d[0]) && d[1] !== undefined && d[1] !== " " ? d[1] : undefined;
    },
    scanLists: (from, count, depth) => native.scanLists(from, count, depth, false) ?? null,
    scanSexps: (from, count) => native.scanLists(from, count, 0, true) ?? null,
    forwardComment: (count = 1) => native.forwardComment(count),
    backwardPrefixChars: () => native.backwardPrefixChars(),
    parsePartialSexp: (from, to) => {
      const st = native.parsePartialSexp(from, to);
      for (const k of ["innermostStart", "lastComplete", "inString", "inComment", "start"]) st[k] ??= null;
      return st;
    },
    syntaxPpss: (pos) => {
      const st = native.parsePartialSexp(undefined, pos ?? native.point());
      for (const k of ["innermostStart", "lastComplete", "inString", "inComment", "start"]) st[k] ??= null;
      return st;
    },
    skipSyntaxForward: (syntaxes, limit) => {
      const not = syntaxes.startsWith("^");
      const set = not ? syntaxes.slice(1) : syntaxes;
      const end = limit ?? native.pointMax();
      let p = native.point();
      const start = p;
      while (p < end) {
        const d = (native.syntaxEntry(native.bufferText(p, p + 1)) ?? " ")[0];
        if (set.includes(d) === not) break;
        p++;
      }
      native.gotoChar(p);
      return p - start;
    },
    skipSyntaxBackward: (syntaxes, limit) => {
      const not = syntaxes.startsWith("^");
      const set = not ? syntaxes.slice(1) : syntaxes;
      const end = limit ?? native.pointMin();
      let p = native.point();
      const start = p;
      while (p > end) {
        const d = (native.syntaxEntry(native.bufferText(p - 1, p)) ?? " ")[0];
        if (set.includes(d) === not) break;
        p--;
      }
      native.gotoChar(p);
      return start - p;
    },
    substCharInRegion: (start, end, from, to) => native.substCharInRegion(start, end, String(from), String(to)),
    makeMarker(pos, { buffer, advances = false } = {}) {
      const id = native.makeMarker(pos ?? native.point(), buffer === undefined ? undefined : nameOf(buffer), Boolean(advances));
      const m = new Marker(id);
      markersFreed.register(m, id, m.__emberMarkerToken);
      return m;
    },
    Marker,
    deleteMarker(m) {
      if (m instanceof Marker) markersFreed.unregister(m.__emberMarkerToken);
      native.deleteMarker(markerId(m));
    },
    markerPosition: (m) => native.markerPosition(markerId(m)) ?? undefined,
    markerBuffer: (m) => native.markerBuffer(markerId(m)) ?? undefined,
    setMarker: (m, pos, buffer) =>
      native.setMarker(markerId(m), pos === null || pos === undefined ? undefined : pos, buffer === undefined ? undefined : nameOf(buffer)),
    overlayPut: (id, name, value) => native.overlayPut(id, String(name), value ?? null),
    overlayGet: (id, name) => native.overlayGet(id, String(name)),
    overlayStart: (id) => native.overlayRange(id)?.[0],
    overlayEnd: (id) => native.overlayRange(id)?.[1],
    moveOverlay: (id, start, end) => native.moveOverlay(id, start, end),
    deleteOverlay: (id) => native.deleteOverlay(id),
    overlaysIn: (start, end) => native.overlaysIn(start, end),
    overlaysAt: (pos) => native.overlaysIn(pos, pos + 1).filter((id) => native.overlayRange(id)[0] <= pos && pos < native.overlayRange(id)[1]),
    invisibleAt: (pos) => native.invisibleAt(pos),
    lineCount: () => native.lineCount(),
    lineOf: (pos) => native.lineOf(pos),
    lineStart: (line) => native.lineStart(line),
    lineEnd: (line) => native.lineEnd(line),
    lineText: (line) => native.lineText(line),
    bufferSize: () => native.bufferSize(),
    pointMin: () => native.pointMin(),
    pointMax: () => native.pointMax(),
    narrowToRegion: (start, end) => native.narrowToRegion(start, end),
    widen: () => native.widen(),
    bufferModifiedTick: () => native.bufferModifiedTick(),
    bufferModified: () => native.bufferModified(),
    setBufferModified: (modified) => native.setBufferModified(Boolean(modified)),
    // As Emacs's add-to-invisibility-spec: a spec of true becomes a list
    // that still hides text whose invisible property is true.
    addToInvisibilitySpec(name, { ellipsis = false } = {}) {
      const spec = native.variable("buffer-invisibility-spec");
      const entries = Array.isArray(spec) ? spec.filter((e) => (Array.isArray(e) ? e[0] : e) !== name) : [true];
      native.setVariable("buffer-invisibility-spec", [...entries, ellipsis ? [String(name), true] : String(name)]);
    },
    removeFromInvisibilitySpec(name) {
      const spec = native.variable("buffer-invisibility-spec");
      if (Array.isArray(spec)) {
        native.setVariable("buffer-invisibility-spec", spec.filter((e) => (Array.isArray(e) ? e[0] : e) !== name));
      }
    },
    defineFace({ name, doc = "", attributes = {}, dark = {}, light = {} }) {
      native.defineFace(String(name), String(doc), attributes, dark, light);
    },
    setFaceAttribute: (name, attributes, { background = "both" } = {}) =>
      native.setFaceAttribute(String(name), attributes, String(background)),
    faceAttributes: (name, { dark = true } = {}) => native.faceAttributes(String(name), Boolean(dark)),
    faceInfo: (name) => native.faceInfo(String(name)) ?? undefined,

    // As Emacs's derived-mode-p: whether the buffer's major mode is one of
    // these or built on one.
    derivedModeP(...modes) {
      for (let mode = majorModes.get(native.variable("major-mode")); mode; mode = mode.parent === null ? undefined : majorModes.get(mode.parent)) {
        if (modes.includes(mode.name)) return true;
      }
      return false;
    },

    defineMajorMode({ name, modeName, parent = null, doc = "", bindings, setup, syntax }) {
      if (parent !== null && !majorModes.has(parent)) {
        throw new TypeError(`Major mode ${name} is built on ${parent}, which is not a major mode`);
      }
      const keymap = `${name}-map`;
      native.defineKeymap(keymap, parent === null ? null : `${parent}-map`);
      bindAll(keymap, bindings);
      native.defineHook(`${name}-hook`, `Run after entering ${modeName} mode, after the hooks of the modes it is built on.`);
      // NAME-syntax-table, built on the parent mode's, as define-derived-mode makes it.
      const syntaxTable = `${name}-syntax-table`;
      native.makeSyntaxTable(syntaxTable, parent === null ? undefined : `${parent}-syntax-table`);
      for (const [chars, descriptor] of Object.entries(syntax ?? {})) native.modifySyntaxEntry(chars, String(descriptor), syntaxTable);
      majorModes.set(name, { name, parent, modeName: String(modeName), keymap, setup, syntaxTable });
      return ember.defineCommand({ name, doc, run: () => enterMajorMode(name) });
    },

    defineMinorMode({ name, lighter = "", doc = "", global = false, bindings, onChange }) {
      const pretty = prettyName(name);
      const keymap = `${name}-map`;
      native.defineVariable(
        name,
        `Whether ${pretty} mode is on${global ? "" : " in this buffer"}. Use the command ${name} to change it.`,
        false,
        !global,
      );
      native.defineKeymap(keymap, null);
      bindAll(keymap, bindings);
      native.defineHook(`${name}-hook`, `Run after ${pretty} mode is turned on or off.`);
      native.defineHook(`${name}-on-hook`, `Run after ${pretty} mode is turned on.`);
      native.defineHook(`${name}-off-hook`, `Run after ${pretty} mode is turned off.`);
      native.registerMinorMode(name, String(lighter), keymap, Boolean(global));
      return ember.defineCommand({
        name,
        doc:
          `${doc}\n\nRun from a key or M-x, it turns the mode on if it is off and off if it is on. ` +
          "A positive prefix argument turns it on and zero or a negative one turns it off. " +
          "Called from code without an argument, it turns the mode on.",
        run: () => {
          const arg = native.prefixArg();
          const interactive = native.calledInteractively();
          const enable =
            arg === null ? (interactive ? !isTrue(native.variable(name)) : true) : ember.prefixNumericValue(arg) > 0;
          native.setVariable(name, enable);
          if (onChange) onChange(enable);
          native.runHooks(`${name}-hook`);
          native.runHooks(`${name}-${enable ? "on" : "off"}-hook`);
          if (interactive) {
            native.message(`${pretty} mode ${enable ? "enabled" : "disabled"}${global ? "" : " in current buffer"}`);
          }
        },
      });
    },

    setTransientMap: (bindings) =>
      native.setTransientMap(
        Object.fromEntries(Object.entries(bindings).map(([keys, command]) => [String(keys), String(command)])),
      ),
  });

  globalThis.console = Object.freeze({
    log: (...items) => native.message(items.map(String).join(" ")),
  });
})();
