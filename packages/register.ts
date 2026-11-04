// Registers, after Emacs's register.el: places, text, numbers, rectangles
// and window configurations kept under a character, on C-x r.

import { keyChar } from "simple";
import { insertRectangle, lastKilledRectangle } from "rect";

/** What a register holds. */
export type RegisterValue =
  | { kind: "position"; marker: gnista.Marker }
  | { kind: "text"; text: string | gnista.PropertizedString }
  | { kind: "number"; value: number }
  | { kind: "rectangle"; lines: string[] }
  | { kind: "window"; configuration: gnista.WindowConfiguration; marker: gnista.Marker };

/** The registers, by name, as register-alist. */
const registers = new Map<string, RegisterValue>();

/** The registers and what each holds, as register-alist, for packages such as consult to list. */
export function registerAlist(): [string, RegisterValue][] {
  return [...registers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reads a register's name, a character typed after the prompt, as register-read-with-preview does traditionally. */
async function readRegister(prompt: string): Promise<string> {
  const key = await gnista.readKey(prompt);
  const c = keyChar(key);
  if (c === undefined) throw new Error("Non-character input-event");
  return c!;
}

/** A register's name as single-key-description writes it. */
const describe = (r: string): string => (r === " " ? "SPC" : r);

gnista.defineCommand({
  name: "point-to-register",
  doc: "Store point's position in a register, to go back to with C-x r j.",
  run: async () => {
    const r = await readRegister("Point to register: ");
    registers.set(r, { kind: "position", marker: gnista.makeMarker(gnista.point()) });
  },
});

gnista.defineCommand({
  name: "window-configuration-to-register",
  doc: "Store the frame's windows and what they show in a register, to restore with C-x r j.",
  run: async () => {
    const r = await readRegister("Window configuration to register: ");
    registers.set(r, { kind: "window", configuration: gnista.currentWindowConfiguration(), marker: gnista.makeMarker(gnista.point()) });
  },
});

gnista.defineCommand({
  name: "jump-to-register",
  doc: "Go to the position or restore the window configuration stored in a register.",
  run: async () => {
    const r = await readRegister("Jump to register: ");
    const val = registers.get(r);
    if (val?.kind === "position") {
      const buffer = gnista.markerBuffer(val.marker);
      if (buffer === undefined) gnista.userError("That register’s buffer no longer exists");
      gnista.call("switch-to-buffer", buffer!);
      const pos = gnista.markerPosition(val.marker)!;
      if (gnista.point() !== pos && gnista.lastCommand() !== "jump-to-register") gnista.pushMark(gnista.point());
      gnista.gotoChar(pos);
    } else if (val?.kind === "window") {
      gnista.setWindowConfiguration(val.configuration);
      const pos = gnista.markerPosition(val.marker);
      if (pos !== undefined) gnista.gotoChar(pos);
    } else {
      gnista.userError("Register doesn’t contain a buffer position or configuration");
    }
  },
});

/** The region's text into a register, deleted with `del`, joined onto what it holds with `join`. */
function textToRegister(r: string, start: number, end: number, del: boolean, join?: "append" | "prepend"): void {
  const text = gnista.bufferSubstring(start, end);
  const old = registers.get(r);
  if (join === undefined || old === undefined) {
    registers.set(r, { kind: "text", text });
  } else if (old.kind === "text") {
    const [a, b] = join === "append" ? [String(old.text), String(text)] : [String(text), String(old.text)];
    registers.set(r, { kind: "text", text: a + b });
  } else {
    gnista.userError("Register does not contain text");
  }
  if (del) gnista.deleteRegion(start, end);
  gnista.deactivateMark();
}

const region = [
  { name: "start", kind: "region-beginning" },
  { name: "end", kind: "region-end" },
  { name: "del", kind: "prefix" },
] as const;

for (const [name, doc, prompt, join] of [
  ["copy-to-register", "Copy the region's text into a register, to insert with C-x r i; with a prefix argument, delete it too.", "Copy to register: ", undefined],
  ["append-to-register", "Add the region's text to the end of the text in a register; with a prefix argument, delete it too.", "Append to register: ", "append"],
  ["prepend-to-register", "Add the region's text to the start of the text in a register; with a prefix argument, delete it too.", "Prepend to register: ", "prepend"],
] as const) {
  gnista.defineCommand({
    name,
    doc,
    params: [...region],
    run: async (start: number, end: number, del: gnista.PrefixArg) => {
      const r = await readRegister(prompt);
      textToRegister(r, start, end, del !== null, join);
    },
  });
}

gnista.defineCommand({
  name: "copy-rectangle-to-register",
  doc: "Copy the rectangle between point and the mark into a register, to insert with C-x r i; with a prefix argument, delete it too.",
  params: [...region],
  run: async (start: number, end: number, del: gnista.PrefixArg) => {
    const r = await readRegister("Copy rectangle to register: ");
    gnista.saveExcursion(() => {
      gnista.call(del !== null ? "kill-rectangle" : "copy-rectangle-as-kill", start, end);
    });
    registers.set(r, { kind: "rectangle", lines: lastKilledRectangle() ?? [] });
    gnista.deactivateMark();
  },
});

gnista.defineCommand({
  name: "number-to-register",
  doc: "Store a number in a register: the prefix argument, or else the number after point, which point moves past.",
  params: [{ name: "number", kind: "prefix" }],
  run: async (number: gnista.PrefixArg) => {
    const r = await readRegister("Number to register: ");
    let value = 0;
    if (number !== null) {
      value = gnista.prefixNumericValue(number);
    } else if (gnista.lookingAt("\\s-*-?[0-9]+")) {
      value = parseInt(gnista.matchString(0)!.trim(), 10);
      gnista.gotoChar(gnista.matchEnd(0)!);
    }
    registers.set(r, { kind: "number", value });
  },
});

gnista.defineCommand({
  name: "increment-register",
  doc: "Add the prefix argument, 1 by default, to the number in a register; to one with text, or none, add the region's text.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: async (prefix: gnista.PrefixArg) => {
    const r = await readRegister("Increment register: ");
    const val = registers.get(r);
    if (val?.kind === "number") {
      registers.set(r, { kind: "number", value: val.value + gnista.prefixNumericValue(prefix) });
    } else if (val === undefined || val.kind === "text") {
      // The region only now, as a number needs none.
      const mark = gnista.mark();
      if (mark === undefined) gnista.userError("The mark is not set now, so there is no region");
      textToRegister(r, Math.min(mark!, gnista.point()), Math.max(mark!, gnista.point()), prefix !== null, "append");
    }
    else gnista.userError("Register does not contain a number or text");
  },
});

gnista.defineCommand({
  name: "insert-register",
  doc: "Insert what a register holds, leaving point before it and the mark after; with a prefix argument, point after it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: async (arg: gnista.PrefixArg) => {
    if (gnista.bufferReadOnly()) gnista.signal("buffer-read-only", `Buffer is read-only: ${gnista.bufferName()}`);
    const r = await readRegister("Insert register: ");
    gnista.pushMark(gnista.point());
    const val = registers.get(r);
    if (val?.kind === "text") gnista.insertForYank(val.text);
    else if (val?.kind === "number") gnista.insert(String(val.value));
    else if (val?.kind === "rectangle") insertRectangle(val.lines);
    else if (val?.kind === "position" && gnista.markerPosition(val.marker) !== undefined) gnista.insert(String(gnista.markerPosition(val.marker)! + 1));
    else gnista.userError("Register does not contain text");
    if (arg === null) gnista.call("exchange-point-and-mark");
  },
});

