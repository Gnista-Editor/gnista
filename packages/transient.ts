// Transient menus, after transient.el 0.10: a prefix command shows its
// suffixes in a window below, grouped in columns, and the keys it shows run
// them. Suffixes run and leave the menu, or run and stay; infix arguments,
// switches (-a, --all) and options (--author=), are set in the menu and read
// by the suffix with transientArgs; a prefix's suffix can be another prefix,
// to which C-g goes back. C-g quits one menu and C-q all of them.
//
// A prefix is defined with transientDefinePrefix and its layout as groups:
//
//   transientDefinePrefix("my-menu", { doc: "...", groups: [
//     { description: "File", items: [["o", "Open", "find-file"], ["-a", "All", "--all"]] },
//   ] });
//
// A group whose items are groups shows them side by side, as Lisp's nested
// vectors do; class "row" puts a group's suffixes on one line. A suffix is
// [key, description, command or argument, options], or the name of a suffix
// defined with transientDefineSuffix, which carries its own key and
// description.

import { truthy } from "subr";

gnista.defineFace({ name: "transient-heading", doc: "Face used for headings.", attributes: { inherit: "font-lock-keyword-face" } });
gnista.defineFace({ name: "transient-key", doc: "Face used for keys.", attributes: { inherit: "font-lock-builtin-face" } });
gnista.defineFace({ name: "transient-argument", doc: "Face used for enabled arguments.", attributes: { inherit: "font-lock-string-face", weight: "bold" } });
gnista.defineFace({ name: "transient-inactive-argument", doc: "Face used for inactive arguments.", attributes: { inherit: "shadow" } });
gnista.defineFace({ name: "transient-inapt-argument", doc: "Face used for enabled arguments of an inapt suffix.", attributes: { inherit: "shadow", weight: "bold" } });
gnista.defineFace({ name: "transient-value", doc: "Face used for values.", attributes: { inherit: "font-lock-string-face", weight: "bold" } });
gnista.defineFace({ name: "transient-inactive-value", doc: "Face used for inactive values.", attributes: { inherit: "shadow" } });
gnista.defineFace({ name: "transient-unreachable", doc: "Face used for suffixes unreachable from the current prefix sequence.", attributes: { inherit: "shadow" } });
gnista.defineFace({ name: "transient-inapt-suffix", doc: "Face used for suffixes that are inapt at this time.", attributes: { inherit: "shadow", slant: "italic" } });
gnista.defineFace({ name: "transient-active-infix", doc: "Face used for the infix for which the value is being read.", attributes: { inherit: "highlight" } });
gnista.defineFace({ name: "transient-delimiter", doc: "Face used for delimiters and separators.", attributes: { inherit: "shadow" } });
gnista.defineFace({ name: "transient-unreachable-key", doc: "Face used for keys unreachable from the current prefix sequence.", attributes: { inherit: "shadow", weight: "normal" } });
const keyFaces: [string, string, string, string][] = [
  ["transient-key-stay", "Face used for keys of suffixes that don't exit the menu.", "#22aa22", "#ddffdd"],
  ["transient-key-noop", "Face used for keys of suffixes that currently cannot be invoked.", "grey80", "grey30"],
  ["transient-key-return", "Face used for keys of suffixes that return to the parent menu.", "#aaaa11", "#ffffcc"],
  ["transient-key-recurse", "Face used for keys of sub-menus whose suffixes return to the current menu.", "#2266ff", "#2299ff"],
  ["transient-key-stack", "Face used for keys of sub-menus that exit the current menu.", "#dd4488", "#ff6699"],
  ["transient-key-exit", "Face used for keys of suffixes that exit the menu.", "#aa2222", "#ffdddd"],
];
for (const [name, doc, light, dark] of keyFaces) {
  gnista.defineFace({ name, doc, attributes: { inherit: "transient-key" }, light: { foreground: light }, dark: { foreground: dark } });
}

gnista.defineVariable({
  name: "transient-semantic-coloring",
  doc: "Whether keys are coloured by what their suffixes do: stay in the menu, exit it, or go into another.",
  value: true,
});
gnista.defineVariable({ name: "transient-force-single-column", doc: "Whether to show the suffixes in one column, rather than side by side.", value: false });
gnista.defineVariable({ name: "transient-current-command", doc: "The transient prefix command from which the running suffix was invoked.", value: null });
gnista.defineVariable({ name: "transient-current-prefix", doc: "The name of the prefix whose menu is showing, or from which the running suffix was invoked.", value: null });

