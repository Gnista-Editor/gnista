// What Emacs's treesit.el builds on the tree-sitter primitives: the node
// at a position, walking up and searching the tree, indenting by rules
// (treesit-simple-indent-rules), and moving by defuns and other things
// (treesit-thing-settings), which treesit-major-mode-setup turns on.
//
// Predicates for nodes are as Emacs's: a string is an Emacs regexp matched
// against a node's type, a function is called with the node, ["or", ...]
// and ["not", p] combine them, [regexp, function] needs both, and a symbol,
// Symbol.for("defun"), names a thing in treesit-thing-settings.

import { forwardSexpDefault } from "lisp";
import { forwardLine, regexpQuote } from "subr";

type Node = ember.TreesitNode;
type Parser = ember.TreesitParser;
type Predicate = string | symbol | ((node: Node) => unknown) | Predicate[];

const nil = (v: unknown): boolean => v === null || v === undefined || v === false;

for (const [name, doc, value, local] of [
  ["treesit-simple-indent-rules", "How tree-sitter modes indent: for each language, [language, rules], each rule [matcher, anchor, offset].", null, true],
  ["treesit-defun-type-regexp", "An Emacs regexp matching the types of the nodes that are defuns, for C-M-a and C-M-e.", null, true],
  ["treesit-defun-name-function", "A function that gives the name of a defun node, or nil.", null, true],
  ["treesit-defun-tactic", 'How C-M-a and C-M-e treat defuns inside defuns: "nested" visits them, "top-level" only the outermost.', "nested", true],
  ["treesit-defun-skipper", "A function called after moving by defuns, to put point at a line's start or after a defun.", null, true],
  ["treesit-thing-settings", "For each language, [language, [[thing, predicate], ...]]: what a sexp, sentence, defun or other thing is.", null, true],
  ["treesit-indent-function", "The function treesit-indent asks for [anchor, offset], given the node, its parent and the line's start.", null, true],
] as const) {
  ember.defineVariable({ name, doc, value, local });
}

/** The language at a position: the first parser's, as treesit-language-at without a mode's function. */
export function languageAt(_pos?: number): string | undefined {
  const parser = ember.treesitParserList()[0];
  return parser && ember.treesitParserLanguage(parser);
}

/** The root of a language's tree, or the first parser's, as treesit-buffer-root-node. */
export function bufferRootNode(language?: string, tag?: string): Node {
  if (language !== undefined) return ember.treesitParserRootNode(ember.treesitParserCreate(language, null, false, tag ?? null));
  const parser = ember.treesitParserList()[0];
  if (parser === undefined) ember.signal("treesit-no-parser", "No tree-sitter parser in this buffer", [ember.currentBuffer()]);
  return ember.treesitParserRootNode(parser!);
}

function rootFor(parserOrLang: Parser | string | undefined, pos: number): Node | undefined {
  if (ember.treesitParserP(parserOrLang)) return ember.treesitParserRootNode(parserOrLang);
  const language = (parserOrLang as string | undefined) ?? languageAt(pos);
  if (language === undefined) return undefined;
  return bufferRootNode(language);
}

/**
 * The leaf node at a position, as treesit-node-at: the one covering it, or
 * ending at it, or else the first after it, or the last before it.
 */
export function nodeAt(pos: number, parserOrLang?: Parser | string, named = false): Node | undefined {
  const root = rootFor(parserOrLang, pos);
  if (root === undefined) return undefined;
  let node = root;
  let nodeBefore = root;
  const pos1 = Math.max(pos - 1, ember.pointMin());
  let next: Node | undefined;
  while ((next = ember.treesitNodeFirstChildForPos(node, pos, named))) node = next;
  if (ember.treesitNodeEq(node, root)) {
    while ((next = ember.treesitNodeChild(node, -1, named))) node = next;
    return node;
  }
  if (ember.treesitNodeStart(node)! <= pos) return node;
  while ((next = ember.treesitNodeFirstChildForPos(nodeBefore, pos1, named))) nodeBefore = next;
  return ember.treesitNodeEnd(nodeBefore) === pos ? nodeBefore : node;
}

/** The smallest node covering beg to end, as treesit-node-on. */
export function nodeOn(beg: number, end?: number, parserOrLang?: Parser | string, named = false): Node | undefined {
  const root = rootFor(parserOrLang, beg);
  return root && ember.treesitNodeDescendantForRange(root, beg, end ?? beg, named);
}

