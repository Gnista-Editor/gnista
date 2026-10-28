// Builds the `ember` global from the native functions. Runs once, before any user script.
"use strict";
(() => {
  const native = globalThis.__ember;
  delete globalThis.__ember;

  // Hook ids by function, so a function can be removed by passing it again.
  const hookIds = new Map();
  const hookKey = (hook, local) => (local ? `${hook} in ${native.bufferName()}` : hook);

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
      if (mode.setup) mode.setup();
    }
    for (const mode of chain) native.runHooks(`${mode.name}-hook`);
    native.runHooks("after-change-major-mode-hook");
  }

  globalThis.ember = Object.freeze({
    defineCommand(definition) {
      if (typeof definition !== "object" || definition === null) {
        throw new TypeError("defineCommand takes an object: { name, doc, params, run }");
      }
      const { name, doc = "", params = [], run } = definition;
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
          prompt: p.prompt ?? `${p.name}: `,
          history: p.history === undefined ? null : String(p.history),
        })),
        run,
      );
      return name;
    },
    bindKey: (keys, command, keymap = "global-map") => native.bindKey(String(keys), String(command), String(keymap)),
    call: (name, ...args) => native.call(String(name), ...args.map(String)),
    callInteractively: (name) => native.callInteractively(String(name)),
    callWithPrefix: (prefix, name, ...args) => native.callWithPrefix(prefix ?? null, String(name), ...args.map(String)),
    message: (text) => native.message(String(text)),
    insert: (text) => native.insert(String(text)),
    point: () => native.point(),
    gotoChar: (position) => native.gotoChar(position),
    // Omitted arguments must not reach the native function as undefined.
    bufferText: (start, end) =>
      end === undefined
        ? start === undefined ? native.bufferText() : native.bufferText(start)
        : native.bufferText(start ?? 0, end),
    deleteRegion: (start, end) => native.deleteRegion(start, end),
    bufferName: () => native.bufferName(),
    mark: () => native.mark(),
    prefixArg: () => native.prefixArg(),
    prefixNumericValue: (arg = native.prefixArg()) =>
      arg === null ? 1 : arg === "-" ? -1 : Array.isArray(arg) ? arg[0] : arg,
    setPrefixArg: (arg) => native.setPrefixArg(arg ?? null),
    lastKey: () => native.lastKey(),
    currentKill: (n = 0) => native.currentKill(n),
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
    addHook(hook, run, { local = false } = {}) {
      if (typeof run !== "function") throw new TypeError("addHook takes a function");
      const key = hookKey(String(hook), local);
      const ids = hookIds.get(run) ?? new Map();
      // As in Emacs, a function already on the hook is not added again.
      if (ids.has(key)) return;
      ids.set(key, native.addHook(String(hook), run.name || "anonymous function", run, Boolean(local)));
      hookIds.set(run, ids);
    },
    removeHook(hook, run, { local = false } = {}) {
      const ids = hookIds.get(run);
      const key = hookKey(String(hook), local);
      if (ids?.has(key)) {
        native.removeHook(String(hook), ids.get(key), Boolean(local));
        ids.delete(key);
      }
    },
    runHooks: (hook, ...args) => native.runHooks(String(hook), args),
    defineKeymap: (name, parent = null) => native.defineKeymap(String(name), parent === null ? null : String(parent)),
    useLocalMap: (name) => native.useLocalMap(name ?? undefined),
    enabledMinorModes: () => native.enabledMinorModes(),
    documentation: (name) => native.documentation(String(name)),
    commandSource: (name) => native.commandSource(String(name)),
    showHelp: (text) => native.showHelp(String(text)),
    bufferFileName: () => native.bufferFileName(),
    commandExists: (name) => native.commandExists(String(name)),
    thisCommand: () => native.thisCommand(),
    calledInteractively: () => native.calledInteractively(),
    pushMark: (position, options = {}) => native.pushMark(position, Boolean(options.activate)),
    activateMark: () => native.activateMark(),
    deactivateMark: () => native.deactivateMark(),
    regionActive: () => native.regionActive(),

    splitWindow: (window, side = "below") => native.splitWindow(window ?? null, side === "right"),
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
    makeOverlay(start, end, properties = {}) {
      const id = native.makeOverlay(start, end);
      for (const [name, value] of Object.entries(properties)) native.overlayPut(id, name, value ?? null);
      return id;
    },
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

    defineMajorMode({ name, modeName, parent = null, doc = "", bindings, setup }) {
      if (parent !== null && !majorModes.has(parent)) {
        throw new TypeError(`Major mode ${name} is built on ${parent}, which is not a major mode`);
      }
      const keymap = `${name}-map`;
      native.defineKeymap(keymap, parent === null ? null : `${parent}-map`);
      bindAll(keymap, bindings);
      native.defineHook(`${name}-hook`, `Run after entering ${modeName} mode, after the hooks of the modes it is built on.`);
      majorModes.set(name, { name, parent, modeName: String(modeName), keymap, setup });
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
