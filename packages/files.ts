import { selectSafeCodingSystem } from "mule";

// Choosing a major mode for a file, after Emacs's files.el.

e8.defineVariable({
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
  const firstLine = e8.saveRestriction(() => {
    e8.widen();
    return e8.lineText(0);
  });
  const inside = /-\*-(.*?)-\*-/.exec(firstLine)?.[1]?.trim();
  if (!inside) {
    return undefined;
  }
  const mode = /(?:^|;)\s*mode:\s*([\w-]+)/i.exec(inside)?.[1] ?? (inside.includes(":") ? undefined : inside);
  return mode === undefined ? undefined : `${mode.toLowerCase()}-mode`;
}

function modeFromFileName(): string | undefined {
  const file = e8.bufferFileName();
  const alist = e8.variable("auto-mode-alist");
  if (file === undefined || !Array.isArray(alist)) {
    return undefined;
  }
  for (const entry of alist) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      if (e8.stringMatch(entry[0], file) !== undefined) {
        return entry[1];
      }
    }
  }
  return undefined;
}

e8.defineCommand({
  name: "normal-mode",
  doc:
    "Choose the current buffer's major mode, as when its file is visited.\n\n" +
    "A mode named on the first line, as in -*- text -*-, comes first; then auto-mode-alist, " +
    "matched against the file name; otherwise Fundamental mode.",
  run: () => {
    const mode = [modeFromFirstLine(), modeFromFileName()].find(
      (mode) => mode !== undefined && e8.commandExists(mode),
    );
    e8.call((mode ?? "fundamental-mode") as e8.CommandName);
    // As hack-local-variables ends, once the mode is set; editorconfig applies its settings here.
    e8.runHooks("hack-local-variables-hook");
  },
});

e8.defineHook("hack-local-variables-hook", "Run after normal-mode chooses a buffer's major mode, as where Emacs applies its local variables.");

// Saving, reverting and recovering files, after files.el. What touches the
// disk is native, as Emacs's fileio.c is: writing with a backup, reading
// back, auto-saving. Emacs's questions wait for an answer; here each one
// calls on with it.

e8.defineVariable({
  name: "require-final-newline",
  doc:
    "Whether saving adds a newline to a file that does not end in one: true adds it, false leaves the file as it is, " +
    '"ask" asks first. Text and programming modes set it from mode-require-final-newline.',
  value: false,
  local: true,
});

e8.defineVariable({
  name: "mode-require-final-newline",
  doc: "The value text and programming modes give require-final-newline in their buffers.",
  value: true,
});

e8.defineVariable({
  name: "revert-without-query",
  doc: "Files revert-buffer reverts without asking, if unmodified: a list of Emacs regular expressions matched against the file name.",
  value: [],
});

e8.defineHook("before-revert-hook", "Run before revert-buffer replaces the text with the file's.");
e8.defineHook("after-revert-hook", "Run after revert-buffer has reread the file.");

/** The buffer's file, or an error saying it has none. */
function visitedFile(message = "Buffer does not seem to be associated with any file"): string {
  const file = e8.bufferFileName();
  if (file === undefined) throw new Error(message);
  return file;
}