/** Text, its faces with it. */
type Text = string | gnista.PropertizedString;
/** A description: text, or a function giving it, called in the buffer the menu was invoked from. */
export type Description = Text | (() => Text | undefined);
type Command = string;
type Predicate = () => unknown;

/** What a suffix can say beside its key, description and command or argument, as transient's slots. */
export interface SuffixOptions {
  description?: Description;
  /** Whether running it leaves the menu: true stays, false exits; for a prefix, true returns to this menu after it. */
  transient?: boolean;
  if?: Predicate;
  ifNot?: Predicate;
  ifMode?: string | string[];
  ifNotMode?: string | string[];
  ifDerived?: string | string[];
  ifNotDerived?: string | string[];
  ifNil?: string;
  ifNonNil?: string;
  inaptIf?: Predicate;
  inaptIfNot?: Predicate;
  /** For an option, the values to choose from. */
  choices?: string[];
  /** For an option, what reads its value, called with the prompt and the value now. */
  reader?: (prompt: string, initial: string | undefined) => string;
  prompt?: string;
  /** What it is, if not worked out: "switch", "option", "suffix", "information". */
  class?: "switch" | "option" | "switches" | "suffix" | "information";
  /** For switches, how the argument is made from a choice, %s for it: "--%s-order". */
  argumentFormat?: string;
  /** Shows the description only, as :info. */
  info?: Description;
  format?: string;
  face?: string;
  level?: number;
  key?: string;
}

/** A suffix in a layout: [key, description, command or argument, options], or a suffix defined by name. */
export type SuffixSpec = [string, Description, Command | DefinedFunction, SuffixOptions?] | [string, SuffixOptions & { info: Description }] | string;
type DefinedFunction = (() => unknown) & { readonly name?: string };

export interface Group {
  description?: Description;
  class?: "column" | "row" | "columns" | "subgroups";
  /** Pads each key to the widest of the group's keys, or to this many columns. */
  padKeys?: boolean | number;
  hide?: Predicate;
  if?: Predicate;
  ifNot?: Predicate;
  items: (SuffixSpec | Group | null)[];
}

export interface PrefixDefinition {
  doc?: string;
  /** The value the infix arguments start with: arguments, or a function or variable that gives them. */
  value?: string[] | (() => string[]) | string;
  /** Whether suffixes stay in the menu unless they say otherwise. */
  transientSuffix?: boolean;
  /** Whether keys that are no suffix's run their commands and stay, rather than being refused. */
  transientNonSuffix?: boolean;
  groups: Group[];
}

/** A suffix as the menu has it once it is set up, as transient's suffix objects. */
interface Suffix {
  key: string;
  description?: Description;
  command: string;
  kind: "suffix" | "prefix" | "infix" | "information";
  argument?: string;
  infixClass?: "switch" | "option" | "switches";
  options: SuffixOptions;
  /** For an infix: its value, true for a switch that is on, the string for an option. */
  value?: string | boolean;
  inapt?: boolean;
}

interface Layout {
  group: Group;
  children: (Layout | Suffix | string)[];
}

/** Each prefix's definition, by name. */
const prefixes = new Map<string, PrefixDefinition>();
/** Each suffix defined by name, with its own key and description. */
const definedSuffixes = new Map<string, SuffixOptions & { key?: string; description?: Description }>();

// The menu showing: its prefix, its suffixes and values, and the menus it was entered from.
interface Active {
  prefix: string;
  layout: Layout[];
  suffixes: Suffix[];
  buffer: gnista.Buffer;
  window: number;
}
let active: Active | undefined;
/** The menus a sub-menu was entered from, to go back to: their prefix and infix values. */
const stack: { prefix: string; values: Map<string, string | boolean | undefined>; returnHere: boolean }[] = [];
/** The values infixes had when the menu last showed, kept across a suffix that stays. */
let values = new Map<string, string | boolean | undefined>();

const BUFFER = " *transient*";
const MAP = "transient--map";
gnista.defineKeymap(MAP);

// Setting a menu up.

