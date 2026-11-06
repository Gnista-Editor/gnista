// Marginalia, after marginalia.el 2.x (https://github.com/minad/marginalia):
// with marginalia-mode on, completion candidates get annotations in the
// margin by their category: a command's key and documentation, a
// variable's value, a face's sample, a buffer's state and file, a file's
// modes, size and age, a bookmark's file. M-A (marginalia-cycle) switches
// a category's annotator, to E8's own or to none.
//
// Copyright (C) 2021-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import type { CompletionMetadata } from "minibuffer";
import { truthy } from "subr";

e8.defineVariable({ name: "marginalia-field-width", doc: "Maximum truncation width of annotation fields, made smaller in narrow windows.", value: 80 });
e8.defineVariable({ name: "marginalia-separator", doc: "Annotation field separator.", value: "  " });
e8.defineVariable({ name: "marginalia-align", doc: 'Alignment of the annotations: "left", "center" or "right".', value: "left" });
e8.defineVariable({ name: "marginalia-align-offset", doc: "Additional offset added to the alignment.", value: 0 });
e8.defineVariable({ name: "marginalia-max-relative-age", doc: "Maximum age in seconds the file annotator shows as relative, such as 3 hours ago.", value: 60 * 60 * 24 * 14 });
e8.defineVariable({
  name: "marginalia-censor-variables",
  doc: "Regexps matching the names of variables whose values are not shown, as they may hold secrets.",
  value: ["pass\\|auth-source-netrc-cache\\|auth-source-.*-nonce\\|api-?key"],
});
e8.defineVariable({
  name: "marginalia-prompt-categories",
  doc: "Categories for prompts that match a regexp, as [regexp, category] pairs, matched ignoring case.",
  value: [
    ["\\<customize group\\>", "customize-group"],
    ["\\<M-x\\>", "command"],
    ["\\<package\\>", "package"],
    ["\\<bookmark\\>", "bookmark"],
    ["\\<color\\>", "color"],
    ["\\<face\\>", "face"],
    ["\\<environment variable\\>", "environment-variable"],
    ["\\<function\\|\\(?:hook\\|advice\\) to remove\\>", "function"],
    ["\\<variable\\>", "variable"],
    ["\\<input method\\>", "input-method"],
    ["\\<charset\\>", "charset"],
    ["\\<coding system\\>", "coding-system"],
    ["\\<minor mode\\>", "minor-mode"],
    ["\\<kill-ring\\>", "kill-ring"],
    ["\\<tab by name\\>", "tab"],
    ["\\<library\\>", "library"],
    ["\\<theme\\>", "theme"],
  ],
});
e8.defineVariable({
  name: "marginalia-command-categories",
  doc: "Categories for the prompts of commands, as [command, category] pairs.",
  value: [
    ["imenu", "imenu"],
    ["recentf-open", "file"],
    ["where-is", "command"],
  ],
});

const faceSpecs: [string, string][] = [
  ["marginalia-key", "font-lock-keyword-face"],
  ["marginalia-type", "marginalia-key"],
  ["marginalia-char", "marginalia-key"],
  ["marginalia-lighter", "marginalia-size"],
  ["marginalia-on", "success"],
  ["marginalia-off", "error"],
  ["marginalia-documentation", "completions-annotations"],
  ["marginalia-value", "marginalia-key"],
  ["marginalia-null", "font-lock-comment-face"],
  ["marginalia-true", "font-lock-builtin-face"],
  ["marginalia-function", "font-lock-function-name-face"],
  ["marginalia-symbol", "font-lock-type-face"],
  ["marginalia-list", "font-lock-constant-face"],
  ["marginalia-mode", "marginalia-key"],
  ["marginalia-date", "marginalia-key"],
  ["marginalia-version", "marginalia-number"],
  ["marginalia-archive", "warning"],
  ["marginalia-installed", "success"],
  ["marginalia-size", "marginalia-number"],
  ["marginalia-number", "font-lock-constant-face"],
  ["marginalia-string", "font-lock-string-face"],
  ["marginalia-modified", "font-lock-negation-char-face"],
  ["marginalia-file-name", "marginalia-documentation"],
  ["marginalia-file-owner", "font-lock-preprocessor-face"],
  ["marginalia-file-priv-no", "shadow"],
  ["marginalia-file-priv-dir", "font-lock-keyword-face"],
  ["marginalia-file-priv-link", "font-lock-keyword-face"],
  ["marginalia-file-priv-read", "font-lock-type-face"],
  ["marginalia-file-priv-write", "font-lock-builtin-face"],
  ["marginalia-file-priv-exec", "font-lock-function-name-face"],
  ["marginalia-file-priv-other", "font-lock-constant-face"],
  ["marginalia-file-priv-rare", "font-lock-variable-name-face"],
];
for (const [name, inherit] of faceSpecs) e8.defineFace({ name, doc: `Face marginalia uses: ${name.slice(11).replace(/-/g, " ")}.`, attributes: { inherit } });

