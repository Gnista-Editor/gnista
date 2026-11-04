// Org Tempo, after Org's org-tempo.el and the part of tempo.el it uses:
// "<s" and TAB at the start of a line insert the block that
// org-structure-template-alist gives "s", and "<L" the keyword that
// org-tempo-keywords-alist gives "L". Not preloaded: requiring it turns it
// on, as (require 'org-tempo) does.

import { structureTemplates, upcaseBlock } from "org";
import { fileRelativeName } from "files";
import { charCount } from "subr";

gnista.defineVariable({
  name: "org-tempo-keywords-alist",
  doc: 'The keywords "<KEY" and TAB insert in Org, each a key and a keyword: ["L", "latex"] makes "<L" #+latex: .',
  value: [
    ["L", "latex"],
    ["H", "html"],
    ["A", "ascii"],
    ["i", "index"],
  ],
});

/**
 * What a template inserts: text, "p" where point goes (the first one), ">"
 * to indent the line as the mode does, "n" a newline, or a function, as
 * tempo's elements.
 */
type Element = string | { p: true } | { indent: true } | { newline: true } | (() => void);
const P: Element = { p: true };
const INDENT: Element = { indent: true };
const N: Element = { newline: true };

/** Each "<KEY" and its template, as org-tempo-add-templates makes them. */
function templates(): Map<string, Element[]> {
  const out = new Map<string, Element[]>();
  // "<I" first, as org-tempo defines it when it loads, so a key of the alists can replace it.
  out.set("<I", [includeFile]);
  for (const [key, name] of structureTemplates()) {
    // As org-tempo-add-block.
    const special = name === "src" || name === "export";
    const up = upcaseBlock(name);
    const first = name.split(" ")[0];
    out.set(`<${key}`, [
      `#+${up ? "BEGIN" : "begin"}_${name}${special ? " " : ""}`,
      ...(special ? [P] : []),
      INDENT,
      N,
      ...(special ? [] : [P]),
      N,
      `#+${up ? "END" : "end"}_${first}`,
      INDENT,
    ]);
  }
  const keywords = gnista.variable("org-tempo-keywords-alist");
  for (const entry of Array.isArray(keywords) ? keywords : []) {
    // As org-tempo-add-keyword.
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      out.set(`<${entry[0]}`, [`#+${entry[1]}: `, P, INDENT]);
    }
  }
  return out;
}

/** "<I": #+include: and a file name, as org-tempo--include-file. */
function includeFile(): void {
  const file = gnista.readFileName("Include file: ");
  gnista.insert(`#+include: ${JSON.stringify(fileRelativeName(file))} `);
}

/** Inserts a template at point, leaving point at its first "p", as tempo-insert-template. */
function insertTemplate(template: Element[]): void {
  const start = gnista.makeMarker(gnista.point());
  let mark: gnista.Marker | undefined;
  for (const element of template) {
    if (typeof element === "string") gnista.insert(element);
    else if (typeof element === "function") element();
    else if ("p" in element) mark ??= gnista.makeMarker(gnista.point());
    else if ("indent" in element) gnista.call("indent-according-to-mode");
    else gnista.insert("\n");
  }
  // As tempo-forward-mark: the first mark after where the template starts, else its end.
  if (mark) {
    gnista.gotoChar(gnista.markerPosition(mark)!);
    gnista.deleteMarker(mark);
  }
  gnista.deleteMarker(start);
}

/**
 * Expands the "<KEY" before point, if the line has only spaces before it,
 * as org-tempo-complete-tag does with tempo-complete-tag: a key that
 * completes to one template expands it, one that completes further is
 * completed. Whether a template was inserted.
 */
function completeTag(): boolean {
  const before = gnista.bufferText(gnista.lineStart(gnista.lineOf(gnista.point())), gnista.point());
  // As tempo-match-finder: "^ *\\(<[[:word:]]+\\)\\=".
  const m = /^ *(<[\p{L}\p{N}]+)$/u.exec(before);
  if (!m) return false;
  const typed = m[1];
  const from = gnista.point() - charCount(typed);
  const all = templates();
  let template = all.get(typed);
  let completion = typed;
  if (!template) {
    // As try-completion: the longest prefix the keys typed so far share.
    const keys = [...all.keys()].filter((k) => k.startsWith(typed));
    if (keys.length === 0) return false;
    completion = keys.reduce((a, b) => {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    template = all.get(completion);
  }
  gnista.deleteRegion(from, gnista.point());
  if (!template) {
    gnista.insert(completion);
    return false;
  }
  insertTemplate(template);
  gnista.deactivateMark();
  return true;
}

gnista.addHook("org-tab-before-tab-emulation-hook", () => completeTag());