gnista.defineCommand({
  name: "view-register",
  doc: "Say what a register holds.",
  run: async () => {
    const r = await readRegister("View register: ");
    const val = registers.get(r);
    if (val === undefined) {
      gnista.message(`Register ${describe(r)} is empty`);
      return;
    }
    let text = `Register ${describe(r)} contains `;
    if (val.kind === "number") text += `${val.value}`;
    else if (val.kind === "text") text += `text:\n${String(val.text)}`;
    else if (val.kind === "rectangle") text += `the rectangle:\n${val.lines.join("\n")}`;
    else if (val.kind === "window") text += "a window configuration.";
    else text += `a buffer position:\nbuffer ${gnista.markerBuffer(val.marker) ?? "(killed)"}, position ${(gnista.markerPosition(val.marker) ?? 0) + 1}`;
    gnista.showHelp(text);
  },
});

for (const [keys, command] of [
  ["C-x r SPC", "point-to-register"],
  ["C-x r C-SPC", "point-to-register"],
  ["C-x r C-@", "point-to-register"],
  ["C-x r j", "jump-to-register"],
  ["C-x r s", "copy-to-register"],
  ["C-x r x", "copy-to-register"],
  ["C-x r i", "insert-register"],
  ["C-x r g", "insert-register"],
  ["C-x r r", "copy-rectangle-to-register"],
  ["C-x r n", "number-to-register"],
  ["C-x r +", "increment-register"],
  ["C-x r w", "window-configuration-to-register"],
] as const) {
  gnista.bindKey(keys, command);
}