type Text = string | e8.PropertizedString;
/** An annotator: a candidate's annotation, or undefined. */
type Annotator = (cand: string) => Text | undefined;

/** The one character where alignment goes, as the space with marginalia--align that marginalia--fields puts. */
const ALIGN = e8.propertize(" ", { "marginalia--align": true });

const fieldWidth = (): number => {
  const v = e8.variable("marginalia-field-width");
  return typeof v === "number" ? v : 80;
};

/** STR cut to its first line and to WIDTH columns with an ellipsis, padded to WIDTH, or from its end for a negative WIDTH, as marginalia--truncate. */
function truncate(str: string, width: number): string {
  // A fraction of marginalia-field-width, as Lisp's floats are: 1.0, -0.5.
  if (Math.abs(width) <= 1) width = Math.round(width * fieldWidth());
  const nl = str.indexOf("\n");
  if (nl >= 0) str = str.slice(0, nl);
  const ell = "…";
  const cut = (s: string, w: number): string => {
    if (e8.stringWidth(s) <= w) return s + " ".repeat(w - e8.stringWidth(s));
    let out = "";
    for (const ch of s) {
      if (e8.stringWidth(out + ch) + e8.stringWidth(ell) > w) break;
      out += ch;
    }
    return out + ell + " ".repeat(Math.max(0, w - e8.stringWidth(out + ell)));
  };
  if (width < 0) return [...cut([...str].reverse().join(""), -width)].reverse().join("");
  return cut(str, width);
}

/** A field of an annotation, as marginalia--field's options take it. */
interface Field {
  text: Text | number | undefined;
  truncate?: number;
  face?: e8.Value;
  width?: number;
  format?: string;
  left?: boolean;
}

/** FIELD formatted, as marginalia--field. */
function formatField(f: Field): Text {
  let text: Text = f.format ? f.format.replace("%s", String(f.text ?? "")) : f.text === undefined ? "" : typeof f.text === "number" ? String(f.text) : f.text;
  const plain = String(text);
  if (f.width !== undefined) text = f.width < 0 ? plain.padStart(-f.width) : plain.padEnd(f.width);
  if (f.truncate !== undefined) text = truncate(String(text), f.truncate);
  if (f.face !== undefined && f.face !== null) {
    text = typeof text === "string" || f.format || f.width !== undefined || f.truncate !== undefined ? e8.propertize(String(text), { face: f.face }) : text;
  }
  return text;
}

/** The fields one after another, the separator before each, the alignment before the first that is not on the left, as marginalia--fields. */
function fields(...list: Field[]): e8.PropertizedString {
  const sep = String(e8.variable("marginalia-separator") ?? "  ");
  const parts: Text[] = [];
  let left = true;
  for (const f of list) {
    if (f.left) {
      if (!left) e8.signal("error", "Left fields must come first");
      parts.push(formatField(f));
      continue;
    }
    if (left) {
      left = false;
      parts.push(ALIGN);
    }
    parts.push(sep, formatField(f));
  }
  return e8.concat(...parts);
}

