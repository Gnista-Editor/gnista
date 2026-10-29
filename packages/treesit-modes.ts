// Major modes that highlight with tree-sitter grammars, after Emacs's
// rust-ts-mode.el, js.el, json-ts-mode.el and python.el. Each is built on
// prog-mode and asks for its grammar with treesit-parser-create.

/** C's comments and operators, as c-mode's and js-mode's syntax tables have them. */
const C_SYNTAX: { [chars: string]: string } = {
  "/": ". 124b",
  "*": ". 23",
  "\n": "> b",
  "+-%<>&|=": ".",
  _: "_",
};

/** Python's, as python-mode-syntax-table: symbol characters but _ are punctuation, # starts a comment, ' quotes. */
const PYTHON_SYNTAX: { [chars: string]: string } = {
  "-+*/&|<>=$%": ".",
  "#": "<",
  "\n": ">",
  "'": '"',
  "`": "$",
};

type ModeSpec = {
  name: string;
  modeName: string;
  language: string;
  pattern: string;
  what: string;
  syntax?: { [chars: string]: string };
  comment?: { start: string; skip: string };
  /** The name Emacs's own mode for the language has, which runs this one, as major-mode-remap-alist can arrange. */
  alias?: string;
  /** Whether indenting may use tabs, as indent-tabs-mode; the language's own modes turn it off for Rust and Python. */
  tabs?: boolean;
};

const modes: ModeSpec[] = [
  {
    name: "rust-ts-mode",
    modeName: "Rust",
    language: "rust",
    pattern: "\\.rs\\'",
    what: "Rust",
    syntax: { ...C_SYNTAX, "'": "." },
    comment: { start: "// ", skip: "\\(?://+\\|/\\*+\\)\\s *" },
    tabs: false,
  },
  {
    name: "js-ts-mode",
    modeName: "JavaScript",
    language: "javascript",
    pattern: "\\.[cm]?js\\'",
    what: "JavaScript",
    syntax: { ...C_SYNTAX, "'`": '"', $: "_" },
    comment: { start: "// ", skip: "\\(?://+\\|/\\*+\\)\\s *" },
    alias: "js-mode",
  },
  { name: "json-ts-mode", modeName: "JSON", language: "json", pattern: "\\.json\\'", what: "JSON" },
  {
    name: "python-ts-mode",
    modeName: "Python",
    language: "python",
    pattern: "\\.py[iw]?\\'",
    what: "Python",
    syntax: PYTHON_SYNTAX,
    comment: { start: "# ", skip: "#+\\s-*" },
    alias: "python-mode",
    tabs: false,
  },
];

// --- Indentation -------------------------------------------------------------

for (const [name, value, doc] of [
  ["js-indent-level", 4, "How far JavaScript indents each level."],
  ["rust-ts-mode-indent-offset", 4, "How far Rust indents each level."],
  ["json-ts-mode-indent-offset", 2, "How far JSON indents each level."],
  ["python-indent-offset", 4, "How far Python indents each block."],
] as const) {
  ember.defineVariable({ name, value, doc });
}

const charAt = (p: number): string => ember.charAfter(p) ?? "";

const indentationOf = (line: number): number => ember.currentIndentation(ember.lineStart(line));

/** Indents point's line to `column`, point kept with the text after the indentation, as js-indent-line does. */
function indentKeepingPoint(column: number): void {
  const offset = ember.point() - (ember.lineBeginningPosition() + /^[ \t]*/.exec(ember.lineText(ember.lineOf(ember.point())))![0].length);
  ember.indentLineTo(column);
  if (offset > 0) ember.gotoChar(ember.point() + offset);
}

const columnOf = (p: number): number =>
  ember.saveExcursion(() => {
    ember.gotoChar(p);
    return ember.currentColumn();
  });

const offsetFor = (): number => {
  const mode = String(ember.variable("major-mode"));
  const name = mode === "rust-ts-mode" ? "rust-ts-mode-indent-offset" : mode === "json-ts-mode" ? "json-ts-mode-indent-offset" : "js-indent-level";
  return Number(ember.variable(name) ?? 4);
};

/**
 * The column a line of code in braces and parens goes to, as
 * js--proper-indentation reckons it: in a list with nothing after its
 * opening paren, a level deeper than the line the list starts on, or the
 * same for its closing paren; with something after it, under that.
 */
function bracedIndentation(line: number): number | undefined {
  const start = ember.lineStart(line);
  const st = ember.syntaxPpss(start);
  // Strings and comments keep their indentation.
  if (st.inString !== null || st.inComment !== null) return undefined;
  const text = ember.lineText(line);
  const first = start + /^[ \t]*/.exec(text)![0].length;
  const open = st.innermostStart;
  if (open === null) return 0;
  const closing = ember.charSyntax(charAt(first)) === ")";
  // What follows the open paren on its line, if anything but a comment.
  let q = open + 1;
  const lineEnd = ember.lineEnd(ember.lineOf(open));
  while (q < lineEnd && " \t".includes(charAt(q))) q++;
  const rest = ember.bufferText(q, lineEnd);
  if (q >= lineEnd || rest.startsWith("//") || rest.startsWith("/*")) {
    // The line the list starts on, from a condition's open paren if it closes just before.
    let p = open;
    while (p > 0 && " \t".includes(charAt(p - 1))) p--;
    if (charAt(p - 1) === ")") {
      const back = ember.scanLists(p, -1, 0);
      if (back !== null) p = back;
    }
    const base = indentationOf(ember.lineOf(p));
    return closing ? base : base + offsetFor();
  }
  return closing ? columnOf(open) : columnOf(q);
}

