// Language servers, after Emacs's eglot.el: M-x eglot starts the server
// eglot-server-programs names for the buffer's major mode, in the buffer's
// project, and manages that project's buffers of the mode. The server hears
// of their text as it changes; M-. and M-? ask it where things are defined
// and used, C-M-i what completes the text at point; its diagnostics show
// underlined, with their message when point is on one, and a pause on a
// name shows what it is. eglot-rename, eglot-format-buffer and
// eglot-code-actions have it edit. Messages go over the server's standard
// input and output as JSON-RPC, as the Language Server Protocol says.

import { current as projectRoot } from "project";
import { truthy } from "subr";
import { defineXrefBackend, type Xref } from "xref";

ember.defineVariable({
  name: "eglot-server-programs",
  doc:
    "How to start a language server for each major mode: a list of [modes, program], modes a mode or a list of them, " +
    'program the command and its arguments, or ["eglot-alternatives", ...commands] to use the first that is installed, ' +
    "as eglot-alternatives makes them.",
  value: [
    [["python-mode", "python-ts-mode"], ["eglot-alternatives", "pylsp", "pyls", ["basedpyright-langserver", "--stdio"], ["pyright-langserver", "--stdio"], "jedi-language-server", "ruff-lsp"]],
    [["go-mode", "go-ts-mode", "go-mod-ts-mode"], ["gopls"]],
    [["rust-mode", "rust-ts-mode"], ["rust-analyzer"]],
    [["js-mode", "js-ts-mode", "typescript-ts-mode", "tsx-ts-mode"], ["typescript-language-server", "--stdio"]],
    [["json-mode", "json-ts-mode"], ["eglot-alternatives", ["vscode-json-language-server", "--stdio"], ["vscode-json-languageserver", "--stdio"], ["json-languageserver", "--stdio"]]],
    [["sh-mode", "bash-ts-mode"], ["bash-language-server", "start"]],
    [["c-mode", "c-ts-mode", "c++-mode", "c++-ts-mode"], ["eglot-alternatives", "clangd", "ccls"]],
    [["nix-mode", "nix-ts-mode"], ["eglot-alternatives", "nil", "rnix-lsp", "nixd"]],
    [["yaml-mode", "yaml-ts-mode"], ["yaml-language-server", "--stdio"]],
    [["julia-mode", "julia-ts-mode"], ["julia", "-e", "using LanguageServer; runserver()"]],
  ],
});
for (const [name, value, doc] of [
  ["eglot-sync-request-timeout", 3, "Seconds to wait for a server's answer before giving up."],
  ["eglot-send-changes-idle-time", 0.5, "Seconds idle after which the server hears of edits, if it has not already."],
  ["eglot-autoshutdown", false, "Whether a server stops when the last buffer it manages is killed."],
  ["eglot-workspace-configuration", [], "Settings given to servers that ask for them, as an object of sections, such as { gopls: { ... } }."],
  ["eglot-ignored-server-capabilities", [], "Capabilities not to use even when a server has them, such as \":hoverProvider\"."],
] as const) {
  ember.defineVariable({ name, value: value as ember.Value, doc });
}
ember.defineHook("eglot-managed-mode-hook", "Run when eglot starts or stops managing a buffer.");
ember.defineHook("eglot-server-initialized-hook", "Run with a server's name when it has started.");

ember.defineFace({ name: "flymake-error", doc: "A diagnostic of an error.", attributes: { underline: { style: "wave", color: "Red1" } } });
ember.defineFace({ name: "flymake-warning", doc: "A diagnostic of a warning.", attributes: { underline: { style: "wave", color: "DarkOrange" } } });
ember.defineFace({ name: "flymake-note", doc: "A diagnostic of a note.", attributes: { underline: { style: "wave", color: "yellow green" } } });

// --- Positions and documents ------------------------------------------------

/** Bytes a string takes in UTF-8, which Content-Length counts. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The characters of a string that take its first `bytes` bytes in UTF-8, and the rest. */
function splitUtf8(s: string, bytes: number): [string, string] | undefined {
  let n = 0;
  let i = 0;
  while (i < s.length && n < bytes) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
    i++;
  }
  return n < bytes ? undefined : [s.slice(0, i), s.slice(i)];
}

