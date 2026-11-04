// Projects, after Emacs's project.el. A project is the tree under a version
// control root, the directory holding .git, found up from the current
// buffer's directory. C-x p f visits one of its files, with completion; C-x p
// d lists one of its directories and C-x p D its root in Dired; C-x p b
// switches among its buffers and C-x p k kills them; C-x p p switches to
// another project Gnista knows. Projects used are remembered in the file
// project-list-file, as JSON where Emacs writes Lisp.

import { regexpQuote } from "subr";
import { matchesInFiles } from "xref";

gnista.defineVariable({
  name: "project-list-file",
  doc: "Where the projects Gnista knows are saved: projects in user-emacs-directory if nil.",
  value: null,
});
gnista.defineVariable({
  name: "project-vc-extra-root-markers",
  doc: "Names of files that mark a project's root as well as version control's, such as \"package.json\".",
  value: [],
});
gnista.defineVariable({
  name: "project-vc-ignores",
  doc: "Names of files and directories a project outside version control leaves out of its files.",
  value: [],
});

/** The files and directories that mark the root of a version-controlled project, as vc-handled-backends find them. */
const VC_MARKERS = [".git", ".hg", ".bzr", ".svn", "_darcs", ".jj"];

const strings = (v: gnista.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The project directory `dir` is in, as project-current finds it: its root, abbreviated, with a slash. */
function findRoot(dir: string): string | undefined {
  const markers = [...VC_MARKERS, ...strings(gnista.variable("project-vc-extra-root-markers"))];
  let d = gnista.fileNameAsDirectory(gnista.expandFileName(dir));
  for (;;) {
    if (markers.some((m) => gnista.fileAttributes(d + m) !== undefined)) return gnista.abbreviateFileName(d);
    const up = gnista.fileNameDirectory(gnista.directoryFileName(d));
    if (up === undefined || up === d) return undefined;
    d = up;
  }
}

/** A project chosen by project-switch-project, for the command it runs. */
let override: string | undefined;

function listFile(): string | undefined {
  const file = gnista.variable("project-list-file");
  if (typeof file === "string") return gnista.expandFileName(file);
  const dir = gnista.variable("user-emacs-directory");
  return typeof dir === "string" ? gnista.expandFileName(`${dir}projects`) : undefined;
}

let known: string[] | undefined;

/** The projects Gnista knows, most recently used first, read from project-list-file the first time. */
function knownProjects(): string[] {
  if (known !== undefined) return known;
  known = [];
  const file = listFile();
  if (file !== undefined && gnista.fileExists(file)) {
    try {
      const list = JSON.parse(gnista.readTextFile(file));
      if (Array.isArray(list)) known = list.filter((p): p is string => typeof p === "string");
    } catch {
      gnista.message(`Error reading ${gnista.abbreviateFileName(file)}`);
    }
  }
  return known;
}

function writeKnown(): void {
  const file = listFile();
  if (file !== undefined) gnista.writeTextFile(file, `${JSON.stringify(knownProjects(), null, 2)}\n`);
}

/** Puts a project first among those known, as project-remember-project, saving the list if it changed. */
function remember(root: string): void {
  const list = knownProjects();
  if (list[0] === root) return;
  known = [root, ...list.filter((p) => p !== root)];
  writeKnown();
}

/** The current project's root, remembered; undefined if the buffer is in none. */
export function current(): string | undefined {
  const root = override ?? findRoot(".");
  if (root !== undefined) remember(root);
  return root;
}

const CHOOSE_DIR = "... (choose a dir)";

/** The current project, asking for one if the buffer is in none, as (project-current t). */
async function projectCurrent(): Promise<string> {
  const root = current();
  if (root !== undefined) return root;
  return useProject(await promptProjectDir());
}

/** Asks for a known project, or any directory, as project-prompt-project-dir. */
async function promptProjectDir(): Promise<string> {
  const answer = await gnista.completingRead("Select project: ", [...knownProjects(), CHOOSE_DIR], { requireMatch: true });
  if (answer !== CHOOSE_DIR && answer !== "") return answer;
  return gnista.readFileName("Select directory: ", { mustMatch: true });
}

/** A directory taken as a project: the root of the one it is in, or itself. */
function useProject(dir: string): string {
  const root = findRoot(dir) ?? gnista.abbreviateFileName(gnista.fileNameAsDirectory(gnista.expandFileName(dir)));
  remember(root);
  return root;
}

/** A project's files, relative to its root. */
function files(root: string): string[] {
  const abs = gnista.fileNameAsDirectory(gnista.expandFileName(root));
  return gnista.projectFiles(abs, { ignores: strings(gnista.variable("project-vc-ignores")) })
    .map((f) => (f.startsWith(abs) ? f.slice(abs.length) : f));
}

/** The longest leading part all the names share, as try-completion of "". */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Asks for one of a project's files, as project--read-file-cpd-relative:
 * relative to the directory they all share, named in the prompt.
 */
async function readFile(root: string, what: string, names: string[]): Promise<string> {
  const common = commonPrefix(names);
  const cpd = common.includes("/") ? common.slice(0, common.lastIndexOf("/") + 1) : "";
  const dir = root + cpd;
  const choices = names.map((n) => n.slice(cpd.length)).map((n) => (n === "" ? "./" : n));
  const answer = await gnista.completingRead(`${what} in ${dir}: `, choices, { category: "project-file", history: "file-name-history" });
  if (answer === "") gnista.userError("You didn't specify the file");
  return gnista.expandFileName(dir + answer);
}

const findFile = gnista.defineCommand({
  name: "project-find-file",
  doc:
    "Visit one of the current project's files, with completion: those Git tracks and does not ignore.\n\n" +
    "Outside a project, it asks which one first.",
  run: async () => {
    const root = await projectCurrent();
    gnista.call("find-file", await readFile(root, "Find file", files(root)));
  },
});

gnista.defineCommand({
  name: "project-find-dir",
  doc: "List one of the current project's directories in Dired, with completion.",
  run: async () => {
    const root = await projectCurrent();
    const dirs = [...new Set(files(root).map((f) => f.slice(0, f.lastIndexOf("/") + 1)))];
    gnista.call("dired", gnista.fileNameAsDirectory(await readFile(root, "Dired", dirs)));
  },
});

gnista.defineCommand({
  name: "project-dired",
  doc: "List the current project's root in Dired.",
  run: async () => gnista.call("dired", await projectCurrent()),
});

/** The buffers that belong to a project: those whose files or default directories are under its root. */
function projectBuffers(root: string): string[] {
  const abs = gnista.fileNameAsDirectory(gnista.expandFileName(root));
  return gnista.bufferList().filter((b) => {
    if (b.startsWith(" ")) return false;
    return gnista.withCurrentBuffer(b, () => {
      const file = gnista.bufferFileName();
      const dir = gnista.fileNameAsDirectory(gnista.expandFileName("."));
      return file !== undefined ? file.startsWith(abs) : gnista.variable("major-mode") === "dired-mode" && dir.startsWith(abs);
    });
  });
}

gnista.defineCommand({
  name: "project-switch-to-buffer",
  doc: "Switch to one of the current project's buffers, with completion.",
  run: async () => {
    const root = await projectCurrent();
    const here = gnista.bufferName();
    const buffers = projectBuffers(root);
    const other = buffers.find((b) => b !== here);
    const b = await gnista.completingRead(
      other === undefined ? "Switch to buffer: " : `Switch to buffer (default ${other}): `,
      buffers,
      { category: "buffer", default: other },
    );
    gnista.call("switch-to-buffer", b === "" ? other ?? here : b);
  },
});

gnista.defineCommand({
  name: "project-kill-buffers",
  doc: "Kill the current project's buffers, after asking. With a prefix argument, without asking.",
  run: async () => {
    const root = await projectCurrent();
    const buffers = projectBuffers(root);
    if (buffers.length === 0) {
      gnista.message("No buffers to kill");
      return;
    }
    if (gnista.prefixArg() === null && !(await gnista.yesOrNoP(`Kill ${buffers.length} buffer${buffers.length === 1 ? "" : "s"} in ${root}? `))) return;
    for (const b of buffers) gnista.call("kill-buffer", b);
  },
});

gnista.defineCommand({
  name: "project-forget-project",
  doc: "Forget a project Gnista knows, so C-x p p no longer offers it.",
  params: [{ name: "dir", prompt: "Forget project: ", requireMatch: true, collection: () => knownProjects() }],
  run: (dir: string) => {
    known = knownProjects().filter((p) => p !== dir);
    writeKnown();
    gnista.message(`Project ${dir} removed from known projects`);
  },
});

gnista.defineCommand({
  name: "project-forget-zombie-projects",
  doc: "Forget the projects Gnista knows whose directories are gone.",
  run: () => {
    known = knownProjects().filter((p) => gnista.fileDirectoryP(p));
    writeKnown();
  },
});

/** The commands C-x p p offers once a project is chosen, as project-switch-commands: key, command, what it says. */
gnista.defineVariable({
  name: "project-switch-commands",
  doc: "What C-x p p offers once a project is chosen, as [key, command, label] lists, the key pressed then running the command.",
  value: [
    ["f", "project-find-file", "Find file"],
    ["d", "project-find-dir", "Find directory"],
    ["D", "project-dired", "Dired"],
    ["b", "project-switch-to-buffer", "Buffer"],
    ["g", "project-find-regexp", "Find regexp"],
    ["k", "project-kill-buffers", "Kill buffers"],
  ],
});

gnista.defineCommand({
  name: "project-switch-project",
  doc:
    "Switch to another project Gnista knows, then choose what to do there, as project-switch-commands lists: " +
    "f finds a file, d a directory, D lists the root in Dired, b switches to a buffer and k kills its buffers.",
  params: [{
    name: "dir",
    prompt: "Select project: ",
    requireMatch: true,
    collection: () => [...knownProjects(), CHOOSE_DIR],
  }],
  run: async (answer: string) => {
    const root = useProject(answer === CHOOSE_DIR ? await gnista.readFileName("Select directory: ", { mustMatch: true }) : answer);
    const entries = (gnista.variable("project-switch-commands") as gnista.Value[])
      .filter((e): e is string[] => Array.isArray(e) && e.length >= 3 && e.every((x) => typeof x === "string"));
    const prompt = entries.map(([key, , label]) => `[${key}] ${label}`).join("  ");
    const key = await gnista.readCharChoice(`${prompt}\n`, entries.map(([key]) => key).join(""));
    const entry = entries.find(([k]) => k === key);
    if (entry === undefined) return;
    // As project-current-directory-override, bound while the command
    // starts; it finds its project before it asks anything.
    override = root;
    try {
      gnista.callInteractively(entry[1] as gnista.CommandName);
    } finally {
      override = undefined;
    }
  },
});

gnista.defineCommand({
  name: "project-remember-projects-under",
  doc: "Remember the projects in a directory and the directories in it, so C-x p p offers them. Says how many were new.",
  params: [{ name: "dir", kind: "file", prompt: "Remember projects under: " }],
  run: (dir: string) => {
    const before = knownProjects().length;
    const base = gnista.fileNameAsDirectory(gnista.expandFileName(dir));
    for (const name of gnista.directoryFiles(base)) {
      if (name === "." || name === "..") continue;
      const sub = `${base}${name}/`;
      if (!gnista.fileDirectoryP(sub)) continue;
      if (VC_MARKERS.some((m) => gnista.fileAttributes(sub + m) !== undefined)) remember(gnista.abbreviateFileName(sub));
    }
    const found = knownProjects().length - before;
    gnista.message(found === 0 ? "No projects were found" : `Found ${found} new project${found === 1 ? "" : "s"}`);
  },
});

/** The symbol at point, for a default, as (thing-at-point 'symbol). */
function symbolAtPoint(): string | undefined {
  const p = gnista.point();
  let a = p;
  let b = p;
  const symbolic = (q: number) => q >= 0 && q < gnista.bufferSize() && "w_".includes(gnista.charSyntax(gnista.bufferText(q, q + 1)));
  while (symbolic(a - 1)) a--;
  while (symbolic(b)) b++;
  return b > a ? gnista.bufferText(a, b) : undefined;
}

gnista.defineCommand({
  name: "project-find-regexp",
  doc: "Find matches for a regexp in the current project's files, showing them in *xref*, grouped by file.",
  params: [{
    name: "regexp",
    prompt: () => {
      const sym = symbolAtPoint();
      return sym === undefined ? "Find regexp: " : `Find regexp (default ${regexpQuote(sym)}): `;
    },
    history: "regexp-history",
  }],
  run: async (input: string) => {
    // The default is the symbol at point, quoted, as project--read-regexp gives it.
    const sym = symbolAtPoint();
    const regexp = input === "" ? (sym === undefined ? "" : regexpQuote(sym)) : input;
    if (regexp === "") throw new Error("No regexp");
    // Case folds, as grep-expand-template does, when case-fold-search says and the regexp has no capitals.
    const fold = gnista.variable("case-fold-search") !== false && gnista.variable("case-fold-search") !== null && !/[A-Z]/.test(regexp);
    const root = await projectCurrent();
    const dir = gnista.fileNameAsDirectory(gnista.expandFileName(root));
    const xrefs = matchesInFiles(regexp, files(root), dir, fold);
    if (xrefs.length === 0) gnista.userError(`No matches for: ${regexp}`);
    gnista.funcall("xref-show-xrefs", xrefs);
  },
});

gnista.defineCommand({
  name: "project-compile",
  doc: "Run a compilation in the current project's root, as M-x compile does there.",
  run: async () => {
    const root = await projectCurrent();
    // As (let ((default-directory root)) (call-interactively #'compile)):
    // compile takes its directory before it asks for the command. Every
    // buffer has its own default-directory in Emacs, so the binding is local.
    const had = gnista.isLocalVariable("default-directory");
    const old = gnista.variable("default-directory");
    gnista.makeLocalVariable("default-directory");
    gnista.setVariable("default-directory", gnista.fileNameAsDirectory(gnista.expandFileName(root)));
    try {
      gnista.callInteractively("compile");
    } finally {
      if (had) gnista.setVariable("default-directory", old ?? null);
      else gnista.killLocalVariable("default-directory");
    }
  },
});

/** The keys after C-x p, as project.el's project-prefix-map. */
const projectPrefixMap = gnista.defineKeymap("project-prefix-map");
for (const [keys, command] of [
  ["f", findFile],
  ["d", "project-find-dir"],
  ["D", "project-dired"],
  ["b", "project-switch-to-buffer"],
  ["k", "project-kill-buffers"],
  ["p", "project-switch-project"],
  ["g", "project-find-regexp"],
  ["c", "project-compile"],
] as const) {
  gnista.defineKey(projectPrefixMap, keys, command);
}
gnista.defineKey("ctl-x-map", "p", projectPrefixMap);
