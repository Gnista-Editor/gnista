// Coming back to where you were in a file, after Emacs's saveplace.el. With
// save-place-mode on, killing a buffer visiting a file, or exiting Gnista,
// remembers where point was, and visiting the file again goes there. The
// places are kept in save-place-file, as JSON where Emacs writes Lisp.

gnista.defineVariable({
  name: "save-place-file",
  doc: "The file places are saved in: places in user-emacs-directory if nil.",
  value: null,
});
gnista.defineVariable({
  name: "save-place-limit",
  doc: "How many files' places to keep, the most recently left first, or nil for all.",
  value: 400,
});
gnista.defineVariable({
  name: "save-place-forget-unreadable-files",
  doc: "Whether saving the places leaves out files that are gone.",
  value: true,
});
gnista.defineVariable({
  name: "save-place-ignore-files-regexp",
  doc: "Files whose places are not saved, as a regular expression, such as Git's commit message file.",
  value: "\\(?:COMMIT_EDITMSG\\|hg-editor-[[:alnum:]]+\\.txt\\|elpa/[^/]+-autoloads\\.el\\|svn-commit\\.tmp\\|bzr_log\\.[[:alnum:]]+\\)$",
});
gnista.defineHook("save-place-after-find-file-hook", "Run after visiting a file puts point at its saved place.");

function placesFile(): string | undefined {
  const file = gnista.variable("save-place-file");
  if (typeof file === "string") return gnista.expandFileName(file);
  const dir = gnista.variable("user-emacs-directory");
  return typeof dir === "string" ? gnista.expandFileName(`${dir}places`) : undefined;
}

/** Each file and where point was in it, most recently left first, as save-place-alist. */
let places: [string, number][] = [];
let loaded = false;

/** Reads the places, once, as save-place-load-alist-from-file. */
function loadPlaces(): void {
  if (loaded) return;
  loaded = true;
  const file = placesFile();
  if (file === undefined || !gnista.fileExists(file)) return;
  try {
    const list = JSON.parse(gnista.readTextFile(file));
    if (Array.isArray(list)) {
      places = list.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number");
    }
  } catch {
    gnista.message(`Error reading ${gnista.abbreviateFileName(file)}`);
  }
}

function ignored(file: string): boolean {
  const re = gnista.variable("save-place-ignore-files-regexp");
  // An Emacs regexp, as the variable's other uses take it; a bad one ignores nothing.
  try {
    return typeof re === "string" && gnista.stringMatch(re, file) !== undefined;
  } catch {
    return false;
  }
}

/** Remembers where point is in the current buffer's file, as save-place-to-alist. */
function placeToAlist(): void {
  loadPlaces();
  const file = gnista.bufferFileName();
  if (file === undefined || ignored(file)) return;
  places = places.filter(([f]) => f !== file);
  // At the start of the file there is nothing to remember.
  if (gnista.variable("save-place-mode") === true && gnista.point() > 0) places.unshift([file, gnista.point()]);
}

/** Writes the places out, as save-place-alist-to-file. */
function writePlaces(): void {
  const file = placesFile();
  if (file === undefined) return;
  if (gnista.variable("save-place-forget-unreadable-files") !== false) places = places.filter(([f]) => gnista.fileExists(f));
  const limit = gnista.variable("save-place-limit");
  if (typeof limit === "number") places = places.slice(0, Math.max(0, limit));
  gnista.writeTextFile(file, `${JSON.stringify(places, null, 1)}\n`);
}

/** Goes to the saved place of the file just visited, as save-place-find-file-hook. */
function findFileHook(): void {
  if (gnista.variable("save-place-mode") !== true) return;
  loadPlaces();
  const file = gnista.bufferFileName();
  const cell = file === undefined ? undefined : places.find(([f]) => f === file);
  if (cell !== undefined && gnista.variable("revert-buffer-in-progress-p") !== true) {
    gnista.gotoChar(Math.min(cell[1], gnista.bufferSize()));
  }
  gnista.runHooks("save-place-after-find-file-hook");
}

/** Remembers every file's place and saves them, as save-place-kill-emacs-hook. */
function killEmacsHook(): void {
  if (gnista.variable("save-place-mode") !== true) return;
  for (const b of gnista.bufferList()) gnista.withCurrentBuffer(b, placeToAlist);
  writePlaces();
}

function killBufferHook(): void {
  if (gnista.variable("save-place-mode") === true) placeToAlist();
}

gnista.defineMinorMode({
  name: "save-place-mode",
  global: true,
  doc: "Remember where point was in each file, so visiting it again goes back there, as saved in save-place-file.",
  onChange: (on) => {
    for (const [hook, fn] of [
      ["find-file-hook", findFileHook],
      ["kill-buffer-hook", killBufferHook],
      ["kill-emacs-hook", killEmacsHook],
    ] as const) {
      if (on) gnista.addHook(hook, fn);
      else gnista.removeHook(hook, fn);
    }
  },
});