/** A file name with the home directory as ~, as Emacs's abbreviate-file-name. */
function abbreviate(file: string): string {
  const home = e8.expandFileName("~");
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function nondirectory(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** Adds the newline require-final-newline asks for, as basic-save-buffer does before writing. */
function addFinalNewline(): void {
  const size = e8.bufferSize();
  const require = e8.variable("require-final-newline");
  if (size === 0 || require === false || require === null || e8.bufferText(size - 1, size) === "\n") return;
  if (require === true || require === "visit-save" || e8.yOrNP(`Buffer ${e8.bufferName()} does not end in newline.  Add one? `)) {
    const point = e8.point();
    e8.gotoChar(e8.pointMax());
    e8.insert("\n");
    e8.gotoChar(point);
  }
}

/** Writes the buffer, says so and runs the save hooks, as basic-save-buffer does once it may. */
function writeBuffer(file: string): void {
  e8.runHooks("before-save-hook");
  e8.writeVisitedFile();
  e8.message(`Wrote ${e8.bufferFileName() ?? file}`);
  e8.runHooks("after-save-hook");
}

/**
 * Saves the current buffer if it is modified, as Emacs's basic-save-buffer.
 * A file changed on disk since it was visited or saved is overwritten
 * only if you say so.
 */
function basicSaveBuffer(): void {
  const file = e8.bufferFileName();
  if (!e8.bufferModified()) {
    if (e8.calledInteractively()) e8.message("(No changes need to be saved)");
    return;
  }
  if (file === undefined) {
    // Emacs reads a file to save in; write-file reads one too.
    e8.callInteractively("write-file");
    return;
  }
  if (e8.visitedFileChanged() && !e8.yesOrNoP(`${nondirectory(file)} has changed since visited or saved.  Save anyway? `)) {
    e8.userError("Save not confirmed");
  }
  addFinalNewline();
  selectSafeCodingSystem();
  writeBuffer(file);
}

e8.defineCommand({
  name: "save-buffer",
  doc:
    "Save the current buffer to its file, if it has changed.\n\n" +
    "The first save in a session keeps the file as it was in name~ (see make-backup-files). If the file changed on disk " +
    "since you visited or saved it, you are asked before it is overwritten. A buffer with no file asks for one, as write-file does.",
  run: () => basicSaveBuffer(),
});

e8.defineCommand({
  name: "write-file",
  doc:
    "Write the current buffer to a file and visit that file instead.\n\n" +
    "A directory writes a file of the buffer's name in it. An existing file is overwritten only if you say so.",
  params: [{ name: "file", kind: "file", prompt: "Write file: " }],
  run: (input: string) => {
    let file = e8.expandFileName(input);
    if (input.endsWith("/")) file = `${file.replace(/\/$/, "")}/${e8.bufferName()}`;
    if (e8.calledInteractively() && e8.fileExists(file) && file !== e8.bufferFileName()) {
      if (!e8.yOrNP(`File ‘${file}’ exists; overwrite? `)) throw new Error("Canceled");
    }
    e8.setVisitedFileName(file);
    e8.setBufferModified(true);
    basicSaveBuffer();
  },
});

e8.defineCommand({
  name: "not-modified",
  doc: "Mark the current buffer as unmodified, not needing to be saved.\n\nWith a prefix argument, mark it as modified, so save-buffer will save it.",
  run: () => {
    const modified = e8.prefixArg() !== null;
    e8.message(modified ? "Modification-flag set" : "Modification-flag cleared");
    e8.setBufferModified(modified);
  },
});

/** Rereads the file into the buffer and chooses its mode again, as revert-buffer--default does once it may. */
function revertNow(): void {
  e8.runHooks("before-revert-hook");
  e8.revertToVisitedFile();
  e8.call("normal-mode");
  e8.runHooks("after-revert-hook");
}


e8.defineVariable({
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
  const own = e8.variable("revert-buffer-function");
  if (typeof own === "string" && e8.commandExists(own)) {
    e8.call(own as e8.CommandName);
    return;
  }
  const file = visitedFile();
  if (!e8.fileExists(file)) throw new Error(`File ${file} no longer exists!`);
  const modified = e8.bufferModified();
  const patterns = e8.variable("revert-without-query");
  const unasked = !modified && Array.isArray(patterns) && patterns.some((p) => typeof p === "string" && e8.stringMatch(p, file) !== undefined);
  const question = modified ? `Discard edits and reread from ${file}? ` : `Revert buffer from file ${file}? `;
  if (noconfirm || unasked || e8.yesOrNoP(question)) revertNow();
}

e8.defineCommand({
  name: "revert-buffer",
  doc:
    "Replace the buffer's text with its file's, after asking.\n\n" +
    "Point stays where the text is unchanged. The major mode is chosen again, as when visiting the file. The revert can be undone.",
  run: () => revertBuffer(false),
});

e8.defineCommand({
  name: "revert-buffer-quick",
  doc: "Revert the buffer from its file, asking only if it has unsaved changes.",
  run: () => {
    if (e8.bufferFileName() !== undefined && !e8.bufferModified()) {
      revertBuffer(true);
      e8.message("Reverted buffer");
    } else {
      revertBuffer(false);
    }
  },
});

e8.defineCommand({
  name: "recover-this-file",
  doc: "Replace the buffer's text with its auto-save file's, after asking: what was typed since the last save, before a crash.",
  run: () => e8.call("recover-file", visitedFile("This buffer is not visiting a file")),
});

e8.defineCommand({
  name: "recover-file",
  doc:
    "Visit a file, taking its text from its auto-save file, #name#, after asking.\n\n" +
    "The buffer is left modified; save it to keep what was recovered.",
  params: [{ name: "file", kind: "file", prompt: "Recover file: " }],
  run: (input: string) => {
    const file = e8.expandFileName(input);
    if (/^#.*#$/.test(nondirectory(file))) throw new Error(`${abbreviate(file)} is an auto-save file`);
    const auto = e8.autoSaveFileName(file);
    if (e8.fileExists(file) && !e8.fileExists(auto)) throw new Error(`Auto save file ${abbreviate(auto)} does not exist`);
    if (!e8.hasNewerAutoSave(file)) e8.userError(`Auto-save file ${abbreviate(auto)} not current`);
    for (;;) {
      const answer = e8.readAnswer(`Recover auto save file ${auto}? `, ["yes", "no", "diff"]);
      if (answer === "diff") {
        e8.message("E8 cannot show the differences yet");
        continue;
      }
      if (answer !== "yes") e8.userError("Recover-file canceled");
      e8.call("switch-to-buffer", e8.findFileNoselect(file));
      e8.recoverFromAutoSave();
      return;
    }
  },
});

e8.defineCommand({
  name: "auto-save-mode",
  doc: "Toggle auto-saving of the current buffer to #name# beside its file.\n\nWith a positive prefix argument, turn it on; with zero or a negative one, off.",
  run: () => {
    const arg = e8.prefixArg();
    const on = arg === null ? !e8.autoSaving() : e8.prefixNumericValue(arg) > 0;
    if (on && e8.bufferFileName() === undefined) throw new Error("Buffer does not seem to be associated with any file");
    e8.setAutoSave(on);
    e8.message(`Auto-save ${on ? "on" : "off"} (in this buffer)`);
  },
});

e8.defineCommand({
  name: "do-auto-save",
  doc: "Auto-save every buffer that has changed since it was last saved or auto-saved.",
  run: () => {
    e8.doAutoSave();
  },
});

/** The buffers save-some-buffers asks about: modified ones visiting files. */
function buffersNeedingSave(): string[] {
  return e8
    .bufferList()
    .filter((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName() !== undefined && e8.bufferModified()));
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
    if (interactive) e8.message("(No files need saving)");
    return;
  }
  const save = (buffer: string) => e8.withCurrentBuffer(buffer, () => basicSaveBuffer());
  if (all) {
    buffers.forEach(save);
    return;
  }
  for (let k = 0; k < buffers.length; k++) {
    const buffer = buffers[k];
    const file = e8.withCurrentBuffer(buffer, () => e8.bufferFileName() ?? "");
    const what = buffer === nondirectory(file) || buffer.startsWith(`${nondirectory(file)}<`) ? `file ${file}` : `file ${file} (buffer ${buffer})`;
    const c = e8.readCharChoice(`Save ${what}? (y, n, !, ., q, C-r, C-f, d or C-h) `, "yn!.q ");
    if (c === "y" || c === " ") save(buffer);
    else if (c === "!") return buffers.slice(k).forEach(save);
    else if (c === ".") return save(buffer);
    else if (c !== "n") return;
  }
}

e8.defineCommand({
  name: "save-some-buffers",
  doc:
    "Save some modified file buffers, asking about each: y saves it, n skips it, ! saves all the rest, . saves it and stops, and q stops.\n\n" +
    "With a prefix argument, save them all without asking.",
  run: () => saveSomeBuffers(e8.prefixArg() !== null, e8.calledInteractively()),
});

e8.defineCommand({
  name: "save-buffers-kill-terminal",
  doc:
    "Offer to save each modified file buffer, then exit.\n\n" +
    "If any are left unsaved, you are asked whether to exit anyway. With a prefix argument, save them all without asking.",
  run: () => {
    saveSomeBuffers(e8.prefixArg() !== null, false);
    if (buffersNeedingSave().length > 0 && !e8.yesOrNoP("Modified buffers exist; exit anyway? ")) return;
    // Then, as save-buffers-kill-emacs does, about processes still running.
    const running = e8.processList().filter((p) => e8.processStatus(p) === "run" && e8.processQueryOnExitFlag(p));
    if (running.length > 0) {
      if (!e8.yesOrNoP("Active processes exist; kill them and exit anyway? ")) return;
      for (const p of running) e8.deleteProcess(p);
    }
    // Then whatever else packages ask about, as Org's clock does; one saying no keeps E8 running.
    if (!e8.runHookWithArgsUntilFailure("kill-emacs-query-functions")) return;
    e8.killEmacs();
  },
});

e8.defineHook("kill-emacs-query-functions", "Functions called before E8 exits from save-buffers-kill-terminal; if one returns false, it does not exit.");

// Reverting buffers when their files change, after autorevert.el, by
// looking every auto-revert-interval seconds.

e8.defineVariable({
  name: "auto-revert-interval",
  doc: "How many seconds between checks for files that changed, in buffers where auto-revert-mode or global-auto-revert-mode is on.",
  value: 5,
});

e8.defineVariable({
  name: "auto-revert-verbose",
  doc: "Whether reverting a buffer because its file changed says so.",
  value: true,
});

let autoRevertTimer: number | undefined;

/** Reverts each buffer that auto-reverts, is unmodified, and whose file changed. */
function autoRevertBuffers(): void {
  const global = e8.variable("global-auto-revert-mode") === true;
  for (const buffer of e8.bufferList()) {
    e8.withCurrentBuffer(buffer, () => {
      const file = e8.bufferFileName();
      if (file === undefined || (!global && e8.variable("auto-revert-mode") !== true)) return;
      if (e8.bufferModified() || !e8.visitedFileChanged() || !e8.fileExists(file)) return;
      revertNow();
      if (e8.variable("auto-revert-verbose") === true) e8.message(`Reverting buffer ‘${buffer}’`);
    });
  }
}

/** Starts checking files if any buffer auto-reverts, and stops when none does. */
function updateAutoRevertTimer(): void {
  const wanted =
    e8.variable("global-auto-revert-mode") === true ||
    e8.bufferList().some((b) => e8.withCurrentBuffer(b, () => e8.variable("auto-revert-mode") === true));
  if (wanted && autoRevertTimer === undefined) {
    const interval = Number(e8.variable("auto-revert-interval")) || 5;
    autoRevertTimer = e8.runWithTimer(interval, interval, autoRevertBuffers);
  } else if (!wanted && autoRevertTimer !== undefined) {
    e8.cancelTimer(autoRevertTimer);
    autoRevertTimer = undefined;
  }
}

e8.defineMinorMode({
  name: "auto-revert-mode",
  lighter: " ARev",
  doc: "Revert the buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

e8.defineMinorMode({
  name: "global-auto-revert-mode",
  global: true,
  doc: "Revert every file buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

// Managing files, after the commands of files.el and fileio.c.

/** Whether to go ahead where `file` exists: asked when typed, refused from code, as `ok-if-already-exists` 0 does. */
function confirmOverwrite(file: string, verb: string): void {
  if (!e8.fileExists(file)) return;
  const exists = `File already exists: ${e8.expandFileName(file)}`;
  if (!e8.calledInteractively()) throw new Error(exists);
  if (!e8.yesOrNoP(`File ${e8.abbreviateFileName(e8.expandFileName(file))} already exists; ${verb} to it anyway? `)) throw new Error(exists);
}

/** Where a copy or rename of `from` to `to` lands: inside `to` if it ends in a slash. */
const targetName = (from: string, to: string): string =>
  to.endsWith("/") ? to + e8.fileNameNondirectory(e8.directoryFileName(from)) : to;

const trashing = (): boolean => {
  const on = e8.variable("delete-by-moving-to-trash");
  return on !== null && on !== false && e8.prefixArg() === null;
};

e8.defineCommand({
  name: "copy-file",
  doc:
    "Copy a file. A name ending in a slash copies it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error. " +
    "With a prefix argument, the copy keeps the file's modification time.",
  params: [
    { name: "file", kind: "file", prompt: "Copy file: " },
    { name: "newname", kind: "file", prompt: (file) => `Copy ${e8.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    const keepTime = e8.prefixArg() !== null;
    confirmOverwrite(targetName(file, newname), "copy");
    e8.copyFile(file, newname, { okIfExists: true, keepTime });
  },
});

e8.defineCommand({
  name: "rename-file",
  doc:
    "Rename a file or directory. A name ending in a slash moves it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error.",
  params: [
    { name: "file", kind: "file", prompt: "Rename file: " },
    { name: "newname", kind: "file", prompt: (file) => `Rename ${e8.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    confirmOverwrite(targetName(file, newname), "rename");
    e8.renameFile(file, newname, { okIfExists: true });
  },
});

e8.defineCommand({
  name: "delete-file",
  doc:
    "Delete a file. With delete-by-moving-to-trash, on in E8, it goes to the trash, from where it can be put back.\n\n" +
    "With a prefix argument, delete it for good instead.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => trashing() ? "Move file to trash: " : "Delete file: ",
  }],
  run: (file: string) => e8.deleteFile(file, { trash: trashing() }),
});

e8.defineCommand({
  name: "make-directory",
  doc: "Make a directory, and any directories above it that are missing.",
  params: [{ name: "dir", kind: "file", prompt: "Make directory: " }],
  run: (dir: string) => e8.makeDirectory(dir, { parents: true }),
});

e8.defineCommand({
  name: "delete-directory",
  doc:
    "Delete a directory, asking first if it has files in it. With delete-by-moving-to-trash, on in E8, " +
    "it goes to the trash.\n\nWith a prefix argument, delete it for good instead.",
  params: [{
    name: "dir",
    kind: "file",
    prompt: () => trashing() ? "Move directory to trash: " : "Delete directory: ",
  }],
  run: (dir: string) => {
    const trash = trashing();
    const empty = e8.directoryFiles(dir).length <= 2;
    if (empty) return e8.deleteDirectory(dir, { trash });
    if (!e8.calledInteractively()) return e8.deleteDirectory(dir, { trash });
    const verb = trash ? "trash" : "delete";
    // As in Emacs, no still tries, and fails as the directory is not empty.
    const yes = e8.yOrNP(`Directory ${e8.abbreviateFileName(e8.directoryFileName(e8.expandFileName(dir)))} is not empty, really ${verb}? `);
    e8.deleteDirectory(dir, { recursive: yes, trash });
  },
});

e8.defineCommand({
  name: "copy-directory",
  doc: "Copy a directory and what it holds: into the new name if that is a directory already, else as it.",
  params: [
    { name: "directory", kind: "file", prompt: "Copy directory: " },
    { name: "newname", kind: "file", prompt: (dir) => `Copy directory ${e8.abbreviateFileName(dir)} to: ` },
  ],
  run: (directory: string, newname: string) => {
    e8.copyDirectory(directory, newname, { keepTime: e8.prefixArg() !== null });
  },
});

e8.defineCommand({
  name: "read-only-mode",
  doc:
    "Make the buffer read-only, or editable again.\n\n" +
    "A buffer visiting a file that cannot be written starts read-only. With a prefix argument, " +
    "a positive number makes it read-only and zero or less editable.",
  run: () => {
    const arg = e8.prefixArg();
    const on = arg === null ? !e8.bufferReadOnly() : e8.prefixNumericValue(arg) > 0;
    e8.setReadOnly(on);
    if (e8.calledInteractively()) e8.message(`Read-Only mode ${on ? "enabled" : "disabled"} in current buffer`);
  },
});

e8.defineCommand({
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
      const file = e8.bufferFileName();
      return file === undefined ? e8.abbreviateFileName(e8.fileNameAsDirectory(e8.expandFileName("."))) : e8.abbreviateFileName(file);
    },
  }],
  run: (file: string) => {
    const old = e8.bufferName();
    const replace = () => {
      // The old buffer gives up its name and file first, so the same file
      // is read afresh, as files.el renames it " **lose**".
      const oldFile = e8.bufferFileName();
      e8.setBufferModified(false);
      e8.setVisitedFileName(null);
      const lose = e8.generateNewBufferName(" **lose**");
      e8.call("rename-buffer", lose);
      try {
        e8.call("find-file", file);
      } finally {
        if (e8.bufferName() === lose) {
          // Visiting failed: the old buffer is as it was.
          e8.call("rename-buffer", old);
          if (oldFile !== undefined) e8.setVisitedFileName(oldFile, { alongWithFile: true });
        }
      }
      if (e8.bufferName() !== lose) e8.call("kill-buffer", lose);
    };
    if (e8.bufferModified() && e8.bufferFileName() !== undefined) {
      if (!e8.calledInteractively()) throw new Error(`Buffer ${old} modified`);
      if (!e8.yesOrNoP(`Buffer \u2018${old}\u2019 modified; kill anyway? `)) throw new Error("Aborted");
    }
    replace();
  },
});

e8.defineCommand({
  name: "rename-visited-file",
  doc:
    "Rename the file the buffer visits, and visit it under its new name.\n\n" +
    "In a buffer visiting no file, set the file it visits instead, as set-visited-file-name does.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => e8.bufferFileName() === undefined ? "Set visited file name: " : "Rename visited file to: ",
  }],
  run: (input: string) => {
    const old = e8.bufferFileName();
    const file = e8.expandFileName(targetName(old ?? e8.bufferName(), input));
    const along = old !== undefined && e8.fileExists(old);
    if (along) e8.renameFile(old, file);
    e8.setVisitedFileName(file, { alongWithFile: along });
  },
});

e8.bindKey("C-x C-q", "read-only-mode");
e8.bindKey("C-x C-v", "find-alternate-file");
e8.bindKey("C-x C-s", "save-buffer");
e8.bindKey("C-x C-w", "write-file");
e8.bindKey("C-x s", "save-some-buffers");
e8.bindKey("C-x C-c", "save-buffers-kill-terminal");
e8.bindKey("C-x x g", "revert-buffer-quick");
e8.bindKey("M-~", "not-modified");

// Inserting and writing parts of files, after files.el's insert-file and
// append-to-file and fileio.c's write-region command.

const insertFile = e8.defineCommand({
  name: "insert-file",
  doc: "Insert a file's text after point, leaving point before it and the mark after it.",
  params: [{ name: "file", kind: "file", prompt: "Insert file: " }],
  run: (file) => {
    // The name as it was given, as insert-file-1 signals it.
    if (e8.fileDirectoryP(file)) {
      e8.signal("file-error", `Opening input file: Is a directory, ${file}`, ["Opening input file", "Is a directory", file]);
    }
    const [, inserted] = e8.insertFileContents(file);
    e8.pushMark(e8.point() + inserted);
    e8.message("Mark set");
  },
});
e8.bindKey("C-x i", insertFile);

e8.defineCommand({
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
    const name = e8.expandFileName(file);
    // As write-region's interactive MUSTBENEW, as barf_or_query_if_file_exists asks.
    if (e8.calledInteractively() && e8.fileExistsP(name)) {
      if (!(await e8.yesOrNoP(`File ${name} already exists; overwrite anyway? `))) {
        e8.signal("file-already-exists", `File already exists: ${name}`, ["File already exists", name]);
      }
    }
    e8.writeRegion(start, end, name);
  },
});

e8.defineCommand({
  name: "append-to-file",
  doc: "Add the region to the end of a file.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "file", kind: "file", prompt: "Append to file: " },
  ],
  run: (start, end, file) => e8.writeRegion(start, end, file, { append: true }),
});

