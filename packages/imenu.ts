// Jumping to a definition by name, after Emacs's imenu.el: M-x imenu reads
// an item of the buffer's index with completion, a submenu's name opening
// its items, and goes there. A mode makes the index with
// imenu-create-index-function, or gives imenu-generic-expression, Emacs
// regexps for each kind of definition.

/** An index item: a name and where it is, or a name and its submenu's items. */
export type IndexItem = [string, number | IndexItem[]];

for (const [name, doc, value, local] of [
  ["imenu-create-index-function", "The function that makes the buffer's index: a list of [name, position], or [name, items] for a submenu.", "imenu-default-create-index-function", true],
  ["imenu-generic-expression", "For imenu-default-create-index-function: a list of [menu-title, regexp, group], each regexp an Emacs regexp whose group is a definition's name; a null title puts the items at the top.", null, true],
  ["imenu-case-fold-search", "Whether imenu-generic-expression's regexps match case loosely.", true, true],
  ["imenu-space-replacement", "What spaces in index names are shown as, so a name reads as one word in completion.", ".", false],
  ["imenu-after-jump-hook", "Functions run after M-x imenu goes to an item.", null, false],
] as const) {
  ember.defineVariable({ name, doc, value: value as ember.Value, local });
}

const isSubmenu = (item: IndexItem): item is [string, IndexItem[]] => Array.isArray(item[1]);

/**
 * The index imenu-generic-expression gives, as imenu--generic-function:
 * each pattern's matches, from the start of the line each name is on,
 * under its title, sorted by position, with untitled items at the top.
 */
export function genericIndex(patterns: [string | null, string, number][]): IndexItem[] {
  const fold = ember.variable("imenu-case-fold-search") !== false;
  const menus = new Map<string | null, IndexItem[]>();
  for (const [title, regexp, group] of patterns) {
    ember.saveExcursion(() => {
      ember.gotoChar(ember.pointMax());
      while (ember.reSearchBackward(regexp, { noerror: true, caseFold: fold }) !== undefined) {
        const start = ember.point();
        const [b, e] = [ember.matchBeginning(0)!, ember.matchEnd(0)!];
        if (b === e) break;
        const name = ember.matchString(group) ?? "";
        const beg = ember.lineBeginningPosition(ember.matchBeginning(group) ?? start);
        if (!menus.has(title)) menus.set(title, []);
        const menu = menus.get(title)!;
        if (!menu.some(([n, p]) => n === name && p === beg)) menu.unshift([name, beg]);
        ember.gotoChar(start);
      }
    });
  }
  const top: IndexItem[] = [];
  const subs: IndexItem[] = [];
  for (const [title, items] of menus) {
    items.sort((a, b) => (a[1] as number) - (b[1] as number));
    if (title === null) top.push(...items);
    else subs.unshift([title, items]);
  }
  return [...top, ...subs];
}

ember.defun("imenu-default-create-index-function", () => {
  const patterns = ember.variable("imenu-generic-expression");
  if (!Array.isArray(patterns) || patterns.length === 0) throw new Error("This buffer cannot use `imenu-default-create-index-function'");
  return genericIndex(patterns as unknown as [string | null, string, number][]) as unknown as ember.Value;
});

/** The buffer's index, made by imenu-create-index-function over the whole buffer. */
export function makeIndex(): IndexItem[] {
  const fn = ember.variable("imenu-create-index-function") ?? "imenu-default-create-index-function";
  const index = ember.saveRestriction(() => {
    ember.widen();
    return ember.saveExcursion(() => ember.funcall(fn as string)) as unknown as IndexItem[] | null;
  });
  if (!index || index.length === 0) throw new Error("No items suitable for an index found in this buffer");
  return index;
}

/** A name with its spaces shown as imenu-space-replacement. */
const shown = (name: string): string => {
  const r = ember.variable("imenu-space-replacement");
  return typeof r === "string" && r !== "" ? name.replaceAll(" ", r[0]!) : name;
};

/** The symbol at point, if there is one. */
function symbolAtPoint(): string | undefined {
  const line = ember.lineText(ember.lineOf(ember.point()));
  const col = ember.point() - ember.lineBeginningPosition();
  const re = /[\w$-]+/g;
  for (const m of line.matchAll(re)) {
    if (m.index! <= col && col <= m.index! + m[0].length) return m[0];
  }
  return undefined;
}

/** Whether a name is in the index, at any depth. */
function inIndex(name: string, items: IndexItem[]): boolean {
  return items.some((item) => (isSubmenu(item) ? inIndex(name, item[1]) : item[0] === name));
}

/**
 * Reads an item of `items` with completion, as imenu--completion-buffer:
 * a submenu's name reads one of its items in turn.
 */
async function chooseItem(items: IndexItem[], prompt?: string): Promise<IndexItem | undefined> {
  const prepared = items.map(([name, value]) => [shown(name), value] as IndexItem);
  const atPoint = symbolAtPoint();
  const fallback = atPoint !== undefined && inIndex(atPoint, prepared) ? atPoint : undefined;
  const p = prompt ?? (fallback === undefined ? "Index item: " : `Index item (default ${fallback}): `);
  const name = await ember.completingRead(p, prepared.map(([n]) => n), { requireMatch: true, default: fallback, history: "imenu--history-list" });
  const choice = prepared.find(([n]) => n === (name === "" ? fallback : name));
  if (choice === undefined) return undefined;
  return isSubmenu(choice) ? chooseItem(choice[1], p) : choice;
}

ember.defineVariable({ name: "imenu--history-list", doc: "Items chosen with M-x imenu, newest first.", value: [] });

ember.defineCommand({
  name: "imenu",
  doc:
    "Go to a definition in the buffer, chosen by name with completion from the buffer's index.\n\n" +
    "Kinds of definition, such as Fn or Struct, open a list of their own. The mark is pushed first.",
  run: async () => {
    const item = await chooseItem(makeIndex());
    if (item === undefined) return;
    ember.pushMark(ember.point());
    const pos = item[1] as number;
    if (pos < ember.pointMin() || pos > ember.pointMax()) ember.widen();
    ember.gotoChar(pos);
    ember.runHooks("imenu-after-jump-hook");
  },
});
