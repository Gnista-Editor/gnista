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

ember.defineFace({ name: "transient-heading", doc: "Face used for headings.", attributes: { inherit: "font-lock-keyword-face" } });
ember.defineFace({ name: "transient-key", doc: "Face used for keys.", attributes: { inherit: "font-lock-builtin-face" } });
ember.defineFace({ name: "transient-argument", doc: "Face used for enabled arguments.", attributes: { inherit: "font-lock-string-face", weight: "bold" } });
ember.defineFace({ name: "transient-inactive-argument", doc: "Face used for inactive arguments.", attributes: { inherit: "shadow" } });
ember.defineFace({ name: "transient-inapt-argument", doc: "Face used for enabled arguments of an inapt suffix.", attributes: { inherit: "shadow", weight: "bold" } });
ember.defineFace({ name: "transient-value", doc: "Face used for values.", attributes: { inherit: "font-lock-string-face", weight: "bold" } });
ember.defineFace({ name: "transient-inactive-value", doc: "Face used for inactive values.", attributes: { inherit: "shadow" } });
ember.defineFace({ name: "transient-unreachable", doc: "Face used for suffixes unreachable from the current prefix sequence.", attributes: { inherit: "shadow" } });
ember.defineFace({ name: "transient-inapt-suffix", doc: "Face used for suffixes that are inapt at this time.", attributes: { inherit: "shadow", slant: "italic" } });
ember.defineFace({ name: "transient-active-infix", doc: "Face used for the infix for which the value is being read.", attributes: { inherit: "highlight" } });
ember.defineFace({ name: "transient-delimiter", doc: "Face used for delimiters and separators.", attributes: { inherit: "shadow" } });
ember.defineFace({ name: "transient-unreachable-key", doc: "Face used for keys unreachable from the current prefix sequence.", attributes: { inherit: "shadow", weight: "normal" } });
const keyFaces: [string, string, string, string][] = [
  ["transient-key-stay", "Face used for keys of suffixes that don't exit the menu.", "#22aa22", "#ddffdd"],
  ["transient-key-noop", "Face used for keys of suffixes that currently cannot be invoked.", "grey80", "grey30"],
  ["transient-key-return", "Face used for keys of suffixes that return to the parent menu.", "#aaaa11", "#ffffcc"],
  ["transient-key-recurse", "Face used for keys of sub-menus whose suffixes return to the current menu.", "#2266ff", "#2299ff"],
  ["transient-key-stack", "Face used for keys of sub-menus that exit the current menu.", "#dd4488", "#ff6699"],
  ["transient-key-exit", "Face used for keys of suffixes that exit the menu.", "#aa2222", "#ffdddd"],
];
for (const [name, doc, light, dark] of keyFaces) {
  ember.defineFace({ name, doc, attributes: { inherit: "transient-key" }, light: { foreground: light }, dark: { foreground: dark } });
}

ember.defineVariable({
  name: "transient-semantic-coloring",
  doc: "Whether keys are coloured by what their suffixes do: stay in the menu, exit it, or go into another.",
  value: true,
});
ember.defineVariable({ name: "transient-force-single-column", doc: "Whether to show the suffixes in one column, rather than side by side.", value: false });
ember.defineVariable({ name: "transient-current-command", doc: "The transient prefix command from which the running suffix was invoked.", value: null });
ember.defineVariable({ name: "transient-current-prefix", doc: "The name of the prefix whose menu is showing, or from which the running suffix was invoked.", value: null });

/** Text, its faces with it. */
type Text = string | ember.PropertizedString;
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
  class?: "switch" | "option" | "suffix" | "information";
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
  infixClass?: "switch" | "option";
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
  buffer: ember.Buffer;
  window: number;
}
let active: Active | undefined;
/** The menus a sub-menu was entered from, to go back to: their prefix and infix values. */
const stack: { prefix: string; values: Map<string, string | boolean | undefined>; returnHere: boolean }[] = [];
/** The values infixes had when the menu last showed, kept across a suffix that stays. */
let values = new Map<string, string | boolean | undefined>();

const BUFFER = " *transient*";
const MAP = "transient--map";
ember.defineKeymap(MAP);

// Setting a menu up.

function oneOf(mode: string | string[] | undefined): boolean {
  const modes = mode === undefined ? [] : Array.isArray(mode) ? mode : [mode];
  return modes.includes(String(ember.variable("major-mode")));
}

