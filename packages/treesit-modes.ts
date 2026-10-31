// Major modes that highlight with tree-sitter grammars, after Emacs's
// rust-ts-mode.el, js.el, json-ts-mode.el and python.el. Each is built on
// prog-mode and asks for its grammar with treesit-parser-create.

import { charCount } from "subr";
import { bufferRootNode, defunName, induceSparseTree, majorModeSetup, nodeText, nodeTopLevel, searchSubtree } from "treesit";

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

// --- Python's Imenu, as python.el's python-imenu-treesit-create-index ------

ember.defun("python--treesit-defun-name", (node: ember.TreesitNode) => {
  const type = ember.treesitNodeType(node);
  if (type !== "function_definition" && type !== "class_definition") return undefined;
  return nodeText(ember.treesitNodeChildByFieldName(node, "name"), true) as string | undefined;
});

/** How an item is labelled, as python-imenu-format-item-label: "name (def)". */
const pythonLabel = (type: string, name: string) => `${name} (${type})`;

type PythonSparse = [ember.TreesitNode | undefined, PythonSparse[]];
type PythonEntry = [string, number | PythonEntry[]];

/** The index from a sparse tree of definitions, as python--imenu-treesit-create-index-1. */
function pythonImenu1([node, children]: PythonSparse): PythonEntry[] {
  const subtrees = children.flatMap(pythonImenu1);
  if (node === undefined) return subtrees;
  const type = ember.treesitNodeType(node) === "class_definition" ? "class" : "def";
  const name = defunName(node) ?? "Anonymous";
  const start = ember.treesitNodeStart(node)!;
  if (subtrees.length === 0) return [[pythonLabel(type, name), start]];
  // As python-imenu-format-parent-item-label and -jump-label.
  return [[`${pythonLabel(type, name)}...`, [[type === "class" ? "*class definition*" : "*function definition*", start], ...subtrees]]];
}

ember.defun("python-imenu-treesit-create-index", () => {
  const tree = induceSparseTree(bufferRootNode("python"), "^\\(?:function\\|class\\)_definition$", 1000) as PythonSparse;
  return pythonImenu1(tree) as unknown as ember.Value;
});

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

// --- Tree-sitter indentation and navigation, as each mode's file has them ----------

/** Whether a "*" starts the line, as c-ts-common-looking-at-star. */
const lookingAtStar = (_n: unknown, _p: unknown, bol: number): boolean => ember.charAfter(bol) === "*";

/** Just after the "/*" a block comment starts with, as c-ts-common-comment-start-after-first-star. */
const commentStartAfterFirstStar = (_n: unknown, parent: ember.TreesitNode): number => {
  const start = ember.treesitNodeStart(parent)!;
  return ember.bufferText(start, start + 2) === "/*" ? start + 2 : start;
};

const ruleFor = (type: string, offset: string) => [["parent-is", type], "parent-bol", offset];

/** rust-ts-mode--indent-rules. */
const RUST_RULES = [
  [["parent-is", "source_file"], "column-0", 0],
  [["node-is", ")"], "parent-bol", 0],
  [["node-is", "]"], "parent-bol", 0],
  [["node-is", "}"], ["and", "parent", "parent-bol"], 0],
  [["and", ["parent-is", "comment"], lookingAtStar], commentStartAfterFirstStar, -1],
  [["parent-is", "comment"], "prev-adaptive-prefix", 0],
  ...[
    "arguments", "await_expression", "array_expression", "binary_expression", "block", "declaration_list", "enum_variant_list",
    "field_declaration_list", "field_expression", "field_initializer_list", "let_declaration", "macro_definition", "parameters",
    "struct_pattern", "token_tree", "use_list",
  ].map((type) => ruleFor(type, "rust-ts-mode-indent-offset")),
];

/** json-ts--indent-rules. */
const JSON_RULES = [
  [["node-is", "}"], "parent-bol", 0],
  [["node-is", ")"], "parent-bol", 0],
  [["node-is", "]"], "parent-bol", 0],
  ruleFor("object", "json-ts-mode-indent-offset"),
  ruleFor("array", "json-ts-mode-indent-offset"),
];

/** JSX's rules for older or newer grammars, as js-jsx--treesit-indent-compatibility-bb1f97b chooses them. */
function jsxCompatibility(): unknown[] {
  const fragment = ember.conditionCase(
    () => (ember.treesitQueryCompile("javascript", "(jsx_fragment) @capture"), true),
    { error: () => false },
  );
  return fragment
    ? [[["match", "<", "jsx_fragment"], "parent", 0], ruleFor("jsx_fragment", "js-indent-level").map((x, i) => (i === 1 ? "parent" : x))]
    : [[["match", "<", "jsx_text"], "parent", 0], ruleFor("jsx_text", "js-indent-level").map((x, i) => (i === 1 ? "parent" : x))];
}

