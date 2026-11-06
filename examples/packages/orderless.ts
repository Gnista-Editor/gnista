// Orderless completion, after orderless.el 1.x
// (https://github.com/oantolin/orderless): a completion style that splits
// the input on spaces into components and matches the candidates that
// match every component, in any order. A component matches as a literal or
// as an Emacs regexp; one starting or ending with one of
// orderless-affix-dispatch-alist's characters matches another way: !
// negates, , as an initialism, = literally, ^ as a literal prefix, ~ flex,
// & against the annotation. Lower case input ignores case.
//
//   e8.setVariable("completion-styles", ["orderless", "basic"]);
//
// Copyright (C) 2021-2025 Free Software Foundation, Inc.
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { completionMetadataGet, defineCompletionStyle, type CompletionField } from "minibuffer";
import { regexpQuote, truthy } from "subr";

const faces: [string, string, string][] = [
  ["#72a4ff", "#223fbf", "0"],
  ["#ed92f8", "#8f0075", "1"],
  ["#90d800", "#145a00", "2"],
  ["#f0ce43", "#804000", "3"],
];
for (const [dark, light, n] of faces) {
  e8.defineFace({
    name: `orderless-match-face-${n}`,
    doc: `Face for matches of components numbered ${n} mod 4.`,
    attributes: { weight: "bold" },
    dark: { foreground: dark },
    light: { foreground: light },
  });
}

e8.defineVariable({
  name: "orderless-component-separator",
  doc: "What splits the input into components: an Emacs regexp, or a function of the input giving them. By default spaces, which a backslash escapes.",
  value: "orderless-escapable-split-on-space",
});
e8.defineVariable({
  name: "orderless-match-faces",
  doc: "Faces used, in turn, for the matches of each component.",
  value: ["orderless-match-face-0", "orderless-match-face-1", "orderless-match-face-2", "orderless-match-face-3"],
});
e8.defineVariable({
  name: "orderless-matching-styles",
  doc: "How each component matches: functions from a component to an Emacs regexp, or to a predicate. A component matches if any of them does.",
  value: ["orderless-literal", "orderless-regexp"],
});
e8.defineVariable({
  name: "orderless-affix-dispatch-alist",
  doc: "Characters that, starting or ending a component, match the rest of it another way, as [character, style] pairs.",
  value: [
    ["%", "char-fold-to-regexp"],
    ["!", "orderless-not"],
    ["&", "orderless-annotation"],
    [",", "orderless-initialism"],
    ["=", "orderless-literal"],
    ["^", "orderless-literal-prefix"],
    ["~", "orderless-flex"],
  ],
});
e8.defineVariable({
  name: "orderless-style-dispatchers",
  doc: "Functions that choose how a component matches, called with the component, its index and how many there are, as orderless--dispatch describes.",
  value: ["orderless-affix-dispatch"],
});
e8.defineVariable({ name: "orderless-smart-case", doc: "Whether input with upper case letters matches case, and input without ignores it.", value: true });

/** What a matching style gives: a regexp, a predicate, or nothing. */
type Matcher = string | ((candidate: string) => boolean) | undefined;

/** A character as an Emacs regexp matches it, outside brackets. */
const quoteChar = (c: string): string => regexpQuote(c);
/** A bracket expression matching anything but C, as rx's (not C). */
const notChar = (c: string): string => (c === "]" ? "[^]]" : c === "^" ? "[^^]" : c === "-" ? "[^-]" : c === "\\" ? "[^\\]" : `[^${c}]`);

/** Matches COMPONENT as a regexp, if it is a valid one, as orderless-regexp. */
export function orderlessRegexp(component: string): Matcher {
  try {
    e8.emacsRegexp(component);
    return component;
  } catch {
    return undefined;
  }
}

/** Matches COMPONENT as a literal string, as orderless-literal. */
export const orderlessLiteral = (component: string): Matcher => regexpQuote(component);

/** Matches COMPONENT as a literal prefix, as orderless-literal-prefix. */
export const orderlessLiteralPrefix = (component: string): Matcher => `\\\`${regexpQuote(component)}`;

/** The characters of COMPONENT in order, not necessarily together, as orderless-flex. */
export function orderlessFlex(component: string): Matcher {
  const chars = [...component];
  return chars.map((c, i) => `${i > 0 ? `${notChar(c)}*` : ""}\\(${quoteChar(c)}\\)`).join("");
}

/** The characters of COMPONENT in order at the starts of words, as orderless-initialism. */
export function orderlessInitialism(component: string): Matcher {
  return [...component].map((c) => `\\(\\<${quoteChar(c)}\\)`).join(".*");
}

/** COMPONENT split at word ends, each piece matching at a word boundary, as orderless-prefixes. */
export function orderlessPrefixes(component: string): Matcher {
  return component
    .split(/(?<=\w)(?=\W)/u)
    .map((p) => `\\(\\b${regexpQuote(p)}\\)`)
    .join(".*");
}