/** Whether a suffix or group shows, as transient--do-suffix-p. */
function shows(o: SuffixOptions | Group): boolean {
  const s = o as SuffixOptions;
  if (s.if) return truthy(s.if() as ember.Value);
  if (s.ifNot) return !truthy(s.ifNot() as ember.Value);
  if (s.ifNonNil) return truthy(ember.variable(s.ifNonNil));
  if (s.ifNil) return !truthy(ember.variable(s.ifNil));
  if (s.ifMode !== undefined) return oneOf(s.ifMode);
  if (s.ifNotMode !== undefined) return !oneOf(s.ifNotMode);
  if (s.ifDerived !== undefined) return ember.derivedModeP(...[s.ifDerived].flat());
  if (s.ifNotDerived !== undefined) return !ember.derivedModeP(...[s.ifNotDerived].flat());
  return true;
}

function inapt(o: SuffixOptions): boolean {
  if (o.inaptIf) return truthy(o.inaptIf() as ember.Value);
  if (o.inaptIfNot) return !truthy(o.inaptIfNot() as ember.Value);
  return false;
}

/** The name of a command given as a function, defined once as transient does with a transient:PREFIX:KEY symbol. */
function commandName(prefix: string, key: string, command: Command | DefinedFunction): string {
  if (typeof command === "string") return command;
  const name = `transient:${prefix}:${key.replace(/ /g, "")}`;
  if (!ember.fboundp(name)) ember.defineCommand({ name, doc: "A suffix of a transient menu.", run: () => void command() });
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
  const isArgument = typeof target === "string" && /^-/.test(target) && options.class !== "suffix";
  const suffix: Suffix = isArgument
    ? {
        key,
        description,
        command: `transient:${prefix}:${target}`,
        kind: "infix",
        argument: target as string,
        infixClass: options.class === "switch" || options.class === "option" ? options.class : (target as string).endsWith("=") || options.choices || options.reader ? "option" : "switch",
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
    const v = ember.variable(value);
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
  if (!truthy(ember.variable("transient-semantic-coloring"))) return s.command ? "transient-key" : "transient-key-noop";
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
  if (typeof d === "function") return active ? ember.withCurrentBuffer(active.buffer, d) : d();
  return d;
}

/** A suffix's value as the menu shows it, as transient-format-value. */
function formatValue(s: Suffix): Text {
  const value = values.get(s.command);
  if (s.infixClass === "switch") return face(s.argument!, value ? (s.inapt ? "transient-inapt-argument" : "transient-argument") : "transient-inactive-argument");
  if (value === undefined) return face(s.argument!, "transient-inactive-argument");
  return ember.concat(face(s.argument!, s.inapt ? "transient-inapt-argument" : "transient-argument"), face(String(value), s.inapt ? "transient-inapt-argument" : "transient-value"));
}

/** TEXT in face F; text that has faces of its own keeps them, as transient-format-description leaves a description's faces. */
const face = (text: Text, f: string): Text => (typeof text === "string" ? ember.propertize(text, { face: f }) : text);
const width = (text: Text): number => [...String(text)].length;

/** A suffix as a line of the menu, as transient-format. */
function formatSuffix(s: Suffix, pad: number | undefined): Text {
  const format = s.options.format ?? (s.kind === "infix" ? " %k %d (%v)" : s.kind === "information" ? " %k %d" : " %k %d");
  let desc = describe(s.description);
  desc = desc === undefined ? face("(BUG: no description)", "error") : s.options.face ? face(desc, s.options.face) : desc;
  if (s.inapt) desc = face(desc, "transient-inapt-suffix");
  const key = s.kind === "information" ? (s.key || " ") : formatKey(s, pad);
  const parts = format.split(/(%[kdv%])/).map((p) => (p === "%k" ? key : p === "%d" ? desc! : p === "%v" ? formatValue(s) : p === "%%" ? "%" : p));
  return ember.concat(...parts);
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
    ember.insert(desc);
    ember.insert("\n");
  }
  const kind = truthy(ember.variable("transient-force-single-column")) && classOf(layout) === "columns" ? "single" : classOf(layout);
  const suffixes = (l: Layout) => l.children.filter((c): c is Suffix | string => typeof c === "string" || !("group" in c));
  const cell = (c: Suffix | string, pad: number | undefined) => (typeof c === "string" ? face(c, "transient-heading") : formatSuffix(c, pad));
  if (kind === "row") {
    const pad = padOf(layout, parent);
    for (const s of suffixes(layout)) {
      ember.insert(cell(s, pad));
      ember.insert("   ");
    }
    ember.insert("\n");
  } else if (kind === "column") {
    const pad = padOf(layout, parent);
    for (const s of suffixes(layout)) {
      const str = cell(s, pad);
      if (String(str) === "") continue;
      ember.insert(str);
      if (!/.\n$/.test(String(str))) ember.insert("\n");
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
        const at = ember.currentColumn();
        if (stops[i] > 0) ember.insert(" ".repeat(Math.max(0, stops[i] - at)));
        ember.insert(text);
      });
      ember.insert("\n");
    }
  } else {
    // Subgroups: each in turn, a blank line between.
    const subs = layout.children.filter((c): c is Layout => typeof c !== "string" && "group" in c);
    subs.forEach((sub, i) => {
      insertGroup(sub, layout);
      if (i < subs.length - 1) ember.insert("\n");
    });
  }
}

