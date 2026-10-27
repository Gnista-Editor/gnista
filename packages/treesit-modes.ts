// Major modes that highlight with tree-sitter grammars, after Emacs's
// rust-ts-mode.el, js.el, json-ts-mode.el and python.el. Each is built on
// prog-mode and asks for its grammar with treesit-parser-create.

const modes: { name: string; modeName: string; language: string; pattern: string; what: string }[] = [
  { name: "rust-ts-mode", modeName: "Rust", language: "rust", pattern: "\\.rs$", what: "Rust" },
  { name: "js-ts-mode", modeName: "JavaScript", language: "javascript", pattern: "\\.[cm]?js$", what: "JavaScript" },
  { name: "json-ts-mode", modeName: "JSON", language: "json", pattern: "\\.json$", what: "JSON" },
  { name: "python-ts-mode", modeName: "Python", language: "python", pattern: "\\.py[iw]?$", what: "Python" },
];

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
    setup: () => ember.treesitParserCreate(mode.language),
  });
  entries.push([mode.pattern, mode.name]);
}

ember.setDefault("auto-mode-alist", entries);
