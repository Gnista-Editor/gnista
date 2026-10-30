// Projects, after Emacs's project.el. A project is the tree under a version
// control root, the directory holding .git, found up from the current
// buffer's directory. C-x p f visits one of its files, with completion; C-x p
// d lists one of its directories and C-x p D its root in Dired; C-x p b
// switches among its buffers and C-x p k kills them; C-x p p switches to
// another project Ember knows. Projects used are remembered in the file
// project-list-file, as JSON where Emacs writes Lisp.

import { regexpQuote } from "subr";

ember.defineVariable({
  name: "project-list-file",
  doc: "Where the projects Ember knows are saved: projects in user-emacs-directory if nil.",
  value: null,
});
ember.defineVariable({
  name: "project-vc-extra-root-markers",
  doc: "Names of files that mark a project's root as well as version control's, such as \"package.json\".",
  value: [],
});
ember.defineVariable({
  name: "project-vc-ignores",
  doc: "Names of files and directories a project outside version control leaves out of its files.",
  value: [],
});

/** The files and directories that mark the root of a version-controlled project, as vc-handled-backends find them. */
const VC_MARKERS = [".git", ".hg", ".bzr", ".svn", "_darcs", ".jj"];

const strings = (v: ember.Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The project directory `dir` is in, as project-current finds it: its root, abbreviated, with a slash. */
function findRoot(dir: string): string | undefined {
  const markers = [...VC_MARKERS, ...strings(ember.variable("project-vc-extra-root-markers"))];
  let d = ember.fileNameAsDirectory(ember.expandFileName(dir));
  for (;;) {
    if (markers.some((m) => ember.fileAttributes(d + m) !== undefined)) return ember.abbreviateFileName(d);
    const up = ember.fileNameDirectory(ember.directoryFileName(d));
    if (up === undefined || up === d) return undefined;
    d = up;
  }
}

/** A project chosen by project-switch-project, for the command it runs. */
let override: string | undefined;

function listFile(): string | undefined {
  const file = ember.variable("project-list-file");
  if (typeof file === "string") return ember.expandFileName(file);
  const dir = ember.variable("user-emacs-directory");
  return typeof dir === "string" ? ember.expandFileName(`${dir}projects`) : undefined;
}

let known: string[] | undefined;

/** The projects Ember knows, most recently used first, read from project-list-file the first time. */
function knownProjects(): string[] {
  if (known !== undefined) return known;
  known = [];
  const file = listFile();
  if (file !== undefined && ember.fileExists(file)) {
    try {
      const list = JSON.parse(ember.readTextFile(file));
      if (Array.isArray(list)) known = list.filter((p): p is string => typeof p === "string");
    } catch {
      ember.message(`Error reading ${ember.abbreviateFileName(file)}`);
    }
  }
  return known;
}

function writeKnown(): void {
  const file = listFile();
  if (file !== undefined) ember.writeTextFile(file, `${JSON.stringify(knownProjects(), null, 2)}\n`);
}

/** Puts a project first among those known, as project-remember-project, saving the list if it changed. */
function remember(root: string): void {
  const list = knownProjects();
  if (list[0] === root) return;
  known = [root, ...list.filter((p) => p !== root)];
  writeKnown();
}

/** The current project's root, remembered; undefined if the buffer is in none. */
function current(): string | undefined {
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
  const answer = await ember.completingRead("Select project: ", [...knownProjects(), CHOOSE_DIR], { requireMatch: true });
  if (answer !== CHOOSE_DIR && answer !== "") return answer;
  return ember.readFileName("Select directory: ", { mustMatch: true });
}

/** A directory taken as a project: the root of the one it is in, or itself. */
function useProject(dir: string): string {
  const root = findRoot(dir) ?? ember.abbreviateFileName(ember.fileNameAsDirectory(ember.expandFileName(dir)));
  remember(root);
  return root;
}

/** A project's files, relative to its root. */
function files(root: string): string[] {
  const abs = ember.fileNameAsDirectory(ember.expandFileName(root));
  return ember.projectFiles(abs, { ignores: strings(ember.variable("project-vc-ignores")) })
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
  const answer = await ember.completingRead(`${what} in ${dir}: `, choices, { category: "project-file", history: "file-name-history" });
  if (answer === "") ember.userError("You didn't specify the file");
  return ember.expandFileName(dir + answer);
}

const findFile = ember.defineCommand({
  name: "project-find-file",
  doc:
    "Visit one of the current project's files, with completion: those Git tracks and does not ignore.\n\n" +
    "Outside a project, it asks which one first.",
  run: async () => {
    const root = await projectCurrent();
    ember.call("find-file", await readFile(root, "Find file", files(root)));
  },
});

ember.defineCommand({
  name: "project-find-dir",
  doc: "List one of the current project's directories in Dired, with completion.",
  run: async () => {
    const root = await projectCurrent();
    const dirs = [...new Set(files(root).map((f) => f.slice(0, f.lastIndexOf("/") + 1)))];
    ember.call("dired", ember.fileNameAsDirectory(await readFile(root, "Dired", dirs)));
  },
});

ember.defineCommand({
  name: "project-dired",
  doc: "List the current project's root in Dired.",
  run: async () => ember.call("dired", await projectCurrent()),
});

/** The buffers that belong to a project: those whose files or default directories are under its root. */
function projectBuffers(root: string): string[] {
  const abs = ember.fileNameAsDirectory(ember.expandFileName(root));
  return ember.bufferList().filter((b) => {
    if (b.startsWith(" ")) return false;
    return ember.withCurrentBuffer(b, () => {
      const file = ember.bufferFileName();
      const dir = ember.fileNameAsDirectory(ember.expandFileName("."));
      return file !== undefined ? file.startsWith(abs) : ember.variable("major-mode") === "dired-mode" && dir.startsWith(abs);
    });
  });
}

ember.defineCommand({
  name: "project-switch-to-buffer",
  doc: "Switch to one of the current project's buffers, with completion.",
  run: async () => {
    const root = await projectCurrent();
    const here = ember.bufferName();
    const buffers = projectBuffers(root);
    const other = buffers.find((b) => b !== here);
    const b = await ember.completingRead(
      other === undefined ? "Switch to buffer: " : `Switch to buffer (default ${other}): `,
      buffers,
      { category: "buffer", default: other },
    );
    ember.call("switch-to-buffer", b === "" ? other ?? here : b);
  },
});

ember.defineCommand({
  name: "project-kill-buffers",
  doc: "Kill the current project's buffers, after asking. With a prefix argument, without asking.",
  run: async () => {
    const root = await projectCurrent();
    const buffers = projectBuffers(root);
    if (buffers.length === 0) {
      ember.message("No buffers to kill");
      return;
    }
    if (ember.prefixArg() === null && !(await ember.yesOrNoP(`Kill ${buffers.length} buffer${buffers.length === 1 ? "" : "s"} in ${root}? `))) return;
    for (const b of buffers) ember.call("kill-buffer", b);
  },
});

ember.defineCommand({
  name: "project-forget-project",
  doc: "Forget a project Ember knows, so C-x p p no longer offers it.",
  params: [{ name: "dir", prompt: "Forget project: ", requireMatch: true, collection: () => knownProjects() }],
  run: (dir: string) => {
    known = knownProjects().filter((p) => p !== dir);
    writeKnown();
    ember.message(`Project ${dir} removed from known projects`);
  },
});

ember.defineCommand({
  name: "project-forget-zombie-projects",
  doc: "Forget the projects Ember knows whose directories are gone.",
  run: () => {
    known = knownProjects().filter((p) => ember.fileDirectoryP(p));
    writeKnown();
  },
});

/** The commands C-x p p offers once a project is chosen, as project-switch-commands: key, command, what it says. */
ember.defineVariable({
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

ember.defineCommand({
  name: "project-switch-project",
  doc:
    "Switch to another project Ember knows, then choose what to do there, as project-switch-commands lists: " +
    "f finds a file, d a directory, D lists the root in Dired, b switches to a buffer and k kills its buffers.",
  params: [{
    name: "dir",
    prompt: "Select project: ",
    requireMatch: true,
    collection: () => [...knownProjects(), CHOOSE_DIR],
  }],
  run: async (answer: string) => {
    const root = useProject(answer === CHOOSE_DIR ? await ember.readFileName("Select directory: ", { mustMatch: true }) : answer);
    const entries = (ember.variable("project-switch-commands") as ember.Value[])
      .filter((e): e is string[] => Array.isArray(e) && e.length >= 3 && e.every((x) => typeof x === "string"));
    const prompt = entries.map(([key, , label]) => `[${key}] ${label}`).join("  ");
    const key = await ember.readCharChoice(`${prompt}\n`, entries.map(([key]) => key).join(""));
    const entry = entries.find(([k]) => k === key);
    if (entry === undefined) return;
    // As project-current-directory-override, bound while the command
    // starts; it finds its project before it asks anything.
    override = root;
    try {
      ember.callInteractively(entry[1] as ember.CommandName);
    } finally {
      override = undefined;
    }
  },
});

ember.defineCommand({
  name: "project-remember-projects-under",
  doc: "Remember the projects in a directory and the directories in it, so C-x p p offers them. Says how many were new.",
  params: [{ name: "dir", kind: "file", prompt: "Remember projects under: " }],
  run: (dir: string) => {
    const before = knownProjects().length;
    const base = ember.fileNameAsDirectory(ember.expandFileName(dir));
    for (const name of ember.directoryFiles(base)) {
      if (name === "." || name === "..") continue;
      const sub = `${base}${name}/`;
      if (!ember.fileDirectoryP(sub)) continue;
      if (VC_MARKERS.some((m) => ember.fileAttributes(sub + m) !== undefined)) remember(ember.abbreviateFileName(sub));
    }
    const found = knownProjects().length - before;
    ember.message(found === 0 ? "No projects were found" : `Found ${found} new project${found === 1 ? "" : "s"}`);
  },
});

/** The symbol at point, for a default, as (thing-at-point 'symbol). */
function symbolAtPoint(): string | undefined {
  const p = ember.point();
  let a = p;
  let b = p;
  const symbolic = (q: number) => q >= 0 && q < ember.bufferSize() && "w_".includes(ember.charSyntax(ember.bufferText(q, q + 1)));
  while (symbolic(a - 1)) a--;
  while (symbolic(b)) b++;
  return b > a ? ember.bufferText(a, b) : undefined;
}

/** Grep's extended regexps for Emacs's, as xref--regexp-to-extended: groups and alternatives unescaped. */
const toExtended = (re: string): string => re.replace(/\\([(){}|])|([(){}|])/g, (_, escaped, plain) => (escaped ?? `\\${plain}`));


ember.defineCommand({
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
    const fold = ember.variable("case-fold-search") !== false && ember.variable("case-fold-search") !== null && !/[A-Z]/.test(regexp);
    const root = await projectCurrent();
    const names = files(root);
    const dir = ember.fileNameAsDirectory(ember.expandFileName(root));
    // As xref-matches-in-files: grep over the files, their names from standard input.
    const result = ember.callProcess(
      ["xargs", "-0", "grep", ...(fold ? ["-i"] : []), "--null", "-snHE", "-e", toExtended(regexp)],
      { directory: dir, input: names.join("\0") },
    );
    // grep says 1 for no matches; more is a failure, as of the regexp.
    if (result.exit > 1 && !/\0\d+:/.test(result.output)) throw new Error(`Search failed with status ${result.exit}: ${result.output.trim()}`);
    let js: RegExp | undefined;
    try {
      js = new RegExp(toExtended(regexp).replace(/\\</g, "\\b").replace(/\\>/g, "\\b"), fold ? "iu" : "u");
    } catch {
      js = undefined;
    }
    const xrefs = result.output
      .split("\n")
      .map((line) => /^([^\0]+)\0(\d+):(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => {
        const hit = js?.exec(m[3]);
        // In characters, as buffer positions count them.
        const col = hit ? [...m[3].slice(0, hit.index)].length : 0;
        const length = hit ? [...hit[0]].length : 0;
        return { file: dir + m[1], line: Number(m[2]), col, length, summary: m[3], group: m[1] };
      });
    if (xrefs.length === 0) throw new Error(`No matches for: ${regexp}`);
    ember.funcall("xref-show-xrefs", xrefs);
  },
});

ember.defineCommand({
  name: "project-compile",
  doc: "Run a compilation in the current project's root, as M-x compile does there.",
  run: async () => {
    const root = await projectCurrent();
    // As (let ((default-directory root)) (call-interactively #'compile)):
    // compile takes its directory before it asks for the command. Every
    // buffer has its own default-directory in Emacs, so the binding is local.
    const had = ember.isLocalVariable("default-directory");
    const old = ember.variable("default-directory");
    ember.makeLocalVariable("default-directory");
    ember.setVariable("default-directory", ember.fileNameAsDirectory(ember.expandFileName(root)));
    try {
      ember.callInteractively("compile");
    } finally {
      if (had) ember.setVariable("default-directory", old ?? null);
      else ember.killLocalVariable("default-directory");
    }
  },
});

/** The keys after C-x p, as project.el's project-prefix-map. */
const projectPrefixMap = ember.defineKeymap("project-prefix-map");
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
  ember.defineKey(projectPrefixMap, keys, command);
}
ember.defineKey("ctl-x-map", "p", projectPrefixMap);