function oneOf(mode: string | string[] | undefined): boolean {
  const modes = mode === undefined ? [] : Array.isArray(mode) ? mode : [mode];
  return modes.includes(String(gnista.variable("major-mode")));
}

/** Whether a suffix or group shows, as transient--do-suffix-p. */
function shows(o: SuffixOptions | Group): boolean {
  const s = o as SuffixOptions;
  if (s.if) return truthy(s.if() as gnista.Value);
  if (s.ifNot) return !truthy(s.ifNot() as gnista.Value);
  if (s.ifNonNil) return truthy(gnista.variable(s.ifNonNil));
  if (s.ifNil) return !truthy(gnista.variable(s.ifNil));
  if (s.ifMode !== undefined) return oneOf(s.ifMode);
  if (s.ifNotMode !== undefined) return !oneOf(s.ifNotMode);
  if (s.ifDerived !== undefined) return gnista.derivedModeP(...[s.ifDerived].flat());
  if (s.ifNotDerived !== undefined) return !gnista.derivedModeP(...[s.ifNotDerived].flat());
  return true;
}

function inapt(o: SuffixOptions): boolean {
  if (o.inaptIf) return truthy(o.inaptIf() as gnista.Value);
  if (o.inaptIfNot) return !truthy(o.inaptIfNot() as gnista.Value);
  return false;
}

/** The name of a command given as a function, defined once as transient does with a transient:PREFIX:KEY symbol. */
function commandName(prefix: string, key: string, command: Command | DefinedFunction): string {
  if (typeof command === "string") return command;
  const name = `transient:${prefix}:${key.replace(/ /g, "")}`;
  if (!gnista.fboundp(name)) gnista.defineCommand({ name, doc: "A suffix of a transient menu.", run: () => void command() });
  return name;
}

/** A suffix of PREFIX from its spec, as transient--parse-suffix and transient--init-suffix make it. */
function makeSuffix(prefix: string, spec: SuffixSpec): Suffix | undefined {
  let key: string;
  let description: Description | undefined;
  let target: Command | DefinedFunction | undefined;
  let options: SuffixOptions;
  if (typeof spec === "string") {
    const defined = definedSuffixes.get(spec);
    if (!defined) return { key: "", command: spec, kind: prefixes.has(spec) ? "prefix" : "suffix", options: {} };
    ({ key = "", description } = defined);
    target = spec;
    options = defined;
  } else if (spec.length === 2) {
    [key, options] = spec;
    description = options.info;
    return { key, description, command: "", kind: "information", options };
  } else {
    [key, description, target, options = {}] = spec;
  }
  if (options.description !== undefined) description = options.description;
  if (!shows(options)) return undefined;
  const isArgument =
    typeof target === "string" && (/^-/.test(target) || options.class === "switch" || options.class === "option" || options.class === "switches") && options.class !== "suffix";
  const suffix: Suffix = isArgument
    ? {
        key,
        description,
        command: `transient:${prefix}:${target}`,
        kind: "infix",
        argument: target as string,
        infixClass:
          options.class === "switch" || options.class === "option" || options.class === "switches"
            ? options.class
            : (target as string).endsWith("=") || options.choices || options.reader
              ? "option"
              : "switch",
        options,
      }
    : { key, description, command: commandName(prefix, key, target!), kind: prefixes.has(target as string) ? "prefix" : "suffix", options };
  suffix.inapt = inapt(options);
  return suffix;
}

/** The layout of a group, its children set up, as transient--init-child. */
function makeLayout(prefix: string, group: Group): Layout | undefined {
  if (!shows(group)) return undefined;
  const children: (Layout | Suffix | string)[] = [];
  for (const item of group.items) {
    if (item === null) continue;
    if (typeof item === "object" && !Array.isArray(item)) {
      const sub = makeLayout(prefix, item);
      if (sub) children.push(sub);
    } else if (typeof item === "string" && !definedSuffixes.has(item) && !prefixes.has(item)) {
      // Text, as a string in a Lisp group is: "" leaves a cell blank.
      children.push(item);
    } else {
      const suffix = makeSuffix(prefix, item);
      if (suffix) children.push(suffix);
    }
  }
  return { group, children };
}

