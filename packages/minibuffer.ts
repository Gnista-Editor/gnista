// Completing the text at point, after Emacs's minibuffer.el: C-M-i runs
// completion-at-point, which asks completion-at-point-functions for what
// could complete the text before point, as a language server or a mode
// gives it. One completion, or the part all share, is put in at once; for
// several, the minibuffer asks which, as completion-in-region would show
// them, with what is typed so far as its input.


gnista.defineHook(
  "completion-at-point-functions",
  "Functions that say what completes the text at point: each gives [start, end, completions] or nil, the first that gives one winning.",
);

/** The part strings share at their start. */
function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/** Puts a completion in place of the text from `start` to `end`, as completion-in-region does. */
function replace(start: number, end: number, text: string): void {
  gnista.deleteRegion(start, end);
  gnista.gotoChar(start);
  gnista.insert(text);
}

/**
 * Completes the text from `start` to `end` from `collection`, as
 * completion-in-region: a sole match goes in; the part all matches share
 * goes in if it is longer; otherwise the minibuffer asks.
 */
export function completionInRegion(start: number, end: number, collection: string[]): boolean {
  const typed = gnista.bufferText(start, end);
  const matches = collection.filter((c) => c.startsWith(typed));
  const candidates = matches.length > 0 ? matches : collection;
  if (candidates.length === 0) {
    gnista.message("No match");
    return false;
  }
  if (candidates.length === 1) {
    replace(start, end, candidates[0]);
    if (candidates[0] === typed) gnista.message("Sole completion");
    return true;
  }
  const prefix = commonPrefix(candidates);
  if (matches.length > 0 && prefix.length > typed.length) {
    replace(start, end, prefix);
    return true;
  }
  const chosen = gnista.completingRead("Complete: ", candidates, { initial: matches.length > 0 ? typed : "" });
  if (chosen !== "") replace(start, end, chosen);
  return true;
}

gnista.defineCommand({
  name: "completion-at-point",
  doc:
    "Complete the text at point, from what completion-at-point-functions give: one completion goes in, or the part they share; " +
    "with several, the minibuffer asks which.",
  run: () => {
    const found = gnista.runHookWithArgsUntilSuccess("completion-at-point-functions");
    if (!Array.isArray(found) || found.length < 3) {
      gnista.message("No completions at point");
      return;
    }
    const [start, end, collection] = found as [number, number, gnista.Value];
    const table = typeof collection === "function" ? (collection as unknown as () => string[])() : collection;
    completionInRegion(start, end, Array.isArray(table) ? table.map(String) : []);
  },
});

gnista.defalias("complete-symbol", "completion-at-point");
gnista.bindKey("C-M-i", "completion-at-point");


// Completion for scripts that show it their own way, as vertico does: the
// open prompt's completions in each style, styles that packages add, as
// orderless does to completion-styles-alist, and the prompt's metadata,
// as completion-metadata gives it.

gnista.defineVariable({
  name: "completion-styles-alist",
  doc: "The completion styles there are, as [name, doc] pairs: those Gnista has built in and those packages add with defineCompletionStyle.",
  value: [
    ["basic", "Completion of the prefix before point and the suffix after point."],
    ["partial-completion", "Completion of multiple words, each one taken as a prefix."],
    ["substring", "Completion of the string taken as a substring."],
    ["flex", "Completion of an in-order subset of characters."],
    ["emacs22", "Prefix completion that only operates on the text before point."],
  ],
});

/** The open prompt's input, split as completion-boundaries splits it, with what it completes against. */
export interface CompletionField {
  base: string;
  before: string;
  after: string;
  suffix: string;
  names: string[];
}

/** What a completion style finds: the matches, and how to highlight one, as completion-lazy-hilit-fn. */
export interface StyleMatches {
  completions: string[];
  hilit?: (candidate: string) => string | gnista.PropertizedString;
}

/** A completion style a package adds, as an entry of completion-styles-alist. */
export interface CompletionStyle {
  doc: string;
  /** The names the field matches, as the style's all-completions function. */
  all: (field: CompletionField, ignoreCase: boolean) => StyleMatches | undefined;
}

const scriptStyles = new Map<string, CompletionStyle>();

/** Adds a completion style, for completion-styles to name, as an entry of completion-styles-alist. */
export function defineCompletionStyle(name: string, style: CompletionStyle): void {
  scriptStyles.set(name, style);
  const alist = gnista.variable("completion-styles-alist");
  const entries = Array.isArray(alist) ? (alist as gnista.Value[][]).filter((e) => e[0] !== name) : [];
  gnista.setDefault("completion-styles-alist", [...entries, [name, style.doc]]);
}

