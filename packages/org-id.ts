// Global identifiers for Org entries, after Emacs's org-id.el: an entry's
// ID property, made with org-id-get-create, which [[id:...]] links follow
// to the entry, in whatever file has it.
//
// org-id.el keeps where each ID is in org-id-locations-file; Gnista looks in
// the Org buffers open, the agenda files and org-id-extra-files, and a
// package such as org-roam, which knows every ID of its directory, advises
// org-id-find to answer first, as org-roam-id.el does.

import { headings, headingIndex, linkSetParameters } from "org";
import { entryGet, entryPut } from "org-list";

gnista.defineVariable({ name: "org-id-extra-files", doc: "Files besides the agenda files that org-id-find looks in for IDs.", value: [] });

/** A new identifier, a random UUID as org-id-uuid makes one. */
export function orgIdUuid(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
gnista.defun("org-id-uuid", orgIdUuid);

/** The heading line the entry at point starts on, or undefined before the first heading. */
function entryLine(): number | undefined {
  const all = headings();
  const i = headingIndex(all, gnista.lineOf(gnista.point()));
  return i === undefined ? undefined : all[i].line;
}

/** The ID of the file-level property drawer at the top of the buffer, before any heading, as org-roam's file nodes keep it. */
function fileLevelDrawer(): { start: number; end: number } | undefined {
  let line = 0;
  while (line < gnista.lineCount() && /^\s*#/.test(gnista.lineText(line)) && !/^\s*#\+/i.test(gnista.lineText(line))) line++;
  if (line >= gnista.lineCount() || !/^[ \t]*:PROPERTIES:[ \t]*$/i.test(gnista.lineText(line))) return undefined;
  for (let l = line + 1; l < gnista.lineCount(); l++) {
    if (/^[ \t]*:END:[ \t]*$/i.test(gnista.lineText(l))) return { start: line, end: l };
    if (!/^[ \t]*:\S+:/.test(gnista.lineText(l))) return undefined;
  }
  return undefined;
}

/** The ID of the entry at point, or of the file before its first heading, making one if CREATE, as org-id-get. */
export function orgIdGet(create = false): string | undefined {
  const line = entryLine();
  if (line !== undefined) {
    const id = entryGet(line, "ID");
    if (id || !create) return id || undefined;
    const fresh = orgIdUuid();
    gnista.saveExcursion(() => entryPut(line, "ID", fresh));
    return fresh;
  }
  const drawer = fileLevelDrawer();
  if (drawer) {
    for (let l = drawer.start + 1; l < drawer.end; l++) {
      const m = /^[ \t]*:ID:[ \t]+(\S+)/i.exec(gnista.lineText(l));
      if (m) return m[1];
    }
  }
  if (!create) return undefined;
  const fresh = orgIdUuid();
  gnista.saveExcursion(() => {
    if (drawer) {
      gnista.gotoChar(gnista.lineStart(drawer.end));
      gnista.insert(`:ID:       ${fresh}\n`);
    } else {
      gnista.gotoChar(0);
      gnista.insert(`:PROPERTIES:\n:ID:       ${fresh}\n:END:\n`);
    }
  });
  return fresh;
}

gnista.defineCommand({
  name: "org-id-get-create",
  doc: "Make an ID for the entry at point, or the file before its first heading, if it has none, and copy it to the kill ring.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: gnista.Value) => {
    if (force !== null && force !== undefined) {
      const line = entryLine();
      if (line !== undefined) gnista.saveExcursion(() => entryPut(line, "ID", orgIdUuid()));
    }
    const id = orgIdGet(true)!;
    gnista.message(id);
  },
});

gnista.defineCommand({
  name: "org-id-copy",
  doc: "Copy the ID of the entry at point, making one if there is none, to the kill ring.",
  run: () => {
    const id = orgIdGet(true)!;
    gnista.killNew(id);
    gnista.message(id);
  },
});

/** Where an ID's entry is: its file and position, as org-id-find; a package advises it to know more IDs. */
export function orgIdFind(id: string): [string, number] | undefined {
  return gnista.funcall("org-id-find", id) as [string, number] | undefined;
}

/** The files org-id looks in: the Org buffers' files, the agenda files and org-id-extra-files. */
function idFiles(): string[] {
  const files = new Set<string>();
  for (const b of gnista.bufferList()) {
    const f = gnista.withCurrentBuffer(b, () => (gnista.variable("major-mode") === "org-mode" ? gnista.bufferFileName() : undefined));
    if (f) files.add(gnista.expandFileName(f));
  }
  for (const v of ["org-agenda-files", "org-id-extra-files"]) {
    const list = gnista.variable(v);
    if (Array.isArray(list)) for (const f of list) if (typeof f === "string" && gnista.fileExists(gnista.expandFileName(f))) files.add(gnista.expandFileName(f));
  }
  return [...files];
}

gnista.defun("org-id-find", (id: string) => {
  const re = new RegExp(`^[ \\t]*:ID:[ \\t]+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "im");
  for (const file of idFiles()) {
    const open = gnista.bufferList().find((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName()) === file);
    const text = open ? gnista.withCurrentBuffer(open, () => gnista.bufferSubstringNoProperties(gnista.pointMin(), gnista.pointMax())) : gnista.readTextFile(file);
    const m = re.exec(text);
    if (m) return [file, [...text.slice(0, m.index)].length];
  }
  return undefined;
});

/** Goes to an ID's entry, as org-id-goto and following an id: link do. */
export function orgIdGoto(id: string): void {
  const found = orgIdFind(id);
  if (!found) gnista.userError(`Cannot find entry with ID "${id}"`);
  const [file, pos] = found!;
  if (gnista.bufferFileName() !== file) gnista.call("find-file", file);
  gnista.gotoChar(pos);
  // To the entry's heading, or the top for a file's ID.
  const line = entryLine();
  gnista.gotoChar(line !== undefined ? gnista.lineStart(line) : 0);
}

gnista.defineCommand({
  name: "org-id-goto",
  doc: "Go to the entry with an ID read.",
  params: [{ name: "id", prompt: "ID: " }],
  run: (id: string) => orgIdGoto(id),
});

linkSetParameters("id", { follow: (path) => orgIdGoto(path.replace(/::.*$/, "")) });
