// Abbreviations, after Emacs's abbrev.el: a word that expands into a
// phrase, kept in the global table or the major mode's. C-x a g and
// C-x a l define one from the words before point, C-x a i g and C-x a i l
// from the word before point, C-x ' expands the one before point, and in
// abbrev-mode typing a character that ends a word expands it. A capital in
// the abbreviation capitalizes the expansion.

import { keyChar } from "simple";

ember.defineVariable({ name: "only-global-abbrevs", doc: "Whether the abbrev commands define only global abbrevs, not ones for the major mode.", value: false });
ember.defineVariable({ name: "abbrev-all-caps", doc: "Whether an abbrev typed in capitals expands all in capitals, rather than with each word capitalized.", value: false });

/** The abbrev tables, by name, each abbrev's name in lower case to its expansion and how often it was used. */
const tables = new Map<string, Map<string, { expansion: string; count: number }>>();

const GLOBAL = "global-abbrev-table";
/** The major mode's table, as local-abbrev-table names it. */
const localTable = (): string => `${String(ember.variable("major-mode"))}-abbrev-table`;
const table = (name: string) => {
  let t = tables.get(name);
  if (t === undefined) {
    t = new Map();
    tables.set(name, t);
  }
  return t;
};

/** Defines an abbrev, as define-abbrev: an empty expansion undefines it. */
export function defineAbbrev(tableName: string, name: string, expansion: string): void {
  if (expansion === "") table(tableName).delete(name.toLowerCase());
  else table(tableName).set(name.toLowerCase(), { expansion, count: 0 });
}

/** What an abbrev expands into in a table, matching case loosely, as abbrev-expansion. */
const abbrevExpansion = (name: string, tableName: string): string | undefined => tables.get(tableName)?.get(name.toLowerCase())?.expansion;

/** The tables to look abbrevs up in, the mode's first, as abbrev--active-tables. */
const activeTables = (): string[] => [localTable(), GLOBAL];

/** The word before point and the abbrev it names, if any, as abbrev--before-point. */
function abbrevBeforePoint(): { table: string; name: string; start: number; end: number } | undefined {
  const pos = ember.point();
  return ember.saveExcursion(() => {
    ember.call("backward-word");
    const start = ember.point();
    ember.call("forward-word");
    const end = Math.min(ember.point(), pos);
    if (end <= start) return undefined;
    const name = ember.bufferSubstringNoProperties(start, end);
    for (const t of activeTables()) {
      if (abbrevExpansion(name, t) !== undefined) return { table: t, name, start, end };
    }
    return undefined;
  });
}

/** Puts an abbrev's expansion in place of the word, with the case the word had, as abbrev-insert. */
function abbrevInsert(t: string, name: string, start: number, wordEnd: number): void {
  const entry = tables.get(t)!.get(name.toLowerCase())!;
  entry.count++;
  ember.gotoChar(start);
  // Inserted first, so markers at the end, point among them, stay after it.
  ember.insert(entry.expansion);
  const endMarker = ember.makeMarker(ember.point());
  ember.deleteRegion(ember.point(), ember.point() + (wordEnd - start));
  const end = ember.markerPosition(endMarker)!;
  if (name !== name.toLowerCase() && /\p{Lu}/u.test(name)) {
    if (!/\p{Ll}/u.test(name)) {
      // All in capitals: each word capitalized if there are several, else all capitals.
      const severalWords = ember.saveExcursion(() => {
        ember.call("backward-word");
        const last = ember.point();
        return last > start;
      });
      if (ember.variable("abbrev-all-caps") !== true && severalWords) ember.call("upcase-initials-region", start, end);
      else ember.call("upcase-region", start, end);
    } else {
      // Some capitals: the expansion's first initial.
      ember.gotoChar(start);
      ember.skipSyntaxForward("^w", end - 1);
      ember.call("upcase-initials-region", ember.point(), ember.point() + 1);
    }
  }
  ember.gotoChar(ember.markerPosition(endMarker)!);
  ember.deleteMarker(endMarker);
}

/** Expands the abbrev before point, if there is one, as expand-abbrev; returns whether it did. */
function expandAbbrev(): boolean {
  const found = abbrevBeforePoint();
  if (found === undefined) return false;
  const pos = ember.point();
  const after = pos - found.end;
  abbrevInsert(found.table, found.name, found.start, found.end);
  ember.gotoChar(ember.point() + after);
  return true;
}

ember.defineMinorMode({
  name: "abbrev-mode",
  lighter: " Abbrev",
  doc: "Expand abbrevs as they are typed: a character that ends a word expands the word before it if it is an abbrev.",
});