const documentationField = (str: string | undefined): Text | undefined => (str ? fields({ text: str, truncate: 1.0, face: "marginalia-documentation" }) : undefined);

/** A command's key, as marginalia-annotate-binding. */
export function annotateBinding(cand: string): Text | undefined {
  if (!e8.fboundp(cand)) return undefined;
  const key = e8.whereIs(cand);
  return key ? e8.concat(" (", e8.propertize(key, { face: "marginalia-key" }), ")") : undefined;
}

/** A command's key and the first line of its documentation, as marginalia-annotate-command. */
export function annotateCommand(cand: string): Text | undefined {
  if (!e8.fboundp(cand)) return undefined;
  return e8.concat(annotateBinding(cand) ?? "", documentationField(e8.documentation(cand)) ?? "");
}

/** What kind of symbol S is, as marginalia--symbol-class: c a command, f a function, v a variable, l local, a a face. */
function symbolClass(s: string): string {
  const cls: string[] = [];
  if (e8.fboundp(s)) cls.push(e8.documentation(s) !== undefined ? "c" : "f");
  const isVar = e8.variable(s) !== undefined || e8.variableDocumentation(s) !== undefined;
  if (isVar) cls.push(e8.isLocalVariable(s) ? "l" : "v");
  if (e8.facep(s)) cls.push("a");
  return ` ${cls.join("").padEnd(6)}`;
}

/** A variable's value as the annotation shows it, as marginalia--variable-value. */
function variableValue(sym: string): Text {
  const val = e8.variable(sym);
  if (val === undefined) return e8.propertize("#<unbound>", { face: "marginalia-null" });
  const censor = e8.variable("marginalia-censor-variables");
  if (Array.isArray(censor) && censor.some((r) => e8.stringMatch(String(r), sym) !== undefined)) {
    return e8.propertize("*****", { face: "marginalia-null" });
  }
  if (val === null || val === false) return e8.propertize("nil", { face: "marginalia-null" });
  if (val === true) return e8.propertize("t", { face: "marginalia-true" });
  if (typeof val === "number") return e8.propertize(String(val), { face: "marginalia-number" });
  if (typeof val === "string") return e8.propertize(JSON.stringify(val), { face: "marginalia-string" });
  if (typeof val === "function") return e8.propertize("#<function>", { face: "marginalia-function" });
  if (Array.isArray(val)) return e8.propertize(`(${val.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v))).join(" ")})`, { face: "marginalia-list" });
  return e8.propertize(String(val), { face: "marginalia-value" });
}

/** A variable's kind, value and documentation, as marginalia-annotate-variable. */
export function annotateVariable(cand: string): Text | undefined {
  if (e8.variable(cand) === undefined && e8.variableDocumentation(cand) === undefined) return undefined;
  return fields(
    { text: symbolClass(cand), face: "marginalia-type" },
    { text: variableValue(cand), truncate: 0.5 },
    { text: e8.variableDocumentation(cand) ?? "", truncate: 1.0, face: "marginalia-documentation" },
  );
}

const PANGRAM = "Cwm fjord bank glyphs vext quiz.";

/** A face's sample and documentation, as marginalia-annotate-face. */
export function annotateFace(cand: string): Text | undefined {
  if (!e8.facep(cand)) return undefined;
  // Emacs aligns the documentation to the window's centre with a display
  // space; here the space is a space.
  return fields(
    { text: `${PANGRAM} `, face: cand },
    { text: e8.faceInfo(cand)?.doc ?? "", truncate: 1.0, face: "marginalia-documentation" },
  );
}

/** A function's kind and documentation, as marginalia-annotate-function. */
export function annotateFunction(cand: string): Text | undefined {
  if (!e8.fboundp(cand)) return undefined;
  return fields(
    { left: true, text: annotateBinding(cand) },
    { text: symbolClass(cand), face: "marginalia-type" },
    { text: e8.documentation(cand) ?? "", truncate: 1.0, face: "marginalia-documentation" },
  );
}