const fileUri = (file: string): string => `file://${file.split("/").map(encodeURIComponent).join("/")}`;
const uriFile = (uri: string): string => decodeURIComponent(uri.replace(/^file:\/\//, ""));

interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}

/** A buffer position as the protocol counts it: its line, and UTF-16 units from the line's start, as eglot--pos-to-lsp-position. */
function lspPosition(pos = ember.point()): Position {
  const line = ember.lineOf(pos);
  return { line, character: ember.bufferText(ember.lineStart(line), pos).length };
}

/** The buffer position a protocol position names, as eglot--lsp-position-to-point. */
function bufferPosition(p: Position): number {
  const line = Math.max(0, Math.min(p.line, ember.lineCount() - 1));
  const text = ember.lineText(line);
  const units = Math.min(p.character, text.length);
  return ember.lineStart(line) + [...text.slice(0, units)].length;
}

/** The language id the protocol names a mode's buffers by, as eglot--language-id. */
function languageId(mode: string): string {
  const base = mode.replace(/-ts-mode$|-mode$/, "");
  return ({ js: "javascript", "c++": "cpp", sh: "shellscript", bash: "shellscript" } as Record<string, string>)[base] ?? base;
}

// --- Servers ----------------------------------------------------------------

interface Server {
  name: string;
  process: string;
  root: string;
  modes: string[];
  nextId: number;
  /** Answers come in by request id. */
  answers: Map<number, { result?: unknown; error?: { message: string } }>;
  /** Output not yet made into messages. */
  input: string;
  capabilities: { [key: string]: unknown };
  buffers: Set<string>;
  initialized: boolean;
}

const servers: Server[] = [];
/** The server managing each buffer, by name. */
const managing = new Map<string, Server>();
/** Each managed buffer's document version, and whether it changed since the server heard. */
const documents = new Map<string, { version: number; dirty: boolean }>();

function send(server: Server, message: object): void {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  ember.processSendString(server.process, `Content-Length: ${utf8Length(body)}\r\n\r\n${body}`);
}

const notify = (server: Server, method: string, params: unknown): void => send(server, { method, params });

/** Sends a request and waits for its answer, as jsonrpc-request: the answer's result, or an error. */
function request(server: Server, method: string, params: unknown): unknown {
  flushChanges(server);
  const id = server.nextId++;
  send(server, { id, method, params });
  const timeout = Number(ember.variable("eglot-sync-request-timeout") ?? 3);
  const until = Date.now() + timeout * 1000;
  while (!server.answers.has(id)) {
    if (!ember.processLiveP(server.process)) ember.userError(`[eglot] ${server.name} has stopped`);
    if (Date.now() > until) {
      send(server, { method: "$/cancelRequest", params: { id } });
      ember.userError(`[eglot] Timed out waiting for ${method}`);
    }
    ember.acceptProcessOutput(server.process, 0.05);
  }
  const answer = server.answers.get(id)!;
  server.answers.delete(id);
  if (answer.error) ember.userError(`[eglot] ${answer.error.message}`);
  return answer.result;
}

/** What the server asks of us, as eglot's handlers for server requests answer. */
function serverRequest(server: Server, method: string, params: any): unknown {
  switch (method) {
    case "workspace/configuration": {
      const config = ember.variable("eglot-workspace-configuration") as any;
      return (params?.items ?? []).map((item: { section?: string }) =>
        item.section && config && typeof config === "object" && !Array.isArray(config) ? (config[item.section] ?? null) : null,
      );
    }
    case "workspace/applyEdit":
      applyWorkspaceEdit(params.edit);
      return { applied: true };
    case "workspace/workspaceFolders":
      return [{ uri: fileUri(server.root), name: server.root }];
    default:
      // client/registerCapability, window/workDoneProgress/create and the like.
      return null;
  }
}

/** Takes in a message from the server: an answer, a notification or a request. */
function handle(server: Server, message: any): void {
  if (message.id !== undefined && message.method === undefined) {
    server.answers.set(message.id, { result: message.result, error: message.error });
  } else if (message.method !== undefined && message.id !== undefined) {
    let result: unknown = null;
    try {
      result = serverRequest(server, message.method, message.params);
    } catch (e) {
      send(server, { id: message.id, error: { code: -32603, message: String(e) } });
      return;
    }
    send(server, { id: message.id, result });
  } else if (message.method === "textDocument/publishDiagnostics") {
    showDiagnostics(message.params);
  } else if (message.method === "window/showMessage" && message.params?.message) {
    ember.message(`[eglot] ${message.params.message}`);
  }
}

/** The process filter: output in Content-Length frames, each a message. */
function filter(server: Server, output: string): void {
  server.input += output;
  for (;;) {
    const headerEnd = server.input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = /Content-Length:\s*(\d+)/i.exec(server.input.slice(0, headerEnd));
    if (!length) {
      server.input = server.input.slice(headerEnd + 4);
      continue;
    }
    const split = splitUtf8(server.input.slice(headerEnd + 4), Number(length[1]));
    if (!split) return;
    server.input = split[1];
    try {
      handle(server, JSON.parse(split[0]));
    } catch (e) {
      ember.message(`[eglot] Bad message from ${server.name}: ${String(e)}`);
    }
  }
}

/** The first program of a server entry that can be run, as eglot--guess-contact tries them. */
function serverCommand(mode: string): string[] | undefined {
  const programs = ember.variable("eglot-server-programs");
  for (const entry of Array.isArray(programs) ? programs : []) {
    if (!Array.isArray(entry)) continue;
    const [modes, program] = entry as [ember.Value, ember.Value];
    const list = Array.isArray(modes) ? modes : [modes];
    if (!list.includes(mode) && !ember.derivedModeAllParents(mode).some((m) => list.includes(m))) continue;
    const command = Array.isArray(program) ? program : [program];
    if (command[0] !== "eglot-alternatives") return command.map(String);
    // As eglot-alternatives: the first that is installed, else the first.
    const alternatives = command.slice(1).map((c) => (Array.isArray(c) ? c.map(String) : [String(c)]));
    return alternatives.find((c) => findExecutable(c[0]) !== undefined) ?? alternatives[0];
  }
  return undefined;
}

/** Where a program is along PATH, as executable-find. */
function findExecutable(program: string): string | undefined {
  if (program.includes("/")) return ember.fileExecutableP(ember.expandFileName(program)) ? program : undefined;
  for (const dir of (ember.getenv("PATH") ?? "").split(":")) {
    if (dir && ember.fileExecutableP(`${dir}/${program}`)) return `${dir}/${program}`;
  }
  return undefined;
}

/** Starts a server for a mode in a project and tells it what we can do, as eglot--connect. */
function connect(mode: string, root: string, command: string[]): Server {
  const name = `EGLOT (${ember.fileNameNondirectory(root.replace(/\/$/, ""))}/${mode})`;
  const server: Server = {
    name,
    process: "",
    root,
    modes: [mode],
    nextId: 1,
    answers: new Map(),
    input: "",
    capabilities: {},
    buffers: new Set(),
    initialized: false,
  };
  server.process = ember.makeProcess({
    name,
    command,
    directory: root,
    connectionType: "pipe",
    stderr: false,
    // -unix, so the headers' CRLFs come through, as eglot's utf-8-emacs-unix.
    coding: "utf-8-unix",
    filter: (_p, output) => filter(server, output),
    sentinel: (_p, event) => {
      if (!ember.processLiveP(server.process)) {
        ember.message(`[eglot] ${name} ${event.trim()}`);
        disconnect(server);
      }
    },
  });
  servers.push(server);
  startTimers();
  const result = request(server, "initialize", {
    processId: ember.emacsPid(),
    rootPath: root,
    rootUri: fileUri(root),
    initializationOptions: {},
    workspaceFolders: [{ uri: fileUri(root), name: root }],
    capabilities: {
      workspace: { applyEdit: true, configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true } },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: true, willSave: false },
        completion: { completionItem: { snippetSupport: false, deprecatedSupport: true }, contextSupport: true },
        hover: { contentFormat: ["plaintext", "markdown"] },
        signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: true } } },
        definition: { linkSupport: false },
        references: {},
        rename: { prepareSupport: false },
        formatting: {},
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] } } },
        publishDiagnostics: { relatedInformation: false },
      },
      general: { positionEncodings: ["utf-16"] },
    },
  }) as { capabilities?: { [key: string]: unknown } };
  server.capabilities = result?.capabilities ?? {};
  notify(server, "initialized", {});
  server.initialized = true;
  ember.runHooks("eglot-server-initialized-hook", name);
  ember.message(`[eglot] Connected! Server \`${name}' now managing \`${mode}' buffers in project \`${root}'.`);
  return server;
}

