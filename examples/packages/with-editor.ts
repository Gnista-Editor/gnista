// Using E8 as $EDITOR, after with-editor.el (https://github.com/magit/with-editor):
// a program E8 runs, as git commit or git rebase -i, gets an editor
// that tells E8 which file to edit and waits; E8 visits it in
// with-editor-mode, where C-c C-c finishes and C-c C-k cancels, and the
// program goes on. This is with-editor's "sleeping editor", which prints
// the request on the program's output and sleeps until E8 signals it.
//
// Copyright (C) 2014-2025 The Magit Project Contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { PerBuffer } from "subr";

/** The editor a program is given: it prints which file to edit and sleeps until signalled, as with-editor-sleeping-editor. */
export const SLEEPING_EDITOR =
  "sh -c '" +
  'printf "\\nWITH-EDITOR: $$ OPEN $0\\037$1\\037 IN $(pwd)\\n"; ' +
  "sleep 604800 & sleep=$!; " +
  'trap "kill $sleep; exit 0" USR1; ' +
  'trap "kill $sleep; exit 1" USR2; ' +
  "wait $sleep'";

e8.defineHook("with-editor-filter-visit-hook", "Functions called in the buffer of a file a program asked to have edited.");
e8.defineHook("with-editor-post-finish-hook", "Functions called after finishing an edit, in the buffer it came back to.");
e8.defineHook("with-editor-post-cancel-hook", "Functions called after cancelling an edit.");
e8.defineVariable({
  name: "with-editor-file-modes",
  doc: "Major modes for the files programs ask to have edited, as [regexp of the file name, mode] pairs: git's commit messages and rebase lists, by packages that know them.",
  value: [],
});

/** The editor's process id in each buffer it asked to have edited, to signal when done. */
const pids = new PerBuffer<{ pid: number; window: number }>();

/** The environment that makes E8 a program's editor, for makeProcess's env, as with-editor-export-editor. */
export function withEditorEnv(): { [name: string]: string } {
  return { GIT_EDITOR: SLEEPING_EDITOR, GIT_SEQUENCE_EDITOR: SLEEPING_EDITOR, EDITOR: SLEEPING_EDITOR, VISUAL: SLEEPING_EDITOR };
}

/**
 * A process filter that visits the files the program's editor asks for and
 * passes the rest of the output on to NEXT, as
 * with-editor-sleeping-editor-filter: output a line at a time.
 */
export function withEditorFilter(next?: (process: string, output: string) => void): (process: string, output: string) => void {
  let incomplete = "";
  return (process, output) => {
    const text = incomplete + output;
    const lastNl = text.lastIndexOf("\n");
    incomplete = lastNl < 0 ? text : text.slice(lastNl + 1);
    const complete = lastNl < 0 ? "" : text.slice(0, lastNl + 1);
    const rest: string[] = [];
    for (const line of complete.split("\n")) {
      const m = /^WITH-EDITOR: (\d+) OPEN ([^\x1f]+?)(?:\x1f([^\x1f]*)\x1f?)?(?: IN ([^\r]+?))?\r?$/.exec(line);
      if (m) visitRequest(Number(m[1]), m[2], m[3], m[4]);
      else rest.push(line);
    }
    const passed = rest.join("\n");
    if (next && passed.trim() !== "") next(process, passed);
  };
}

/** Visits the file an editor asked for, as with-editor-sleeping-editor-filter does. */
function visitRequest(pid: number, arg0: string, arg1: string | undefined, dir: string | undefined): void {
  let file = arg0;
  let line: number | undefined;
  const at = /^\+(\d+)(?::(\d+))?$/.exec(arg0);
  if (at && arg1) {
    file = arg1;
    line = Number(at[1]);
  }
  if (!file.startsWith("/")) file = e8.expandFileName(file, dir);
  const window = e8.selectedWindow();
  e8.call("find-file", file);
  const modes = e8.variable("with-editor-file-modes");
  for (const [re, mode] of Array.isArray(modes) ? (modes as string[][]) : []) {
    if (e8.stringMatch(re, file) !== undefined) {
      e8.call(mode as e8.CommandName);
      break;
    }
  }
  pids.set(e8.currentBuffer(), { pid, window });
  e8.callWithPrefix(1, withEditorMode);
  if (line !== undefined) e8.gotoChar(e8.lineStart(Math.max(0, line - 1)));
  e8.runHooks("with-editor-filter-visit-hook");
  e8.message("Type C-c C-c to finish, or C-c C-k to cancel");
}

/** Signals the editor waiting for this buffer, to finish or cancel, as with-editor-return. */
function returnToProgram(cancel: boolean): void {
  const entry = pids.get(e8.currentBuffer());
  if (!entry) e8.userError("Not in a buffer a program waits for");
  if (!cancel) e8.call("save-buffer");
  else e8.setBufferModified(false);
  pids.delete(e8.currentBuffer());
  e8.callWithPrefix(-1, withEditorMode);
  e8.callProcess(["kill", cancel ? "-USR2" : "-USR1", String(entry.pid)]);
  e8.call("kill-buffer", e8.bufferName());
  if (e8.windowList().includes(entry.window)) e8.selectWindow(entry.window);
  e8.runHooks(cancel ? "with-editor-post-cancel-hook" : "with-editor-post-finish-hook");
}

const finish = e8.defineCommand({ name: "with-editor-finish", doc: "Finish editing: save the file and let the program waiting go on with it.", run: () => returnToProgram(false) });
const cancel = e8.defineCommand({ name: "with-editor-cancel", doc: "Cancel editing: let the program waiting go on, told it was cancelled.", run: () => returnToProgram(true) });

/** Whether the current buffer is one a program waits for, as with-editor-mode is on there. */
export const withEditorP = (): boolean => pids.get(e8.currentBuffer()) !== undefined;

export const withEditorMode = e8.defineMinorMode({
  name: "with-editor-mode",
  lighter: " WE",
  doc: "In a file a program asked E8 to edit: C-c C-c finishes, C-c C-k cancels.",
  bindings: { "C-c C-c": finish, "C-c C-k": cancel },
});