/** The metadata of a completion table, as Emacs's completion metadata: what kind of things it completes and how to show them. */
export interface CompletionMetadata {
  category?: string;
  /** Text to show after a candidate. */
  annotationFunction?: (candidate: string) => string | gnista.PropertizedString | undefined;
  /** Each candidate with text to show before and after it, as [candidate, prefix, suffix]. */
  affixationFunction?: (candidates: string[]) => [string, string | gnista.PropertizedString, string | gnista.PropertizedString][];
  /** A candidate's group title, or with `transform` the candidate as shown in its group. */
  groupFunction?: (candidate: string, transform: boolean) => string | undefined;
  /** How to order the candidates for showing them. */
  displaySortFunction?: (candidates: string[]) => string[];
  cycleSortFunction?: (candidates: string[]) => string[];
  /** How much of the input completion leaves alone, as a table's completion-boundaries: the rest is matched against the candidates. */
  boundaries?: (input: string) => number;
}

/** The metadata each open prompt's caller gave, by minibuffer depth. */
const metadataByDepth = new Map<number, CompletionMetadata>();

/**
 * Reads with completion, as completingRead does, the table's metadata
 * given too, as a completion table gives Emacs's completing-read its
 * metadata: annotations, groups, a sort.
 */
export function completingReadWithMetadata(
  prompt: string,
  collection: gnista.CompletionTable,
  options: gnista.CompletingReadOptions & { metadata?: CompletionMetadata } = {},
): string {
  const { metadata, ...rest } = options;
  const depth = gnista.minibufferDepth() + 1;
  const old = metadataByDepth.get(depth);
  if (metadata) metadataByDepth.set(depth, { ...metadata, category: metadata.category ?? rest.category });
  try {
    return gnista.completingRead(prompt, collection, { ...rest, category: rest.category ?? metadata?.category });
  } finally {
    if (old) metadataByDepth.set(depth, old);
    else metadataByDepth.delete(depth);
  }
}

/** A property of the open prompt's metadata, as completion-metadata-get: marginalia advises it to give annotations by category. */
export function completionMetadataGet<K extends keyof CompletionMetadata>(prop: K): CompletionMetadata[K] | undefined {
  return gnista.funcall("completion-metadata-get", prop) as CompletionMetadata[K] | undefined;
}

gnista.defun("completion-metadata-get", (prop: string) => {
  const own = metadataByDepth.get(gnista.minibufferDepth());
  if (prop === "category") return own?.category ?? gnista.minibufferInfo()?.category ?? undefined;
  return own?.[prop as keyof CompletionMetadata];
});

/** Highlights the part of CANDIDATE a built-in style matched, in completions-common-part, as completion-hilit-commonality does. */
function builtinHilit(style: string, field: CompletionField, ignoreCase: boolean): ((candidate: string) => string | gnista.PropertizedString) | undefined {
  const typed = field.before;
  if (typed === "") return undefined;
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  return (candidate) => {
    const at = style === "substring" ? fold(candidate).indexOf(fold(typed)) : fold(candidate).startsWith(fold(typed)) ? 0 : -1;
    if (at < 0) return candidate;
    return gnista.concat(candidate.slice(0, at), gnista.propertize(candidate.slice(at, at + typed.length), { face: "completions-common-part" }), candidate.slice(at + typed.length));
  };
}

/**
 * The open prompt's completions in the first of its styles that finds any,
 * as completion-all-completions, with the base they go after and how to
 * highlight them; undefined with no prompt that completes.
 */
export function completionAllCompletions(point?: number): (StyleMatches & { base: string; style?: string; field: CompletionField }) | undefined {
  let field = gnista.minibufferCompletionField(point);
  if (!field) return undefined;
  const boundaries = completionMetadataGet("boundaries");
  if (boundaries) {
    const whole = field.before + field.after;
    const n = Math.min(boundaries(whole), whole.length);
    const cut = Math.min(n, field.before.length);
    field = { ...field, base: field.base + whole.slice(0, n), before: field.before.slice(cut), after: n > field.before.length ? field.after.slice(n - field.before.length) : field.after };
  }
  const ignoreCase = gnista.minibufferInfo()?.ignoreCase ?? false;
  for (const style of gnista.completionStyles()) {
    const own = scriptStyles.get(style);
    const found: StyleMatches | undefined = own
      ? own.all(field, ignoreCase)
      : (() => {
          const completions = gnista.completionAllInStyle(style, field.before, field.after, field.names, ignoreCase);
          return completions ? { completions, hilit: builtinHilit(style, field, ignoreCase) } : undefined;
        })();
    if (found && found.completions.length > 0) return { ...found, base: field.base, style, field };
  }
  return { completions: [], base: field.base, field };
}

/** Whether INPUT is an answer the open prompt takes, as test-completion: the part after the table's boundaries one of its names. */
export function testCompletion(input: string): boolean {
  const boundaries = completionMetadataGet("boundaries");
  return gnista.testCompletion(boundaries ? input.slice(Math.min(boundaries(input), input.length)) : input);
}