function disconnect(server: Server): void {
  for (const buffer of [...server.buffers]) {
    if (ember.getBuffer(buffer)) ember.withCurrentBuffer(buffer, () => manage(false));
  }
  const k = servers.indexOf(server);
  if (k >= 0) servers.splice(k, 1);
  if (servers.length === 0) stopTimers();
}

/** The server for the current buffer's project and mode, if one runs, as eglot-current-server. */
function currentServer(): Server | undefined {
  const name = ember.currentBuffer().name;
  return name ? managing.get(name) : undefined;
}

function requireServer(): Server {
  const server = currentServer();
  if (!server) ember.userError("No current JSON-RPC connection");
  return server;
}

const hasCapability = (server: Server, name: string): boolean => {
  const ignored = (ember.variable("eglot-ignored-server-capabilities") ?? []) as ember.Value[];
  return truthy(server.capabilities[name] as ember.Value) && !(Array.isArray(ignored) && ignored.includes(`:${name}`));
};

// --- Managing buffers -------------------------------------------------------

/** The current buffer's document, as the protocol names it. */
const textDocument = () => ({ uri: fileUri(ember.bufferFileName()!) });

/** Tells the server of the buffers' edits it has not heard of, with their whole text, as eglot--signal-textDocument/didChange. */
function flushChanges(server: Server): void {
  for (const buffer of server.buffers) {
    const doc = documents.get(buffer);
    if (!doc?.dirty || !ember.getBuffer(buffer)) continue;
    doc.dirty = false;
    doc.version++;
    ember.withCurrentBuffer(buffer, () =>
      notify(server, "textDocument/didChange", {
        textDocument: { ...textDocument(), version: doc.version },
        contentChanges: [{ text: ember.bufferText(ember.pointMin(), ember.pointMax()) }],
      }),
    );
  }
}

