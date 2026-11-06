// Packages from their git repositories, after Emacs's package-vc.el, as
// ADR 0059 describes: a package is a repository, its versions are its tags,
// installing it is a clone into package-user-dir, and activating it puts the
// checkout on load-path. What is installed, and at which commit, is kept in
// a lock file beside init.ts, so a configuration reproduces elsewhere.
//
// A configuration names its packages with gnista.usePackage (use-package.ts);
// M-x package-vc-install, package-vc-upgrade, package-vc-upgrade-all and
// package-delete manage them by hand. Only these commands, and installing a
// package a configuration names that is not there yet, use the network:
// starting Gnista with its packages installed runs no git at all.
//
// Preloaded, for its commands, which Emacs autoloads; it runs nothing until
// one is used.

gnista.defineVariable({
  name: "package-user-dir",
  doc: "The directory packages are installed in, each in a directory named after it; nil for elpa/ in user-emacs-directory, as Emacs's.",
  value: null,
});

gnista.defineVariable({
  name: "package-vc-lock-file",
  doc: "The file that records each installed package's source, version and commit; nil for gnista-lock.json in user-emacs-directory. Keep it with init.ts so another machine installs the same commits.",
  value: null,
});

gnista.defineVariable({
  name: "vc-git-program",
  doc: "The git program, as Emacs's vc-git-program: package-vc runs it to install and upgrade packages.",
  value: "git",
});

gnista.defineError("package-error", "error");

/** What `gnista-package.json` says about a package. */
export interface Manifest {
  name: string;
  description?: string;
  /** The oldest Gnista it runs on. */
  gnista?: string;
  /** The packages it needs, each a source and the oldest version: "Gnista-Editor/gnista-magit-section@0.1.0". */
  requires?: Record<string, string>;
}

/** A package's line in the lock file. */
export interface LockEntry {
  /** The source as the configuration or command gave it. */
  source: string;
  url: string;
  /** The revision asked for, a tag, a branch or a commit; none for the newest tag. */
  rev?: string;
  /** The version tag the commit has, if any. */
  tag?: string;
  /** The branch followed, if the checkout follows one. */
  branch?: string;
  commit: string;
}

interface LockFile {
  version: 1;
  packages: Record<string, LockEntry>;
}

function fail(message: string): never {
  return gnista.signal("package-error", message);
}

/** A package's name: a directory in package-user-dir, so never "." or "..", nor a path. */
const NAME = /^[A-Za-z0-9][\w.+-]*$/;

/**
 * Refuses a source or revision git would read as an option: a manifest
 * names its requirements' sources, and a manifest is the package author's,
 * not the user's.
 */
function checkArgument(what: string, value: string): string {
  if (value.startsWith("-") || value.includes("\n")) fail(`Not a usable ${what}: ${value}`);
  return value;
}

function userEmacsFile(name: string): string {
  const base = gnista.variable("user-emacs-directory");
  if (typeof base !== "string" || base === "") fail(`Cannot find ${name}: user-emacs-directory is not set`);
  return gnista.expandFileName(name, base);
}

/** The directory packages are installed in, with a slash at its end. */
export function packageUserDir(): string {
  const dir = gnista.variable("package-user-dir");
  return gnista.fileNameAsDirectory(typeof dir === "string" && dir !== "" ? gnista.expandFileName(dir) : userEmacsFile("elpa"));
}

function lockFileName(): string {
  const file = gnista.variable("package-vc-lock-file");
  return typeof file === "string" && file !== "" ? gnista.expandFileName(file) : userEmacsFile("gnista-lock.json");
}

/** The directory a package is installed in, whether or not it is. */
export function packageDir(name: string): string {
  return packageUserDir() + name;
}

// Git

function gitProgram(): string {
  const program = gnista.variable("vc-git-program");
  return typeof program === "string" && program !== "" ? program : "git";
}

/**
 * Runs git in `dir`, giving its exit status and output. It never asks for a
 * password, which it would ask on a terminal Gnista may be drawing on.
 */
function runGit(args: string[], dir?: string): { exit: number; output: string } {
  return gnista.callProcess(["env", "GIT_TERMINAL_PROMPT=0", gitProgram(), ...args], dir === undefined ? {} : { directory: dir });
}