/** js--treesit-indent-rules. */
const jsRules = (): unknown[] => {
  const switchCase = "switch_\\(?:case\\|default\\)";
  return [
    [["parent-is", "program"], "parent-bol", 0],
    [["node-is", "}"], "parent-bol", 0],
    [["node-is", ")"], "parent-bol", 0],
    [["node-is", "]"], "parent-bol", 0],
    [["node-is", ">"], "parent-bol", 0],
    [["and", ["parent-is", "comment"], lookingAtStar], commentStartAfterFirstStar, -1],
    [["parent-is", "comment"], "prev-adaptive-prefix", 0],
    ruleFor("ternary_expression", "js-indent-level"),
    ruleFor("member_expression", "js-indent-level"),
    [["node-is", switchCase], "parent-bol", 0],
    [["node-is", "statement_block"], "parent-bol", "js-indent-level"],
    ...["named_imports", "statement_block", "variable_declarator", "arguments", "array", "formal_parameters"].map((t) => ruleFor(t, "js-indent-level")),
    [["parent-is", "template_string"], "no-indent"],
    ...[
      "template_substitution", "object_pattern", "object", "pair", "arrow_function", "parenthesized_expression", "binary_expression",
      "class_body", switchCase, "statement_block",
    ].map((t) => ruleFor(t, "js-indent-level")),
    [["match", "while", "do_statement"], "parent-bol", 0],
    [["match", "else", "if_statement"], "parent-bol", 0],
    ruleFor("\\(?:\\(?:do\\|for\\(?:_in\\)?\\|if\\|while\\)_statement\\|else_clause\\)", "js-indent-level"),
    ...jsxCompatibility(),
    [["node-is", "jsx_closing_element"], "parent", 0],
    [["match", "jsx_element", "statement"], "parent", "js-indent-level"],
    [["parent-is", "jsx_element"], "parent", "js-indent-level"],
    ruleFor("jsx_text", "js-indent-level"),
    [["parent-is", "jsx_opening_element"], "parent", "js-indent-level"],
    ruleFor("jsx_expression", "js-indent-level"),
    [["match", "/", "jsx_self_closing_element"], "parent", 0],
    [["parent-is", "jsx_self_closing_element"], "parent", "js-indent-level"],
    ["no-node", "parent-bol", 0],
  ];
};

const fieldText = (node: ember.TreesitNode, field: string): string =>
  String(nodeText(ember.treesitNodeChildByFieldName(node, field), true) ?? "");

/** rust-ts-mode--defun-name. */
const rustDefunName = (node: ember.TreesitNode): string | null => {
  const type = ember.treesitNodeType(node);
  if (type === "impl_item") {
    const trait = ember.treesitNodeChildByFieldName(node, "trait");
    return `${trait ? `${nodeText(trait, true)} for ` : ""}${fieldText(node, "type")}`;
  }
  return ["enum_item", "function_item", "mod_item", "struct_item", "type_item"].includes(type ?? "") ? fieldText(node, "name") : null;
};

/** js--treesit-defun-name. */
const jsDefunName = (node: ember.TreesitNode): string | null => {
  const type = ember.treesitNodeType(node);
  const named = type === "lexical_declaration" ? searchSubtree(node, "variable_declarator", false, false, 1) : ["function_declaration", "method_definition", "class_declaration"].includes(type ?? "") ? node : undefined;
  return named ? fieldText(named, "name") : null;
};

/** json-ts-mode--defun-name. */
const jsonDefunName = (node: ember.TreesitNode): string | null =>
  ["pair", "object"].includes(ember.treesitNodeType(node) ?? "") ? fieldText(node, "key").replace(/^"/, "").replace(/"$/, "") : null;

/** What each language's mode sets for treesit.el, as its mode's body does. */
/** Any of these names as a whole symbol, as js--regexp-opt-symbol makes a regexp of them. */
const symbolRegexp = (names: string[]): string => `\\_<\\(${names.map((n) => n.replace(/[.*+?^$\\[\]]/g, "\\$&")).join("\\|")}\\)\\_>`;

/** js--treesit-valid-imenu-entry, as Emacs has it. */
const jsValidImenuEntry = (node: ember.TreesitNode): unknown =>
  ember.treesitNodeType(node) === "lexical_declaration" ? nodeTopLevel(node) : true;

const TREESIT_SETTINGS: Record<
  string,
  { rules: () => unknown[]; defun: string; name: (node: ember.TreesitNode) => string | null; electric: string; imenu: unknown[]; things?: unknown[] }