const afterChange = (): void => {
  const doc = documents.get(ember.currentBuffer().name ?? "");
  if (doc) doc.dirty = true;
};

const afterSave = (): void => {
  const server = currentServer();
  if (server) {
    flushChanges(server);
    notify(server, "textDocument/didSave", { textDocument: textDocument() });
  }
};

const killBuffer = (): void => {
  const server = currentServer();
  if (!server) return;
  notify(server, "textDocument/didClose", { textDocument: textDocument() });
  const name = ember.currentBuffer().name!;
  server.buffers.delete(name);
  managing.delete(name);
  documents.delete(name);
  if (server.buffers.size === 0 && truthy(ember.variable("eglot-autoshutdown"))) shutdown(server);
};

/** Starts or stops managing the current buffer with the server, as eglot--managed-mode. */
function manage(on: boolean, server?: Server): void {
  const name = ember.currentBuffer().name!;
  if (on && server) {
    managing.set(name, server);
    server.buffers.add(name);
    documents.set(name, { version: 0, dirty: false });
    notify(server, "textDocument/didOpen", {
      textDocument: { ...textDocument(), languageId: languageId(String(ember.variable("major-mode"))), version: 0, text: ember.bufferText(ember.pointMin(), ember.pointMax()) },
    });
    ember.addHook("after-change-functions", afterChange, { local: true });
    ember.addHook("after-save-hook", afterSave, { local: true });
    ember.addHook("kill-buffer-hook", killBuffer, { local: true });
    ember.addHook("xref-backend-functions", () => "eglot", { local: true });
    ember.addHook("completion-at-point-functions", completionAtPoint, { local: true });
    if (!truthy(ember.variable("eglot--managed-mode"))) ember.callWithPrefix(1, "eglot--managed-mode");
  } else {
    ember.removeHook("after-change-functions", afterChange, { local: true });
    ember.removeHook("after-save-hook", afterSave, { local: true });
    ember.removeHook("kill-buffer-hook", killBuffer, { local: true });
    managing.get(name)?.buffers.delete(name);
    managing.delete(name);
    documents.delete(name);
    clearDiagnostics();
    if (truthy(ember.variable("eglot--managed-mode"))) ember.callWithPrefix(-1, "eglot--managed-mode");
  }
}

