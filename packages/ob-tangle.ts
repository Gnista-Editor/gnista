// Tangling, after Org's ob-tangle.el: C-c C-v t writes the source blocks of
// an Org file whose :tangle header argument names a file, or is yes for
// the Org file's name with the language's extension, into those files, as
// a literate configuration is turned into the code it describes. Header
// arguments come from org-babel-default-header-args, #+PROPERTY: header-args
// lines, the header-args properties of the headings above a block, and the
// block's own #+begin_src line and #+header: lines, the nearest winning.

import { headings, keywordLines } from "org";
import { truthy } from "subr";

ember.defineVariable({
  name: "org-babel-default-header-args",
  doc: "The header arguments every source block has unless it says otherwise: pairs of an argument and its value.",
  value: [
    [":session", "none"],
    [":results", "replace"],
    [":exports", "code"],
    [":cache", "no"],
    [":noweb", "no"],
    [":hlines", "no"],
    [":tangle", "no"],
  ],
});
ember.defineVariable({
  name: "org-babel-tangle-lang-exts",
  doc: "The extension a language's code is tangled to with :tangle yes: pairs of a language and an extension, else the language's name.",
  value: [
    ["emacs-lisp", "el"],
    ["elisp", "el"],
    ["python", "py"],
    ["shell", "sh"],
    ["sh", "sh"],
    ["bash", "sh"],
    ["javascript", "js"],
    ["js", "js"],
    ["typescript", "ts"],
    ["rust", "rs"],
    ["julia", "jl"],
    ["ruby", "rb"],
    ["haskell", "hs"],
    ["latex", "tex"],
    ["C", "c"],
    ["C++", "cpp"],
  ],
});
ember.defineVariable({
  name: "org-src-preserve-indentation",
  doc: "Whether a source block's code keeps its indentation when tangled, rather than losing what all its lines share.",
  value: false,
});
for (const [name, doc] of [
  ["org-babel-pre-tangle-hook", "Run before tangling."],
  ["org-babel-post-tangle-hook", "Run in each file tangled, visited, after tangling."],
  ["org-babel-tangle-finished-hook", "Run once tangling is done."],
] as const) {
  ember.defineHook(name, doc);
}

type Params = Map<string, string>;

const pairs = (v: ember.Value | undefined): [string, string][] =>
  Array.isArray(v) ? (v.filter((p) => Array.isArray(p) && p.length >= 2) as [string, string][]).map(([k, x]) => [String(k), String(x)]) : [];

/** Header arguments as a line writes them, ":tangle ~/x.el :mkdirp yes", as org-babel-parse-header-arguments reads them. */
export function parseHeaderArguments(text: string): Params {
  const out: Params = new Map();
  for (const part of ` ${text}`.split(/[ \t]+(?=:\S)/)) {
    const m = /^:(\S+)(?:[ \t]+([\s\S]*))?$/.exec(part.trim());
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    // As org-babel-read reads a quoted string: without its quotes.
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) value = JSON.parse(value) as string;
    out.set(`:${m[1]}`, value);
  }
  return out;
}

/** Merges header arguments, later ones winning, as org-babel-merge-params. */
const merge = (...all: Params[]): Params => new Map(all.flatMap((p) => [...p]));

/** The header arguments #+PROPERTY: lines give the buffer: for all languages, or with `language` for that one. */
function bufferHeaderArgs(language?: string): Params {
  let out: Params = new Map();
  for (const [, , text] of keywordLines()) {
    const m = /^#\+PROPERTY:[ \t]+header-args(?::(\S+?))?(\+)?[ \t]+(.*)$/i.exec(text);
    if (m && m[1] === language) out = merge(out, parseHeaderArguments(m[3]));
  }
  return out;
}

/** A heading's header-args property: for all languages, or with `language` for that one. */
function headingHeaderArgs(line: number, language?: string): Params {
  let out: Params = new Map();
  let k = line + 1;
  // Past the planning line, if any, to the drawer.
  if (/^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/.test(ember.lineText(k))) k++;
  if (!/^[ \t]*:PROPERTIES:[ \t]*$/i.test(ember.lineText(k))) return out;
  for (k++; k < ember.lineCount() && !/^[ \t]*:END:[ \t]*$/i.test(ember.lineText(k)); k++) {
    const m = /^[ \t]*:header-args(?::(\S+?))?(\+)?:[ \t]*(.*)$/i.exec(ember.lineText(k));
    if (m && m[1] === language) out = merge(out, parseHeaderArguments(m[3]));
  }
  return out;
}