function classOf(layout: Layout): NonNullable<Group["class"]> {
  return layout.group.class ?? (layout.group.items.some((i) => i !== null && typeof i === "object" && !Array.isArray(i)) ? "columns" : "column");
}

function flatten(layouts: Layout[]): Suffix[] {
  return layouts.flatMap((l) => l.children.flatMap((c) => (typeof c === "string" ? [] : "group" in c ? flatten([c]) : [c])));
}

/** The value a prefix starts with, as its :value says. */
function initialValue(prefix: string): string[] {
  const value = prefixes.get(prefix)?.value;
  if (value === undefined) return [];
  if (typeof value === "function") return value();
  if (typeof value === "string") {
    const v = gnista.variable(value);
    return Array.isArray(v) ? v.map(String) : [];
  }
  return value;
}

/** Gives each infix its value from VALUE, a list of arguments, as transient-init-value does. */
function initValues(suffixes: Suffix[], value: string[]): Map<string, string | boolean | undefined> {
  const map = new Map<string, string | boolean | undefined>();
  for (const s of suffixes) {
    if (s.kind !== "infix") continue;
    const arg = s.argument!;
    if (s.infixClass === "switch") {
      map.set(s.command, value.includes(arg) ? true : undefined);
    } else if (s.infixClass === "switches") {
      const format = s.options.argumentFormat ?? `${arg}%s`;
      map.set(s.command, value.find((a) => (s.options.choices ?? []).some((c) => format.replace("%s", c) === a)));
    } else {
      const found = value.find((a) => a.startsWith(arg));
      map.set(s.command, found === undefined ? undefined : found.slice(arg.length));
    }
  }
  return map;
}

// Drawing.

/** A suffix's key as the menu shows it, padded and in the face for what it does. */
function formatKey(s: Suffix, pad: number | undefined): Text {
  let key = s.key;
  if (pad !== undefined) key = key.padEnd(pad);
  return face(key, keyFace(s));
}

function keyFace(s: Suffix): string {
  if (!truthy(gnista.variable("transient-semantic-coloring"))) return s.command ? "transient-key" : "transient-key-noop";
  const kind = behaviour(s);
  return kind === "stay" || kind === "infix" ? "transient-key-stay" : kind === "stack" ? "transient-key-stack" : kind === "recurse" ? "transient-key-recurse" : "transient-key-exit";
}

/** What running a suffix does, as transient--make-predicate-map works it out. */
function behaviour(s: Suffix): "exit" | "stay" | "stack" | "recurse" | "infix" {
  if (s.kind === "infix") return "infix";
  const transient = s.options.transient ?? (s.kind === "suffix" ? prefixes.get(active?.prefix ?? "")?.transientSuffix : undefined);
  if (s.kind === "prefix") return transient === true ? "recurse" : "stack";
  return transient ? "stay" : "exit";
}

function describe(d: Description | undefined): Text | undefined {
  if (typeof d === "function") return active ? gnista.withCurrentBuffer(active.buffer, d) : d();
  return d;
}

/** A suffix's value as the menu shows it, as transient-format-value. */
function formatValue(s: Suffix): Text {
  const value = values.get(s.command);
  if (s.infixClass === "switch") return face(s.argument!, value ? (s.inapt ? "transient-inapt-argument" : "transient-argument") : "transient-inactive-argument");
  if (s.infixClass === "switches") {
    // --[topo|author-date|date]-order, the chosen one lit, as transient-switches show.
    const format = s.options.argumentFormat ?? `${s.argument}%s`;
    const [before, after] = format.split("%s");
    const choices = (s.options.choices ?? []).flatMap((c, i) => [...(i > 0 ? [face("|", "transient-delimiter")] : []), face(c, format.replace("%s", c) === value ? "transient-value" : "transient-inactive-value")]);
    const f = value ? "transient-argument" : "transient-inactive-argument";
    return gnista.concat(face(before, f), face("[", "transient-delimiter"), ...choices, face("]", "transient-delimiter"), face(after ?? "", f));
  }
  if (value === undefined) return face(s.argument!, "transient-inactive-argument");
  return gnista.concat(face(s.argument!, s.inapt ? "transient-inapt-argument" : "transient-argument"), face(String(value), s.inapt ? "transient-inapt-argument" : "transient-value"));
}