/** Shows the menu, in a window along the bottom of the frame, as transient--show. */
function show(): void {
  if (!active) return;
  ember.getBufferCreate(BUFFER);
  ember.withCurrentBuffer(BUFFER, () => {
    ember.letBind({ "inhibit-read-only": true }, () => {
      ember.deleteRegion(ember.pointMin(), ember.pointMax());
      const groups = active!.layout.filter((l) => !(l.group.hide && truthy(ember.withCurrentBuffer(active!.buffer, l.group.hide) as ember.Value)));
      groups.forEach((layout, i) => {
        insertGroup(layout);
        if (i < groups.length - 1) ember.insert("\n");
      });
      ember.gotoChar(ember.pointMin());
    });
    for (const [name, value] of [
      ["mode-line-format", null],
      ["truncate-lines", true],
      ["cursor-type", null],
    ] as const) {
      ember.makeLocalVariable(name);
      ember.setVariable(name, value);
    }
    ember.setBufferModified(false);
  });
  const lines = ember.withCurrentBuffer(BUFFER, () => ember.bufferSubstringNoProperties(ember.pointMin(), ember.pointMax()).replace(/\n$/, "").split("\n").length);
  const live = active.window !== 0 && ember.windowList().includes(active.window);
  if (live && ember.windowSize(active.window)?.totalHeight !== lines) {
    ember.deleteWindow(active.window);
    active.window = 0;
  }
  if (!live || active.window === 0) {
    const selected = ember.selectedWindow();
    active.window = ember.splitRootWindow("below", -Math.max(1, lines));
    ember.setWindowBuffer(active.window, BUFFER);
    ember.setWindowDedicatedP(active.window, true);
    ember.selectWindow(selected);
  }
}

/** Takes the menu's window away, as transient--delete-window. */
function hide(): void {
  if (active && active.window !== 0 && ember.windowList().includes(active.window)) ember.deleteWindow(active.window);
  if (ember.bufferLiveP(ember.getBuffer(BUFFER))) ember.call("kill-buffer", BUFFER);
  if (active) active.window = 0;
}