/** A source block: where it is, its language, its header arguments and its code. */
interface Block {
  line: number;
  language: string;
  params: Params;
  body: string;
}

const BEGIN = /^[ \t]*#\+begin_src(?:[ \t]+(\S+)(.*))?$/i;
const END = /^[ \t]*#\+end_src[ \t]*$/i;

/** A block's code as tangled: without the indentation its lines share, and Org's escaping commas, as org-babel-get-src-block-info has it. */
function blockBody(lines: string[]): string {
  let out = lines;
  if (!truthy(ember.variable("org-src-preserve-indentation"))) {
    const indents = out.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
    const common = indents.length ? Math.min(...indents) : 0;
    out = out.map((l) => l.slice(Math.min(common, /^[ \t]*/.exec(l)![0].length)));
  }
  // As org-unescape-code-in-string: one comma less before * and #+ at a line's start.
  return out.map((l) => l.replace(/^([ \t]*,*),(?=\*|#\+)/, "$1")).join("\n");
}

/** Whether a heading, or one above it, is commented or archived, as org-in-commented-heading-p and org-in-archived-heading-p ask. */
function skipped(ancestors: { line: number }[]): boolean {
  return ancestors.some(({ line }) => {
    const text = ember.lineText(line);
    return /^\*+[ \t]+(?:\S+[ \t]+)?COMMENT\b/.test(text) || /:ARCHIVE:(?:\S*:)?[ \t]*$/.test(text);
  });
}

/** The buffer's source blocks with their header arguments, in order, as org-babel-map-src-blocks finds them. */
function collectBlocks(): Block[] {
  const all = headings();
  const blocks: Block[] = [];
  const defaults = new Map(pairs(ember.variable("org-babel-default-header-args")));
  for (let line = 0; line < ember.lineCount(); line++) {
    const m = BEGIN.exec(ember.lineText(line));
    if (!m) continue;
    let end = line + 1;
    while (end < ember.lineCount() && !END.test(ember.lineText(end))) end++;
    if (end >= ember.lineCount()) break;
    // The headings this block is under, outermost first.
    const ancestors: { line: number; level: number }[] = [];
    for (const h of all) {
      if (h.line > line) break;
      while (ancestors.length && ancestors[ancestors.length - 1].level >= h.level) ancestors.pop();
      ancestors.push({ line: h.line, level: h.level });
    }
    const language = m[1] ?? "";
    if (!skipped(ancestors) && language !== "") {
      // #+header: lines just before the block add to its own arguments.
      const headers: Params[] = [];
      for (let k = line - 1; k >= 0; k--) {
        const h = /^[ \t]*#\+headers?:[ \t]*(.*)$/i.exec(ember.lineText(k));
        if (!h) break;
        headers.unshift(parseHeaderArguments(h[1]));
      }
      const langDefaults = new Map(pairs(ember.variable(`org-babel-default-header-args:${language}`)));
      // As org-babel-params-from-properties: the header-args properties,
      // inherited, then the language's, each the buffer's then the headings'.
      const params = merge(
        defaults,
        langDefaults,
        bufferHeaderArgs(),
        ...ancestors.map((a) => headingHeaderArgs(a.line)),
        bufferHeaderArgs(language),
        ...ancestors.map((a) => headingHeaderArgs(a.line, language)),
        ...headers,
        parseHeaderArguments(m[2] ?? ""),
      );
      const lines: string[] = [];
      for (let k = line + 1; k < end; k++) lines.push(ember.lineText(k));
      blocks.push({ line, language, params, body: blockBody(lines) });
    }
    line = end;
  }
  return blocks;
}

/** The file a block tangles to, or undefined for :tangle no, as org-babel-effective-tangled-filename. */
function tangledFile(block: Block, orgFile: string): string | undefined {
  const tangle = block.params.get(":tangle") ?? "no";
  if (tangle === "no" || tangle === "") return undefined;
  const dir = ember.fileNameDirectory(orgFile) ?? undefined;
  if (tangle === "yes") {
    const exts = new Map(pairs(ember.variable("org-babel-tangle-lang-exts")));
    const base = ember.fileNameNondirectory(orgFile).replace(/\.[^./]*$/, "");
    return ember.expandFileName(`${base}.${exts.get(block.language) ?? block.language}`, dir);
  }
  return ember.expandFileName(tangle, dir);
}

/** A file mode as :tangle-mode writes it, "o755" or 0o755, as org-babel-interpret-file-mode reads the common ones. */
function fileMode(value: string): number | undefined {
  const m = /^(?:o|#o)?0?([0-7]{3})$/.exec(value.trim());
  return m ? parseInt(m[1], 8) : undefined;
}

/**
 * Tangles the buffer's blocks, or with `only` some of them, as
 * org-babel-tangle: each file gets its blocks' code in order, a blank line
 * between blocks unless :padline no, a :shebang first, and is written only
 * if it changed. The files written.
 */
export function tangle(only?: (block: Block, file: string) => boolean): string[] {
  ember.runHooks("org-babel-pre-tangle-hook");
  const orgFile = ember.bufferFileName();
  if (!orgFile) ember.userError("Buffer is not visiting a file");
  const blocks = ember.saveRestriction(() => {
    ember.widen();
    return collectBlocks();
  });
  const byFile = new Map<string, Block[]>();
  for (const block of blocks) {
    const file = tangledFile(block, orgFile);
    if (file === undefined || (only && !only(block, file))) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(block);
  }
  let count = 0;
  const written: string[] = [];
  for (const [file, fileBlocks] of byFile) {
    if (file === orgFile) ember.signal("error", "Not allowed to tangle into the same file as self");
    let text = "";
    let shebanged = false;
    let mode: number | undefined;
    let mkdirp = false;
    for (const block of fileBlocks) {
      const shebang = block.params.get(":shebang") ?? "";
      const tangleMode = block.params.get(":tangle-mode");
      if (shebang !== "" && mode === undefined) mode = 0o755;
      if (tangleMode !== undefined) mode = fileMode(tangleMode) ?? mode;
      const m = block.params.get(":mkdirp");
      if (m !== undefined && m !== "no") mkdirp = true;
      if (block.params.get(":padline") !== "no" && text !== "") text += "\n";
      if (shebang !== "" && !shebanged) {
        text += `${shebang}\n`;
        shebanged = true;
      }
      text += `${block.body}\n`;
      count++;
    }
    const dir = ember.fileNameDirectory(file);
    if (mkdirp && dir && !ember.fileExists(dir)) ember.makeDirectory(dir, { parents: true });
    if (!(ember.fileExists(file) && ember.readTextFile(file) === text)) {
      ember.writeTextFile(file, text);
      if (mode !== undefined) ember.setFileModes(file, mode);
    }
    written.push(file);
  }
  ember.message(`Tangled ${count} code block${count === 1 ? "" : "s"} from ${ember.fileNameNondirectory(orgFile)}`);
  if (ember.variable("org-babel-post-tangle-hook") !== undefined) {
    for (const file of written) {
      const buffer = ember.findFileNoselect(file);
      ember.withCurrentBuffer(buffer, () => ember.runHooks("org-babel-post-tangle-hook"));
    }
  }
  ember.runHooks("org-babel-tangle-finished-hook");
  return written;
}

/** The source block point is in, by the line its #+begin_src is on, as org-babel-where-is-src-block-head finds it. */
function blockAtPoint(): number | undefined {
  const here = ember.lineOf(ember.point());
  for (let line = here; line >= 0; line--) {
    const text = ember.lineText(line);
    if (BEGIN.test(text)) return line;
    if (END.test(text) && line !== here) return undefined;
  }
  return undefined;
}

const tangleCommand = ember.defineCommand({
  name: "org-babel-tangle",
  doc:
    "Write the source blocks whose :tangle header argument names a file into their files. With C-u, only the block at " +
    "point; with C-u C-u, the blocks that tangle to the same file as it.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg) => {
    const prefix = Array.isArray(arg) ? arg[0] : undefined;
    if (prefix === 4 || prefix === 16) {
      const head = blockAtPoint();
      if (head === undefined) ember.userError("Point is not in a source code block");
      const orgFile = ember.bufferFileName() ?? "";
      const target = ember.saveRestriction(() => {
        ember.widen();
        return collectBlocks().find((b) => b.line === head);
      });
      const targetFile = target && tangledFile(target, orgFile);
      if (prefix === 16 && targetFile === undefined) ember.userError("Point is not in a source code block");
      tangle((block, file) => (prefix === 4 ? block.line === head : file === targetFile));
    } else tangle();
  },
});

ember.defineCommand({
  name: "org-babel-tangle-file",
  doc: "Tangle an Org file's source blocks into their files.",
  params: [{ name: "file", kind: "file", prompt: "File to tangle: " }],
  run: (file) => {
    const buffer = ember.findFileNoselect(file);
    ember.withCurrentBuffer(buffer, () => tangle());
  },
});

ember.defineKey("org-mode-map", "C-c C-v t", tangleCommand);
ember.defineKey("org-mode-map", "C-c C-v C-t", tangleCommand);