function git(args: string[], dir?: string): string {
  const r = runGit(args, dir);
  if (r.exit !== 0) fail(`git ${args.join(" ")} failed: ${r.output.trim()}`);
  return r.output.trim();
}

/** The commit a checkout is at, read from .git without running git. */
export function checkoutCommit(dir: string): string | undefined {
  const gitDir = gnista.fileNameAsDirectory(dir) + ".git/";
  if (!gnista.fileExists(gitDir + "HEAD")) return undefined;
  const head = gnista.readTextFile(gitDir + "HEAD").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5);
  if (gnista.fileExists(gitDir + ref)) return gnista.readTextFile(gitDir + ref).trim();
  if (gnista.fileExists(gitDir + "packed-refs")) {
    for (const line of gnista.readTextFile(gitDir + "packed-refs").split("\n")) {
      const [commit, name] = line.split(" ");
      if (name === ref) return commit;
    }
  }
  return undefined;
}

// Versions

/** A version tag's numbers, "v0.3.1" as [0, 3, 1], or none for a tag that is not a version. */
export function parseVersion(tag: string): number[] | undefined {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(tag);
  return m === null ? undefined : m[1].split(".").map(Number);
}

/** Compares two versions as numbers, missing parts counting as 0, as version-list-<. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest version tag of a checkout. */
function newestTag(dir: string): string | undefined {
  const tags = git(["tag", "--list"], dir)
    .split("\n")
    .filter((t) => parseVersion(t) !== undefined);
  tags.sort((a, b) => compareVersions(parseVersion(b)!, parseVersion(a)!));
  return tags[0];
}

function versionTagAt(dir: string): string | undefined {
  const tags = git(["tag", "--points-at", "HEAD"], dir)
    .split("\n")
    .filter((t) => parseVersion(t) !== undefined);
  tags.sort((a, b) => compareVersions(parseVersion(b)!, parseVersion(a)!));
  return tags[0];
}

function isRemoteBranch(dir: string, rev: string): boolean {
  return runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${rev}`], dir).exit === 0;
}

function currentBranch(dir: string): string | undefined {
  const r = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  return r.exit === 0 ? r.output.trim() : undefined;
}

/**
 * Puts a checkout at a commit, if given, else at a revision, else at the
 * newest version tag, or on the default branch if there is none.
 */
function checkOut(dir: string, rev: string | undefined, commit: string | undefined): void {
  if (commit !== undefined) {
    if (runGit(["cat-file", "-e", `${commit}^{commit}`], dir).exit !== 0) git(["fetch", "--quiet", "--tags", "origin"], dir);
    if (rev !== undefined && isRemoteBranch(dir, rev)) {
      git(["checkout", "--quiet", "-B", rev, commit], dir);
      git(["branch", "--quiet", "--set-upstream-to", `origin/${rev}`], dir);
    } else {
      git(["checkout", "--quiet", "--detach", commit], dir);
    }
    return;
  }
  if (rev !== undefined) {
    if (isRemoteBranch(dir, rev)) {
      if (currentBranch(dir) === rev) git(["merge", "--quiet", "--ff-only", `origin/${rev}`], dir);
      else git(["checkout", "--quiet", "-B", rev, "--track", `origin/${rev}`], dir);
    } else {
      git(["checkout", "--quiet", "--detach", rev], dir);
    }
    return;
  }
  const tag = newestTag(dir);
  if (tag !== undefined) git(["checkout", "--quiet", "--detach", tag], dir);
}

/** Where a checkout is, as the lock file records it. */
function describe(dir: string, source: string, url: string, rev: string | undefined): LockEntry {
  const entry: LockEntry = { source, url, commit: git(["rev-parse", "HEAD"], dir) };
  if (rev !== undefined) entry.rev = rev;
  const tag = versionTagAt(dir);
  if (tag !== undefined) entry.tag = tag;
  const branch = currentBranch(dir);
  if (branch !== undefined) entry.branch = branch;
  return entry;
}

// Sources

/**
 * Where a package's repository is: `owner/name` is a GitHub repository, and
 * anything else a URL or a directory git can clone.
 */
export function sourceUrl(source: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(source) && !gnista.fileExists(source) ? `https://github.com/${source}.git` : source;
}

/** A repository's name, from the last part of its URL. */
export function repositoryName(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? url;
}