/**
 * KEY in Ember's notation, as kbd reads transient's: a word that is no one
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
  const map = ember.makeSparseKeymap();
  for (const s of active!.suffixes) {
    if (s.kind === "information" || !s.key) continue;
    const keys = kbdKeys(s.key);
    if (ember.lookupKey(map, keys) === undefined) ember.defineKey(map, keys, dispatchCommand(s));
  }
  for (const [key, command] of [
    ["C-g", quitOne],
    ["C-q", quitAll],
    ["ESC ESC ESC", quitAll],
  ] as const) {
    if (ember.lookupKey(map, key) === undefined) ember.defineKey(map, key, command);
  }
  ember.setKeymapParent(MAP, null);
  ember.setKeymapParent(MAP, map);
  ember.setKeymapDefault(MAP, prefixes.get(active!.prefix)?.transientNonSuffix ? null : undefinedKey);
  ember.setOverridingMap(MAP);
}

/** The command a suffix's key runs in the menu: one for each key, as transient's infix commands are one for each argument. */
const dispatchers = new Map<string, ember.DefinedCommand>();
function dispatchCommand(s: Suffix): ember.DefinedCommand {
  const name = `transient--dispatch:${s.key}`;
  if (!dispatchers.has(name)) {
    dispatchers.set(name, ember.defineCommand({
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
    args.push(s.infixClass === "switch" ? s.argument! : `${s.argument}${value}`);
  }
  return args;
}

/** The arguments a running suffix's prefix has, as transient-args: the menu's, or the prefix's start value. */
let lastArgs: { prefix: string; args: string[] } | undefined;
export function transientArgs(prefix: string | string[]): string[] {
  const names = Array.isArray(prefix) ? prefix : [prefix];
  const current = ember.variable("transient-current-command");
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
  ember.setOverridingMap(null);
  ember.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => {
    ember.callInteractively(command as ember.CommandName);
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
    ember.setOverridingMap(null);
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
    ember.letBind({ "transient-current-command": prefix, "transient-current-prefix": prefix }, () => ember.callInteractively(s.command as ember.CommandName));
  } finally {
    if (parent && !active) {
      values = parent.values;
      setup(parent.prefix, ember.currentBuffer(), true);
    } else if (!active) {
      stack.length = 0;
    }
  }
}

/** Shows the menu again and binds its keys, its suffixes' predicates and descriptions worked out afresh. */
function refresh(): void {
  if (!active) return;
  const buffer = ember.bufferLiveP(active.buffer) ? active.buffer : ember.currentBuffer();
  active.buffer = buffer;
  const defs = prefixes.get(active.prefix)!;
  ember.withCurrentBuffer(buffer, () => {
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
  if (now !== undefined) {
    values.set(s.command, undefined);
    return;
  }
  const prompt = s.options.prompt ?? `${s.argument}`;
  ember.setOverridingMap(null);
  try {
    const value = s.options.reader
      ? s.options.reader(prompt, undefined)
      : s.options.choices
        ? ember.completingRead(prompt, s.options.choices, { requireMatch: true })
        : ember.readString(prompt);
    values.set(s.command, value === "" ? undefined : value);
  } finally {
    ember.setOverridingMap(MAP);
  }
}

function invalid(message: string): void {
  ember.ding();
  ember.message(`${message}: \`${ember.thisSingleCommandKeys()}' (Use \`C-g' to abort, \`?' for help)`);
}

/** Sets a prefix's menu up and shows it, as transient-setup. */
function setup(prefix: string, buffer: ember.Buffer, keepValues = false): void {
  const defs = prefixes.get(prefix);
  if (!defs) ember.signal("error", `Not a transient prefix: ${prefix}`);
  active = { prefix, layout: [], suffixes: [], buffer, window: 0 };
  ember.withCurrentBuffer(buffer, () => {
    active!.layout = defs.groups.map((g) => makeLayout(prefix, g)).filter((l): l is Layout => l !== undefined);
  });
  active.suffixes = flatten(active.layout);
  if (!keepValues) values = initValues(active.suffixes, ember.withCurrentBuffer(buffer, () => initialValue(prefix)));
  ember.setVariable("transient-current-prefix", prefix);
  show();
  bindKeys();
}

/** Leaves the menu, and with ALL every menu it was entered from. */
function exit(all: boolean): void {
  hide();
  ember.setOverridingMap(null);
  active = undefined;
  if (all) stack.length = 0;
  ember.setVariable("transient-current-prefix", null);
}

const quitOne = ember.defineCommand({
  name: "transient-quit-one",
  doc: "Exit the current transient, returning to the outer one, if any.",
  run: () => {
    // Also from a suffix that runs it once the menu has gone, as casual's Back does.
    const parent = stack.pop();
    const buffer = active?.buffer ?? ember.currentBuffer();
    exit(false);
    if (parent) {
      values = parent.values;
      setup(parent.prefix, buffer, true);
    }
  },
});

const quitAll = ember.defineCommand({
  name: "transient-quit-all",
  doc: "Exit all transients without saving the transient stack.",
  run: () => exit(true),
});

const undefinedKey = ember.defineCommand({
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
export function transientDefinePrefix(name: string, definition: PrefixDefinition): ember.DefinedCommand {
  prefixes.set(name, definition);
  return ember.defineCommand({
    name,
    doc: definition.doc ?? "A transient menu.",
    run: () => {
      if (active) exit(true);
      setup(name, ember.currentBuffer());
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
): ember.DefinedCommand {
  definedSuffixes.set(name, definition);
  return ember.defineCommand({ name, doc: definition.doc ?? "A transient suffix.", run: () => void definition.run() });
}

/** The suffix spec for transient-quit-one and transient-quit-all, for a layout to name. */
transientDefineSuffix("transient-quit-one-suffix", { key: "C-g", description: "Quit", run: () => ember.call(quitOne) });