/** Strings that do not contain COMPONENT, as orderless-without-literal. */
export const orderlessWithoutLiteral = (component: string): Matcher => (candidate) => !candidate.includes(component);

const named: { [name: string]: (component: string) => Matcher } = {
  "orderless-regexp": orderlessRegexp,
  "orderless-literal": orderlessLiteral,
  "orderless-literal-prefix": orderlessLiteralPrefix,
  "orderless-flex": orderlessFlex,
  "orderless-initialism": orderlessInitialism,
  "orderless-prefixes": orderlessPrefixes,
  "orderless-without-literal": orderlessWithoutLiteral,
  // E8 has no character folding yet: the component matches literally.
  "char-fold-to-regexp": orderlessLiteral,
};

/** The styles that take what the rest of a component compiles to, rather than the component. */
const wrapping: { [name: string]: (pred: Matcher, regexp: string | undefined) => Matcher } = {
  "orderless-not": (pred, regexp) => (c) => !matchP(pred, regexp, c),
  "orderless-annotation": (pred, regexp) => {
    const aff = completionMetadataGet("affixationFunction");
    const ann = completionMetadataGet("annotationFunction");
    if (aff) return (c) => aff([c])[0].slice(1).some((s) => matchP(pred, regexp, String(s)));
    if (ann) return (c) => matchP(pred, regexp, String(ann(c) ?? ""));
    return undefined;
  },
};

function matchP(pred: Matcher, regexp: string | undefined, candidate: string): boolean {
  if (typeof pred === "function" && !pred(candidate)) return false;
  if (regexp !== undefined) {
    const fold = truthy(e8.variable("completion-ignore-case"));
    if (!e8.emacsRegexp(regexp, { caseFold: fold }).test(candidate)) return false;
  }
  return true;
}

const callStyle = (style: string, component: string): Matcher => {
  const fn = named[style];
  if (fn) return fn(component);
  const result = e8.funcall(style, component);
  return typeof result === "string" || typeof result === "function" ? (result as Matcher) : undefined;
};

/** Splits STRING on spaces, which a backslash escapes, as orderless-escapable-split-on-space. */
export function escapableSplitOnSpace(string: string): string[] {
  return string
    .replace(/\\\\|\\ /g, (x) => (x === "\\ " ? "\0" : x))
    .split(/ +/)
    .filter((p) => p !== "")
    .map((p) => p.replace(/\0/g, " "));
}
e8.defun("orderless-escapable-split-on-space", escapableSplitOnSpace);

/** Matches a component by a character at either end, as orderless-affix-dispatch. */
export function orderlessAffixDispatch(component: string): string | [string, string] | undefined {
  const alist = e8.variable("orderless-affix-dispatch-alist");
  const styles = new Map(Array.isArray(alist) ? (alist as [string, string][]) : []);
  if (component.length === 0) return undefined;
  const chars = [...component];
  if (chars.length === 1 && styles.has(chars[0])) return ["ignore", ""];
  const head = styles.get(chars[0]);
  if (head) return [head, chars.slice(1).join("")];
  const tail = styles.get(chars[chars.length - 1]);
  if (tail) return [tail, chars.slice(0, -1).join("")];
  return undefined;
}
e8.defun("orderless-affix-dispatch", (c: string) => orderlessAffixDispatch(c));

/** The styles to match COMPONENT with and the component they match, as orderless--dispatch. */
function dispatch(defaults: string[], component: string, index: number, total: number): [string[], string] {
  const dispatchers = e8.variable("orderless-style-dispatchers");
  for (const d of Array.isArray(dispatchers) ? dispatchers.map(String) : []) {
    const result = d === "orderless-affix-dispatch" ? orderlessAffixDispatch(component) : (e8.funcall(d, component, index, total) as unknown);
    if (result === undefined || result === null) continue;
    if (typeof result === "string") {
      component = result;
      continue;
    }
    if (Array.isArray(result) && result.length === 2 && typeof result[1] === "string") {
      const [styles, rest] = result as [string | string[] | null, string];
      return [styles === null ? defaults : [styles].flat(), rest];
    }
    return [[result as string].flat(), component];
  }
  return [defaults, component];
}

interface Compiled {
  pred?: (candidate: string) => boolean;
  regexps: string[];
}

/** What COMPONENT matches by: a predicate and an alternation of regexps, as orderless--compile-component. */
function compileComponent(component: string, index: number, total: number, styles: string[]): { pred?: (c: string) => boolean; regexp?: string } {
  const [chosen, comp] = dispatch(styles, component, index, total);
  let pred: ((c: string) => boolean) | undefined;
  const regexps: string[] = [];
  for (const style of chosen) {
    if (style === "ignore") continue;
    let res: Matcher;
    if (wrapping[style]) {
      const inner = compileComponent(comp, index, total, styles);
      res = wrapping[style](inner.pred, inner.regexp);
    } else {
      res = callStyle(style, comp);
    }
    if (typeof res === "function") {
      const [p, q] = [pred, res];
      pred = p ? (c) => p(c) && q(c) : q;
    } else if (res !== undefined && !regexps.includes(res)) {
      regexps.push(res);
    }
  }
  return { pred, regexp: regexps.length === 0 ? undefined : regexps.length === 1 ? regexps[0] : `\\(?:${regexps.join("\\|")}\\)` };
}