/** Splits a requirement, "owner/name@0.1.0", into its source and oldest version. */
export function parseRequirement(requirement: string): { source: string; version?: number[] } {
  const at = requirement.lastIndexOf("@");
  const version = at < 0 ? undefined : parseVersion(requirement.slice(at + 1));
  return version === undefined ? { source: requirement } : { source: requirement.slice(0, at), version };
}

/**
 * A checkout's manifest; for a repository that has none, a package named
 * after the repository with nothing more said.
 */
export function readManifest(dir: string, url: string): Manifest {
  const file = gnista.fileNameAsDirectory(dir) + "gnista-package.json";
  if (!gnista.fileExists(file)) return { name: repositoryName(url) };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(gnista.readTextFile(file)) as Manifest;
  } catch (e) {
    return fail(`${url}: gnista-package.json is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof manifest.name !== "string" || !NAME.test(manifest.name)) fail(`${url}: gnista-package.json has no usable "name"`);
  for (const [name, requirement] of Object.entries(manifest.requires ?? {})) {
    if (!NAME.test(name) || typeof requirement !== "string") fail(`${url}: gnista-package.json requires ${JSON.stringify(name)}, which is not usable`);
  }
  return manifest;
}

function checkGnistaVersion(manifest: Manifest): void {
  if (manifest.gnista === undefined) return;
  const needed = parseVersion(manifest.gnista);
  const running = parseVersion(String(gnista.variable("gnista-version") ?? ""));
  if (needed === undefined) fail(`${manifest.name}: "gnista" is not a version: ${manifest.gnista}`);
  if (running !== undefined && compareVersions(running, needed) < 0) {
    fail(`${manifest.name} needs Gnista ${manifest.gnista} or newer; this is ${String(gnista.variable("gnista-version"))}`);
  }
}

// The lock file

export function readLock(): LockFile {
  const file = lockFileName();
  if (!gnista.fileExists(file)) return { version: 1, packages: {} };
  try {
    const lock = JSON.parse(gnista.readTextFile(file)) as LockFile;
    return { version: 1, packages: lock.packages ?? {} };
  } catch (e) {
    return fail(`${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function writeLock(lock: LockFile): void {
  const packages: Record<string, LockEntry> = {};
  for (const name of Object.keys(lock.packages).sort()) packages[name] = lock.packages[name];
  const file = lockFileName();
  gnista.makeDirectory(gnista.fileNameDirectory(file) ?? ".", { parents: true });
  gnista.writeTextFile(file, JSON.stringify({ version: 1, packages }, null, 2) + "\n");
}

function setLockEntry(name: string, entry: LockEntry | undefined): void {
  const lock = readLock();
  if (entry === undefined) delete lock.packages[name];
  else lock.packages[name] = entry;
  writeLock(lock);
}

/** The installed package a source names, as the lock file records it. */
export function lockedPackage(source: string): string | undefined {
  const url = sourceUrl(source);
  const packages = readLock().packages;
  return Object.keys(packages).find((name) => packages[name].url === url);
}

// Installing

/** Puts an installed package's checkout on load-path, as package-activate. */
export function packageActivate(name: string): void {
  const dir = packageDir(name);
  const path = gnista.variable("load-path");
  const dirs = Array.isArray(path) ? path.filter((d): d is string => typeof d === "string") : [];
  if (!dirs.some((d) => gnista.expandFileName(d) === dir)) gnista.setVariable("load-path", [dir, ...dirs]);
}

/** The packages installed, by name. */
export function packageInstalledList(): string[] {
  return Object.keys(readLock().packages).filter((name) => gnista.fileDirectoryP(packageDir(name)));
}

function installedVersion(name: string): number[] | undefined {
  const tag = readLock().packages[name]?.tag;
  return tag === undefined ? undefined : parseVersion(tag);
}

/** Installs what a manifest requires and checks the versions installed. */
function installRequirements(manifest: Manifest, seen: Set<string>): void {
  for (const [name, requirement] of Object.entries(manifest.requires ?? {})) {
    const { source, version } = parseRequirement(requirement);
    if (!gnista.fileDirectoryP(packageDir(name))) installPackage(source, { seen });
    else packageActivate(name);
    const have = installedVersion(name);
    if (version !== undefined && have !== undefined && compareVersions(have, version) < 0) {
      fail(`${manifest.name} needs ${name} ${version.join(".")} or newer; ${have.join(".")} is installed (M-x package-vc-upgrade)`);
    }
  }
}

/**
 * Installs a package from its repository and activates it, giving its
 * name, as package-vc-install: at `rev` if given, else at the commit the
 * lock file records for it, else at its newest version tag. A package
 * already installed is put at that revision instead.
 */
export function installPackage(source: string, options: { rev?: string; name?: string; url?: string; seen?: Set<string> } = {}): string {
  const url = checkArgument("source", options.url ?? sourceUrl(source));
  if (options.rev !== undefined) checkArgument("revision", options.rev);
  const lock = readLock();
  const lockedName = Object.keys(lock.packages).find((n) => lock.packages[n].url === url);
  const locked = lockedName === undefined ? undefined : lock.packages[lockedName];
  // The locked commit holds unless the configuration now asks for another revision.
  const commit = locked !== undefined && locked.rev === options.rev ? locked.commit : undefined;
  const seen = options.seen ?? new Set<string>();
  if (seen.has(url)) fail(`${source} requires itself, through the packages it requires`);
  seen.add(url);

  const installed = lockedName !== undefined && gnista.fileDirectoryP(packageDir(lockedName));
  let dir: string;
  let manifest: Manifest;
  if (installed) {
    dir = packageDir(lockedName);
    checkOut(dir, options.rev, commit);
    manifest = readManifest(dir, url);
  } else {
    gnista.makeDirectory(packageUserDir(), { parents: true });
    const temporary = `${packageUserDir()}.installing-${repositoryName(url)}-${Date.now()}`;
    gnista.message(`Installing ${source}...`);
    try {
      git(["clone", "--quiet", "--", url, temporary]);
      checkOut(temporary, options.rev, commit);
      manifest = readManifest(temporary, url);
      if (options.name !== undefined && options.name !== manifest.name) {
        fail(`${url} holds the package ${manifest.name}, not ${options.name}`);
      }
      checkGnistaVersion(manifest);
      dir = packageDir(manifest.name);
      if (gnista.fileExists(dir)) {
        fail(`${dir} is there already: delete it, or M-x package-delete ${manifest.name}, to install ${source}`);
      }
      gnista.renameFile(temporary, dir);
    } catch (e) {
      if (gnista.fileExists(temporary)) gnista.deleteDirectory(temporary, { recursive: true, trash: false });
      throw e;
    }
  }
  checkGnistaVersion(manifest);
  setLockEntry(manifest.name, describe(dir, source, url, options.rev));
  installRequirements(manifest, seen);
  packageActivate(manifest.name);
  if (!installed) gnista.message(`Installed ${manifest.name}${versionLabel(manifest.name)}`);
  return manifest.name;
}

function versionLabel(name: string): string {
  const entry = readLock().packages[name];
  if (entry === undefined) return "";
  if (entry.tag !== undefined) return ` ${entry.tag}`;
  return ` ${entry.branch ?? ""}${entry.branch === undefined ? "" : " "}at ${entry.commit.slice(0, 7)}`;
}

/**
 * Makes sure a package a configuration names is installed and at the
 * commit the lock file records, without the network unless it has to
 * fetch, and activates it, giving its name.
 */
export function ensurePackage(source: string, options: { rev?: string; name?: string; url?: string } = {}): string {
  const url = options.url ?? sourceUrl(source);
  const lock = readLock();
  const name = Object.keys(lock.packages).find((n) => lock.packages[n].url === url);
  if (name !== undefined) {
    const entry = lock.packages[name];
    const dir = packageDir(name);
    if (gnista.fileDirectoryP(dir) && entry.rev === options.rev && checkoutCommit(dir) === entry.commit) {
      for (const requirement of Object.values(readManifest(dir, url).requires ?? {})) {
        const required = lockedPackage(parseRequirement(requirement).source);
        if (required !== undefined && gnista.fileDirectoryP(packageDir(required))) packageActivate(required);
        else ensurePackage(parseRequirement(requirement).source);
      }
      packageActivate(name);
      return name;
    }
  }
  return installPackage(source, options);
}

// Upgrading and deleting

/**
 * Brings an installed package up to date, as package-vc-upgrade: to the
 * newest version tag, or the head of the branch it follows. A package
 * pinned to a tag or commit stays. Gives a description of the change.
 */
export function upgradePackage(name: string): string {
  const entry = readLock().packages[name];
  const dir = packageDir(name);
  if (entry === undefined || !gnista.fileDirectoryP(dir)) fail(`${name} is not installed`);
  const old = entry.commit;
  const oldLabel = versionLabel(name).trim();
  git(["fetch", "--quiet", "--tags", "origin"], dir);
  if (entry.rev !== undefined && !isRemoteBranch(dir, entry.rev)) return `${name} is pinned to ${entry.rev}`;
  if (entry.rev !== undefined) checkOut(dir, entry.rev, undefined);
  else if (newestTag(dir) !== undefined) checkOut(dir, undefined, undefined);
  else git(["merge", "--quiet", "--ff-only", "@{upstream}"], dir);
  const manifest = readManifest(dir, entry.url);
  try {
    checkGnistaVersion(manifest);
  } catch (e) {
    git(["checkout", "--quiet", "--detach", old], dir);
    throw e;
  }
  setLockEntry(name, describe(dir, entry.source, entry.url, entry.rev));
  installRequirements(manifest, new Set([entry.url]));
  const now = readLock().packages[name].commit;
  if (now === old) return `${name} is up to date`;
  const commits = git(["rev-list", "--count", `${old}..${now}`], dir);
  return `${name}: ${oldLabel} -> ${versionLabel(name).trim()} (${commits} commit${commits === "1" ? "" : "s"}); restart Gnista to load it`;
}

/** The installed packages whose manifests require a package. */
function dependents(name: string): string[] {
  const packages = readLock().packages;
  return packageInstalledList().filter((other) => other !== name && Object.keys(readManifest(packageDir(other), packages[other].url).requires ?? {}).includes(name));
}

/** Deletes an installed package, as package-delete, unless another needs it. */
export function deletePackage(name: string): void {
  const needed = dependents(name);
  if (needed.length > 0) fail(`Package ${name} is a dependency of ${needed.join(", ")}`);
  const dir = packageDir(name);
  if (gnista.fileDirectoryP(dir)) gnista.deleteDirectory(dir, { recursive: true, trash: false });
  setLockEntry(name, undefined);
  const path = gnista.variable("load-path");
  if (Array.isArray(path)) gnista.setVariable("load-path", path.filter((d) => typeof d !== "string" || gnista.expandFileName(d) !== dir));
}

// Commands

gnista.defineCommand({
  name: "package-vc-install",
  doc: "Install a package from its git repository, owner/name on GitHub or a URL, at its newest version tag; with a prefix argument, ask for the revision, a tag, branch or commit.",
  params: [
    { name: "source", prompt: "Install package from (owner/name or URL): ", history: "package-vc--install-history" },
    { name: "arg", kind: "prefix" },
  ],
  run: (source: string, arg: gnista.PrefixArg) => {
    if (source.trim() === "") gnista.userError("No package given");
    const rev = arg === null || arg === undefined ? undefined : gnista.readString("Revision: ");
    const name = installPackage(source.trim(), rev === undefined || rev === "" ? {} : { rev });
    gnista.message(`Installed ${name}${versionLabel(name)}`);
  },
});

gnista.defineCommand({
  name: "package-vc-upgrade",
  doc: "Upgrade an installed package to its newest version tag, or the head of the branch it follows, as the lock file records.",
  params: [{ name: "name", prompt: "Upgrade package: ", collection: () => packageInstalledList(), requireMatch: true }],
  run: (name: string) => gnista.message(upgradePackage(name)),
});

gnista.defineCommand({
  name: "package-vc-upgrade-all",
  doc: "Upgrade every installed package, as package-vc-upgrade does each.",
  run: () => {
    const lines = packageInstalledList().map((name) => upgradePackage(name));
    gnista.message(lines.length === 0 ? "No packages are installed" : lines.join("\n"));
  },
});

gnista.defineCommand({
  name: "package-delete",
  doc: "Delete an installed package and its line in the lock file, unless another installed package requires it.",
  params: [{ name: "name", prompt: "Delete package: ", collection: () => packageInstalledList(), requireMatch: true }],
  run: (name: string) => {
    deletePackage(name);
    gnista.message(`Package ${name} deleted`);
  },
});