/** A symbol's kind and documentation, as marginalia-annotate-symbol. */
export function annotateSymbol(cand: string): Text | undefined {
  const doc = e8.fboundp(cand) ? e8.documentation(cand) : e8.variableDocumentation(cand) ?? e8.faceInfo(cand)?.doc;
  if (!e8.fboundp(cand) && doc === undefined && e8.variable(cand) === undefined) return undefined;
  return fields(
    { left: true, text: annotateBinding(cand) },
    { text: symbolClass(cand), face: "marginalia-type" },
    { text: doc ?? "", truncate: 1.0, face: "marginalia-documentation" },
  );
}

/** Whether a minor mode is on, its lighter and documentation, as marginalia-annotate-minor-mode. */
export function annotateMinorMode(cand: string): Text | undefined {
  if (!e8.fboundp(cand)) return undefined;
  const on = truthy(e8.variable(cand));
  return fields(
    { text: on ? "On" : "Off", face: on ? "marginalia-on" : "marginalia-off", width: 3 },
    { text: e8.documentation(cand) ?? "", truncate: 1.0, face: "marginalia-documentation" },
  );
}

/** A size as file-size-human-readable writes it: 123, 1.2k, 45M. */
export function fileSizeHumanReadable(size: number): string {
  const prefixes = ["", "k", "M", "G", "T", "P", "E", "Z", "Y"];
  let i = 0;
  while (size >= 1024 && i < prefixes.length - 1) {
    size /= 1024;
    i++;
  }
  const frac = size % 1;
  return size < 10 && frac >= 0.05 && frac < 0.95 ? `${size.toFixed(1)}${prefixes[i]}` : `${Math.round(size)}${prefixes[i]}`;
}

/** A buffer's state, as marginalia--buffer-status: whether it is modified, its size and its mode. */
function bufferStatus(buffer: string): Text {
  return e8.withCurrentBuffer(buffer, () => {
    const modified = e8.bufferModified();
    const ro = e8.bufferReadOnly();
    const flags = `${modified ? "*" : ro ? "%" : "-"}${modified ? "*" : ro ? "%" : "-"}-`;
    const size = fileSizeHumanReadable(e8.bufferSize());
    const mode = String(e8.formatModeLine(e8.variable("mode-name") ?? "")).slice(0, 20).padEnd(20);
    const sep = String(e8.variable("marginalia-separator") ?? "  ");
    return e8.concat(
      e8.propertize(flags, { face: "marginalia-modified" }),
      sep,
      e8.propertize(size.padEnd(7), { face: "marginalia-size" }),
      sep,
      e8.propertize(mode, { face: "marginalia-mode" }),
    );
  });
}

/** A buffer's file, or its process, as marginalia--buffer-file. */
function bufferFile(buffer: string): string {
  const proc = e8.getBufferProcess(buffer);
  const dir = String(e8.bufferLocalValue("default-directory", buffer) ?? "");
  if (proc) return `(${proc} run) ${e8.abbreviateFileName(dir)}`;
  const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName());
  if (file) return e8.abbreviateFileName(file);
  const dired = e8.bufferLocalValue("dired-directory", buffer);
  return typeof dired === "string" ? e8.abbreviateFileName(e8.expandFileName(dired, dir)) : "";
}

/** A buffer's state and file, as marginalia-annotate-buffer. */
export function annotateBuffer(cand: string): Text | undefined {
  if (!e8.bufferLiveP(e8.getBuffer(cand))) return undefined;
  return fields({ text: bufferStatus(cand) }, { text: bufferFile(cand), truncate: -0.5, face: "marginalia-file-name" });
}

