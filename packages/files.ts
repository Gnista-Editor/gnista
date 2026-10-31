import { selectSafeCodingSystem } from "mule";

// Choosing a major mode for a file, after Emacs's files.el.

ember.defineVariable({
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
  const text = ember.bufferText();
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const inside = /-\*-(.*?)-\*-/.exec(firstLine)?.[1]?.trim();
  if (!inside) {
    return undefined;
  }
  const mode = /(?:^|;)\s*mode:\s*([\w-]+)/i.exec(inside)?.[1] ?? (inside.includes(":") ? undefined : inside);
  return mode === undefined ? undefined : `${mode.toLowerCase()}-mode`;
}

function modeFromFileName(): string | undefined {
  const file = ember.bufferFileName();
  const alist = ember.variable("auto-mode-alist");
  if (file === undefined || !Array.isArray(alist)) {
    return undefined;
  }
  for (const entry of alist) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      if (ember.stringMatch(entry[0], file) !== undefined) {
        return entry[1];
      }
    }
  }
  return undefined;
}

ember.defineCommand({
  name: "normal-mode",
  doc:
    "Choose the current buffer's major mode, as when its file is visited.\n\n" +
    "A mode named on the first line, as in -*- text -*-, comes first; then auto-mode-alist, " +
    "matched against the file name; otherwise Fundamental mode.",
  run: () => {
    const mode = [modeFromFirstLine(), modeFromFileName()].find(
      (mode) => mode !== undefined && ember.commandExists(mode),
    );
    ember.call((mode ?? "fundamental-mode") as ember.CommandName);
  },
});

// Saving, reverting and recovering files, after files.el. What touches the
// disk is native, as Emacs's fileio.c is: writing with a backup, reading
// back, auto-saving. Emacs's questions wait for an answer; here each one
// calls on with it.

ember.defineVariable({
  name: "require-final-newline",
  doc:
    "Whether saving adds a newline to a file that does not end in one: true adds it, false leaves the file as it is, " +
    '"ask" asks first. Text and programming modes set it from mode-require-final-newline.',
  value: false,
  local: true,
});

ember.defineVariable({
  name: "mode-require-final-newline",
  doc: "The value text and programming modes give require-final-newline in their buffers.",
  value: true,
});

ember.defineVariable({
  name: "revert-without-query",
  doc: "Files revert-buffer reverts without asking, if unmodified: a list of Emacs regular expressions matched against the file name.",
  value: [],
});

ember.defineHook("before-revert-hook", "Run before revert-buffer replaces the text with the file's.");
ember.defineHook("after-revert-hook", "Run after revert-buffer has reread the file.");

/** The buffer's file, or an error saying it has none. */
function visitedFile(message = "Buffer does not seem to be associated with any file"): string {
  const file = ember.bufferFileName();
  if (file === undefined) throw new Error(message);
  return file;
}

