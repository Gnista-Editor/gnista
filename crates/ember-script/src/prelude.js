// Builds the `ember` global from the native functions. Runs once, before any user script.
"use strict";
(() => {
  const native = globalThis.__ember;
  delete globalThis.__ember;

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
        })),
        run,
      );
      return name;
    },
    bindKey: (keys, command) => native.bindKey(String(keys), String(command)),
    call: (name, ...args) => native.call(String(name), ...args.map(String)),
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
    setTransientMap: (bindings) =>
      native.setTransientMap(
        Object.fromEntries(Object.entries(bindings).map(([keys, command]) => [String(keys), String(command)])),
      ),
  });

  globalThis.console = Object.freeze({
    log: (...items) => native.message(items.map(String).join(" ")),
  });
})();
