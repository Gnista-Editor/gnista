import { selectSafeCodingSystem } from "mule";

// Choosing a major mode for a file, after Emacs's files.el.

gnista.defineVariable({
  name: "auto-mode-alist",
  doc:
    "Which major mode files get, by name: a list of [pattern, mode] pairs, tried in order.\n\n" +
    "Each pattern is an Emacs regular expression matched against the whole file name, as \\\\.txt\\\\', " +
    "and mode is the command that turns the mode on. Files that match nothing get Fundamental mode.",
  value: [["\\.te?xt\\'", "text-mode"]],
});

/**
 * The mode a file's first line asks for, as Emacs reads "-*- text -*-" or
 * "-*- mode: text -*-": the name with "-mode" added.
 */
function modeFromFirstLine(): string | undefined {
  const firstLine = gnista.saveRestriction(() => {
    gnista.widen();
    return gnista.lineText(0);
  });
  const inside = /-\*-(.*?)-\*-/.exec(firstLine)?.[1]?.trim();
  if (!inside) {
    return undefined;
  }
  const mode = /(?:^|;)\s*mode:\s*([\w-]+)/i.exec(inside)?.[1] ?? (inside.includes(":") ? undefined : inside);
  return mode === undefined ? undefined : `${mode.toLowerCase()}-mode`;
}

function modeFromFileName(): string | undefined {
  const file = gnista.bufferFileName();
  const alist = gnista.variable("auto-mode-alist");
  if (file === undefined || !Array.isArray(alist)) {
    return undefined;
  }
  for (const entry of alist) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      if (gnista.stringMatch(entry[0], file) !== undefined) {
        return entry[1];
      }
    }
  }
  return undefined;
}

gnista.defineCommand({
  name: "normal-mode",
  doc:
    "Choose the current buffer's major mode, as when its file is visited.\n\n" +
    "A mode named on the first line, as in -*- text -*-, comes first; then auto-mode-alist, " +
    "matched against the file name; otherwise Fundamental mode.",
  run: () => {
    const mode = [modeFromFirstLine(), modeFromFileName()].find(
      (mode) => mode !== undefined && gnista.commandExists(mode),
    );
    gnista.call((mode ?? "fundamental-mode") as gnista.CommandName);
    // As hack-local-variables ends, once the mode is set; editorconfig applies its settings here.
    gnista.runHooks("hack-local-variables-hook");
  },
});

gnista.defineHook("hack-local-variables-hook", "Run after normal-mode chooses a buffer's major mode, as where Emacs applies its local variables.");

// Saving, reverting and recovering files, after files.el. What touches the
// disk is native, as Emacs's fileio.c is: writing with a backup, reading
// back, auto-saving. Emacs's questions wait for an answer; here each one
// calls on with it.

gnista.defineVariable({
  name: "require-final-newline",
  doc:
    "Whether saving adds a newline to a file that does not end in one: true adds it, false leaves the file as it is, " +
    '"ask" asks first. Text and programming modes set it from mode-require-final-newline.',
  value: false,
  local: true,
});

gnista.defineVariable({
  name: "mode-require-final-newline",
  doc: "The value text and programming modes give require-final-newline in their buffers.",
  value: true,
});

gnista.defineVariable({
  name: "revert-without-query",
  doc: "Files revert-buffer reverts without asking, if unmodified: a list of Emacs regular expressions matched against the file name.",
  value: [],
});

gnista.defineHook("before-revert-hook", "Run before revert-buffer replaces the text with the file's.");
gnista.defineHook("after-revert-hook", "Run after revert-buffer has reread the file.");

/** The buffer's file, or an error saying it has none. */
function visitedFile(message = "Buffer does not seem to be associated with any file"): string {
  const file = gnista.bufferFileName();
  if (file === undefined) throw new Error(message);
  return file;
}