/** TEXT in face F; text that has faces of its own keeps them, as transient-format-description leaves a description's faces. */
const face = (text: Text, f: string): Text => (typeof text === "string" ? gnista.propertize(text, { face: f }) : text);
const width = (text: Text): number => [...String(text)].length;

/** A suffix as a line of the menu, as transient-format. */
function formatSuffix(s: Suffix, pad: number | undefined): Text {
  const format = s.options.format ?? (s.kind === "infix" ? " %k %d (%v)" : s.kind === "information" ? " %k %d" : " %k %d");
  let desc = describe(s.description);
  desc = desc === undefined ? face("(BUG: no description)", "error") : s.options.face ? face(desc, s.options.face) : desc;
  if (s.inapt) desc = face(desc, "transient-inapt-suffix");
  const key = s.kind === "information" ? (s.key || " ") : formatKey(s, pad);
  const parts = format.split(/(%[kdv%])/).map((p) => (p === "%k" ? key : p === "%d" ? desc! : p === "%v" ? formatValue(s) : p === "%%" ? "%" : p));
  return gnista.concat(...parts);
}

/** How wide a group's keys are padded, as transient--maybe-pad-keys. */
function padOf(layout: Layout, parent?: Layout): number | undefined {
  const pad = layout.group.padKeys ?? parent?.group.padKeys;
  if (!pad) return undefined;
  const widths = layout.children.filter((c): c is Suffix => typeof c !== "string" && !("group" in c)).map((s) => [...s.key].length);
  return Math.max(typeof pad === "number" ? pad : 0, ...widths);
}

function groupDescription(layout: Layout): Text | undefined {
  const desc = describe(layout.group.description);
  return desc === undefined ? undefined : face(desc, "transient-heading");
}

/** The text of a group's lines, as transient--insert-group. */
function insertGroup(layout: Layout, parent?: Layout): void {
  const desc = groupDescription(layout);
  if (desc !== undefined) {
    gnista.insert(desc);
    gnista.insert("\n");
  }
  const kind = truthy(gnista.variable("transient-force-single-column")) && classOf(layout) === "columns" ? "single" : classOf(layout);
  const suffixes = (l: Layout) => l.children.filter((c): c is Suffix | string => typeof c === "string" || !("group" in c));
  const cell = (c: Suffix | string, pad: number | undefined) => (typeof c === "string" ? face(c, "transient-heading") : formatSuffix(c, pad));
  if (kind === "row") {
    const pad = padOf(layout, parent);
    for (const s of suffixes(layout)) {
      gnista.insert(cell(s, pad));
      gnista.insert("   ");
    }
    gnista.insert("\n");
  } else if (kind === "column") {
    const pad = padOf(layout, parent);
    for (const s of suffixes(layout)) {
      const str = cell(s, pad);
      if (String(str) === "") continue;
      gnista.insert(str);
      if (!/.\n$/.test(String(str))) gnista.insert("\n");
    }
  } else if (kind === "single") {
    for (const c of layout.children) if (typeof c !== "string" && "group" in c) insertGroup(c, layout);
  } else if (kind === "columns") {
    const columns = layout.children
      .filter((c): c is Layout => typeof c !== "string" && "group" in c)
      .map((column) => {
        const pad = padOf(column, layout);
        const head = groupDescription(column);
        return [...(head !== undefined ? [head] : []), ...suffixes(column).map((s) => cell(s, pad))];
      });
    // Each column starts two past the widest cell of the one before.
    const stops: number[] = [0];
    for (const column of columns.slice(0, -1)) stops.push(stops[stops.length - 1] + 2 + Math.max(0, ...column.map(width)));
    const rows = Math.max(0, ...columns.map((c) => c.length));
    for (let row = 0; row < rows; row++) {
      columns.forEach((column, i) => {
        const text = column[row];
        if (text === undefined) return;
        const at = gnista.currentColumn();
        if (stops[i] > 0) gnista.insert(" ".repeat(Math.max(0, stops[i] - at)));
        gnista.insert(text);
      });
      gnista.insert("\n");
    }
  } else {
    // Subgroups: each in turn, a blank line between.
    const subs = layout.children.filter((c): c is Layout => typeof c !== "string" && "group" in c);
    subs.forEach((sub, i) => {
      insertGroup(sub, layout);
      if (i < subs.length - 1) gnista.insert("\n");
    });
  }
}