ember.defineCommand({
  name: "js-indent-line",
  doc: "Indent the current line of code by the braces and parens it is in, as js-mode does, by js-indent-level, or the mode's own offset.",
  run: () => {
    const line = ember.lineOf(ember.point());
    const column = bracedIndentation(line);
    if (column !== undefined) indentKeepingPoint(column);
  },
});

/** The column a line of Python goes to, as python-indent-line-function does on its first try. */
function pythonIndentation(line: number): number | undefined {
  const start = ember.lineStart(line);
  const st = ember.syntaxPpss(start);
  if (st.inString !== null) return undefined;
  const offset = Number(ember.variable("python-indent-offset") ?? 4);
  const text = ember.lineText(line).trim();
  // In parens: under what follows the open paren, or a block deeper than its line.
  if (st.innermostStart !== null) {
    const open = st.innermostStart;
    let q = open + 1;
    const lineEnd = ember.lineEnd(ember.lineOf(open));
    while (q < lineEnd && " \t".includes(charAt(q))) q++;
    const closing = ember.charSyntax(text[0] ?? "") === ")";
    if (q >= lineEnd || charAt(q) === "#") return indentationOf(ember.lineOf(open)) + (closing ? 0 : offset);
    return closing ? columnOf(open) : columnOf(q);
  }
  // The code line before, not blank or a comment.
  let prev = line - 1;
  while (prev >= 0 && /^\s*(#.*)?$/.test(ember.lineText(prev))) prev--;
  if (prev < 0) return 0;
  // A line ending a list goes from where the list started.
  let from = prev;
  const prevSt = ember.syntaxPpss(ember.lineStart(prev));
  if (prevSt.openParens.length > 0) from = ember.lineOf(prevSt.openParens[0]);
  const prevText = ember.lineText(prev).replace(/\s*#.*$/, "").trimEnd();
  let column = indentationOf(from);
  if (prevText.endsWith(":")) column += offset;
  else if (/^\s*(return|pass|break|continue|raise)\b/.test(ember.lineText(prev))) column = Math.max(0, column - offset);
  // A block's later parts go back to the block they belong to.
  const dedenter = /^(else|elif|except|finally)\b/.exec(text);
  if (dedenter !== null) {
    const opener = { else: /^(if|elif|for|while|try|except)\b/, elif: /^(if|elif)\b/, except: /^(try|except)\b/, finally: /^(try|except|else)\b/ }[dedenter[1] as "else"];
    for (let l = line - 1; l >= 0; l--) {
      const t = ember.lineText(l).trim();
      if (t === "" || t.startsWith("#")) continue;
      if (indentationOf(l) < column && opener.test(t)) return indentationOf(l);
      if (indentationOf(l) < column - offset) break;
    }
    return Math.max(0, column - offset);
  }
  return column;
}

ember.defineCommand({
  name: "python-indent-line-function",
  doc: "Indent the current line of Python as its block says: deeper after a line ending in a colon, back after return, and else, elif, except and finally with their block.",
  run: () => {
    const column = pythonIndentation(ember.lineOf(ember.point()));
    if (column !== undefined) indentKeepingPoint(column);
  },
});

const alist = ember.defaultValue("auto-mode-alist");
const entries = Array.isArray(alist) ? [...alist] : [];

for (const mode of modes) {
  ember.defineMajorMode({
    name: mode.name,
    modeName: mode.modeName,
    parent: "prog-mode",
    doc:
      `The major mode for editing ${mode.what}, highlighted from a tree-sitter syntax tree.\n\n` +
      `Files matching ${mode.pattern} use it; see auto-mode-alist.`,
    syntax: mode.syntax,
    setup: () => {
      ember.treesitParserCreate(mode.language);
      if (mode.comment !== undefined) {
        ember.setVariable("comment-start", mode.comment.start);
        ember.setVariable("comment-end", "");
        ember.setVariable("comment-start-skip", mode.comment.skip);
      }
      ember.setVariable("parse-sexp-ignore-comments", true);
      if (mode.tabs === false) ember.setVariable("indent-tabs-mode", false);
      ember.setVariable("indent-line-function", mode.language === "python" ? "python-indent-line-function" : "js-indent-line");
      // Typing a closing brace or paren reindents its line, as electric-indent-chars has them;
      // Python reindents the line it leaves only by hand, as electric-indent-inhibit says.
      ember.setVariable("electric-indent-chars", mode.language === "python" ? ["\n"] : ["\n", "}", ")", "]"]);
      ember.setVariable("electric-indent-inhibit", mode.language === "python");
    },
  });
  if (mode.alias !== undefined) {
    ember.defineCommand({
      name: mode.alias,
      doc: `Edit ${mode.what}, in ${mode.name}: Ember's mode for it, as major-mode-remap-alist would have Emacs use.`,
      run: () => ember.call(mode.name as ember.CommandName),
    });
  }
  entries.push([mode.pattern, mode.name]);
}

ember.setDefault("auto-mode-alist", entries);