/** A node's text, with its properties unless noProperty, as treesit-node-text. */
export function nodeText(node: Node | undefined, noProperty = false): string | ember.PropertizedString | undefined {
  if (node === undefined) return undefined;
  const [start, end] = [ember.treesitNodeStart(node)!, ember.treesitNodeEnd(node)!];
  return ember.withCurrentBuffer(ember.treesitParserBuffer(ember.treesitNodeParser(node)), () =>
    noProperty ? ember.bufferSubstringNoProperties(start, end) : ember.bufferSubstring(start, end),
  );
}

/** The predicate a thing names for a language, as treesit-thing-definition. */
export function thingDefinition(thing: string, language?: string): Predicate | undefined {
  const settings = (ember.variable("treesit-thing-settings") ?? []) as unknown as [string, [string, Predicate][]][];
  for (const [lang, things] of settings) {
    if (language !== undefined && lang !== language) continue;
    const found = things.find(([name]) => name === thing);
    if (found) return found[1];
  }
  return undefined;
}

class MissingThing extends Error {}

function matches(node: Node, pred: Predicate, language: string): boolean {
  if (typeof pred === "string") return ember.stringMatch(pred, ember.treesitNodeType(node) ?? "") !== undefined;
  if (typeof pred === "function") return !nil(pred(node));
  if (typeof pred === "symbol") {
    const definition = thingDefinition(pred.description ?? "", language);
    if (definition === undefined) throw new MissingThing(pred.description);
    return matches(node, definition, language);
  }
  const [head, ...rest] = pred;
  if (head === "not") return !matches(node, rest[0]!, language);
  if (head === "or") return rest.some((p) => matches(node, p, language));
  if (typeof head === "string" && typeof rest[0] === "function") return matches(node, head, language) && matches(node, rest[0], language);
  return ember.signal("treesit-invalid-predicate", "Invalid predicate, see treesit-thing-settings for valid forms of predicate", [String(pred)]);
}

/** Whether a node matches a predicate, as treesit-node-match-p; a missing thing is an error unless ignoreMissing. */
export function nodeMatchP(node: Node | undefined, pred: Predicate, ignoreMissing = false): boolean {
  if (node === undefined) return false;
  try {
    return matches(node, pred, ember.treesitParserLanguage(ember.treesitNodeParser(node)));
  } catch (e) {
    if (!(e instanceof MissingThing)) throw e;
    if (ignoreMissing) return false;
    return ember.signal("treesit-predicate-not-found", "Cannot find the definition of the predicate in treesit-thing-settings", [e.message]);
  }
}

/** The first ancestor that matches, the node itself too with includeNode, as treesit-parent-until. */
export function parentUntil(node: Node | undefined, pred: Predicate, includeNode = false): Node | undefined {
  let n = includeNode ? node : node && ember.treesitNodeParent(node);
  while (n !== undefined && !nodeMatchP(n, pred)) n = ember.treesitNodeParent(n);
  return n;
}

/** The last of the node and its ancestors that match, while they do, as treesit-parent-while. */
export function parentWhile(node: Node | undefined, pred: Predicate): Node | undefined {
  let last: Node | undefined;
  let n = node;
  while (n !== undefined && nodeMatchP(n, pred)) {
    last = n;
    n = ember.treesitNodeParent(n);
  }
  return last;
}

/** The highest ancestor of the node's type, or that matches pred, as treesit-node-top-level. */
export function nodeTopLevel(node: Node, pred?: Predicate, includeNode = false): Node | undefined {
  const p = pred ?? `\\\`${regexpQuote(ember.treesitNodeType(node)!)}\\'`;
  let result: Node | undefined;
  for (let n = includeNode ? node : ember.treesitNodeParent(node); n !== undefined; n = ember.treesitNodeParent(n)) {
    if (nodeMatchP(n, p, true)) result = n;
  }
  return result;
}

export function nodeChildren(node: Node, named = false): Node[] {
  const count = ember.treesitNodeChildCount(node, named) ?? 0;
  return Array.from({ length: count }, (_, i) => ember.treesitNodeChild(node, i, named)!);
}

export function filterChild(node: Node, pred: (child: Node) => unknown, named = false): Node[] {
  return nodeChildren(node, named).filter((c) => !nil(pred(c)));
}

/** A node's index among its siblings, as treesit-node-index. */
export function nodeIndex(node: Node, named = false): number {
  let count = 0;
  for (let n = ember.treesitNodePrevSibling(node, named); n !== undefined; n = ember.treesitNodePrevSibling(n, named)) count++;
  return count;
}

/** The field a node is in its parent, as treesit-node-field-name. */
export function nodeFieldName(node: Node): string | undefined {
  const parent = ember.treesitNodeParent(node);
  return parent && ember.treesitNodeFieldNameForChild(parent, nodeIndex(node));
}