/** Shows the menu, in a window along the bottom of the frame, as transient--show. */
function show(): void {
  if (!active) return;
  gnista.getBufferCreate(BUFFER);
  gnista.withCurrentBuffer(BUFFER, () => {
    gnista.letBind({ "inhibit-read-only": true }, () => {
      gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
      const groups = active!.layout.filter((l) => !(l.group.hide && truthy(gnista.withCurrentBuffer(active!.buffer, l.group.hide) as gnista.Value)));
      groups.forEach((layout, i) => {
        insertGroup(layout);
        if (i < groups.length - 1) gnista.insert("\n");
      });
      gnista.gotoChar(gnista.pointMin());
    });
    for (const [name, value] of [
      ["mode-line-format", null],
      ["truncate-lines", true],
      ["cursor-type", null],
    ] as const) {
      gnista.makeLocalVariable(name);
      gnista.setVariable(name, value);
    }
    gnista.setBufferModified(false);
  });
  const lines = gnista.withCurrentBuffer(BUFFER, () => gnista.bufferSubstringNoProperties(gnista.pointMin(), gnista.pointMax()).replace(/\n$/, "").split("\n").length);
  const live = active.window !== 0 && gnista.windowList().includes(active.window);
  if (live && gnista.windowSize(active.window)?.totalHeight !== lines) {
    gnista.deleteWindow(active.window);
    active.window = 0;
  }
  if (!live || active.window === 0) {
    const selected = gnista.selectedWindow();
    active.window = gnista.splitRootWindow("below", -Math.max(1, lines));
    gnista.setWindowBuffer(active.window, BUFFER);
    gnista.setWindowDedicatedP(active.window, true);
    gnista.selectWindow(selected);
  }
}

/** Takes the menu's window away, as transient--delete-window. */
function hide(): void {
  if (active && active.window !== 0 && gnista.windowList().includes(active.window)) gnista.deleteWindow(active.window);
  if (gnista.bufferLiveP(gnista.getBuffer(BUFFER))) gnista.call("kill-buffer", BUFFER);
  if (active) active.window = 0;
}

/**
 * KEY in Gnista's notation, as kbd reads transient's: a word that is no one
 * key, such as "-a", is its characters one after another.
 */
function kbdKeys(key: string): string {
  const one = /^(?:[ACHMSs]-)*(?:.|RET|SPC|TAB|ESC|DEL|LFD|NUL|<[^>]+>)$/u;
  return key
    .split(" ")
    .filter((w) => w !== "")
    .flatMap((w) => (one.test(w) ? [w] : [...w]))
    .join(" ");
}

/** Binds the active suffixes' keys, as transient--make-transient-map, and takes over the keyboard. */
function bindKeys(): void {
  const map = gnista.makeSparseKeymap();
  for (const s of active!.suffixes) {
    if (s.kind === "information" || !s.key) continue;
    const keys = kbdKeys(s.key);
    if (gnista.lookupKey(map, keys) === undefined) gnista.defineKey(map, keys, dispatchCommand(s));
  }
  for (const [key, command] of [
    ["C-g", quitOne],
    ["C-q", quitAll],
    ["ESC ESC ESC", quitAll],
  ] as const) {
    if (gnista.lookupKey(map, key) === undefined) gnista.defineKey(map, key, command);
  }
  gnista.setKeymapParent(MAP, null);
  gnista.setKeymapParent(MAP, map);
  gnista.setKeymapDefault(MAP, prefixes.get(active!.prefix)?.transientNonSuffix ? null : undefinedKey);
  gnista.setOverridingMap(MAP);
}

/** The command a suffix's key runs in the menu: one for each key, as transient's infix commands are one for each argument. */
const dispatchers = new Map<string, gnista.DefinedCommand>();
function dispatchCommand(s: Suffix): gnista.DefinedCommand {
  const name = `transient--dispatch:${s.key}`;
  if (!dispatchers.has(name)) {
    dispatchers.set(name, gnista.defineCommand({
      name,
      doc: "Run the suffix of the menu showing that this key is.",
      run: () => {
        const suffix = active?.suffixes.find((x) => x.key === s.key);
        if (suffix) runSuffix(suffix);
      },
    }));
  }
  return dispatchers.get(name)!;
}