// Typing a character that is not part of a word, after a word, expands it
// first, as self-insert-command does in Emacs.
ember.adviceAdd("self-insert-command", "before", () => {
  if (ember.variable("abbrev-mode") !== true) return;
  const c = keyChar(ember.lastKey() ?? "");
  if (c === undefined || ember.charSyntax(c) === "w") return;
  if (ember.point() === ember.pointMin() || ember.charSyntax(ember.charAfter(ember.point() - 1) ?? "") !== "w") return;
  expandAbbrev();
});

ember.defineCommand({
  name: "expand-abbrev",
  doc: "Expand the abbrev before point, if there is one.",
  run: () => {
    expandAbbrev();
  },
});

/** Defines an abbrev for the words before point, or the region, as add-abbrev; a prefix argument of 0 means the region. */
async function addAbbrev(tableName: string, type: string, arg: ember.PrefixArg): Promise<void> {
  const n = ember.prefixNumericValue(arg);
  const mark = ember.mark();
  let exp: string | undefined;
  if ((arg === null && ember.regionActive() && mark !== undefined) || n === 0) {
    exp = ember.bufferSubstringNoProperties(Math.min(mark!, ember.point()), Math.max(mark!, ember.point()));
  } else if (n > 0) {
    const start = ember.saveExcursion(() => {
      ember.callWithPrefix(-n, "forward-word");
      return ember.point();
    });
    exp = ember.bufferSubstringNoProperties(start, ember.point());
  }
  const name = await ember.readString(exp !== undefined ? `${type} abbrev that expands into "${exp}": ` : `Undefine ${type} abbrev: `);
  const old = abbrevExpansion(name, tableName);
  if (exp === undefined || old === undefined || (await ember.yOrNP(`${name} expands into "${old}"; redefine? `))) {
    defineAbbrev(tableName, name, exp ?? "");
  }
}

/** Defines the word before point as an abbrev for an expansion asked for, and expands it, as inverse-add-abbrev. */
async function inverseAddAbbrev(tableName: string, type: string, arg: number): Promise<void> {
  const [start, end] = ember.saveExcursion(() => {
    ember.callWithPrefix(1 - arg, "forward-word");
    const e = ember.point();
    ember.call("backward-word");
    return [ember.point(), e];
  });
  const name = ember.bufferSubstringNoProperties(start, end);
  const exp = await ember.readString(`${type} expansion for "${name}": `);
  const old = abbrevExpansion(name, tableName);
  if (old === undefined || (await ember.yOrNP(`${name} expands into "${old}"; redefine? `))) {
    defineAbbrev(tableName, name, exp);
    ember.saveExcursion(() => {
      ember.gotoChar(end);
      expandAbbrev();
    });
  }
}

const modeTable = () => (ember.variable("only-global-abbrevs") === true ? GLOBAL : localTable());

ember.defineCommand({
  name: "add-global-abbrev",
  doc: "Define a global abbrev for the word before point, or that many words, or the region with 0, asking for its name.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => addAbbrev(GLOBAL, "Global", arg),
});
ember.defineCommand({
  name: "add-mode-abbrev",
  doc: "Define an abbrev for the major mode for the word before point, or that many words, or the region with 0, asking for its name.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: ember.PrefixArg) => addAbbrev(modeTable(), ember.variable("only-global-abbrevs") === true ? "Global" : "Mode", arg),
});
ember.defineCommand({
  name: "inverse-add-global-abbrev",
  doc: "Make the word before point a global abbrev for an expansion asked for, and expand it.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => inverseAddAbbrev(GLOBAL, "Global", arg),
});
ember.defineCommand({
  name: "inverse-add-mode-abbrev",
  doc: "Make the word before point an abbrev for the major mode for an expansion asked for, and expand it.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => inverseAddAbbrev(modeTable(), ember.variable("only-global-abbrevs") === true ? "Global" : "Mode", arg),
});

ember.defineCommand({
  name: "define-global-abbrev",
  doc: "Define a global abbrev, asking for its name and expansion.",
  params: [
    { name: "abbrev", kind: "string", prompt: "Define global abbrev: " },
    { name: "expansion", kind: "string", prompt: "Expansion: " },
  ],
  run: (abbrev: string, expansion: string) => defineAbbrev(GLOBAL, abbrev, expansion),
});
ember.defineCommand({
  name: "define-mode-abbrev",
  doc: "Define an abbrev for the major mode, asking for its name and expansion.",
  params: [
    { name: "abbrev", kind: "string", prompt: "Define mode abbrev: " },
    { name: "expansion", kind: "string", prompt: "Expansion: " },
  ],
  run: (abbrev: string, expansion: string) => defineAbbrev(localTable(), abbrev, expansion),
});
ember.defineCommand({
  name: "kill-all-abbrevs",
  doc: "Forget every abbrev in every table.",
  run: () => tables.clear(),
});