> = {
  rust: {
    imenu: [
      ["Module", "\\`mod_item\\'", null, null],
      ["Enum", "\\`enum_item\\'", null, null],
      ["Impl", "\\`impl_item\\'", null, null],
      ["Type", "\\`type_item\\'", null, null],
      ["Struct", "\\`struct_item\\'", null, null],
      ["Fn", "\\`function_item\\'", null, null],
    ],
    rules: () => RUST_RULES,
    defun: "\\(?:enum_item\\|function_item\\|impl_item\\|struct_item\\)",
    name: rustDefunName,
    electric: "{}():;,#",
  },
  javascript: {
    // js-ts-mode's treesit-thing-settings: js--treesit-sexp-nodes and the rest, as js--regexp-opt-symbol makes them.
    things: [
      ["sexp", symbolRegexp([
        "expression", "parenthesized_expression", "formal_parameters", "pattern", "array", "function", "string", "escape", "template",
        "regex", "number", "identifier", "this", "super", "true", "false", "null", "undefined", "arguments", "pair", "jsx",
        "statement_block", "object", "object_pattern", "named_imports", "class_body",
      ])],
      ["sentence", symbolRegexp([
        "import_statement", "debugger_statement", "expression_statement", "if_statement", "switch_statement", "for_statement",
        "for_in_statement", "while_statement", "do_statement", "try_statement", "with_statement", "break_statement",
        "continue_statement", "return_statement", "throw_statement", "empty_statement", "labeled_statement", "variable_declaration",
        "lexical_declaration", "jsx_element", "jsx_self_closing_element",
      ])],
      ["text", symbolRegexp(["comment", "template_string"])],
    ],
    imenu: [
      ["Function", "\\`function_declaration\\'", null, null],
      ["Variable", "\\`lexical_declaration\\'", jsValidImenuEntry, null],
      ["Class", "\\`\\(?:class_declaration\\|method_definition\\)\\'", null, null],
    ],
    rules: jsRules,
    defun: "\\(?:class_declaration\\|function_declaration\\|lexical_declaration\\|method_definition\\)",
    name: jsDefunName,
    electric: "{}():;,<>/",
  },
  json: { rules: () => JSON_RULES, defun: "\\(?:object\\|pair\\)", name: jsonDefunName, electric: "{}():;,", imenu: [[null, "\\`pair\\'", null, null]] },
};

const alist = ember.defaultValue("auto-mode-alist");
const entries = Array.isArray(alist) ? [...alist] : [];

/** A char literal, such as 'a', '"' or '\u{1F600}', rather than a lifetime. */
const RUST_CHAR = /'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/gu;

/**
 * Makes a char literal's quotes delimit a string, as rust-ts-mode's
 * syntax-propertize does, so a quote inside one, as in '"', opens nothing.
 */
function rustSyntaxPropertize(start: number, end: number): void {
  const text = ember.bufferText(start, end);
  for (const m of text.matchAll(RUST_CHAR)) {
    const at = start + charCount(text.slice(0, m.index));
    const close = at + charCount(m[0]) - 1;
    ember.putTextProperty(at, at + 1, "syntax-table", '"');
    ember.putTextProperty(close, close + 1, "syntax-table", '"');
  }
}

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
      ember.treesitSetPrimaryLanguage(mode.language);
      if (mode.comment !== undefined) {
        ember.setVariable("comment-start", mode.comment.start);
        ember.setVariable("comment-end", "");
        ember.setVariable("comment-start-skip", mode.comment.skip);
      }
      ember.setVariable("parse-sexp-ignore-comments", true);
      if (mode.tabs === false) ember.setVariable("indent-tabs-mode", false);
      // Python reindents the line it leaves only by hand, as electric-indent-inhibit says.
      ember.setVariable("electric-indent-inhibit", mode.language === "python");
      const settings = TREESIT_SETTINGS[mode.language];
      if (settings === undefined) {
        ember.setVariable("indent-line-function", "python-indent-line-function");
        ember.setVariable("electric-indent-chars", ["\n"]);
        ember.setVariable("imenu-create-index-function", "python-imenu-treesit-create-index");
        ember.setVariable("treesit-defun-type-regexp", "\\(?:class\\|function\\)_definition");
        ember.setVariable("treesit-defun-name-function", "python--treesit-defun-name");
        majorModeSetup(`${mode.name}-map`);
      } else {
        // Typing these reindents the line, as the mode's electric-indent-chars has them.
        ember.setVariable("electric-indent-chars", ["\n", ...settings.electric]);
        ember.setVariable("treesit-simple-indent-rules", [[mode.language, settings.rules()]] as unknown as ember.Value);
        ember.setVariable("treesit-defun-type-regexp", settings.defun);
        ember.setVariable("treesit-defun-name-function", ember.defun(`${mode.name}--defun-name`, settings.name));
        ember.setVariable("treesit-simple-imenu-settings", settings.imenu as unknown as ember.Value);
        if (settings.things) ember.setVariable("treesit-thing-settings", [[mode.language, settings.things]] as unknown as ember.Value);
        majorModeSetup(`${mode.name}-map`);
      }
      if (mode.language === "rust") {
        ember.setVariable("syntax-propertize-function", rustSyntaxPropertize);
        ember.setVariable("parse-sexp-lookup-properties", true);
      }
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
ember.defineKey("python-ts-mode-map", "C-c C-j", "imenu");

ember.setDefault("auto-mode-alist", entries);