// Running.

/** The infix arguments of the menu now, as transient-args gives them while a suffix runs. */
function currentArgs(): string[] {
  if (!active) return [];
  const args: string[] = [];
  for (const s of active.suffixes) {
    if (s.kind !== "infix") continue;
    const value = values.get(s.command);
    if (value === undefined || value === false) continue;
    args.push(s.infixClass === "switch" ? s.argument! : s.infixClass === "switches" ? String(value) : `${s.argument}${value}`);
  }
  return args;
}

/** The arguments a running suffix's prefix has, as transient-args: the menu's, or the prefix's start value. */
let lastArgs: { prefix: string; args: string[] } | undefined;
export function transientArgs(prefix: string | string[]): string[] {
  const names = Array.isArray(prefix) ? prefix : [prefix];
  const current = gnista.variable("transient-current-command");
  if (typeof current === "string" && names.includes(current) && lastArgs?.prefix === current) return lastArgs.args;
  return initialValue(names[0]);
}

/** The value of ARG in ARGS: whether a switch is there, or an option's value, as transient-arg-value. */
export function transientArgValue(arg: string, args: string[]): string | boolean | undefined {
  if (!arg.endsWith("=")) return args.includes(arg);
  const base = arg.slice(0, -1);
  const found = args.find((a) => a === base || a.startsWith(arg));
  return found === undefined ? undefined : found.slice(arg.length);
}

/** Runs COMMAND as the suffix of the menu, the menu's arguments in transientArgs, with the keyboard its own. */
function callSuffix(command: string): void {
  const prefix = active!.prefix;
  lastArgs = { prefix, args: currentArgs() };
  gnista.setOverridingMap(null);
  gnista.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => {
    gnista.callInteractively(command as gnista.CommandName);
  });
}

function runSuffix(s: Suffix): void {
  if (s.inapt) {
    invalid("Inapt command");
    return;
  }
  const kind = behaviour(s);
  if (kind === "infix") {
    readInfix(s);
    refresh();
    return;
  }
  if (kind === "stack" || kind === "recurse") {
    stack.push({ prefix: active!.prefix, values, returnHere: kind === "recurse" });
    const buffer = active!.buffer;
    hide();
    gnista.setOverridingMap(null);
    setup(s.command, buffer);
    return;
  }
  if (kind === "stay") {
    try {
      callSuffix(s.command);
    } finally {
      if (active) refresh();
    }
    return;
  }
  // Exit: the menu goes, then the suffix runs, still able to read its
  // arguments. A suffix that quits one menu, as casual's do, goes back to
  // the menu before; any other leaves them all, unless this menu was
  // entered to return to the one before.
  const prefix = active!.prefix;
  const args = currentArgs();
  const parent = stack.length > 0 && stack[stack.length - 1].returnHere ? stack.pop() : undefined;
  exit(false);
  lastArgs = { prefix, args };
  try {
    gnista.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => gnista.callInteractively(s.command as gnista.CommandName));
  } finally {
    if (parent && !active) {
      values = parent.values;
      setup(parent.prefix, gnista.currentBuffer(), true);
    } else if (!active) {
      stack.length = 0;
    }
  }
}

/** Shows the menu again and binds its keys, its suffixes' predicates and descriptions worked out afresh. */
function refresh(): void {
  if (!active) return;
  const buffer = gnista.bufferLiveP(active.buffer) ? active.buffer : gnista.currentBuffer();
  active.buffer = buffer;
  const defs = prefixes.get(active.prefix)!;
  gnista.withCurrentBuffer(buffer, () => {
    active!.layout = defs.groups.map((g) => makeLayout(active!.prefix, g)).filter((l): l is Layout => l !== undefined);
  });
  active.suffixes = flatten(active.layout);
  show();
  bindKeys();
}