/** File modes, each character in its face, as marginalia--file-modes. */
function fileModes(modes: string): Text {
  const face = (c: string) =>
    c === "-" ? "marginalia-file-priv-no" : c === "d" ? "marginalia-file-priv-dir" : c === "l" ? "marginalia-file-priv-link" : c === "r" ? "marginalia-file-priv-read" : c === "w" ? "marginalia-file-priv-write" : c === "x" ? "marginalia-file-priv-exec" : "sStT".includes(c) ? "marginalia-file-priv-other" : "marginalia-file-priv-rare";
  return e8.concat(...[...modes].map((c) => e8.propertize(c, { face: face(c) })));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A file's age, relative when recent, as marginalia--time. */
export function fileTime(ms: number, now = Date.now()): string {
  const age = Math.max(0, (now - ms) / 1000);
  const max = Number(e8.variable("marginalia-max-relative-age") ?? 0);
  if (age < max) {
    const steps: [number | undefined, string, number][] = [
      [100, "sec", 1],
      [60 * 100, "min", 60],
      [3600 * 30, "hour", 3600],
      [3600 * 24 * 400, "day", 3600 * 24],
      [undefined, "year", 365.25 * 24 * 3600],
    ];
    const here = steps.find(([limit]) => limit === undefined || age < limit)!;
    const n = Math.round(age / here[2]);
    return `${n} ${here[1]}${n === 1 ? "" : "s"} ago`;
  }
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return new Date(now).getFullYear() > d.getFullYear()
    ? ` ${d.getFullYear()} ${MONTHS[d.getMonth()]} ${pad(d.getDate())}`
    : `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The candidate with what comes before it in the input, as a file name's directory, as marginalia--full-candidate. */
function fullCandidate(cand: string): string {
  const field = e8.minibufferCompletionField?.(e8.pointMax());
  return field ? field.base + cand : cand;
}

/** A file's modes, size, age and owner, as marginalia-annotate-file. */
export function annotateFile(cand: string): Text | undefined {
  const remote = /^\/([^/|:]+):/.exec(cand);
  if (remote) return fields({ text: remote[1], format: "*%s*", face: "marginalia-documentation" });
  const attrs = e8.fileAttributes(e8.expandFileName(fullCandidate(cand)));
  if (!attrs) return undefined;
  // The user's own ids, as user-uid and group-gid give them: those of their home.
  const home = e8.fileAttributes(e8.expandFileName("~"));
  const owner = attrs.uid !== home?.uid || attrs.gid !== home?.gid ? `${attrs.user}:${attrs.group}` : undefined;
  const rest: Field[] = [
    { text: fileModes(attrs.modes) },
    { text: fileSizeHumanReadable(attrs.size), face: "marginalia-size", width: -7 },
    { text: fileTime(attrs.modified), face: "marginalia-date", width: -12 },
  ];
  const ownerField: Field[] = owner ? [{ text: owner, face: "marginalia-file-owner" }] : [];
  return e8.variable("marginalia-align") === "right" ? fields(...ownerField, ...rest) : fields(...rest, ...ownerField);
}

/** A project file, by its name in the project's root, as marginalia-annotate-project-file. */
export function annotateProjectFile(cand: string): Text | undefined {
  if (e8.fileNameAbsoluteP(cand)) return annotateFile(cand);
  const prompt = e8.minibufferInfo()?.prompt ?? "";
  const m = /^(?:Dired|Find file) in (.*): $/.exec(prompt);
  const root = m?.[1] ?? (e8.variable("default-directory") as string | undefined);
  return root ? annotateFile(e8.expandFileName(cand, root)) : undefined;
}

/** A bookmark's type, file and context, as marginalia-annotate-bookmark. */
export function annotateBookmark(cand: string): Text | undefined {
  const alist = e8.variable("bookmark-alist");
  const entry = Array.isArray(alist) ? (alist as e8.Value[]).find((b) => Array.isArray(b) && b[0] === cand) : undefined;
  if (!Array.isArray(entry)) return undefined;
  const props = new Map((entry.slice(1) as e8.Value[]).filter((p): p is e8.Value[] => Array.isArray(p)).map((p) => [String(p[0]), p[1]]));
  const file = props.get("filename") ?? props.get("location");
  const front = String(props.get("front-context-string") ?? "");
  const rear = String(props.get("rear-context-string") ?? "");
  return fields(
    { text: "File", width: 10, face: "marginalia-type" },
    { text: file ? String(file) : "", truncate: props.has("filename") ? -0.5 : 0.5, face: "marginalia-file-name" },
    ...(front.trim() || rear.trim()
      ? [{ text: `${rear.replace(/\s+/g, " ").trim()}${e8.propertize("▮", { face: "marginalia-null" })}${front.replace(/\s+/g, " ").trim()}`, truncate: 1.0, face: "marginalia-documentation" } as Field]
      : []),
  );
}

/** A theme's documentation, as marginalia-annotate-theme. */
export function annotateTheme(cand: string): Text | undefined {
  const enabled = e8.variable("custom-enabled-themes");
  const on = Array.isArray(enabled) && enabled.includes(cand);
  return fields({ text: on ? e8.propertize("Enabled", { face: "marginalia-on" }) : "", width: 8 });
}

/** A tab's place among the tabs, as marginalia-annotate-tab. */
export function annotateTab(cand: string): Text | undefined {
  const names = e8.funcall("tab-bar-tab-names") as string[] | undefined;
  const index = Array.isArray(names) ? names.indexOf(cand) : -1;
  return index < 0 ? undefined : fields({ left: true, text: index + 1, format: " (%s)", face: "marginalia-key" });
}

e8.defineVariable({
  name: "marginalia-annotators",
  doc: 'The annotators for each category, as [category, annotator...]: marginalia-cycle turns them; "builtin" is the table\'s own annotation, "none" none.',
  value: [
    ["command", "marginalia-annotate-command", "marginalia-annotate-binding", "builtin", "none"],
    ["variable", "marginalia-annotate-variable", "builtin", "none"],
    ["function", "marginalia-annotate-function", "builtin", "none"],
    ["face", "marginalia-annotate-face", "builtin", "none"],
    ["minor-mode", "marginalia-annotate-minor-mode", "builtin", "none"],
    ["symbol", "marginalia-annotate-symbol", "builtin", "none"],
    ["bookmark", "marginalia-annotate-bookmark", "builtin", "none"],
    ["file", "marginalia-annotate-file", "builtin", "none"],
    ["project-file", "marginalia-annotate-project-file", "builtin", "none"],
    ["project-buffer", "marginalia-annotate-buffer", "builtin", "none"],
    ["buffer", "marginalia-annotate-buffer", "builtin", "none"],
    ["theme", "marginalia-annotate-theme", "builtin", "none"],
    ["tab", "marginalia-annotate-tab", "builtin", "none"],
  ],
});

const annotators: { [name: string]: Annotator } = {
  "marginalia-annotate-command": annotateCommand,
  "marginalia-annotate-binding": annotateBinding,
  "marginalia-annotate-variable": annotateVariable,
  "marginalia-annotate-function": annotateFunction,
  "marginalia-annotate-face": annotateFace,
  "marginalia-annotate-minor-mode": annotateMinorMode,
  "marginalia-annotate-symbol": annotateSymbol,
  "marginalia-annotate-bookmark": annotateBookmark,
  "marginalia-annotate-file": annotateFile,
  "marginalia-annotate-project-file": annotateProjectFile,
  "marginalia-annotate-buffer": annotateBuffer,
  "marginalia-annotate-theme": annotateTheme,
  "marginalia-annotate-tab": annotateTab,
};
for (const [name, fn] of Object.entries(annotators)) e8.defun(name, fn);

/** The annotator for category CAT, "builtin" to leave it to the table, or "none", as marginalia--annotator. */
function annotatorFor(cat: string): Annotator | "builtin" | undefined {
  const reg = e8.variable("marginalia-annotators");
  const entry = Array.isArray(reg) ? (reg as e8.Value[][]).find((e) => e[0] === cat) : undefined;
  const first = entry?.[1];
  if (first === undefined || first === "builtin") return "builtin";
  if (first === "none") return () => undefined;
  return annotators[String(first)] ?? ((c) => e8.funcall(String(first), c) as Text | undefined);
}

e8.defineVariable({
  name: "marginalia--cand-width-max",
  doc: "The widest candidate and its annotation's left part seen, rounded up to 10: local to the minibuffer, so each starts again.",
  value: 20,
});

/** The candidates with their annotations, aligned as marginalia-align says, as marginalia--affixate and marginalia--align. */
function affixate(annotator: Annotator, cands: string[]): [string, Text, Text][] {
  const win = e8.windowSize(e8.minibufferWindow())?.width ?? 80;
  return e8.letBind({ "marginalia-field-width": Math.min(Math.trunc(win / 2), fieldWidth()) }, () => {
    const anns = cands.map((c) => {
      const ann = cache(annotator, c) ?? "";
      return String(ann).trim() === "" ? "" : ann;
    });
    const alignAt = (ann: Text): number => {
      if (typeof ann === "string") return -1;
      const runs = (ann as unknown as { properties: [number, number, { [k: string]: e8.Value }][] }).properties ?? [];
      const run = runs.find(([, , p]) => p["marginalia--align"] === true);
      return run ? run[0] : -1;
    };
    // Kept in the minibuffer, whose locals each new prompt clears, as Emacs's is.
    const mini = e8.windowBuffer(e8.minibufferWindow()) ?? e8.currentBuffer();
    const candWidthMax = e8.withCurrentBuffer(mini, () => {
      let max = Number(e8.variable("marginalia--cand-width-max"));
      cands.forEach((c, i) => {
        const at = alignAt(anns[i]);
        if (at >= 0) max = Math.max(max, Math.ceil((e8.stringWidth(c) + e8.stringWidth(String(anns[i]).slice(0, at))) / 10) * 10);
      });
      e8.makeLocalVariable("marginalia--cand-width-max");
      e8.setVariable("marginalia--cand-width-max", max);
      return max;
    });
    const align = String(e8.variable("marginalia-align"));
    const offset = Number(e8.variable("marginalia-align-offset") ?? 0);
    return cands.map((c, i) => {
      const ann = anns[i];
      const at = alignAt(ann);
      if (at < 0) return [c, "", ann];
      const text = String(ann);
      const before = text.slice(0, at);
      const target =
        align === "center" ? Math.trunc(win / 2) + offset : align === "right" ? win - 1 - offset - e8.stringWidth(text.slice(at + 1)) : offset + candWidthMax;
      const pad = Math.max(1, target - e8.stringWidth(c) - e8.stringWidth(before));
      return [c, "", e8.concat(substring(ann, 0, at), " ".repeat(pad), substring(ann, at + 1))];
    });
  });
}

/** Part of a propertized string, its properties kept. */
function substring(text: Text, start: number, end?: number): Text {
  if (typeof text === "string") return text.slice(start, end);
  const s = String(text);
  const stop = end ?? s.length;
  const runs = (text as unknown as { properties: [number, number, { [k: string]: e8.Value }][] }).properties ?? [];
  const parts: Text[] = [];
  let at = start;
  for (const [a, b, props] of [...runs].sort((x, y) => x[0] - y[0])) {
    const [from, to] = [Math.max(a, start), Math.min(b, stop)];
    if (from >= to) continue;
    if (from > at) parts.push(s.slice(at, from));
    parts.push(e8.propertize(s.slice(from, to), props));
    at = to;
  }
  if (at < stop) parts.push(s.slice(at, stop));
  return e8.concat(...parts);
}

/** The last annotations worked out, so scrolling does not work them out again, as marginalia--cache. */
const annotationCache = new Map<string, Text | undefined>();
let cacheOwner: unknown;
function cache(annotator: Annotator, cand: string): Text | undefined {
  if (cacheOwner !== annotator) {
    annotationCache.clear();
    cacheOwner = annotator;
  }
  if (!annotationCache.has(cand)) {
    if (annotationCache.size >= 100) annotationCache.delete(annotationCache.keys().next().value!);
    annotationCache.set(cand, annotator(cand));
  }
  return annotationCache.get(cand);
}

/** The command whose prompt is open, as marginalia--command. */
let command: string | undefined;

/** The category, as marginalia-classifiers work it out: by command, the table's own, by prompt. */
function classify(original: string | undefined): string | undefined {
  const byCommand = e8.variable("marginalia-command-categories");
  const c = Array.isArray(byCommand) ? (byCommand as string[][]).find((e) => e[0] === command)?.[1] : undefined;
  if (c) return c;
  if (original && original !== "symbol-help") return original;
  const prompt = (e8.minibufferInfo()?.prompt ?? "").replace(/\(.*?default.*?\)|\[.*?\]/g, "");
  const cats = e8.variable("marginalia-prompt-categories");
  for (const [regexp, category] of Array.isArray(cats) ? (cats as string[][]) : []) {
    if (e8.stringMatch(regexp, prompt, { caseFold: true }) !== undefined) return category;
  }
  return undefined;
}

/** Answers completion-metadata-get for annotations and the category, as marginalia--completion-metadata-get advises it. */
function metadataGet(next: (prop: string) => unknown, prop: string): unknown {
  if (prop === "category") return classify(next("category") as string | undefined);
  if (prop === "annotationFunction" || prop === "affixationFunction") {
    const cat = metadataGet(next, "category") as string | undefined;
    const annotator = cat ? annotatorFor(cat) : undefined;
    if (!annotator || annotator === "builtin") return next(prop);
    if (prop === "annotationFunction") {
      return ((cand: string) => {
        const ann = affixate(annotator, [cand])[0][2];
        return String(ann) === "" ? undefined : ann;
      }) satisfies CompletionMetadata["annotationFunction"];
    }
    return ((cands: string[]) => affixate(annotator, cands)) satisfies CompletionMetadata["affixationFunction"];
  }
  return next(prop);
}

const advice = (next: (prop: string) => unknown, prop: string) => metadataGet(next, prop);

function minibufferSetup(): void {
  command = e8.thisCommand();
  annotationCache.clear();
}

e8.defineMinorMode({
  name: "marginalia-mode",
  global: true,
  doc: "Annotate completion candidates with richer information.",
  onChange: (enabled) => {
    if (enabled) {
      e8.addHook("minibuffer-setup-hook", minibufferSetup);
      e8.adviceAdd("completion-metadata-get", "around", advice, { name: "marginalia" });
    } else {
      e8.adviceRemove("completion-metadata-get", "marginalia");
      e8.removeHook("minibuffer-setup-hook", minibufferSetup);
    }
  },
});

e8.defineCommand({
  name: "marginalia-cycle",
  doc: "Cycle between the annotators of marginalia-annotators for the open prompt's category.",
  run: () => {
    if (e8.minibufferDepth() === 0) e8.userError("Marginalia: No active minibuffer");
    const cat = e8.funcall("completion-metadata-get", "category") as string | undefined;
    if (!cat) e8.userError("Marginalia: Unknown completion category");
    const reg = e8.variable("marginalia-annotators");
    const entries = Array.isArray(reg) ? (reg as e8.Value[][]).map((e) => [...e]) : [];
    const entry = entries.find((e) => e[0] === cat);
    if (!entry) e8.userError(`Marginalia: No annotators found for category \`${cat}'`);
    entry.push(entry.splice(1, 1)[0]);
    e8.setDefault("marginalia-annotators", entries);
    annotationCache.clear();
    e8.message(`Marginalia: Use annotator \`${String(entry[1])}' for category \`${cat}'`);
  },
});