// Killing several buffers, after files.el: kill-some-buffers asks about
// each one, kill-matching-buffers about those whose names match.

/** Kills a buffer if the answer is yes, as kill-buffer-ask. */
async function killBufferAsk(buffer: string): Promise<void> {
  const modified = e8.withCurrentBuffer(buffer, () => e8.bufferModified());
  if (await e8.yesOrNoP(`Buffer ${buffer} ${modified ? "HAS BEEN EDITED" : "is unmodified"}.  Kill? `)) e8.call("kill-buffer", buffer);
}

e8.defineCommand({
  name: "kill-some-buffers",
  doc: "Ask about each buffer whether to kill it, saying whether it has been edited; buffers whose names start with a space are left.",
  run: async () => {
    for (const buffer of e8.bufferList()) {
      if (buffer === "" || buffer.startsWith(" ") || !e8.getBuffer(buffer)) continue;
      await killBufferAsk(buffer);
    }
  },
});

for (const [name, doc, ask] of [
  ["kill-matching-buffers", "Kill the buffers whose names match a regexp, asking about each; with a prefix argument, those whose names start with a space too.", true],
  ["kill-matching-buffers-no-ask", "Kill the buffers whose names match a regexp, without asking; with a prefix argument, those whose names start with a space too.", false],
] as const) {
  e8.defineCommand({
    name,
    doc,
    params: [
      { name: "regexp", kind: "string", prompt: "Kill buffers matching this regular expression: " },
      { name: "internal", kind: "prefix" },
    ],
    run: async (regexp: string, internal: e8.PrefixArg) => {
      for (const buffer of e8.bufferList()) {
        if (buffer === "" || (internal === null && buffer.startsWith(" ")) || !e8.getBuffer(buffer)) continue;
        if (e8.stringMatch(regexp, buffer) === undefined) continue;
        if (ask) await killBufferAsk(buffer);
        else e8.call("kill-buffer", buffer);
      }
    },
  });
}

/**
 * A file's name relative to a directory, default-directory unless given,
 * going up with ".." where it must, as file-relative-name.
 */
export function fileRelativeName(file: string, directory?: string): string {
  const dir = e8.expandFileName(directory ?? String(e8.variable("default-directory") ?? "."));
  const parts = (path: string) => path.split("/").filter((p) => p !== "");
  const [from, to] = [parts(dir), parts(e8.expandFileName(file))];
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const rel = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
  return rel === "" ? "." : rel;
}

/**
 * The buffer visiting a file, by its name or, failing that, its true name,
 * so a link or another spelling of the same file finds it, as
 * find-buffer-visiting.
 */
export function findBufferVisiting(file: string): string | undefined {
  const name = e8.expandFileName(file);
  const visited = (b: string) => e8.withCurrentBuffer(b, () => e8.bufferFileName());
  const exact = e8.bufferList().find((b) => visited(b) === name);
  if (exact !== undefined) return exact;
  const truename = e8.fileTruename(name);
  return e8.bufferList().find((b) => {
    const f = visited(b);
    return f !== undefined && e8.fileTruename(f) === truename;
  });
}