for (const [keys, command] of [
  ["C-x a g", "add-global-abbrev"],
  ["C-x a l", "add-mode-abbrev"],
  ["C-x a +", "add-mode-abbrev"],
  ["C-x a C-a", "add-mode-abbrev"],
  ["C-x a i g", "inverse-add-global-abbrev"],
  ["C-x a i l", "inverse-add-mode-abbrev"],
  ["C-x a -", "inverse-add-global-abbrev"],
  ["C-x a e", "expand-abbrev"],
  ["C-x a '", "expand-abbrev"],
  ["C-x '", "expand-abbrev"],
] as const) {
  ember.bindKey(keys, command);
}

// Listing and editing the abbrevs, as list-abbrevs and edit-abbrevs: each
// table under its name, an abbrev a line with how often it was used and
// its expansion, which C-c C-c makes the abbrevs again.

/** A Lisp string, as prin1 writes one. */
const lispString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Spaces and tabs from `col` to `to`, as indent-to with indent-tabs-mode inserts them. */
function indentText(col: number, to: number): string {
  let out = "";
  let c = col;
  while (Math.floor(c / 8) * 8 + 8 <= to) {
    out += "\t";
    c = Math.floor(c / 8) * 8 + 8;
  }
  // indent-to puts at least nothing; a column already past gets no space.
  return out + " ".repeat(Math.max(0, to - c));
}

/** A table's description, as insert-abbrev-table-description writes it to read back. */
function tableDescription(name: string): string {
  const entries = [...(tables.get(name) ?? new Map())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let text = `(${name})\n\n`;
  for (const [abbrev, { expansion, count }] of entries) {
    const quoted = lispString(abbrev);
    // Columns, not characters: indent-to may put a tab in.
    const countColumn = Math.max(quoted.length, 15) + String(count).length;
    text += quoted + indentText(quoted.length, 15) + String(count) + indentText(countColumn, 20) + lispString(expansion) + "\n";
  }
  return `${text}\n\n`;
}

/** The tables to list: the global one first, then the others. */
const tableNames = (): string[] => [GLOBAL, ...[...tables.keys()].filter((t) => t !== GLOBAL).sort()];

function prepareAbbrevList(): string {
  const buffer = "*Abbrevs*";
  ember.getBufferCreate(buffer);
  ember.withCurrentBuffer(buffer, () => {
    if (ember.variable("major-mode") !== "edit-abbrevs-mode") ember.call("edit-abbrevs-mode");
    ember.deleteRegion(ember.pointMin(), ember.pointMax());
    ember.insert(tableNames().map(tableDescription).join(""));
    ember.gotoChar(ember.pointMin());
    ember.setBufferModified(false);
  });
  return buffer;
}

ember.defineCommand({
  name: "list-abbrevs",
  doc: "Show the abbrevs in *Abbrevs*: each table, and each abbrev in it with how often it was used and its expansion.",
  run: () => ember.call("display-buffer", prepareAbbrevList()),
});

ember.defineCommand({
  name: "edit-abbrevs",
  doc: "Edit the abbrevs in *Abbrevs*; C-c C-c makes them the abbrevs again.",
  run: () => ember.call("switch-to-buffer", prepareAbbrevList()),
});

ember.defineCommand({
  name: "edit-abbrevs-redefine",
  doc: "Make the abbrevs the ones *Abbrevs* lists now, as edit-abbrevs left them.",
  run: () => {
    const text = ember.bufferText(ember.pointMin(), ember.pointMax());
    const read = new Map<string, Map<string, { expansion: string; count: number }>>();
    let current: Map<string, { expansion: string; count: number }> | undefined;
    const unquote = (s: string) => s.slice(1, -1).replace(/\\(.)/g, "$1");
    for (const line of text.split("\n")) {
      const header = /^\(([^()\s]+)\)\s*$/.exec(line);
      if (header !== null) {
        current = new Map();
        read.set(header[1]!, current);
        continue;
      }
      const entry = /^("(?:[^"\\]|\\.)*")\s+(\d+)\s+("(?:[^"\\]|\\.)*")/.exec(line);
      if (entry !== null && current !== undefined) current.set(unquote(entry[1]!).toLowerCase(), { expansion: unquote(entry[3]!), count: Number(entry[2]) });
    }
    for (const [name, entries] of read) tables.set(name, entries);
    ember.setBufferModified(false);
  },
});

ember.defineMajorMode({
  name: "edit-abbrevs-mode",
  modeName: "Edit-Abbrevs",
  doc: "The mode of *Abbrevs*: edit the abbrevs listed, then C-c C-c to make them the abbrevs.",
  bindings: { "C-c C-c": "edit-abbrevs-redefine", "C-x C-s": "edit-abbrevs-redefine" } as Record<string, ember.CommandName>,
});