/** A file name with the home directory as ~, as Emacs's abbreviate-file-name. */
function abbreviate(file: string): string {
  const home = gnista.expandFileName("~");
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function nondirectory(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** Adds the newline require-final-newline asks for, as basic-save-buffer does before writing. */
function addFinalNewline(): void {
  const size = gnista.bufferSize();
  const require = gnista.variable("require-final-newline");
  if (size === 0 || require === false || require === null || gnista.bufferText(size - 1, size) === "\n") return;
  if (require === true || require === "visit-save" || gnista.yOrNP(`Buffer ${gnista.bufferName()} does not end in newline.  Add one? `)) {
    const point = gnista.point();
    gnista.gotoChar(gnista.pointMax());
    gnista.insert("\n");
    gnista.gotoChar(point);
  }
}

/** Writes the buffer, says so and runs the save hooks, as basic-save-buffer does once it may. */
function writeBuffer(file: string): void {
  gnista.runHooks("before-save-hook");
  gnista.writeVisitedFile();
  gnista.message(`Wrote ${gnista.bufferFileName() ?? file}`);
  gnista.runHooks("after-save-hook");
}

/**
 * Saves the current buffer if it is modified, as Emacs's basic-save-buffer.
 * A file changed on disk since it was visited or saved is overwritten
 * only if you say so.
 */
function basicSaveBuffer(): void {
  const file = gnista.bufferFileName();
  if (!gnista.bufferModified()) {
    if (gnista.calledInteractively()) gnista.message("(No changes need to be saved)");
    return;
  }
  if (file === undefined) {
    // Emacs reads a file to save in; write-file reads one too.
    gnista.callInteractively("write-file");
    return;
  }
  if (gnista.visitedFileChanged() && !gnista.yesOrNoP(`${nondirectory(file)} has changed since visited or saved.  Save anyway? `)) {
    gnista.userError("Save not confirmed");
  }
  addFinalNewline();
  selectSafeCodingSystem();
  writeBuffer(file);
}

gnista.defineCommand({
  name: "save-buffer",
  doc:
    "Save the current buffer to its file, if it has changed.\n\n" +
    "The first save in a session keeps the file as it was in name~ (see make-backup-files). If the file changed on disk " +
    "since you visited or saved it, you are asked before it is overwritten. A buffer with no file asks for one, as write-file does.",
  run: () => basicSaveBuffer(),
});

gnista.defineCommand({
  name: "write-file",
  doc:
    "Write the current buffer to a file and visit that file instead.\n\n" +
    "A directory writes a file of the buffer's name in it. An existing file is overwritten only if you say so.",
  params: [{ name: "file", kind: "file", prompt: "Write file: " }],
  run: (input: string) => {
    let file = gnista.expandFileName(input);
    if (input.endsWith("/")) file = `${file.replace(/\/$/, "")}/${gnista.bufferName()}`;
    if (gnista.calledInteractively() && gnista.fileExists(file) && file !== gnista.bufferFileName()) {
      if (!gnista.yOrNP(`File ‘${file}’ exists; overwrite? `)) throw new Error("Canceled");
    }
    gnista.setVisitedFileName(file);
    gnista.setBufferModified(true);
    basicSaveBuffer();
  },
});

gnista.defineCommand({
  name: "not-modified",
  doc: "Mark the current buffer as unmodified, not needing to be saved.\n\nWith a prefix argument, mark it as modified, so save-buffer will save it.",
  run: () => {
    const modified = gnista.prefixArg() !== null;
    gnista.message(modified ? "Modification-flag set" : "Modification-flag cleared");
    gnista.setBufferModified(modified);
  },
});

/** Rereads the file into the buffer and chooses its mode again, as revert-buffer--default does once it may. */
function revertNow(): void {
  gnista.runHooks("before-revert-hook");
  gnista.revertToVisitedFile();
  gnista.call("normal-mode");
  gnista.runHooks("after-revert-hook");
}


gnista.defineVariable({
  name: "revert-buffer-function",
  doc: "The command revert-buffer runs instead of rereading the file, in buffers that set it, such as Dired's. Nil for the usual.",
  value: null,
});

/**
 * Reverts the buffer, asking first unless `noconfirm`, or the buffer is
 * unmodified and its file matches revert-without-query.
 */
function revertBuffer(noconfirm: boolean): void {
  // A buffer such as Dired's reverts itself, as its revert-buffer-function says.
  const own = gnista.variable("revert-buffer-function");
  if (typeof own === "string" && gnista.commandExists(own)) {
    gnista.call(own as gnista.CommandName);
    return;
  }
  const file = visitedFile();
  if (!gnista.fileExists(file)) throw new Error(`File ${file} no longer exists!`);
  const modified = gnista.bufferModified();
  const patterns = gnista.variable("revert-without-query");
  const unasked = !modified && Array.isArray(patterns) && patterns.some((p) => typeof p === "string" && gnista.stringMatch(p, file) !== undefined);
  const question = modified ? `Discard edits and reread from ${file}? ` : `Revert buffer from file ${file}? `;
  if (noconfirm || unasked || gnista.yesOrNoP(question)) revertNow();
}

gnista.defineCommand({
  name: "revert-buffer",
  doc:
    "Replace the buffer's text with its file's, after asking.\n\n" +
    "Point stays where the text is unchanged. The major mode is chosen again, as when visiting the file. The revert can be undone.",
  run: () => revertBuffer(false),
});

gnista.defineCommand({
  name: "revert-buffer-quick",
  doc: "Revert the buffer from its file, asking only if it has unsaved changes.",
  run: () => {
    if (gnista.bufferFileName() !== undefined && !gnista.bufferModified()) {
      revertBuffer(true);
      gnista.message("Reverted buffer");
    } else {
      revertBuffer(false);
    }
  },
});

gnista.defineCommand({
  name: "recover-this-file",
  doc: "Replace the buffer's text with its auto-save file's, after asking: what was typed since the last save, before a crash.",
  run: () => gnista.call("recover-file", visitedFile("This buffer is not visiting a file")),
});

gnista.defineCommand({
  name: "recover-file",
  doc:
    "Visit a file, taking its text from its auto-save file, #name#, after asking.\n\n" +
    "The buffer is left modified; save it to keep what was recovered.",
  params: [{ name: "file", kind: "file", prompt: "Recover file: " }],
  run: (input: string) => {
    const file = gnista.expandFileName(input);
    if (/^#.*#$/.test(nondirectory(file))) throw new Error(`${abbreviate(file)} is an auto-save file`);
    const auto = gnista.autoSaveFileName(file);
    if (gnista.fileExists(file) && !gnista.fileExists(auto)) throw new Error(`Auto save file ${abbreviate(auto)} does not exist`);
    if (!gnista.hasNewerAutoSave(file)) gnista.userError(`Auto-save file ${abbreviate(auto)} not current`);
    for (;;) {
      const answer = gnista.readAnswer(`Recover auto save file ${auto}? `, ["yes", "no", "diff"]);
      if (answer === "diff") {
        gnista.message("Gnista cannot show the differences yet");
        continue;
      }
      if (answer !== "yes") gnista.userError("Recover-file canceled");
      gnista.call("switch-to-buffer", gnista.findFileNoselect(file));
      gnista.recoverFromAutoSave();
      return;
    }
  },
});

gnista.defineCommand({
  name: "auto-save-mode",
  doc: "Toggle auto-saving of the current buffer to #name# beside its file.\n\nWith a positive prefix argument, turn it on; with zero or a negative one, off.",
  run: () => {
    const arg = gnista.prefixArg();
    const on = arg === null ? !gnista.autoSaving() : gnista.prefixNumericValue(arg) > 0;
    if (on && gnista.bufferFileName() === undefined) throw new Error("Buffer does not seem to be associated with any file");
    gnista.setAutoSave(on);
    gnista.message(`Auto-save ${on ? "on" : "off"} (in this buffer)`);
  },
});

gnista.defineCommand({
  name: "do-auto-save",
  doc: "Auto-save every buffer that has changed since it was last saved or auto-saved.",
  run: () => {
    gnista.doAutoSave();
  },
});

/** The buffers save-some-buffers asks about: modified ones visiting files. */
function buffersNeedingSave(): string[] {
  return gnista
    .bufferList()
    .filter((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName() !== undefined && gnista.bufferModified()));
}

/**
 * Asks about saving each modified file buffer in turn, as Emacs's
 * save-some-buffers with map-y-or-n-p: y saves it, n skips it, ! saves the
 * rest, . saves it and stops, q stops. With `all`, saves them all without
 * asking.
 */
function saveSomeBuffers(all: boolean, interactive: boolean): void {
  const buffers = buffersNeedingSave();
  if (buffers.length === 0) {
    if (interactive) gnista.message("(No files need saving)");
    return;
  }
  const save = (buffer: string) => gnista.withCurrentBuffer(buffer, () => basicSaveBuffer());
  if (all) {
    buffers.forEach(save);
    return;
  }
  for (let k = 0; k < buffers.length; k++) {
    const buffer = buffers[k];
    const file = gnista.withCurrentBuffer(buffer, () => gnista.bufferFileName() ?? "");
    const what = buffer === nondirectory(file) || buffer.startsWith(`${nondirectory(file)}<`) ? `file ${file}` : `file ${file} (buffer ${buffer})`;
    const c = gnista.readCharChoice(`Save ${what}? (y, n, !, ., q, C-r, C-f, d or C-h) `, "yn!.q ");
    if (c === "y" || c === " ") save(buffer);
    else if (c === "!") return buffers.slice(k).forEach(save);
    else if (c === ".") return save(buffer);
    else if (c !== "n") return;
  }
}

gnista.defineCommand({
  name: "save-some-buffers",
  doc:
    "Save some modified file buffers, asking about each: y saves it, n skips it, ! saves all the rest, . saves it and stops, and q stops.\n\n" +
    "With a prefix argument, save them all without asking.",
  run: () => saveSomeBuffers(gnista.prefixArg() !== null, gnista.calledInteractively()),
});

gnista.defineCommand({
  name: "save-buffers-kill-terminal",
  doc:
    "Offer to save each modified file buffer, then exit.\n\n" +
    "If any are left unsaved, you are asked whether to exit anyway. With a prefix argument, save them all without asking.",
  run: () => {
    saveSomeBuffers(gnista.prefixArg() !== null, false);
    if (buffersNeedingSave().length > 0 && !gnista.yesOrNoP("Modified buffers exist; exit anyway? ")) return;
    // Then, as save-buffers-kill-emacs does, about processes still running.
    const running = gnista.processList().filter((p) => gnista.processStatus(p) === "run" && gnista.processQueryOnExitFlag(p));
    if (running.length > 0) {
      if (!gnista.yesOrNoP("Active processes exist; kill them and exit anyway? ")) return;
      for (const p of running) gnista.deleteProcess(p);
    }
    // Then whatever else packages ask about, as Org's clock does; one saying no keeps Gnista running.
    if (!gnista.runHookWithArgsUntilFailure("kill-emacs-query-functions")) return;
    gnista.killEmacs();
  },
});

gnista.defineHook("kill-emacs-query-functions", "Functions called before Gnista exits from save-buffers-kill-terminal; if one returns false, it does not exit.");

// Reverting buffers when their files change, after autorevert.el, by
// looking every auto-revert-interval seconds.

gnista.defineVariable({
  name: "auto-revert-interval",
  doc: "How many seconds between checks for files that changed, in buffers where auto-revert-mode or global-auto-revert-mode is on.",
  value: 5,
});

gnista.defineVariable({
  name: "auto-revert-verbose",
  doc: "Whether reverting a buffer because its file changed says so.",
  value: true,
});

let autoRevertTimer: number | undefined;

/** Reverts each buffer that auto-reverts, is unmodified, and whose file changed. */
function autoRevertBuffers(): void {
  const global = gnista.variable("global-auto-revert-mode") === true;
  for (const buffer of gnista.bufferList()) {
    gnista.withCurrentBuffer(buffer, () => {
      const file = gnista.bufferFileName();
      if (file === undefined || (!global && gnista.variable("auto-revert-mode") !== true)) return;
      if (gnista.bufferModified() || !gnista.visitedFileChanged() || !gnista.fileExists(file)) return;
      revertNow();
      if (gnista.variable("auto-revert-verbose") === true) gnista.message(`Reverting buffer ‘${buffer}’`);
    });
  }
}

/** Starts checking files if any buffer auto-reverts, and stops when none does. */
function updateAutoRevertTimer(): void {
  const wanted =
    gnista.variable("global-auto-revert-mode") === true ||
    gnista.bufferList().some((b) => gnista.withCurrentBuffer(b, () => gnista.variable("auto-revert-mode") === true));
  if (wanted && autoRevertTimer === undefined) {
    const interval = Number(gnista.variable("auto-revert-interval")) || 5;
    autoRevertTimer = gnista.runWithTimer(interval, interval, autoRevertBuffers);
  } else if (!wanted && autoRevertTimer !== undefined) {
    gnista.cancelTimer(autoRevertTimer);
    autoRevertTimer = undefined;
  }
}

gnista.defineMinorMode({
  name: "auto-revert-mode",
  lighter: " ARev",
  doc: "Revert the buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

gnista.defineMinorMode({
  name: "global-auto-revert-mode",
  global: true,
  doc: "Revert every file buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

// Managing files, after the commands of files.el and fileio.c.

/** Whether to go ahead where `file` exists: asked when typed, refused from code, as `ok-if-already-exists` 0 does. */
function confirmOverwrite(file: string, verb: string): void {
  if (!gnista.fileExists(file)) return;
  const exists = `File already exists: ${gnista.expandFileName(file)}`;
  if (!gnista.calledInteractively()) throw new Error(exists);
  if (!gnista.yesOrNoP(`File ${gnista.abbreviateFileName(gnista.expandFileName(file))} already exists; ${verb} to it anyway? `)) throw new Error(exists);
}

/** Where a copy or rename of `from` to `to` lands: inside `to` if it ends in a slash. */
const targetName = (from: string, to: string): string =>
  to.endsWith("/") ? to + gnista.fileNameNondirectory(gnista.directoryFileName(from)) : to;

const trashing = (): boolean => {
  const on = gnista.variable("delete-by-moving-to-trash");
  return on !== null && on !== false && gnista.prefixArg() === null;
};

gnista.defineCommand({
  name: "copy-file",
  doc:
    "Copy a file. A name ending in a slash copies it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error. " +
    "With a prefix argument, the copy keeps the file's modification time.",
  params: [
    { name: "file", kind: "file", prompt: "Copy file: " },
    { name: "newname", kind: "file", prompt: (file) => `Copy ${gnista.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    const keepTime = gnista.prefixArg() !== null;
    confirmOverwrite(targetName(file, newname), "copy");
    gnista.copyFile(file, newname, { okIfExists: true, keepTime });
  },
});

gnista.defineCommand({
  name: "rename-file",
  doc:
    "Rename a file or directory. A name ending in a slash moves it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error.",
  params: [
    { name: "file", kind: "file", prompt: "Rename file: " },
    { name: "newname", kind: "file", prompt: (file) => `Rename ${gnista.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    confirmOverwrite(targetName(file, newname), "rename");
    gnista.renameFile(file, newname, { okIfExists: true });
  },
});

gnista.defineCommand({
  name: "delete-file",
  doc:
    "Delete a file. With delete-by-moving-to-trash, on in Gnista, it goes to the trash, from where it can be put back.\n\n" +
    "With a prefix argument, delete it for good instead.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => trashing() ? "Move file to trash: " : "Delete file: ",
  }],
  run: (file: string) => gnista.deleteFile(file, { trash: trashing() }),
});

gnista.defineCommand({
  name: "make-directory",
  doc: "Make a directory, and any directories above it that are missing.",
  params: [{ name: "dir", kind: "file", prompt: "Make directory: " }],
  run: (dir: string) => gnista.makeDirectory(dir, { parents: true }),
});

gnista.defineCommand({
  name: "delete-directory",
  doc:
    "Delete a directory, asking first if it has files in it. With delete-by-moving-to-trash, on in Gnista, " +
    "it goes to the trash.\n\nWith a prefix argument, delete it for good instead.",
  params: [{
    name: "dir",
    kind: "file",
    prompt: () => trashing() ? "Move directory to trash: " : "Delete directory: ",
  }],
  run: (dir: string) => {
    const trash = trashing();
    const empty = gnista.directoryFiles(dir).length <= 2;
    if (empty) return gnista.deleteDirectory(dir, { trash });
    if (!gnista.calledInteractively()) return gnista.deleteDirectory(dir, { trash });
    const verb = trash ? "trash" : "delete";
    // As in Emacs, no still tries, and fails as the directory is not empty.
    const yes = gnista.yOrNP(`Directory ${gnista.abbreviateFileName(gnista.directoryFileName(gnista.expandFileName(dir)))} is not empty, really ${verb}? `);
    gnista.deleteDirectory(dir, { recursive: yes, trash });
  },
});

gnista.defineCommand({
  name: "copy-directory",
  doc: "Copy a directory and what it holds: into the new name if that is a directory already, else as it.",
  params: [
    { name: "directory", kind: "file", prompt: "Copy directory: " },
    { name: "newname", kind: "file", prompt: (dir) => `Copy directory ${gnista.abbreviateFileName(dir)} to: ` },
  ],
  run: (directory: string, newname: string) => {
    gnista.copyDirectory(directory, newname, { keepTime: gnista.prefixArg() !== null });
  },
});

gnista.defineCommand({
  name: "read-only-mode",
  doc:
    "Make the buffer read-only, or editable again.\n\n" +
    "A buffer visiting a file that cannot be written starts read-only. With a prefix argument, " +
    "a positive number makes it read-only and zero or less editable.",
  run: () => {
    const arg = gnista.prefixArg();
    const on = arg === null ? !gnista.bufferReadOnly() : gnista.prefixNumericValue(arg) > 0;
    gnista.setReadOnly(on);
    if (gnista.calledInteractively()) gnista.message(`Read-Only mode ${on ? "enabled" : "disabled"} in current buffer`);
  },
});

gnista.defineCommand({
  name: "find-alternate-file",
  doc:
    "Visit another file in place of the current buffer's, which is killed.\n\n" +
    "The prompt starts with the current file's name, for visiting one like it. A buffer with unsaved changes " +
    "is killed only once you say so.",
  params: [{
    name: "file",
    kind: "file",
    prompt: "Find alternate file: ",
    initial: () => {
      const file = gnista.bufferFileName();
      return file === undefined ? gnista.abbreviateFileName(gnista.fileNameAsDirectory(gnista.expandFileName("."))) : gnista.abbreviateFileName(file);
    },
  }],
  run: (file: string) => {
    const old = gnista.bufferName();
    const replace = () => {
      // The old buffer gives up its name and file first, so the same file
      // is read afresh, as files.el renames it " **lose**".
      const oldFile = gnista.bufferFileName();
      gnista.setBufferModified(false);
      gnista.setVisitedFileName(null);
      const lose = gnista.generateNewBufferName(" **lose**");
      gnista.call("rename-buffer", lose);
      try {
        gnista.call("find-file", file);
      } finally {
        if (gnista.bufferName() === lose) {
          // Visiting failed: the old buffer is as it was.
          gnista.call("rename-buffer", old);
          if (oldFile !== undefined) gnista.setVisitedFileName(oldFile, { alongWithFile: true });
        }
      }
      if (gnista.bufferName() !== lose) gnista.call("kill-buffer", lose);
    };
    if (gnista.bufferModified() && gnista.bufferFileName() !== undefined) {
      if (!gnista.calledInteractively()) throw new Error(`Buffer ${old} modified`);
      if (!gnista.yesOrNoP(`Buffer \u2018${old}\u2019 modified; kill anyway? `)) throw new Error("Aborted");
    }
    replace();
  },
});

gnista.defineCommand({
  name: "rename-visited-file",
  doc:
    "Rename the file the buffer visits, and visit it under its new name.\n\n" +
    "In a buffer visiting no file, set the file it visits instead, as set-visited-file-name does.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => gnista.bufferFileName() === undefined ? "Set visited file name: " : "Rename visited file to: ",
  }],
  run: (input: string) => {
    const old = gnista.bufferFileName();
    const file = gnista.expandFileName(targetName(old ?? gnista.bufferName(), input));
    const along = old !== undefined && gnista.fileExists(old);
    if (along) gnista.renameFile(old, file);
    gnista.setVisitedFileName(file, { alongWithFile: along });
  },
});

gnista.bindKey("C-x C-q", "read-only-mode");
gnista.bindKey("C-x C-v", "find-alternate-file");
gnista.bindKey("C-x C-s", "save-buffer");
gnista.bindKey("C-x C-w", "write-file");
gnista.bindKey("C-x s", "save-some-buffers");
gnista.bindKey("C-x C-c", "save-buffers-kill-terminal");
gnista.bindKey("C-x x g", "revert-buffer-quick");
gnista.bindKey("M-~", "not-modified");

// Inserting and writing parts of files, after files.el's insert-file and
// append-to-file and fileio.c's write-region command.

const insertFile = gnista.defineCommand({
  name: "insert-file",
  doc: "Insert a file's text after point, leaving point before it and the mark after it.",
  params: [{ name: "file", kind: "file", prompt: "Insert file: " }],
  run: (file) => {
    // The name as it was given, as insert-file-1 signals it.
    if (gnista.fileDirectoryP(file)) {
      gnista.signal("file-error", `Opening input file: Is a directory, ${file}`, ["Opening input file", "Is a directory", file]);
    }
    const [, inserted] = gnista.insertFileContents(file);
    gnista.pushMark(gnista.point() + inserted);
    gnista.message("Mark set");
  },
});
gnista.bindKey("C-x i", insertFile);

gnista.defineCommand({
  name: "write-region",
  doc:
    "Write the region to a file, as it is, the buffer still visiting its own.\n\n" +
    "A file that exists is overwritten only if you say so.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "file", kind: "file", prompt: "Write region to file: " },
  ],
  run: async (start, end, file) => {
    const name = gnista.expandFileName(file);
    // As write-region's interactive MUSTBENEW, as barf_or_query_if_file_exists asks.
    if (gnista.calledInteractively() && gnista.fileExistsP(name)) {
      if (!(await gnista.yesOrNoP(`File ${name} already exists; overwrite anyway? `))) {
        gnista.signal("file-already-exists", `File already exists: ${name}`, ["File already exists", name]);
      }
    }
    gnista.writeRegion(start, end, name);
  },
});

gnista.defineCommand({
  name: "append-to-file",
  doc: "Add the region to the end of a file.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "file", kind: "file", prompt: "Append to file: " },
  ],
  run: (start, end, file) => gnista.writeRegion(start, end, file, { append: true }),
});

// Killing several buffers, after files.el: kill-some-buffers asks about
// each one, kill-matching-buffers about those whose names match.

/** Kills a buffer if the answer is yes, as kill-buffer-ask. */
async function killBufferAsk(buffer: string): Promise<void> {
  const modified = gnista.withCurrentBuffer(buffer, () => gnista.bufferModified());
  if (await gnista.yesOrNoP(`Buffer ${buffer} ${modified ? "HAS BEEN EDITED" : "is unmodified"}.  Kill? `)) gnista.call("kill-buffer", buffer);
}

gnista.defineCommand({
  name: "kill-some-buffers",
  doc: "Ask about each buffer whether to kill it, saying whether it has been edited; buffers whose names start with a space are left.",
  run: async () => {
    for (const buffer of gnista.bufferList()) {
      if (buffer === "" || buffer.startsWith(" ") || !gnista.getBuffer(buffer)) continue;
      await killBufferAsk(buffer);
    }
  },
});

for (const [name, doc, ask] of [
  ["kill-matching-buffers", "Kill the buffers whose names match a regexp, asking about each; with a prefix argument, those whose names start with a space too.", true],
  ["kill-matching-buffers-no-ask", "Kill the buffers whose names match a regexp, without asking; with a prefix argument, those whose names start with a space too.", false],
] as const) {
  gnista.defineCommand({
    name,
    doc,
    params: [
      { name: "regexp", kind: "string", prompt: "Kill buffers matching this regular expression: " },
      { name: "internal", kind: "prefix" },
    ],
    run: async (regexp: string, internal: gnista.PrefixArg) => {
      for (const buffer of gnista.bufferList()) {
        if (buffer === "" || (internal === null && buffer.startsWith(" ")) || !gnista.getBuffer(buffer)) continue;
        if (gnista.stringMatch(regexp, buffer) === undefined) continue;
        if (ask) await killBufferAsk(buffer);
        else gnista.call("kill-buffer", buffer);
      }
    },
  });
}

/**
 * A file's name relative to a directory, default-directory unless given,
 * going up with ".." where it must, as file-relative-name.
 */
export function fileRelativeName(file: string, directory?: string): string {
  const dir = gnista.expandFileName(directory ?? String(gnista.variable("default-directory") ?? "."));
  const parts = (path: string) => path.split("/").filter((p) => p !== "");
  const [from, to] = [parts(dir), parts(gnista.expandFileName(file))];
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const rel = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
  return rel === "" ? "." : rel;
}