ember.defineKeymap("eglot-mode-map");
ember.defineMinorMode({
  name: "eglot--managed-mode",
  lighter: " eglot",
  doc: "Eglot manages this buffer: a language server hears of its text and answers M-., M-?, C-M-i and the eglot commands.",
  onChange: () => ember.runHooks("eglot-managed-mode-hook"),
});
ember.setKeymapParent("eglot--managed-mode-map", "eglot-mode-map");

/** Manages the current buffer, starting a server for its project and mode if none runs, as M-x eglot. */
function eglot(): void {
  const file = ember.bufferFileName();
  if (!file) ember.userError("[eglot] This buffer is not visiting a file");
  const mode = String(ember.variable("major-mode"));
  const root = ember.fileNameAsDirectory(ember.expandFileName(projectRoot() ?? ember.fileNameDirectory(file) ?? "."));
  let server = servers.find((s) => s.root === root && s.modes.includes(mode) && ember.processLiveP(s.process));
  if (!server) {
    const command = serverCommand(mode);
    if (!command) ember.userError(`[eglot] Couldn't guess LSP server for \`${mode}'`);
    if (findExecutable(command[0]) === undefined) ember.userError(`[eglot] Couldn't start \`${command.join(" ")}': program not found`);
    server = connect(mode, root, command);
  }
  // The project's other buffers of the mode too, as eglot--maybe-activate-editing-mode does.
  for (const name of ember.bufferList()) {
    ember.withCurrentBuffer(name, () => {
      const f = ember.bufferFileName();
      if (f && f.startsWith(root) && ember.variable("major-mode") === mode && !managing.has(name)) manage(true, server);
    });
  }
}

ember.defineCommand({
  name: "eglot",
  doc: "Start the language server eglot-server-programs names for this buffer's mode, in its project, and manage its buffers of that mode.",
  run: () => eglot(),
});

/** Starts eglot in the current buffer if a server is known for it, as eglot-ensure does from a mode hook. */
export function ensure(): void {
  if (!ember.bufferFileName() || managing.has(ember.currentBuffer().name!)) return;
  const command = serverCommand(String(ember.variable("major-mode")));
  if (command && findExecutable(command[0]) !== undefined) {
    try {
      eglot();
    } catch (e) {
      ember.message(String(e instanceof Error ? e.message : e));
    }
  }
}
ember.defun("eglot-ensure", () => ensure());

function shutdown(server: Server): void {
  try {
    request(server, "shutdown", null);
    notify(server, "exit", null);
  } catch {
    // A server that does not answer is killed.
  }
  if (ember.processLiveP(server.process)) ember.deleteProcess(server.process);
  disconnect(server);
}

ember.defineCommand({
  name: "eglot-shutdown",
  doc: "Stop the current buffer's language server, and manage its buffers no more.",
  run: () => shutdown(requireServer()),
});

ember.defineCommand({
  name: "eglot-shutdown-all",
  doc: "Stop every language server.",
  run: () => [...servers].forEach(shutdown),
});

