// EditorConfig, after Emacs 30's editorconfig.el and its core: with
// editorconfig-mode on, a file's .editorconfig files, from its directory up
// to one that says root = true, set how its buffer indents (indent_style,
// indent_size, tab_width), fill-column (max_line_length), whether saving
// adds a final newline (insert_final_newline) and deletes trailing
// whitespace (trim_trailing_whitespace). They apply once the major mode is
// chosen, as directory-local variables do.

import { fileRelativeName } from "files";
import { truthy } from "subr";

gnista.defineVariable({
  name: "editorconfig-indentation-alist",
  doc: "For each major mode, the variables indent_size sets, as [mode, ...variables].",
  value: [
    ["css-mode", "css-indent-offset"],
    ["css-ts-mode", "css-indent-offset"],
    ["go-ts-mode", "go-ts-mode-indent-offset"],
    ["js-mode", "js-indent-level"],
    ["js-ts-mode", "js-indent-level"],
    ["json-ts-mode", "json-ts-mode-indent-offset"],
    ["python-mode", "python-indent-offset"],
    ["python-ts-mode", "python-indent-offset"],
    ["rust-ts-mode", "rust-ts-mode-indent-offset"],
    ["sh-mode", "sh-basic-offset"],
    ["bash-ts-mode", "sh-basic-offset"],
    ["typescript-ts-mode", "typescript-ts-mode-indent-offset"],
    ["yaml-ts-mode", "yaml-indent-offset"],
  ],
});
gnista.defineHook("editorconfig-after-apply-functions", "Functions called with a file's EditorConfig properties, as an object, after they are applied.");

// --- Reading .editorconfig files, as editorconfig-core-handle --------------

interface Section {
  pattern: string;
  props: [string, string][];
}
interface Handle {
  dir: string;
  root: boolean;
  sections: Section[];
}

/** Each file read, by name, with the time it was read at, as editorconfig-core-handle caches them. */
const handles = new Map<string, { mtime: number; handle: Handle }>();