/** Builds the regexps and the predicate PATTERN's components match by, as orderless-compile. */
export function orderlessCompile(pattern: string, styles?: string[]): Compiled {
  const matching = e8.variable("orderless-matching-styles");
  styles ??= Array.isArray(matching) && matching.length > 0 ? matching.map(String) : ["orderless-regexp"];
  const separator = e8.variable("orderless-component-separator");
  const components =
    separator === "orderless-escapable-split-on-space"
      ? escapableSplitOnSpace(pattern)
      : typeof separator === "string" && !e8.fboundp(separator)
        ? pattern.split(e8.emacsRegexp(separator)).filter((p) => p !== "")
        : ((e8.funcall(separator as string, pattern) as string[]) ?? []);
  let pred: ((c: string) => boolean) | undefined;
  const regexps: string[] = [];
  components.forEach((comp, index) => {
    const c = compileComponent(comp, index, components.length, styles!);
    if (c.regexp !== undefined) regexps.push(c.regexp);
    if (c.pred) {
      const [p, q] = [pred, c.pred];
      pred = p ? (x) => p(x) && q(x) : q;
    }
  });
  return { pred, regexps };
}

/** Whether case is ignored for REGEXPS: with smart case, when none has an upper case letter, as orderless--ignore-case-p. */
function ignoreCaseP(regexps: string[], ignoreCase: boolean): boolean {
  if (!truthy(e8.variable("orderless-smart-case"))) return ignoreCase;
  // As isearch-no-upper-case-p with REGEXP-FLAG: escapes do not count.
  return regexps.every((r) => !/\p{Lu}/u.test(r.replace(/\\./gu, "")));
}

/** Highlights the match of each of REGEXPS in CANDIDATE, its groups if it has any, as orderless--highlight. */
function highlight(compiled: RegExp[], candidate: string): string | e8.PropertizedString {
  const facesValue = e8.variable("orderless-match-faces");
  const names = Array.isArray(facesValue) ? facesValue.map(String) : [];
  const marks: (string | undefined)[] = new Array(candidate.length).fill(undefined);
  compiled.forEach((re, i) => {
    const m = re.exec(candidate) as (RegExpExecArray & { indices?: [number, number][] }) | null;
    if (!m) return;
    const spans = m.indices ? (m.indices.length > 1 ? m.indices.slice(1) : [m.indices[0]]) : [[m.index, m.index + m[0].length]];
    for (const span of spans) {
      if (!span) continue;
      for (let k = span[0]; k < span[1]; k++) marks[k] ??= names[i % names.length];
    }
  });
  if (marks.every((m) => m === undefined)) return candidate;
  const parts: (string | e8.PropertizedString)[] = [];
  let start = 0;
  for (let k = 1; k <= candidate.length; k++) {
    if (k === candidate.length || marks[k] !== marks[start]) {
      const text = candidate.slice(start, k);
      parts.push(marks[start] ? e8.propertize(text, { face: marks[start]! }) : text);
      start = k;
    }
  }
  return e8.concat(...parts);
}

/** The candidates matching every component of the field, as orderless-all-completions, highlighted lazily. */
function allCompletions(field: CompletionField, ignoreCase: boolean) {
  const pattern = field.before + field.after;
  const { pred, regexps } = orderlessCompile(pattern);
  const fold = ignoreCaseP(regexps, ignoreCase);
  const compiled = regexps.map((r) => e8.emacsRegexp(r, { caseFold: fold }));
  const completions = field.names.filter((n) => compiled.every((re) => re.test(n)) && (!pred || pred(n)));
  const withIndices = compiled.map((re) => {
    try {
      return new RegExp(re.source, `${re.flags.replace(/[gyd]/g, "")}d`);
    } catch {
      return re;
    }
  });
  return { completions, hilit: (c: string) => highlight(withIndices, c) };
}

/** Highlights the matches of each of PATTERN's components in each of STRINGS, as orderless-highlight-matches. */
export function orderlessHighlightMatches(pattern: string, strings: string[]): (string | e8.PropertizedString)[] {
  const { regexps } = orderlessCompile(pattern);
  const fold = ignoreCaseP(regexps, truthy(e8.variable("completion-ignore-case")));
  const compiled = regexps.map((r) => new RegExp(e8.emacsRegexp(r, { caseFold: fold }).source, `${fold ? "i" : ""}ud`));
  return strings.map((s) => highlight(compiled, s));
}

/** Filters NAMES by PATTERN as orderless does, as orderless-filter. */
export function orderlessFilter(pattern: string, names: string[]): string[] {
  return allCompletions({ base: "", before: pattern, after: "", suffix: "", names }, truthy(e8.variable("completion-ignore-case"))).completions;
}

defineCompletionStyle("orderless", { doc: "Completion of multiple components, in any order.", all: allCompletions });