ember.defineCommand({
  name: "eglot-reconnect",
  doc: "Stop the current buffer's language server and start it again.",
  run: () => {
    shutdown(requireServer());
    eglot();
  },
});

// --- Finding things, as eglot's xref backend ---------------------------------

/** Places from Location or LocationLink answers, with their lines' text, as eglot--lsp-xrefs-for-method makes them. */
function xrefs(locations: unknown): Xref[] {
  const list = (Array.isArray(locations) ? locations : locations ? [locations] : []) as any[];
  return list.map((l) => {
    const uri: string = l.uri ?? l.targetUri;
    const range: Range = l.range ?? l.targetSelectionRange ?? l.targetRange;
    const file = uriFile(uri);
    const buffer = ember.getBuffer(file) ?? (ember.fileExists(file) ? ember.getBuffer(ember.findFileNoselect(file)) : undefined);
    let summary = "";
    let col = range.start.character;
    if (buffer) {
      ember.withCurrentBuffer(buffer, () => {
        summary = ember.lineText(Math.min(range.start.line, ember.lineCount() - 1));
        col = bufferPosition(range.start) - ember.lineStart(range.start.line);
      });
    }
    return { file, line: range.start.line + 1, col, length: range.end.line === range.start.line ? range.end.character - range.start.character : 0, summary, group: ember.abbreviateFileName(file) };
  });
}

defineXrefBackend("eglot", {
  identifierAtPoint: () =>
    ember.saveExcursion(() => {
      ember.skipSyntaxBackward("w_");
      const start = ember.point();
      ember.skipSyntaxForward("w_");
      return ember.point() > start ? ember.bufferText(start, ember.point()) : "LSP identifier at point";
    }),
  definitions: () => xrefs(request(requireServer(), "textDocument/definition", { textDocument: textDocument(), position: lspPosition() })),
  references: () =>
    xrefs(request(requireServer(), "textDocument/references", { textDocument: textDocument(), position: lspPosition(), context: { includeDeclaration: true } })),
});

// --- Completion, as eglot-completion-at-point --------------------------------

function completionAtPoint(): ember.Value {
  const server = currentServer();
  if (!server || !hasCapability(server, "completionProvider")) return null;
  const end = ember.point();
  const start = ember.saveExcursion(() => {
    ember.skipSyntaxBackward("w_");
    return ember.point();
  });
  const answer = request(server, "textDocument/completion", { textDocument: textDocument(), position: lspPosition(), context: { triggerKind: 1 } }) as any;
  const items: any[] = Array.isArray(answer) ? answer : (answer?.items ?? []);
  const words = items.map((item) => String(item.textEdit?.newText ?? item.insertText ?? item.label));
  return [start, end, [...new Set(words)]];
}

ember.defineKey("eglot--managed-mode-map", "C-M-i", "completion-at-point");

// --- Diagnostics, as eglot's flymake backend ---------------------------------

/** Each buffer's diagnostic overlays. */
const diagnosticOverlays = new Map<string, number[]>();

function clearDiagnostics(buffer = ember.currentBuffer().name!): void {
  for (const o of diagnosticOverlays.get(buffer) ?? []) ember.deleteOverlay(o);
  diagnosticOverlays.delete(buffer);
}

/** Shows a file's diagnostics as underlined overlays carrying their messages, as eglot--report-to-flymake does. */
function showDiagnostics(params: { uri: string; diagnostics: { range: Range; severity?: number; message: string; source?: string }[] }): void {
  const file = uriFile(params.uri);
  const buffer = [...managing.keys()].find((b) => ember.withCurrentBuffer(b, () => ember.bufferFileName()) === file);
  if (!buffer) return;
  ember.withCurrentBuffer(buffer, () => {
    clearDiagnostics(buffer);
    const overlays: number[] = [];
    for (const d of params.diagnostics) {
      let start = bufferPosition(d.range.start);
      let end = bufferPosition(d.range.end);
      // An empty range marks the thing at it, as flymake-diag-region does.
      if (end <= start) end = Math.min(ember.lineEndPosition(start), start + 1);
      if (end <= start) start = Math.max(0, end - 1);
      const face = d.severity === 1 || d.severity === undefined ? "flymake-error" : d.severity === 2 ? "flymake-warning" : "flymake-note";
      const text = d.source ? `${d.source}: ${d.message}` : d.message;
      overlays.push(ember.makeOverlay(start, end, { face, "flymake-diagnostic": text, "eglot-severity": d.severity ?? 1 }));
    }
    diagnosticOverlays.set(buffer, overlays);
  });
}