/** A file name with the home directory as ~, as Emacs's abbreviate-file-name. */
function abbreviate(file: string): string {
  const home = ember.expandFileName("~");
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

function nondirectory(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/** Calls `then` in the buffer named `buffer`, current again after a question. */
function inBuffer(buffer: string, then: () => void): () => void {
  return () => {
    // Already current, as after most questions; then may rename it.
    if (ember.bufferName() === buffer) then();
    else if (ember.bufferList().includes(buffer)) ember.withCurrentBuffer(buffer, then);
  };
}

/**
 * Adds the newline require-final-newline asks for, then calls `then`, as
 * basic-save-buffer does before writing.
 */
function addFinalNewline(then: () => void): void {
  const size = ember.bufferSize();
  const require = ember.variable("require-final-newline");
  if (size === 0 || require === false || require === null || ember.bufferText().endsWith("\n")) {
    then();
    return;
  }
  const add = () => {
    const point = ember.point();
    ember.gotoChar(ember.pointMax());
    ember.insert("\n");
    ember.gotoChar(point);
  };
  if (require === true || require === "visit-save") {
    add();
    then();
    return;
  }
  const buffer = ember.bufferName();
  ember.yOrNP(`Buffer ${buffer} does not end in newline.  Add one? `, (yes) => {
    inBuffer(buffer, () => {
      if (yes) add();
      then();
    })();
  });
}

/** Writes the buffer, says so and runs the save hooks, as basic-save-buffer does once it may. */
function writeBuffer(file: string): void {
  ember.runHooks("before-save-hook");
  ember.writeVisitedFile();
  ember.message(`Wrote ${ember.bufferFileName() ?? file}`);
  ember.runHooks("after-save-hook");
}

/**
 * Saves the current buffer if it is modified, as Emacs's basic-save-buffer,
 * then calls `then`. A file changed on disk since it was visited or saved
 * is overwritten only if you say so.
 */
function basicSaveBuffer(then: () => void = () => {}): void {
  const file = ember.bufferFileName();
  if (!ember.bufferModified()) {
    if (ember.calledInteractively()) ember.message("(No changes need to be saved)");
    then();
    return;
  }
  if (file === undefined) {
    // Emacs reads a file to save in; write-file reads one too.
    ember.callInteractively("write-file");
    return;
  }
  const buffer = ember.bufferName();
  const save = inBuffer(buffer, () => addFinalNewline(() => selectSafeCodingSystem(() => {
    writeBuffer(file);
    then();
  })));
  if (ember.visitedFileChanged()) {
    ember.yesOrNoP(`${nondirectory(file)} has changed since visited or saved.  Save anyway? `, (yes) => {
      if (!yes) throw new Error("Save not confirmed");
      save();
    });
    return;
  }
  save();
}

ember.defineCommand({
  name: "save-buffer",
  doc:
    "Save the current buffer to its file, if it has changed.\n\n" +
    "The first save in a session keeps the file as it was in name~ (see make-backup-files). If the file changed on disk " +
    "since you visited or saved it, you are asked before it is overwritten. A buffer with no file asks for one, as write-file does.",
  run: () => basicSaveBuffer(),
});

ember.defineCommand({
  name: "write-file",
  doc:
    "Write the current buffer to a file and visit that file instead.\n\n" +
    "A directory writes a file of the buffer's name in it. An existing file is overwritten only if you say so.",
  params: [{ name: "file", kind: "file", prompt: "Write file: " }],
  run: (input: string) => {
    let file = ember.expandFileName(input);
    if (input.endsWith("/")) file = `${file.replace(/\/$/, "")}/${ember.bufferName()}`;
    const write = () => {
      ember.setVisitedFileName(file);
      ember.setBufferModified(true);
      basicSaveBuffer();
    };
    if (ember.calledInteractively() && ember.fileExists(file) && file !== ember.bufferFileName()) {
      const buffer = ember.bufferName();
      ember.yOrNP(`File ‘${file}’ exists; overwrite? `, (yes) => {
        if (!yes) throw new Error("Canceled");
        inBuffer(buffer, write)();
      });
      return;
    }
    write();
  },
});

ember.defineCommand({
  name: "not-modified",
  doc: "Mark the current buffer as unmodified, not needing to be saved.\n\nWith a prefix argument, mark it as modified, so save-buffer will save it.",
  run: () => {
    const modified = ember.prefixArg() !== null;
    ember.message(modified ? "Modification-flag set" : "Modification-flag cleared");
    ember.setBufferModified(modified);
  },
});

/** Rereads the file into the buffer and chooses its mode again, as revert-buffer--default does once it may. */
function revertNow(): void {
  ember.runHooks("before-revert-hook");
  ember.revertToVisitedFile();
  ember.call("normal-mode");
  ember.runHooks("after-revert-hook");
}

/**
 * Reverts the buffer, asking first unless `noconfirm`, or the buffer is
 * unmodified and its file matches revert-without-query. Calls `then` once
 * reverted.
 */
ember.defineVariable({
  name: "revert-buffer-function",
  doc: "The command revert-buffer runs instead of rereading the file, in buffers that set it, such as Dired's. Nil for the usual.",
  value: null,
});

function revertBuffer(noconfirm: boolean, then: () => void = () => {}): void {
  // A buffer such as Dired's reverts itself, as its revert-buffer-function says.
  const own = ember.variable("revert-buffer-function");
  if (typeof own === "string" && ember.commandExists(own)) {
    ember.call(own as ember.CommandName);
    then();
    return;
  }
  const file = visitedFile();
  if (!ember.fileExists(file)) throw new Error(`File ${file} no longer exists!`);
  const modified = ember.bufferModified();
  const patterns = ember.variable("revert-without-query");
  const unasked = !modified && Array.isArray(patterns) && patterns.some((p) => typeof p === "string" && ember.stringMatch(p, file) !== undefined);
  if (noconfirm || unasked) {
    revertNow();
    then();
    return;
  }
  const question = modified ? `Discard edits and reread from ${file}? ` : `Revert buffer from file ${file}? `;
  const buffer = ember.bufferName();
  ember.yesOrNoP(question, (yes) => {
    if (yes) inBuffer(buffer, () => {
      revertNow();
      then();
    })();
  });
}

ember.defineCommand({
  name: "revert-buffer",
  doc:
    "Replace the buffer's text with its file's, after asking.\n\n" +
    "Point stays where the text is unchanged. The major mode is chosen again, as when visiting the file. The revert can be undone.",
  run: () => revertBuffer(false),
});

ember.defineCommand({
  name: "revert-buffer-quick",
  doc: "Revert the buffer from its file, asking only if it has unsaved changes.",
  run: () => {
    if (ember.bufferFileName() !== undefined && !ember.bufferModified()) {
      revertBuffer(true);
      ember.message("Reverted buffer");
    } else {
      revertBuffer(false);
    }
  },
});

ember.defineCommand({
  name: "recover-this-file",
  doc: "Replace the buffer's text with its auto-save file's, after asking: what was typed since the last save, before a crash.",
  run: () => ember.call("recover-file", visitedFile("This buffer is not visiting a file")),
});

ember.defineCommand({
  name: "recover-file",
  doc:
    "Visit a file, taking its text from its auto-save file, #name#, after asking.\n\n" +
    "The buffer is left modified; save it to keep what was recovered.",
  params: [{ name: "file", kind: "file", prompt: "Recover file: " }],
  run: (input: string) => {
    const file = ember.expandFileName(input);
    if (/^#.*#$/.test(nondirectory(file))) throw new Error(`${abbreviate(file)} is an auto-save file`);
    const auto = ember.autoSaveFileName(file);
    if (ember.fileExists(file) && !ember.fileExists(auto)) throw new Error(`Auto save file ${abbreviate(auto)} does not exist`);
    if (!ember.hasNewerAutoSave(file)) throw new Error(`Auto-save file ${abbreviate(auto)} not current`);
    const ask = () =>
      ember.readAnswer(`Recover auto save file ${auto}? `, ["yes", "no", "diff"], (answer) => {
        if (answer === "diff") {
          ember.message("Ember cannot show the differences yet");
          ask();
        } else if (answer === "yes") {
          const buffer = ember.findFileNoselect(file);
          ember.call("switch-to-buffer", buffer);
          ember.recoverFromAutoSave();
        } else {
          throw new Error("Recover-file canceled");
        }
      });
    ask();
  },
});

ember.defineCommand({
  name: "auto-save-mode",
  doc: "Toggle auto-saving of the current buffer to #name# beside its file.\n\nWith a positive prefix argument, turn it on; with zero or a negative one, off.",
  run: () => {
    const arg = ember.prefixArg();
    const on = arg === null ? !ember.autoSaving() : ember.prefixNumericValue(arg) > 0;
    if (on && ember.bufferFileName() === undefined) throw new Error("Buffer does not seem to be associated with any file");
    ember.setAutoSave(on);
    ember.message(`Auto-save ${on ? "on" : "off"} (in this buffer)`);
  },
});

ember.defineCommand({
  name: "do-auto-save",
  doc: "Auto-save every buffer that has changed since it was last saved or auto-saved.",
  run: () => {
    ember.doAutoSave();
  },
});

/** The buffers save-some-buffers asks about: modified ones visiting files. */
function buffersNeedingSave(): string[] {
  return ember
    .bufferList()
    .filter((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName() !== undefined && ember.bufferModified()));
}

/**
 * Asks about saving each modified file buffer in turn, as Emacs's
 * save-some-buffers with map-y-or-n-p: y saves it, n skips it, ! saves the
 * rest, . saves it and stops, q stops. With `all`, saves them all without
 * asking. Calls `then` once done, unless the questions were quit.
 */
function saveSomeBuffers(all: boolean, interactive: boolean, then: () => void = () => {}): void {
  const buffers = buffersNeedingSave();
  if (buffers.length === 0) {
    if (interactive) ember.message("(No files need saving)");
    then();
    return;
  }
  const saveAll = (rest: string[], done: () => void) => {
    const [first, ...later] = rest;
    if (first === undefined) return done();
    ember.withCurrentBuffer(first, () => basicSaveBuffer(() => saveAll(later, done)));
  };
  if (all) {
    saveAll(buffers, then);
    return;
  }
  const ask = (rest: string[]) => {
    const [buffer, ...later] = rest;
    if (buffer === undefined) return then();
    const file = ember.withCurrentBuffer(buffer, () => ember.bufferFileName() ?? "");
    const what = buffer === nondirectory(file) || buffer.startsWith(`${nondirectory(file)}<`) ? `file ${file}` : `file ${file} (buffer ${buffer})`;
    ember.readCharChoice(`Save ${what}? (y, n, !, ., q, C-r, C-f, d or C-h) `, "yn!.q ", (c) => {
      if (c === "y" || c === " ") saveAll([buffer], () => ask(later));
      else if (c === "n") ask(later);
      else if (c === "!") saveAll(rest, then);
      else if (c === ".") saveAll([buffer], then);
      else then();
    });
  };
  ask(buffers);
}

ember.defineCommand({
  name: "save-some-buffers",
  doc:
    "Save some modified file buffers, asking about each: y saves it, n skips it, ! saves all the rest, . saves it and stops, and q stops.\n\n" +
    "With a prefix argument, save them all without asking.",
  run: () => saveSomeBuffers(ember.prefixArg() !== null, ember.calledInteractively()),
});

ember.defineCommand({
  name: "save-buffers-kill-terminal",
  doc:
    "Offer to save each modified file buffer, then exit.\n\n" +
    "If any are left unsaved, you are asked whether to exit anyway. With a prefix argument, save them all without asking.",
  run: () => {
    // Then, as save-buffers-kill-emacs does, about processes still running.
    const killEmacs = () => {
      const running = ember.processList().filter((p) => ember.processStatus(p) === "run" && ember.processQueryOnExitFlag(p));
      if (running.length === 0) return ember.killEmacs();
      ember.yesOrNoP("Active processes exist; kill them and exit anyway? ", (yes) => {
        if (!yes) return;
        for (const p of running) ember.deleteProcess(p);
        ember.killEmacs();
      });
    };
    saveSomeBuffers(ember.prefixArg() !== null, false, () => {
      if (buffersNeedingSave().length === 0) {
        killEmacs();
        return;
      }
      ember.yesOrNoP("Modified buffers exist; exit anyway? ", (yes) => {
        if (yes) killEmacs();
      });
    });
  },
});

// Reverting buffers when their files change, after autorevert.el, by
// looking every auto-revert-interval seconds.

ember.defineVariable({
  name: "auto-revert-interval",
  doc: "How many seconds between checks for files that changed, in buffers where auto-revert-mode or global-auto-revert-mode is on.",
  value: 5,
});

ember.defineVariable({
  name: "auto-revert-verbose",
  doc: "Whether reverting a buffer because its file changed says so.",
  value: true,
});

let autoRevertTimer: number | undefined;

/** Reverts each buffer that auto-reverts, is unmodified, and whose file changed. */
function autoRevertBuffers(): void {
  const global = ember.variable("global-auto-revert-mode") === true;
  for (const buffer of ember.bufferList()) {
    ember.withCurrentBuffer(buffer, () => {
      const file = ember.bufferFileName();
      if (file === undefined || (!global && ember.variable("auto-revert-mode") !== true)) return;
      if (ember.bufferModified() || !ember.visitedFileChanged() || !ember.fileExists(file)) return;
      revertNow();
      if (ember.variable("auto-revert-verbose") === true) ember.message(`Reverting buffer ‘${buffer}’`);
    });
  }
}

/** Starts checking files if any buffer auto-reverts, and stops when none does. */
function updateAutoRevertTimer(): void {
  const wanted =
    ember.variable("global-auto-revert-mode") === true ||
    ember.bufferList().some((b) => ember.withCurrentBuffer(b, () => ember.variable("auto-revert-mode") === true));
  if (wanted && autoRevertTimer === undefined) {
    const interval = Number(ember.variable("auto-revert-interval")) || 5;
    autoRevertTimer = ember.runWithTimer(interval, interval, autoRevertBuffers);
  } else if (!wanted && autoRevertTimer !== undefined) {
    ember.cancelTimer(autoRevertTimer);
    autoRevertTimer = undefined;
  }
}

ember.defineMinorMode({
  name: "auto-revert-mode",
  lighter: " ARev",
  doc: "Revert the buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

ember.defineMinorMode({
  name: "global-auto-revert-mode",
  global: true,
  doc: "Revert every file buffer when its file changes on disk, if the buffer has no unsaved changes.",
  onChange: updateAutoRevertTimer,
});

// Managing files, after the commands of files.el and fileio.c.

/** Whether to go ahead where `file` exists: asked when typed, refused from code, as `ok-if-already-exists` 0 does. */
function confirmOverwrite(file: string, verb: string, then: () => void): void {
  if (!ember.fileExists(file)) return then();
  if (!ember.calledInteractively()) throw new Error(`File already exists: ${ember.expandFileName(file)}`);
  ember.yesOrNoP(`File ${ember.abbreviateFileName(ember.expandFileName(file))} already exists; ${verb} to it anyway? `, (yes) => {
    if (!yes) throw new Error(`File already exists: ${ember.expandFileName(file)}`);
    then();
  });
}

/** Where a copy or rename of `from` to `to` lands: inside `to` if it ends in a slash. */
const targetName = (from: string, to: string): string =>
  to.endsWith("/") ? to + ember.fileNameNondirectory(ember.directoryFileName(from)) : to;

const trashing = (): boolean => {
  const on = ember.variable("delete-by-moving-to-trash");
  return on !== null && on !== false && ember.prefixArg() === null;
};

ember.defineCommand({
  name: "copy-file",
  doc:
    "Copy a file. A name ending in a slash copies it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error. " +
    "With a prefix argument, the copy keeps the file's modification time.",
  params: [
    { name: "file", kind: "file", prompt: "Copy file: " },
    { name: "newname", kind: "file", prompt: (file) => `Copy ${ember.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    const keepTime = ember.prefixArg() !== null;
    confirmOverwrite(targetName(file, newname), "copy", () => {
      ember.copyFile(file, newname, { okIfExists: true, keepTime });
    });
  },
});

ember.defineCommand({
  name: "rename-file",
  doc:
    "Rename a file or directory. A name ending in a slash moves it into that directory.\n\n" +
    "Typed, it asks before replacing a file; from code, a file already there is an error.",
  params: [
    { name: "file", kind: "file", prompt: "Rename file: " },
    { name: "newname", kind: "file", prompt: (file) => `Rename ${ember.abbreviateFileName(file)} to file: ` },
  ],
  run: (file: string, newname: string) => {
    confirmOverwrite(targetName(file, newname), "rename", () => {
      ember.renameFile(file, newname, { okIfExists: true });
    });
  },
});

ember.defineCommand({
  name: "delete-file",
  doc:
    "Delete a file. With delete-by-moving-to-trash, on in Ember, it goes to the trash, from where it can be put back.\n\n" +
    "With a prefix argument, delete it for good instead.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => trashing() ? "Move file to trash: " : "Delete file: ",
  }],
  run: (file: string) => ember.deleteFile(file, { trash: trashing() }),
});

ember.defineCommand({
  name: "make-directory",
  doc: "Make a directory, and any directories above it that are missing.",
  params: [{ name: "dir", kind: "file", prompt: "Make directory: " }],
  run: (dir: string) => ember.makeDirectory(dir, { parents: true }),
});

ember.defineCommand({
  name: "delete-directory",
  doc:
    "Delete a directory, asking first if it has files in it. With delete-by-moving-to-trash, on in Ember, " +
    "it goes to the trash.\n\nWith a prefix argument, delete it for good instead.",
  params: [{
    name: "dir",
    kind: "file",
    prompt: () => trashing() ? "Move directory to trash: " : "Delete directory: ",
  }],
  run: (dir: string) => {
    const trash = trashing();
    const empty = ember.directoryFiles(dir).length <= 2;
    if (empty) return ember.deleteDirectory(dir, { trash });
    if (!ember.calledInteractively()) return ember.deleteDirectory(dir, { trash });
    const verb = trash ? "trash" : "delete";
    // As in Emacs, no still tries, and fails as the directory is not empty.
    ember.yOrNP(`Directory ${ember.abbreviateFileName(ember.directoryFileName(ember.expandFileName(dir)))} is not empty, really ${verb}? `, (yes) => {
      ember.deleteDirectory(dir, { recursive: yes, trash });
    });
  },
});

ember.defineCommand({
  name: "copy-directory",
  doc: "Copy a directory and what it holds: into the new name if that is a directory already, else as it.",
  params: [
    { name: "directory", kind: "file", prompt: "Copy directory: " },
    { name: "newname", kind: "file", prompt: (dir) => `Copy directory ${ember.abbreviateFileName(dir)} to: ` },
  ],
  run: (directory: string, newname: string) => {
    ember.copyDirectory(directory, newname, { keepTime: ember.prefixArg() !== null });
  },
});

ember.defineCommand({
  name: "read-only-mode",
  doc:
    "Make the buffer read-only, or editable again.\n\n" +
    "A buffer visiting a file that cannot be written starts read-only. With a prefix argument, " +
    "a positive number makes it read-only and zero or less editable.",
  run: () => {
    const arg = ember.prefixArg();
    const on = arg === null ? !ember.bufferReadOnly() : ember.prefixNumericValue(arg) > 0;
    ember.setReadOnly(on);
    if (ember.calledInteractively()) ember.message(`Read-Only mode ${on ? "enabled" : "disabled"} in current buffer`);
  },
});

ember.defineCommand({
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
      const file = ember.bufferFileName();
      return file === undefined ? ember.abbreviateFileName(ember.fileNameAsDirectory(ember.expandFileName("."))) : ember.abbreviateFileName(file);
    },
  }],
  run: (file: string) => {
    const old = ember.bufferName();
    const replace = () => {
      // The old buffer gives up its name and file first, so the same file
      // is read afresh, as files.el renames it " **lose**".
      const oldFile = ember.bufferFileName();
      ember.setBufferModified(false);
      ember.setVisitedFileName(null);
      const lose = ember.generateNewBufferName(" **lose**");
      ember.call("rename-buffer", lose);
      try {
        ember.call("find-file", file);
      } finally {
        if (ember.bufferName() === lose) {
          // Visiting failed: the old buffer is as it was.
          ember.call("rename-buffer", old);
          if (oldFile !== undefined) ember.setVisitedFileName(oldFile, { alongWithFile: true });
        }
      }
      if (ember.bufferName() !== lose) ember.call("kill-buffer", lose);
    };
    if (ember.bufferModified() && ember.bufferFileName() !== undefined) {
      if (!ember.calledInteractively()) throw new Error(`Buffer ${old} modified`);
      ember.yesOrNoP(`Buffer \u2018${old}\u2019 modified; kill anyway? `, (yes) => {
        if (!yes) throw new Error("Aborted");
        replace();
      });
      return;
    }
    replace();
  },
});

ember.defineCommand({
  name: "rename-visited-file",
  doc:
    "Rename the file the buffer visits, and visit it under its new name.\n\n" +
    "In a buffer visiting no file, set the file it visits instead, as set-visited-file-name does.",
  params: [{
    name: "file",
    kind: "file",
    prompt: () => ember.bufferFileName() === undefined ? "Set visited file name: " : "Rename visited file to: ",
  }],
  run: (input: string) => {
    const old = ember.bufferFileName();
    const file = ember.expandFileName(targetName(old ?? ember.bufferName(), input));
    const along = old !== undefined && ember.fileExists(old);
    if (along) ember.renameFile(old, file);
    ember.setVisitedFileName(file, { alongWithFile: along });
  },
});

ember.bindKey("C-x C-q", "read-only-mode");
ember.bindKey("C-x C-v", "find-alternate-file");
ember.bindKey("C-x C-s", "save-buffer");
ember.bindKey("C-x C-w", "write-file");
ember.bindKey("C-x s", "save-some-buffers");
ember.bindKey("C-x C-c", "save-buffers-kill-terminal");
ember.bindKey("C-x x g", "revert-buffer-quick");
ember.bindKey("M-~", "not-modified");

// Inserting and writing parts of files, after files.el's insert-file and
// append-to-file and fileio.c's write-region command.

const insertFile = ember.defineCommand({
  name: "insert-file",
  doc: "Insert a file's text after point, leaving point before it and the mark after it.",
  params: [{ name: "file", kind: "file", prompt: "Insert file: " }],
  run: (file) => {
    // The name as it was given, as insert-file-1 signals it.
    if (ember.fileDirectoryP(file)) {
      ember.signal("file-error", `Opening input file: Is a directory, ${file}`, ["Opening input file", "Is a directory", file]);
    }
    const [, inserted] = ember.insertFileContents(file);
    ember.pushMark(ember.point() + inserted);
    ember.message("Mark set");
  },
});
ember.bindKey("C-x i", insertFile);

ember.defineCommand({
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
    const name = ember.expandFileName(file);
    // As write-region's interactive MUSTBENEW, as barf_or_query_if_file_exists asks.
    if (ember.calledInteractively() && ember.fileExistsP(name)) {
      if (!(await ember.yesOrNoP(`File ${name} already exists; overwrite anyway? `))) {
        ember.signal("file-already-exists", `File already exists: ${name}`, ["File already exists", name]);
      }
    }
    ember.writeRegion(start, end, name);
  },
});

ember.defineCommand({
  name: "append-to-file",
  doc: "Add the region to the end of a file.",
  params: [
    { name: "start", kind: "region-beginning" },
    { name: "end", kind: "region-end" },
    { name: "file", kind: "file", prompt: "Append to file: " },
  ],
  run: (start, end, file) => ember.writeRegion(start, end, file, { append: true }),
});