type Span = Node | [number, number];
const spanOf = (x: Span): [number, number] => (Array.isArray(x) ? x : [ember.treesitNodeStart(x)!, ember.treesitNodeEnd(x)!]);

/** Whether smaller lies inside larger, strictly with strict, or not equal with "partial", as treesit-node-enclosed-p. */
export function nodeEnclosedP(smaller: Span, larger: Span, strict: boolean | "partial" = false): boolean {
  const [ls, le] = spanOf(larger);
  const [ss, se] = spanOf(smaller);
  if (strict === true) return ls < ss && se < le;
  if (strict === "partial") return (ls !== ss || le !== se) && ls <= ss && ss <= se && se <= le;
  return ls <= ss && ss <= se && se <= le;
}

// Searching, as treesit.c's treesit-search-forward and treesit-search-subtree.

/** The next or previous sibling, named only if named. */
const sibling = (n: Node, forward: boolean, named: boolean): Node | undefined =>
  forward ? ember.treesitNodeNextSibling(n, named) : ember.treesitNodePrevSibling(n, named);

/** The first or last child, named only if named. */
const edgeChild = (n: Node, forward: boolean, named: boolean): Node | undefined =>
  ember.treesitNodeChild(n, forward ? 0 : -1, named);

/**
 * The next node after start that matches, leaves first and then their
 * parents, not looking into start's own subtree, as treesit-search-forward.
 * Only named nodes unless all.
 */
export function searchForward(start: Node, pred: Predicate, backward = false, all = false): Node | undefined {
  const [forward, named] = [!backward, !all];
  const match = (n: Node) => (!named || ember.treesitNodeCheck(n, "named")) && nodeMatchP(n, pred, true);
  let cursor = start;
  let initial = true;
  for (;;) {
    if (!initial && match(cursor)) return cursor;
    initial = false;
    let next = sibling(cursor, forward, named);
    while (next === undefined) {
      const parent = ember.treesitNodeParent(cursor);
      if (parent === undefined) return undefined;
      cursor = parent;
      if (match(cursor)) return cursor;
      next = sibling(cursor, forward, named);
    }
    cursor = next;
    for (let child = edgeChild(cursor, forward, false); child !== undefined; child = edgeChild(cursor, forward, false)) cursor = child;
  }
}