/** The diagnostics' overlays in the current buffer, in order. */
const diagnostics = (): number[] =>
  (diagnosticOverlays.get(ember.currentBuffer().name ?? "") ?? []).filter((o) => ember.overlayStart(o) !== undefined).sort((a, b) => ember.overlayStart(a)! - ember.overlayStart(b)!);

function gotoDiagnostic(n: number): void {
  const all = diagnostics();
  const here = ember.point();
  const next = n > 0 ? all.find((o) => ember.overlayStart(o)! > here) : [...all].reverse().find((o) => ember.overlayStart(o)! < here);
  if (next === undefined) ember.userError(n > 0 ? "No more Flymake diagnostics" : "No more Flymake diagnostics before point");
  ember.gotoChar(ember.overlayStart(next)!);
  ember.message(String(ember.overlayGet(next, "flymake-diagnostic") ?? ""));
}

ember.defineCommand({ name: "flymake-goto-next-error", doc: "Go to the next diagnostic and show its message.", run: () => gotoDiagnostic(1) });
ember.defineCommand({ name: "flymake-goto-prev-error", doc: "Go to the diagnostic before point and show its message.", run: () => gotoDiagnostic(-1) });

// --- What point is on, as eglot's eldoc functions -----------------------------

/** After a pause, a diagnostic's message at point, or else what the server says of the thing at point, in the echo area. */
let lastHoverAt: string | undefined;
function showAtPoint(): void {
  const server = currentServer();
  if (!server || ember.minibufferDepth() > 0) return;
  const here = ember.point();
  const at = `${ember.currentBuffer().name}:${here}:${documents.get(ember.currentBuffer().name!)?.version}`;
  if (at === lastHoverAt) return;
  lastHoverAt = at;
  const diagnostic = diagnostics().find((o) => ember.overlayStart(o)! <= here && here < ember.overlayEnd(o)!);
  if (diagnostic !== undefined) {
    ember.message(String(ember.overlayGet(diagnostic, "flymake-diagnostic")));
    return;
  }
  if (!hasCapability(server, "hoverProvider")) return;
  try {
    const hover = request(server, "textDocument/hover", { textDocument: textDocument(), position: lspPosition() }) as any;
    const text = hoverText(hover?.contents);
    if (text) ember.letBind({ "message-log-max": null }, () => ember.message(text));
  } catch {
    // The server may not answer for what point is on.
  }
}