/** Reads an infix's new value, as transient-infix-read: a switch toggles, an option is read or, when set, unset. */
function readInfix(s: Suffix): void {
  const now = values.get(s.command);
  if (s.infixClass === "switch") {
    values.set(s.command, now ? undefined : true);
    return;
  }
  if (s.infixClass === "switches") {
    // Each press takes the next choice, then none, as transient-switches do.
    const format = s.options.argumentFormat ?? `${s.argument}%s`;
    const args = (s.options.choices ?? []).map((c) => format.replace("%s", c));
    const at = now === undefined ? -1 : args.indexOf(String(now));
    values.set(s.command, at + 1 < args.length ? args[at + 1] : undefined);
    return;
  }
  if (now !== undefined) {
    values.set(s.command, undefined);
    return;
  }
  const prompt = s.options.prompt ?? `${s.argument}`;
  gnista.setOverridingMap(null);
  try {
    const value = s.options.reader
      ? s.options.reader(prompt, undefined)
      : s.options.choices
        ? gnista.completingRead(prompt, s.options.choices, { requireMatch: true })
        : gnista.readString(prompt);
    values.set(s.command, value === "" ? undefined : value);
  } finally {
    gnista.setOverridingMap(MAP);
  }
}

function invalid(message: string): void {
  gnista.ding();
  gnista.message(`${message}: \`${gnista.thisSingleCommandKeys()}' (Use \`C-g' to abort, \`?' for help)`);
}

/** Sets a prefix's menu up and shows it, as transient-setup. */
function setup(prefix: string, buffer: gnista.Buffer, keepValues = false): void {
  const defs = prefixes.get(prefix);
  if (!defs) gnista.signal("error", `Not a transient prefix: ${prefix}`);
  active = { prefix, layout: [], suffixes: [], buffer, window: 0 };
  gnista.withCurrentBuffer(buffer, () => {
    active!.layout = defs.groups.map((g) => makeLayout(prefix, g)).filter((l): l is Layout => l !== undefined);
  });
  active.suffixes = flatten(active.layout);
  if (!keepValues) values = initValues(active.suffixes, gnista.withCurrentBuffer(buffer, () => initialValue(prefix)));
  gnista.setVariable("transient-current-prefix", prefix);
  show();
  bindKeys();
}

/** Leaves the menu, and with ALL every menu it was entered from. */
function exit(all: boolean): void {
  hide();
  gnista.setOverridingMap(null);
  active = undefined;
  if (all) stack.length = 0;
  gnista.setVariable("transient-current-prefix", null);
}

const quitOne = gnista.defineCommand({
  name: "transient-quit-one",
  doc: "Exit the current transient, returning to the outer one, if any.",
  run: () => {
    // Also from a suffix that runs it once the menu has gone, as casual's Back does.
    const parent = stack.pop();
    const buffer = active?.buffer ?? gnista.currentBuffer();
    exit(false);
    if (parent) {
      values = parent.values;
      setup(parent.prefix, buffer, true);
    }
  },
});

const quitAll = gnista.defineCommand({
  name: "transient-quit-all",
  doc: "Exit all transients without saving the transient stack.",
  run: () => exit(true),
});

const undefinedKey = gnista.defineCommand({
  name: "transient-undefined",
  doc: "Warn the user that the pressed key is not bound to any suffix.",
  run: () => invalid("Unbound suffix"),
});

/** Whether there are menus to go back to, as transient--stack is non-nil. */
export function transientStackP(): boolean {
  return stack.length > 0;
}

/**
 * Defines a transient prefix command NAME, as transient-define-prefix: run,
 * it shows its groups below and takes the keys they show.
 */
export function transientDefinePrefix(name: string, definition: PrefixDefinition): gnista.DefinedCommand {
  prefixes.set(name, definition);
  return gnista.defineCommand({
    name,
    doc: definition.doc ?? "A transient menu.",
    run: () => {
      if (active) exit(true);
      setup(name, gnista.currentBuffer());
    },
  });
}

/**
 * Defines a suffix command NAME with its own key and description, as
 * transient-define-suffix, to put in a layout by its name.
 */
export function transientDefineSuffix(
  name: string,
  definition: SuffixOptions & { key?: string; description?: Description; doc?: string; run: () => unknown },
): gnista.DefinedCommand {
  definedSuffixes.set(name, definition);
  return gnista.defineCommand({ name, doc: definition.doc ?? "A transient suffix.", run: () => void definition.run() });
}

/** The suffix spec for transient-quit-one and transient-quit-all, for a layout to name. */
transientDefineSuffix("transient-quit-one-suffix", { key: "C-g", description: "Quit", run: () => gnista.call(quitOne) });