/** The first node in a subtree that matches, depth first, to depth levels, as treesit-search-subtree. */
export function searchSubtree(node: Node, pred: Predicate, backward = false, all = false, depth = 1000): Node | undefined {
  const named = !all;
  const visit = (n: Node, limit: number): Node | undefined => {
    if ((!named || ember.treesitNodeCheck(n, "named")) && nodeMatchP(n, pred, true)) return n;
    if (limit === 0) return undefined;
    const children = nodeChildren(n, named);
    for (const child of backward ? children.reverse() : children) {
      const found = visit(child, limit - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(node, depth);
}

/** Searches on from a node, going to the end of the one found, or its start with start, as treesit-search-forward-goto. */
export function searchForwardGoto(node: Node, pred: Predicate, start = false, backward = false, all = false): Node | undefined {
  const edge = (n: Node) => (start ? ember.treesitNodeStart(n)! : ember.treesitNodeEnd(n)!);
  const startPos = edge(node);
  let current = startPos;
  let n: Node | undefined = node;
  while (n !== undefined && (backward ? current >= startPos : current <= startPos)) {
    n = searchForward(n, pred, backward, all);
    if (n !== undefined) current = edge(n);
  }
  if (n !== undefined && (backward ? current < ember.point() : current > ember.point())) ember.gotoChar(current);
  return n;
}

// Indenting by rules, as treesit.el's treesit-simple-indent.

type IndentFn = (node: Node | undefined, parent: Node, bol: number) => unknown;
const startOf = (n: Node | undefined): number | undefined => (n === undefined ? undefined : ember.treesitNodeStart(n));
/** Emacs's string-match-p, folding case as case-fold-search says. */
const matchP = (regexp: string, text: string): boolean =>
  ember.stringMatch(regexp, text, { caseFold: !nil(ember.variable("case-fold-search")) }) !== undefined;
const typeIs = (re: string | null | undefined, n: Node | undefined) => re === null || re === undefined || matchP(re, ember.treesitNodeType(n) ?? "");

/** Back to indentation from a position, as (save-excursion (goto-char pos) (back-to-indentation) (point)). */
const indentationAt = (pos: number): number =>
  ember.saveExcursion(() => {
    ember.gotoChar(ember.lineBeginningPosition(pos));
    ember.skipCharsForward(" \t", ember.lineEndPosition());
    return ember.point();
  });

/** The presets rules are written with, as treesit-simple-indent-presets: each a function, or one that makes one. */
export const simpleIndentPresets: Record<string, (...args: never[]) => unknown> = {
  match:
    (nodeType?: string | null, parentType?: string | null, nodeField?: string | null, min?: number | null, max?: number | null): IndentFn =>
    (node, parent) =>
      (nodeType === "null" ? node === undefined : nodeType === null || nodeType === undefined || matchP(nodeType, ember.treesitNodeType(node) ?? "")) &&
      typeIs(parentType, parent) &&
      (nodeField === null || nodeField === undefined || matchP(nodeField, (node && nodeFieldName(node)) ?? "")) &&
      (min === null || min === undefined || (node !== undefined && nodeIndex(node) >= min)) &&
      (max === null || max === undefined || (node !== undefined && nodeIndex(node) <= max)),
  "n-p-gp":
    (nodeType: string | null, parentType: string | null, grandType: string | null): IndentFn =>
    (node, parent) =>
      (nodeType === null || matchP(nodeType, ember.treesitNodeType(node) ?? "")) &&
      typeIs(parentType, parent) &&
      (grandType === null || (ember.treesitNodeParent(parent) !== undefined && typeIs(grandType, ember.treesitNodeParent(parent)))),
  "no-node": ((node: Node | undefined) => node === undefined) as never,
  "parent-is": (type: string): IndentFn => (_n, parent) => matchP(type, ember.treesitNodeType(parent) ?? ""),
  "node-is": (type: string): IndentFn => (node) => matchP(type, ember.treesitNodeType(node) ?? ""),
  "field-is": (name: string): IndentFn => (node) => matchP(name, (node && nodeFieldName(node)) ?? ""),
  "comment-end": ((_n: unknown, _p: unknown, bol: number) =>
    ember.saveExcursion(() => ember.lookingAt(String(ember.variable("comment-end-skip") ?? "\\s>"), bol) === true)) as never,
  "catch-all": (() => true) as never,
  query:
    (pattern: string): IndentFn =>
    (node, parent) =>
      ember.treesitQueryCapture(parent, pattern).some(([, n]) => ember.treesitNodeEq(node, n)),
  "first-sibling": ((_n: unknown, parent: Node) => startOf(ember.treesitNodeChild(parent, 0))) as never,
  "nth-sibling":
    (n: number, named?: boolean): IndentFn =>
    (_n, parent) =>
      startOf(ember.treesitNodeChild(parent, n, named)),
  parent: ((_n: unknown, parent: Node) => startOf(parent)) as never,
  "comment-start": ((_n: unknown, parent: Node) =>
    ember.saveExcursion(() => {
      ember.gotoChar(startOf(parent)!);
      ember.reSearchForward(String(ember.variable("comment-start-skip")));
      ember.skipSyntaxBackward("-");
      return ember.point();
    })) as never,
  "prev-adaptive-prefix": ((_n: unknown, parent: Node, bol: number) => prevAdaptivePrefix(parent, bol)) as never,
  "grand-parent": ((_n: unknown, parent: Node) => startOf(ember.treesitNodeParent(parent))) as never,
  "great-grand-parent": ((_n: unknown, parent: Node) => {
    const grand = ember.treesitNodeParent(parent);
    return startOf(grand && ember.treesitNodeParent(grand));
  }) as never,
  "parent-bol": ((_n: unknown, parent: Node) => indentationAt(startOf(parent)!)) as never,
  "standalone-parent": ((_n: unknown, parent: Node | undefined) => {
    for (let p = parent; p !== undefined; p = ember.treesitNodeParent(p)) {
      const start = startOf(p)!;
      if (/^[ \t]*$/.test(ember.bufferText(ember.lineBeginningPosition(start), start))) return start;
    }
    return undefined;
  }) as never,
  "prev-sibling": ((node: Node | undefined, parent: Node, bol: number) =>
    startOf(
      (node && ember.treesitNodePrevSibling(node, true)) ??
        ember.treesitNodePrevSibling(ember.treesitNodeFirstChildForPos(parent, bol) as Node, true) ??
        ember.treesitNodeChild(parent, -1, true),
    )) as never,
  "no-indent": ((_n: unknown, _p: unknown, bol: number) => bol) as never,
  "prev-line": ((_n: unknown, _p: unknown, bol: number) =>
    ember.saveExcursion(() => {
      ember.gotoChar(bol);
      forwardLine(-1);
      ember.skipCharsForward(" \t");
      return ember.point();
    })) as never,
  "column-0": ((_n: unknown, _p: unknown, bol: number) => ember.lineBeginningPosition(bol)) as never,
  and:
    (...fns: IndentFn[]): IndentFn =>
    (node, parent, bol) => {
      let result: unknown;
      for (const fn of fns) {
        result = fn(node, parent, bol);
        if (nil(result)) return result;
      }
      return result;
    },
  or:
    (...fns: IndentFn[]): IndentFn =>
    (node, parent, bol) => {
      for (const fn of fns) {
        const result = fn(node, parent, bol);
        if (!nil(result)) return result;
      }
      return false;
    },
  not:
    (fn: IndentFn): IndentFn =>
    (node, parent, bol) =>
      nil(fn(node, parent, bol)),
  list:
    (...fns: IndentFn[]): IndentFn =>
    (node, parent, bol) =>
      fns.map((fn) => fn(node, parent, bol)),
};

/** The combinators, whose arguments are matchers or anchors themselves. */
const COMBINATORS = new Set(["and", "or", "not", "list"]);

/** A matcher, anchor or offset as a function of node, parent and bol, as treesit--simple-indent-eval. */
function indentFunction(exp: unknown): IndentFn | unknown {
  if (Array.isArray(exp)) {
    const [head, ...args] = exp;
    const fn = typeof head === "function" ? head : simpleIndentPresets[head as string];
    if (fn === undefined) ember.signal("error", `Unknown indent preset: ${String(head)}`);
    const evaluated = COMBINATORS.has(head as string) ? args.map(indentFunction) : args;
    return (fn as (...a: unknown[]) => unknown)(...evaluated);
  }
  if (typeof exp === "string" && exp in simpleIndentPresets) return simpleIndentPresets[exp];
  return exp;
}

const call = (fn: unknown, node: Node | undefined, parent: Node, bol: number): unknown =>
  typeof fn === "function" ? (fn as IndentFn)(node, parent, bol) : fn;

/** Where a comment line's prefix is, as the prev-adaptive-prefix anchor finds it. */
function prevAdaptivePrefix(parent: Node, bol: number): number | undefined {
  const regexp = ember.variable("adaptive-fill-regexp");
  if (typeof regexp !== "string") return undefined;
  return ember.saveExcursion(() => {
    const commentStartBol = ember.lineBeginningPosition(startOf(parent)!);
    ember.gotoChar(bol);
    const thisLineHasPrefix = ember.lookingAt(regexp) === true && !/^\s*$/.test(ember.matchString(0) ?? "");
    forwardLine(-1);
    if (ember.point() < commentStartBol || ember.lookingAt(regexp) !== true || ember.lookingAt("[ \t]*$") === true) return undefined;
    ember.lookingAt(regexp);
    return (thisLineHasPrefix ? ember.matchBeginning(1) : undefined) ?? ember.matchEnd(0);
  });
}

/** [anchor, offset] for a line, by treesit-simple-indent-rules, as treesit-simple-indent. */
export function simpleIndent(node: Node | undefined, parent: Node | undefined, bol: number): [number | undefined, number | undefined] {
  if (parent === undefined) return [undefined, undefined];
  const language = ember.treesitParserLanguage(ember.treesitNodeParser(parent));
  const all = (ember.variable("treesit-simple-indent-rules") ?? []) as unknown as [string, unknown[][]][];
  const rules = all.find(([lang]) => lang === language)?.[1] ?? [];
  for (const [matcher, anchor, offset] of rules) {
    if (nil(call(indentFunction(matcher), node, parent, bol))) continue;
    const anchorPos = call(indentFunction(anchor), node, parent, bol) as number | undefined;
    // A number, a variable's name, or a preset or function to call.
    let offsetValue: unknown = offset;
    if (typeof offset === "string" && typeof ember.variable(offset) === "number") offsetValue = ember.variable(offset);
    else if (typeof offset !== "number") offsetValue = call(indentFunction(offset), node, parent, bol);
    return [anchorPos ?? undefined, typeof offsetValue === "number" ? offsetValue : undefined];
  }
  return [undefined, undefined];
}

/** The node starting a line, its parent and the line's start, then [anchor, offset], as treesit--indent-1. */
function indent1(): [number | undefined, number | undefined] {
  const bol = indentationAt(ember.point());
  if (ember.treesitParserList().length === 0) return [undefined, undefined];
  const smallest = nodeAt(bol);
  const root = smallest && ember.treesitParserRootNode(ember.treesitNodeParser(smallest));
  const node = parentWhile(smallest, (n) => ember.treesitNodeStart(n) === bol && !ember.treesitNodeEq(n, root));
  const parent = node !== undefined ? ember.treesitNodeParent(node) : nodeOn(bol, bol);
  const fn = ember.variable("treesit-indent-function");
  if (typeof fn === "function" || typeof fn === "string") {
    const result = ember.funcall(fn, node ?? null, parent ?? null, bol) as unknown as [number, number] | null;
    return result ? [result[0], result[1]] : [undefined, undefined];
  }
  return simpleIndent(node, parent, bol);
}

/** Indents the line by the mode's rules, as treesit-indent. */
export const treesitIndent = ember.defun("treesit-indent", () => {
  const [anchor, offset] = indent1();
  if (anchor === undefined || offset === undefined) return;
  const column = ember.saveExcursion(() => {
    ember.gotoChar(anchor);
    return ember.currentColumn();
  }) + offset;
  const delta = ember.pointMax() - ember.point();
  ember.indentLineTo(column);
  if (ember.pointMax() - delta > ember.point()) ember.gotoChar(ember.pointMax() - delta);
});

// Things and defuns, as treesit.el's treesit-navigate-thing.

/** The smallest thing around pos, its start before pos if strict, as treesit-thing-at. */
export function thingAt(pos: number, thing: Predicate, strict = false): Node | undefined {
  return parentUntil(
    nodeAt(pos),
    (n: Node) => {
      const [start, end] = [ember.treesitNodeStart(n)!, ember.treesitNodeEnd(n)!];
      return nodeMatchP(n, thing, true) && (strict ? start < pos : start <= pos) && pos < end;
    },
    true,
  );
}

/** The next thing after pos, or with prev the previous one before it, as treesit--thing-sibling. */
function thingSibling(pos: number, thing: Predicate, prev: boolean): Node | undefined {
  let cursor = nodeAt(pos);
  const posPred = (n: Node) => (prev ? ember.treesitNodeEnd(n)! <= pos : ember.treesitNodeStart(n)! >= pos);
  const iterPred = (n: Node) => nodeMatchP(n, thing, true) && posPred(n);
  let found: Node | undefined;
  if (cursor === undefined) return undefined;
  ember.saveExcursion(() => {
    while (cursor !== undefined && !posPred(cursor)) cursor = searchForwardGoto(cursor, "", prev, prev, true);
  });
  while (cursor !== undefined && posPred(cursor) && found === undefined) {
    found = nodeTopLevel(cursor, iterPred, true);
    cursor = searchForward(cursor, thing, prev, prev);
  }
  return found;
}

/**
 * Where `arg` things on from pos are, back if negative, at their starts or
 * ends as side says, or undefined if there are not enough, as
 * treesit-navigate-thing.
 */
export function navigateThing(posIn: number, arg: number, side: "beg" | "end", thing: Predicate, tactic = "nested", recursing = false): number | undefined {
  let pos = posIn;
  let counter = Math.abs(arg);
  const advance = (n: Node | undefined): number => {
    if (n === undefined) throw new Done();
    return side === "beg" ? ember.treesitNodeStart(n)! : ember.treesitNodeEnd(n)!;
  };
  class Done extends Error {}
  try {
    while (counter > 0) {
      let prev = thingSibling(pos, thing, true);
      let next = thingSibling(pos, thing, false);
      let parent = thingAt(pos, thing, true);
      if (parent && prev && !nodeEnclosedP(prev, parent)) prev = undefined;
      if (parent && next && !nodeEnclosedP(next, parent)) next = undefined;
      if (tactic === "top-level" && parent) {
        parent = nodeTopLevel(parent, thing, true);
        prev = next = undefined;
      }
      if (tactic === "restricted") {
        pos = advance(next === undefined && prev === undefined ? parent : arg > 0 ? next : prev);
      } else if (arg > 0) {
        if (side === "beg" && (next ? !recursing && pos === advance(next) : parent !== undefined)) {
          const found = navigateThing(ember.treesitNodeEnd((next ?? parent)!)!, 1, "beg", thing, tactic, true);
          if (found === undefined) throw new Done();
          pos = found;
        } else {
          pos = advance(next ?? parent);
        }
      } else if (side === "end" && (prev ? !recursing && pos === advance(prev) : parent !== undefined)) {
        const found = navigateThing(ember.treesitNodeStart((prev ?? parent)!)!, -1, "end", thing, tactic, true);
        if (found === undefined) throw new Done();
        pos = found;
      } else {
        pos = advance(prev ?? parent);
      }
      counter--;
    }
  } catch (e) {
    if (e instanceof Done) return undefined;
    throw e;
  }
  return counter === 0 ? pos : undefined;
}

export function beginningOfThing(thing: Predicate, arg = 1, tactic?: string): boolean {
  const dest = navigateThing(ember.point(), -arg, "beg", thing, tactic);
  if (dest !== undefined) ember.gotoChar(dest);
  return dest !== undefined;
}

export function endOfThing(thing: Predicate, arg = 1, tactic?: string): boolean {
  const dest = navigateThing(ember.point(), arg, "end", thing, tactic);
  if (dest !== undefined) ember.gotoChar(dest);
  return dest !== undefined;
}

/** After moving by a defun: to the next line from a defun's end, or a line's start, as treesit-default-defun-skipper. */
export const defaultDefunSkipper = ember.defun("treesit-default-defun-skipper", () => {
  const bol = ember.lineBeginningPosition();
  if (ember.lookingAt("[ \t]*\n") === true && ember.point() !== bol) forwardLine(1);
  else if (ember.point() !== bol && /^[ \t]+$/.test(ember.bufferText(bol, ember.point()))) ember.gotoChar(bol);
});

const defunPredicate = (): Predicate => (ember.variable("treesit-defun-type-regexp") as string | null) ?? Symbol.for("defun");
const defunTactic = (): string => String(ember.variable("treesit-defun-tactic") ?? "nested");

function skipDefun(): void {
  const skipper = ember.variable("treesit-defun-skipper");
  if (!nil(skipper)) ember.funcall(skipper as string);
}

/** Moves back to the start of a defun, forward if negative, as treesit-beginning-of-defun. */
export function treesitBeginningOfDefun(argIn = 1): boolean {
  let arg = argIn;
  const orig = ember.point();
  let success = false;
  for (let i = 0; i < 2; i++) {
    if (beginningOfThing(defunPredicate(), arg, defunTactic()) && !nil(ember.variable("treesit-defun-skipper"))) {
      skipDefun();
      success = true;
    }
    if (arg === 0 || orig !== ember.point()) return success;
    arg = arg > 0 ? arg + 1 : arg - 1;
  }
  return success;
}

/** Moves forward to the end of a defun, back if negative, as treesit-end-of-defun. */
export function treesitEndOfDefun(argIn = 1): void {
  let arg = argIn === 0 ? 1 : argIn;
  const orig = ember.point();
  for (let i = 0; i < 2; i++) {
    if (endOfThing(defunPredicate(), arg, defunTactic())) skipDefun();
    if (arg === 0 || orig !== ember.point()) return;
    arg = arg > 0 ? arg + 1 : arg - 1;
  }
}

/** Pushes the mark before a run of a movement command, as the defun commands do. */
function markBeforeMoving(command: string): void {
  if (ember.thisCommand() === command && ember.lastCommand() !== command && !ember.regionActive()) ember.pushMark(ember.point());
}

ember.defineCommand({
  name: "treesit-beginning-of-defun",
  doc: "Move back to the beginning of a defun, by the syntax tree, or as many as the prefix argument says; forward if negative.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => {
    markBeforeMoving("treesit-beginning-of-defun");
    treesitBeginningOfDefun(arg);
  },
});

ember.defineCommand({
  name: "treesit-end-of-defun",
  doc: "Move forward to the end of a defun, by the syntax tree, or as many as the prefix argument says; back if negative.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => {
    markBeforeMoving("treesit-end-of-defun");
    treesitEndOfDefun(arg);
  },
});

/**
 * Moves over `arg` sexps by the tree, as treesit-forward-sexp: within the
 * thing around point, the next or previous sexp thing; in text, such as a
 * comment, as forward-sexp does by the syntax table. With none left, a
 * scan error, as forward-sexp gives.
 */
export function treesitForwardSexp(arg = 1): void {
  const pred = Symbol.for("sexp");
  const here = nodeAt(ember.point(), languageAt(ember.point()));
  if (here !== undefined && ember.treesitNodeStart(here)! < ember.point() && ember.point() < ember.treesitNodeEnd(here)! && nodeMatchP(here, Symbol.for("text"), true)) {
    forwardSexpDefault(arg);
    return;
  }
  const moved = arg > 0 ? endOfThing(pred, Math.abs(arg), "restricted") : beginningOfThing(pred, Math.abs(arg), "restricted");
  if (moved) return;
  const parent = thingAt(ember.point(), pred, true);
  const boundary = parent && ember.treesitNodeChild(parent, arg > 0 ? -1 : 0);
  if (boundary !== undefined) {
    ember.signal("scan-error", "No more sexp to move across", [
      "No more sexp to move across",
      ember.treesitNodeStart(boundary)! + 1,
      ember.treesitNodeEnd(boundary)! + 1,
    ]);
  }
}

/** The defun around point, the outermost with the top-level tactic, as treesit-defun-at-point. */
export function defunAtPoint(): Node | undefined {
  const node = thingAt(ember.point(), defunPredicate());
  return node && defunTactic() === "top-level" ? nodeTopLevel(node, defunPredicate(), true) : node;
}

/** A defun's name, by treesit-defun-name-function, as treesit-defun-name. */
export function defunName(node: Node | undefined): string | undefined {
  const fn = ember.variable("treesit-defun-name-function");
  if (nil(fn) || node === undefined) return undefined;
  return (ember.funcall(fn as string, node) as string | null) ?? undefined;
}

// Imenu from the tree, as treesit.el's treesit-simple-imenu.

ember.defineVariable({
  name: "treesit-simple-imenu-settings",
  doc: "What M-x imenu lists in a tree-sitter mode: a list of [category, regexp, pred, name-fn], nodes whose type matches regexp, grouped under category.",
  value: null,
  local: true,
});

/** A node and the matching nodes below it, as treesit-induce-sparse-tree makes them. */
type Sparse = [Node | undefined, Sparse[]];

/** The nodes under `root` that match, as a tree of their own, as treesit-induce-sparse-tree. */
export function induceSparseTree(root: Node, pred: Predicate, depth = 1000): Sparse {
  const visit = (n: Node, limit: number): Sparse[] => {
    const below = limit === 0 ? [] : nodeChildren(n).flatMap((c) => visit(c, limit - 1));
    return nodeMatchP(n, pred, true) ? [[n, below]] : below;
  };
  const below = nodeChildren(root).flatMap((c) => visit(c, depth - 1));
  return nodeMatchP(root, pred, true) ? [root, below] : [undefined, below];
}

type ImenuEntry = [string, number | ImenuEntry[]];

/** An index from a sparse tree, as treesit--simple-imenu-1: a defun with defuns inside is a submenu, " " itself. */
function simpleImenu1(tree: Sparse, pred: ((n: Node) => unknown) | null, nameFn: ((n: Node) => string | null) | null): ImenuEntry[] {
  const [node, children] = tree;
  const subtrees = children.flatMap((c) => simpleImenu1(c, pred, nameFn));
  if (node === undefined) return subtrees;
  if (pred && nil(pred(node))) return subtrees;
  const name = (nameFn ? nameFn(node) : defunName(node)) ?? "Anonymous";
  const start = ember.treesitNodeStart(node)!;
  return subtrees.length > 0 ? [[name, [[" ", start], ...subtrees]]] : [[name, start]];
}

/** The buffer's index by treesit-simple-imenu-settings, as treesit-simple-imenu. */
export const simpleImenu = ember.defun("treesit-simple-imenu", () => {
  const root = bufferRootNode();
  const settings = (ember.variable("treesit-simple-imenu-settings") ?? []) as unknown as [string | null, string, unknown, unknown][];
  const call = (f: unknown) => (typeof f === "function" || typeof f === "string" ? (n: Node) => ember.funcall(f as string, n) : null);
  return settings.flatMap(([category, regexp, pred, nameFn]): ImenuEntry[] => {
    const index = simpleImenu1(induceSparseTree(root, regexp), call(pred), call(nameFn) as ((n: Node) => string | null) | null);
    if (index.length === 0) return [];
    return category === null ? index : [[category, index] as ImenuEntry];
  }) as unknown as ember.Value;
});

/**
 * Turns on what the mode's tree-sitter settings ask for, as
 * treesit-major-mode-setup: indenting by treesit-simple-indent-rules,
 * M-x imenu by treesit-simple-imenu-settings, and C-M-a and C-M-e by
 * treesit-defun-type-regexp or a defun thing.
 */
export function majorModeSetup(keymap: string): void {
  if (nil(ember.variable("treesit-defun-skipper"))) ember.setVariable("treesit-defun-skipper", defaultDefunSkipper);
  if (!nil(ember.variable("treesit-simple-indent-rules")) || !nil(ember.variable("treesit-indent-function"))) {
    ember.setVariable("indent-line-function", treesitIndent);
  }
  if (!nil(ember.variable("treesit-simple-imenu-settings"))) ember.setVariable("imenu-create-index-function", simpleImenu);
  if (thingDefinition("sexp") !== undefined) {
    ember.setVariable("forward-sexp-function", ember.defun("treesit-forward-sexp", (arg: number) => treesitForwardSexp(arg)));
  }
  if (!nil(ember.variable("treesit-defun-type-regexp")) || thingDefinition("defun") !== undefined) {
    ember.remapCommand(keymap, "beginning-of-defun", "treesit-beginning-of-defun");
    ember.remapCommand(keymap, "end-of-defun", "treesit-end-of-defun");
    ember.setVariable("beginning-of-defun-function", ember.defun("treesit-beginning-of-defun-function", (arg: number) => treesitBeginningOfDefun(arg)));
    ember.setVariable("end-of-defun-function", ember.defun("treesit-end-of-defun-function", () => treesitEndOfDefun()));
  }
}