/** A hover's first non-empty line, from MarkupContent, MarkedString or a list of them. */
function hoverText(contents: unknown): string {
  const parts = Array.isArray(contents) ? contents : [contents];
  const text = parts.map((c: any) => (typeof c === "string" ? c : (c?.value ?? ""))).join("\n");
  return (text.split("\n").find((l) => l.trim() !== "" && !/^```/.test(l)) ?? "").trim();
}

// --- Edits, as eglot-rename, eglot-format-buffer and eglot-code-actions ------

/** Applies text edits to the current buffer, last first so the positions hold, as eglot--apply-text-edits. */
function applyTextEdits(edits: { range: Range; newText: string }[]): void {
  const resolved = edits.map((e) => ({ start: bufferPosition(e.range.start), end: bufferPosition(e.range.end), text: e.newText }));
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  const point = ember.makeMarker(ember.point());
  for (const e of resolved) {
    ember.deleteRegion(e.start, e.end);
    ember.gotoChar(e.start);
    ember.insert(e.text);
  }
  ember.gotoChar(ember.markerPosition(point)!);
  ember.deleteMarker(point);
}

/** Applies a WorkspaceEdit to the files it names, visiting them, as eglot--apply-workspace-edit. */
function applyWorkspaceEdit(edit: any): void {
  const byFile: [string, { range: Range; newText: string }[]][] = [];
  for (const change of edit?.documentChanges ?? []) {
    if (change.textDocument) byFile.push([uriFile(change.textDocument.uri), change.edits]);
  }
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) byFile.push([uriFile(uri), edits as { range: Range; newText: string }[]]);
  for (const [file, edits] of byFile) {
    const buffer = ember.findFileNoselect(file);
    ember.withCurrentBuffer(buffer, () => applyTextEdits(edits));
  }
  if (byFile.length > 0) ember.message(`[eglot] Edited ${byFile.length} file${byFile.length === 1 ? "" : "s"}`);
}

ember.defineCommand({
  name: "eglot-rename",
  doc: "Rename the thing at point everywhere the server knows of it.",
  params: [{ name: "newname", prompt: () => "Rename to: " }],
  run: (newname) => {
    const server = requireServer();
    if (!hasCapability(server, "renameProvider")) ember.userError("[eglot] Server can't rename");
    applyWorkspaceEdit(request(server, "textDocument/rename", { textDocument: textDocument(), position: lspPosition(), newName: newname }));
  },
});

ember.defineCommand({
  name: "eglot-format-buffer",
  doc: "Have the server format the whole buffer.",
  run: () => {
    const server = requireServer();
    if (!hasCapability(server, "documentFormattingProvider")) ember.userError("[eglot] Server can't format");
    const tabWidth = Number(ember.variable("tab-width") ?? 8);
    const edits = request(server, "textDocument/formatting", {
      textDocument: textDocument(),
      options: { tabSize: tabWidth, insertSpaces: !truthy(ember.variable("indent-tabs-mode")) },
    }) as { range: Range; newText: string }[] | null;
    if (edits) applyTextEdits(edits);
  },
});

ember.defineCommand({
  name: "eglot-code-actions",
  doc: "Choose one of the changes the server offers for point, or the region, and make it.",
  run: () => {
    const server = requireServer();
    const [start, end] = ember.regionActive() ? [Math.min(ember.point(), ember.mark()!), Math.max(ember.point(), ember.mark()!)] : [ember.point(), ember.point()];
    const here = diagnostics().filter((o) => ember.overlayStart(o)! <= end && start <= ember.overlayEnd(o)!);
    const actions = (request(server, "textDocument/codeAction", {
      textDocument: textDocument(),
      range: { start: lspPosition(start), end: lspPosition(end) },
      context: { diagnostics: here.map((o) => ({ range: { start: lspPosition(ember.overlayStart(o)), end: lspPosition(ember.overlayEnd(o)) }, message: String(ember.overlayGet(o, "flymake-diagnostic")) })) },
    }) ?? []) as any[];
    if (actions.length === 0) ember.userError("[eglot] No code actions here");
    const title = ember.completingRead("[eglot] Pick an action: ", actions.map((a) => String(a.title)), { requireMatch: true });
    const action = actions.find((a) => a.title === title);
    if (action?.edit) applyWorkspaceEdit(action.edit);
    const command = action?.command && typeof action.command === "object" ? action.command : action?.command ? action : undefined;
    if (command?.command) request(server, "workspace/executeCommand", { command: command.command, arguments: command.arguments ?? [] });
  },
});

/** The idle timers that send edits and show what point is on, while any server runs. */
let timers: number[] = [];

function startTimers(): void {
  if (timers.length > 0) return;
  timers = [
    // Edits are sent once Ember has been idle a moment, as eglot-send-changes-idle-time has it.
    ember.runWithIdleTimer(Number(ember.variable("eglot-send-changes-idle-time") ?? 0.5), true, () => {
      for (const server of servers) if (server.initialized && ember.processLiveP(server.process)) flushChanges(server);
    }),
    ember.runWithIdleTimer(0.5, true, showAtPoint),
  ];
}

function stopTimers(): void {
  for (const t of timers) ember.cancelTimer(t);
  timers = [];
}