/** Reads an .editorconfig file, as editorconfig-core-handle--parse-file. */
function parse(file: string, dir: string): Handle {
  const sections: Section[] = [];
  const top: [string, string][] = [];
  let current: Section | undefined;
  gnista
    .readTextFile(file)
    .split(/\r?\n/)
    .forEach((raw, k) => {
      const line = raw.replace(/^[ \t\f]+/, "");
      if (/^([#;].*)?$/.test(line)) return;
      const section = /^\[(.*)\][ \t]*$/.exec(line);
      if (section) {
        current = { pattern: section[1], props: [] };
        sections.push(current);
        return;
      }
      const prop = /^([^=: \t]+)[ \t]*[=:][ \t]*(.*?)[ \t]*$/.exec(line);
      if (!prop) gnista.signal("error", `Error while reading config file: ${file}:${k + 1}:\n    ${raw}\n`);
      const [key, value] = [prop[1].toLowerCase(), prop[2]];
      if (key.length < 51 && value.length < 256) (current ? current.props : top).push([key, value]);
    });
  const root = top.find(([k]) => k === "root");
  return { dir, root: root !== undefined && root[1].toLowerCase() === "true", sections };
}

function handleFor(dir: string): Handle | undefined {
  const file = gnista.expandFileName(".editorconfig", dir);
  if (!gnista.fileExists(file)) return undefined;
  const mtime = gnista.fileAttributes(file)?.modified ?? 0;
  const cached = handles.get(file);
  if (cached && cached.mtime === mtime) return cached.handle;
  const handle = parse(file, dir);
  handles.set(file, { mtime, handle });
  return handle;
}

/** The .editorconfig files that apply to a directory, the one nearest the root first, as editorconfig-core--get-handles. */
function handlesFor(dir: string): Handle[] {
  const out: Handle[] = [];
  for (let d = gnista.fileNameAsDirectory(dir); ; ) {
    const handle = handleFor(d);
    if (handle) {
      out.unshift(handle);
      if (handle.root) break;
    }
    const parent = gnista.fileNameDirectory(d.replace(/\/$/, ""));
    if (!parent || parent === d) break;
    d = parent;
  }
  return out;
}

// --- Globs, as editorconfig-fnmatch -----------------------------------------

/** A glob as a JavaScript regexp, and the number ranges it has, as editorconfig-fnmatch--do-translate. */
function translate(glob: string): { re: RegExp; ranges: [number, number][] } {
  let out = "";
  const ranges: [number, number][] = [];
  let braces = 0;
  // Whether the braces' contents are alternatives, as a lone {x} is literal.
  const matchingBrace = (from: number): number | undefined => {
    let depth = 0;
    for (let k = from; k < glob.length; k++) {
      if (glob[k] === "\\") k++;
      else if (glob[k] === "{") depth++;
      else if (glob[k] === "}" && --depth === 0) return k;
    }
    return undefined;
  };
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) out += escapeChar(glob[++i]);
    else if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      const body = end > i ? glob.slice(i + 1, end) : "";
      if (end < 0 || body.includes("/")) out += "\\[";
      else {
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      const end = matchingBrace(i);
      const body = end !== undefined ? glob.slice(i + 1, end) : "";
      const range = /^([+-]?\d+)\.\.([+-]?\d+)$/.exec(body);
      if (end === undefined) out += "\\{";
      else if (range) {
        ranges.push([Number(range[1]), Number(range[2])]);
        out += "([+-]?\\d+)";
        i = end;
      } else if (!body.includes(",")) {
        out += `\\{${translate(body).re.source.slice(1, -1)}\\}`;
        i = end;
      } else {
        out += "(?:";
        braces++;
      }
    } else if (c === "}" && braces > 0) {
      out += ")";
      braces--;
    } else if (c === "," && braces > 0) out += "|";
    else out += escapeChar(c);
  }
  return { re: new RegExp(`^${out}$`), ranges };
}

const escapeChar = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Whether a file name matches a glob, as editorconfig-fnmatch-p. */
function fnmatch(name: string, glob: string): boolean {
  const { re, ranges } = translate(glob);
  const m = re.exec(name);
  if (!m) return false;
  // The numbers matched must lie in their ranges, whose groups come first.
  return ranges.every(([lo, hi], k) => {
    const n = Number(m[k + 1]);
    return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
  });
}

/**
 * Whether a section's pattern takes in a file, by its name relative to the
 * .editorconfig's directory, as editorconfig-core-handle--fnmatch-p: a
 * pattern without a slash matches in that directory or any below it.
 */
function sectionMatches(file: string, pattern: string, dir: string): boolean {
  const name = fileRelativeName(file, dir);
  if (pattern.includes("/")) return fnmatch(name, pattern.replace(/^\//, ""));
  return fnmatch(name, pattern) || fnmatch(name, `**/${pattern}`);
}

/** A file's EditorConfig properties, the nearest file's winning, as editorconfig-core-get-properties-hash. */
export function properties(file: string): { [key: string]: string } {
  file = gnista.expandFileName(file);
  const out: { [key: string]: string } = {};
  for (const handle of handlesFor(gnista.fileNameDirectory(file) ?? "/")) {
    for (const section of handle.sections) {
      if (!sectionMatches(file, section.pattern, handle.dir)) continue;
      for (const [key, value] of section.props) out[key] = value;
    }
  }
  for (const key of ["end_of_line", "indent_style", "indent_size", "insert_final_newline", "trim_trailing_whitespace", "charset"]) {
    if (out[key] !== undefined) out[key] = out[key].toLowerCase();
  }
  for (const [key, value] of Object.entries(out)) if (value === "unset") delete out[key];
  return out;
}

// --- Applying them, as editorconfig--get-local-variables ---------------------

const integer = (s: string | undefined): boolean => s !== undefined && /^\d+$/.test(s);

/** The variables indent_size sets in the current buffer's mode, as editorconfig--default-indent-size-function. */
function indentSizeVariables(): string[] {
  const alist = gnista.variable("editorconfig-indentation-alist");
  const entries = (Array.isArray(alist) ? alist : []) as gnista.Value[][];
  const parents = gnista.derivedModeAllParents();
  for (const m of parents) {
    const entry = entries.find((e) => e[0] === m);
    if (entry) return entry.slice(1).filter((v): v is string => typeof v === "string" && gnista.variable(v) !== undefined);
  }
  // A guess from the mode's name, as for modes not listed.
  for (const m of parents) {
    const name = m.replace(/-mode$/, "");
    const guess = ["-indent-level", "-basic-offset", "-indent-offset", "-block-offset"].map((s) => name + s).find((v) => gnista.variable(v) !== undefined);
    if (guess) return [guess];
  }
  return [];
}

/** The buffer-local values a file's properties give, as editorconfig--get-local-variables. */
function localVariables(props: { [key: string]: string }): [string, gnista.Value][] {
  const out: [string, gnista.Value][] = [];
  // As editorconfig--get-indentation.
  let style = props.indent_style;
  let tabWidth: number | undefined = integer(props.tab_width) ? Number(props.tab_width) : undefined;
  if (tabWidth === undefined && style === "tab" && integer(props.indent_size)) tabWidth = Number(props.indent_size);
  if (style === undefined && props.indent_size === "tab") style = "tab";
  const size = integer(props.indent_size)
    ? Number(props.indent_size)
    : props.indent_size === "tab"
      ? (tabWidth ?? Number(gnista.variable("tab-width") ?? 8))
      : undefined;
  if (tabWidth !== undefined) out.push(["tab-width", tabWidth]);
  if (style === "space") out.push(["indent-tabs-mode", false]);
  else if (style === "tab") out.push(["indent-tabs-mode", true]);
  if (size !== undefined) for (const v of indentSizeVariables()) out.push([v, size]);
  // As editorconfig--get-trailing-nl.
  if (props.insert_final_newline === "true") {
    const current = gnista.variable("require-final-newline");
    out.push(["require-final-newline", truthy(current) ? current! : (gnista.variable("mode-require-final-newline") ?? true)]);
  } else if (props.insert_final_newline === "false") out.push(["require-final-newline", false]);
  // As editorconfig--get-line-length.
  if (integer(props.max_line_length) && Number(props.max_line_length) > 0) out.push(["fill-column", Number(props.max_line_length)]);
  return out;
}

/** Deletes trailing whitespace before saving, unless the buffer is read-only, as editorconfig--delete-trailing-whitespace. */
const deleteTrailingWhitespace = (): void => {
  if (!gnista.bufferReadOnly()) gnista.call("delete-trailing-whitespace");
};

/** Applies the visited file's properties to the current buffer. */
function apply(): void {
  const file = gnista.bufferFileName();
  if (!file || !truthy(gnista.variable("editorconfig-mode"))) return;
  const props = properties(file);
  for (const [name, value] of localVariables(props)) {
    gnista.makeLocalVariable(name);
    gnista.setVariable(name, value);
  }
  // As editorconfig--get-trailing-ws.
  if (props.trim_trailing_whitespace === "true") gnista.addHook("before-save-hook", deleteTrailingWhitespace, { local: true });
  else if (props.trim_trailing_whitespace === "false") gnista.removeHook("before-save-hook", deleteTrailingWhitespace, { local: true });
  gnista.runHooks("editorconfig-after-apply-functions", props as unknown as gnista.Value);
}

gnista.addHook("hack-local-variables-hook", apply);

gnista.defineMinorMode({
  name: "editorconfig-mode",
  global: true,
  doc:
    "Set how files indent and save from their .editorconfig files: indent_style, indent_size, tab_width, " +
    "max_line_length, insert_final_newline and trim_trailing_whitespace.",
});

gnista.defineCommand({
  name: "editorconfig-display-current-properties",
  doc: "Show the EditorConfig properties of the visited file.",
  run: () => {
    const file = gnista.bufferFileName();
    if (!file) gnista.userError("Buffer has no file");
    const props = properties(file);
    const text = Object.entries(props)
      .map(([k, v]) => `${k} = ${v}`)
      .join("\n");
    gnista.withCurrentBuffer(gnista.getBufferCreate("*EditorConfig Properties*"), () => {
      gnista.setReadOnly(false);
      gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
      gnista.insert(`${text}\n`);
      gnista.setReadOnly(true);
    });
    gnista.call("display-buffer", "*EditorConfig Properties*");
  },
});
