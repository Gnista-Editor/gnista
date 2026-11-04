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
import { executableFind, truthy } from "subr";
import { defineXrefBackend, type Xref } from "xref";

gnista.defineVariable({
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
  gnista.defineVariable({ name, value: value as gnista.Value, doc });
}
gnista.defineHook("eglot-managed-mode-hook", "Run when eglot starts or stops managing a buffer.");
gnista.defineHook("eglot-server-initialized-hook", "Run with a server's name when it has started.");

gnista.defineFace({ name: "flymake-error", doc: "A diagnostic of an error.", attributes: { underline: { style: "wave", color: "Red1" } } });
gnista.defineFace({ name: "flymake-warning", doc: "A diagnostic of a warning.", attributes: { underline: { style: "wave", color: "DarkOrange" } } });
gnista.defineFace({ name: "flymake-note", doc: "A diagnostic of a note.", attributes: { underline: { style: "wave", color: "yellow green" } } });

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
function lspPosition(pos = gnista.point()): Position {
  const line = gnista.lineOf(pos);
  return { line, character: gnista.bufferText(gnista.lineStart(line), pos).length };
}

/** The buffer position a protocol position names, as eglot--lsp-position-to-point. */
function bufferPosition(p: Position): number {
  const line = Math.max(0, Math.min(p.line, gnista.lineCount() - 1));
  const text = gnista.lineText(line);
  const units = Math.min(p.character, text.length);
  return gnista.lineStart(line) + [...text.slice(0, units)].length;
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
  gnista.processSendString(server.process, `Content-Length: ${utf8Length(body)}\r\n\r\n${body}`);
}

const notify = (server: Server, method: string, params: unknown): void => send(server, { method, params });

/** Sends a request and waits for its answer, as jsonrpc-request: the answer's result, or an error. */
function request(server: Server, method: string, params: unknown): unknown {
  flushChanges(server);
  const id = server.nextId++;
  send(server, { id, method, params });
  const timeout = Number(gnista.variable("eglot-sync-request-timeout") ?? 3);
  const until = Date.now() + timeout * 1000;
  while (!server.answers.has(id)) {
    if (!gnista.processLiveP(server.process)) gnista.userError(`[eglot] ${server.name} has stopped`);
    if (Date.now() > until) {
      send(server, { method: "$/cancelRequest", params: { id } });
      gnista.userError(`[eglot] Timed out waiting for ${method}`);
    }
    gnista.acceptProcessOutput(server.process, 0.05);
  }
  const answer = server.answers.get(id)!;
  server.answers.delete(id);
  if (answer.error) gnista.userError(`[eglot] ${answer.error.message}`);
  return answer.result;
}

/** What the server asks of us, as eglot's handlers for server requests answer. */
function serverRequest(server: Server, method: string, params: any): unknown {
  switch (method) {
    case "workspace/configuration": {
      const config = gnista.variable("eglot-workspace-configuration") as any;
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
    gnista.message(`[eglot] ${message.params.message}`);
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
      gnista.message(`[eglot] Bad message from ${server.name}: ${String(e)}`);
    }
  }
}

/** The first program of a server entry that can be run, as eglot--guess-contact tries them. */
function serverCommand(mode: string): string[] | undefined {
  const programs = gnista.variable("eglot-server-programs");
  for (const entry of Array.isArray(programs) ? programs : []) {
    if (!Array.isArray(entry)) continue;
    const [modes, program] = entry as [gnista.Value, gnista.Value];
    const list = Array.isArray(modes) ? modes : [modes];
    if (!list.includes(mode) && !gnista.derivedModeAllParents(mode).some((m) => list.includes(m))) continue;
    const command = Array.isArray(program) ? program : [program];
    if (command[0] !== "eglot-alternatives") return command.map(String);
    // As eglot-alternatives: the first that is installed, else the first.
    const alternatives = command.slice(1).map((c) => (Array.isArray(c) ? c.map(String) : [String(c)]));
    return alternatives.find((c) => executableFind(c[0]) !== undefined) ?? alternatives[0];
  }
  return undefined;
}

/** Starts a server for a mode in a project and tells it what we can do, as eglot--connect. */
function connect(mode: string, root: string, command: string[]): Server {
  const name = `EGLOT (${gnista.fileNameNondirectory(root.replace(/\/$/, ""))}/${mode})`;
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
  server.process = gnista.makeProcess({
    name,
    command,
    directory: root,
    connectionType: "pipe",
    stderr: false,
    // -unix, so the headers' CRLFs come through, as eglot's utf-8-emacs-unix.
    coding: "utf-8-unix",
    filter: (_p, output) => filter(server, output),
    sentinel: (_p, event) => {
      if (!gnista.processLiveP(server.process)) {
        gnista.message(`[eglot] ${name} ${event.trim()}`);
        disconnect(server);
      }
    },
  });
  servers.push(server);
  startTimers();
  const result = request(server, "initialize", {
    processId: gnista.emacsPid(),
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
  gnista.runHooks("eglot-server-initialized-hook", name);
  gnista.message(`[eglot] Connected! Server \`${name}' now managing \`${mode}' buffers in project \`${root}'.`);
  return server;
}

function disconnect(server: Server): void {
  for (const buffer of [...server.buffers]) {
    if (gnista.getBuffer(buffer)) gnista.withCurrentBuffer(buffer, () => manage(false));
  }
  const k = servers.indexOf(server);
  if (k >= 0) servers.splice(k, 1);
  if (servers.length === 0) stopTimers();
}

/** The server for the current buffer's project and mode, if one runs, as eglot-current-server. */
function currentServer(): Server | undefined {
  const name = gnista.currentBuffer().name;
  return name ? managing.get(name) : undefined;
}

function requireServer(): Server {
  const server = currentServer();
  if (!server) gnista.userError("No current JSON-RPC connection");
  return server;
}

const hasCapability = (server: Server, name: string): boolean => {
  const ignored = (gnista.variable("eglot-ignored-server-capabilities") ?? []) as gnista.Value[];
  return truthy(server.capabilities[name] as gnista.Value) && !(Array.isArray(ignored) && ignored.includes(`:${name}`));
};

// --- Managing buffers -------------------------------------------------------

/** The current buffer's document, as the protocol names it. */
const textDocument = () => ({ uri: fileUri(gnista.bufferFileName()!) });

/** Tells the server of the buffers' edits it has not heard of, with their whole text, as eglot--signal-textDocument/didChange. */
function flushChanges(server: Server): void {
  for (const buffer of server.buffers) {
    const doc = documents.get(buffer);
    if (!doc?.dirty || !gnista.getBuffer(buffer)) continue;
    doc.dirty = false;
    doc.version++;
    gnista.withCurrentBuffer(buffer, () =>
      notify(server, "textDocument/didChange", {
        textDocument: { ...textDocument(), version: doc.version },
        contentChanges: [{ text: gnista.bufferText(gnista.pointMin(), gnista.pointMax()) }],
      }),
    );
  }
}

const afterChange = (): void => {
  const doc = documents.get(gnista.currentBuffer().name ?? "");
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
  const name = gnista.currentBuffer().name!;
  server.buffers.delete(name);
  managing.delete(name);
  documents.delete(name);
  if (server.buffers.size === 0 && truthy(gnista.variable("eglot-autoshutdown"))) shutdown(server);
};

/** Starts or stops managing the current buffer with the server, as eglot--managed-mode. */
function manage(on: boolean, server?: Server): void {
  const name = gnista.currentBuffer().name!;
  if (on && server) {
    managing.set(name, server);
    server.buffers.add(name);
    documents.set(name, { version: 0, dirty: false });
    notify(server, "textDocument/didOpen", {
      textDocument: { ...textDocument(), languageId: languageId(String(gnista.variable("major-mode"))), version: 0, text: gnista.bufferText(gnista.pointMin(), gnista.pointMax()) },
    });
    gnista.addHook("after-change-functions", afterChange, { local: true });
    gnista.addHook("after-save-hook", afterSave, { local: true });
    gnista.addHook("kill-buffer-hook", killBuffer, { local: true });
    gnista.addHook("xref-backend-functions", () => "eglot", { local: true });
    gnista.addHook("completion-at-point-functions", completionAtPoint, { local: true });
    if (!truthy(gnista.variable("eglot--managed-mode"))) gnista.callWithPrefix(1, "eglot--managed-mode");
  } else {
    gnista.removeHook("after-change-functions", afterChange, { local: true });
    gnista.removeHook("after-save-hook", afterSave, { local: true });
    gnista.removeHook("kill-buffer-hook", killBuffer, { local: true });
    managing.get(name)?.buffers.delete(name);
    managing.delete(name);
    documents.delete(name);
    clearDiagnostics();
    if (truthy(gnista.variable("eglot--managed-mode"))) gnista.callWithPrefix(-1, "eglot--managed-mode");
  }
}

gnista.defineKeymap("eglot-mode-map");
gnista.defineMinorMode({
  name: "eglot--managed-mode",
  lighter: " eglot",
  doc: "Eglot manages this buffer: a language server hears of its text and answers M-., M-?, C-M-i and the eglot commands.",
  onChange: () => gnista.runHooks("eglot-managed-mode-hook"),
});
gnista.setKeymapParent("eglot--managed-mode-map", "eglot-mode-map");

/** Manages the current buffer, starting a server for its project and mode if none runs, as M-x eglot. */
function eglot(): void {
  const file = gnista.bufferFileName();
  if (!file) gnista.userError("[eglot] This buffer is not visiting a file");
  const mode = String(gnista.variable("major-mode"));
  const root = gnista.fileNameAsDirectory(gnista.expandFileName(projectRoot() ?? gnista.fileNameDirectory(file) ?? "."));
  let server = servers.find((s) => s.root === root && s.modes.includes(mode) && gnista.processLiveP(s.process));
  if (!server) {
    const command = serverCommand(mode);
    if (!command) gnista.userError(`[eglot] Couldn't guess LSP server for \`${mode}'`);
    if (executableFind(command[0]) === undefined) gnista.userError(`[eglot] Couldn't start \`${command.join(" ")}': program not found`);
    server = connect(mode, root, command);
  }
  // The project's other buffers of the mode too, as eglot--maybe-activate-editing-mode does.
  for (const name of gnista.bufferList()) {
    gnista.withCurrentBuffer(name, () => {
      const f = gnista.bufferFileName();
      if (f && f.startsWith(root) && gnista.variable("major-mode") === mode && !managing.has(name)) manage(true, server);
    });
  }
}

gnista.defineCommand({
  name: "eglot",
  doc: "Start the language server eglot-server-programs names for this buffer's mode, in its project, and manage its buffers of that mode.",
  run: () => eglot(),
});

/** Starts eglot in the current buffer if a server is known for it, as eglot-ensure does from a mode hook. */
export function ensure(): void {
  if (!gnista.bufferFileName() || managing.has(gnista.currentBuffer().name!)) return;
  const command = serverCommand(String(gnista.variable("major-mode")));
  if (command && executableFind(command[0]) !== undefined) {
    try {
      eglot();
    } catch (e) {
      gnista.message(String(e instanceof Error ? e.message : e));
    }
  }
}
gnista.defun("eglot-ensure", () => ensure());

function shutdown(server: Server): void {
  try {
    request(server, "shutdown", null);
    notify(server, "exit", null);
  } catch {
    // A server that does not answer is killed.
  }
  if (gnista.processLiveP(server.process)) gnista.deleteProcess(server.process);
  disconnect(server);
}

gnista.defineCommand({
  name: "eglot-shutdown",
  doc: "Stop the current buffer's language server, and manage its buffers no more.",
  run: () => shutdown(requireServer()),
});

gnista.defineCommand({
  name: "eglot-shutdown-all",
  doc: "Stop every language server.",
  run: () => [...servers].forEach(shutdown),
});

gnista.defineCommand({
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
    const buffer = gnista.getBuffer(file) ?? (gnista.fileExists(file) ? gnista.getBuffer(gnista.findFileNoselect(file)) : undefined);
    let summary = "";
    let col = range.start.character;
    if (buffer) {
      gnista.withCurrentBuffer(buffer, () => {
        summary = gnista.lineText(Math.min(range.start.line, gnista.lineCount() - 1));
        col = bufferPosition(range.start) - gnista.lineStart(range.start.line);
      });
    }
    return { file, line: range.start.line + 1, col, length: range.end.line === range.start.line ? range.end.character - range.start.character : 0, summary, group: gnista.abbreviateFileName(file) };
  });
}

defineXrefBackend("eglot", {
  identifierAtPoint: () =>
    gnista.saveExcursion(() => {
      gnista.skipSyntaxBackward("w_");
      const start = gnista.point();
      gnista.skipSyntaxForward("w_");
      return gnista.point() > start ? gnista.bufferText(start, gnista.point()) : "LSP identifier at point";
    }),
  definitions: () => xrefs(request(requireServer(), "textDocument/definition", { textDocument: textDocument(), position: lspPosition() })),
  references: () =>
    xrefs(request(requireServer(), "textDocument/references", { textDocument: textDocument(), position: lspPosition(), context: { includeDeclaration: true } })),
});

// --- Completion, as eglot-completion-at-point --------------------------------

function completionAtPoint(): gnista.Value {
  const server = currentServer();
  if (!server || !hasCapability(server, "completionProvider")) return null;
  const end = gnista.point();
  const start = gnista.saveExcursion(() => {
    gnista.skipSyntaxBackward("w_");
    return gnista.point();
  });
  const answer = request(server, "textDocument/completion", { textDocument: textDocument(), position: lspPosition(), context: { triggerKind: 1 } }) as any;
  const items: any[] = Array.isArray(answer) ? answer : (answer?.items ?? []);
  const words = items.map((item) => String(item.textEdit?.newText ?? item.insertText ?? item.label));
  return [start, end, [...new Set(words)]];
}

gnista.defineKey("eglot--managed-mode-map", "C-M-i", "completion-at-point");

// --- Diagnostics, as eglot's flymake backend ---------------------------------

/** Each buffer's diagnostic overlays. */
const diagnosticOverlays = new Map<string, number[]>();

function clearDiagnostics(buffer = gnista.currentBuffer().name!): void {
  for (const o of diagnosticOverlays.get(buffer) ?? []) gnista.deleteOverlay(o);
  diagnosticOverlays.delete(buffer);
}

/** Shows a file's diagnostics as underlined overlays carrying their messages, as eglot--report-to-flymake does. */
function showDiagnostics(params: { uri: string; diagnostics: { range: Range; severity?: number; message: string; source?: string }[] }): void {
  const file = uriFile(params.uri);
  const buffer = [...managing.keys()].find((b) => gnista.withCurrentBuffer(b, () => gnista.bufferFileName()) === file);
  if (!buffer) return;
  gnista.withCurrentBuffer(buffer, () => {
    clearDiagnostics(buffer);
    const overlays: number[] = [];
    for (const d of params.diagnostics) {
      let start = bufferPosition(d.range.start);
      let end = bufferPosition(d.range.end);
      // An empty range marks the thing at it, as flymake-diag-region does.
      if (end <= start) end = Math.min(gnista.lineEndPosition(start), start + 1);
      if (end <= start) start = Math.max(0, end - 1);
      const face = d.severity === 1 || d.severity === undefined ? "flymake-error" : d.severity === 2 ? "flymake-warning" : "flymake-note";
      const text = d.source ? `${d.source}: ${d.message}` : d.message;
      overlays.push(gnista.makeOverlay(start, end, { face, "flymake-diagnostic": text, "eglot-severity": d.severity ?? 1 }));
    }
    diagnosticOverlays.set(buffer, overlays);
  });
}

/** The diagnostics' overlays in the current buffer, in order. */
const diagnostics = (): number[] =>
  (diagnosticOverlays.get(gnista.currentBuffer().name ?? "") ?? []).filter((o) => gnista.overlayStart(o) !== undefined).sort((a, b) => gnista.overlayStart(a)! - gnista.overlayStart(b)!);

function gotoDiagnostic(n: number): void {
  const all = diagnostics();
  const here = gnista.point();
  const next = n > 0 ? all.find((o) => gnista.overlayStart(o)! > here) : [...all].reverse().find((o) => gnista.overlayStart(o)! < here);
  if (next === undefined) gnista.userError(n > 0 ? "No more Flymake diagnostics" : "No more Flymake diagnostics before point");
  gnista.gotoChar(gnista.overlayStart(next)!);
  gnista.message(String(gnista.overlayGet(next, "flymake-diagnostic") ?? ""));
}

gnista.defineCommand({ name: "flymake-goto-next-error", doc: "Go to the next diagnostic and show its message.", run: () => gotoDiagnostic(1) });
gnista.defineCommand({ name: "flymake-goto-prev-error", doc: "Go to the diagnostic before point and show its message.", run: () => gotoDiagnostic(-1) });

// --- What point is on, as eglot's eldoc functions -----------------------------

/** After a pause, a diagnostic's message at point, or else what the server says of the thing at point, in the echo area. */
let lastHoverAt: string | undefined;
function showAtPoint(): void {
  const server = currentServer();
  if (!server || gnista.minibufferDepth() > 0) return;
  const here = gnista.point();
  const at = `${gnista.currentBuffer().name}:${here}:${documents.get(gnista.currentBuffer().name!)?.version}`;
  if (at === lastHoverAt) return;
  lastHoverAt = at;
  const diagnostic = diagnostics().find((o) => gnista.overlayStart(o)! <= here && here < gnista.overlayEnd(o)!);
  if (diagnostic !== undefined) {
    gnista.message(String(gnista.overlayGet(diagnostic, "flymake-diagnostic")));
    return;
  }
  if (!hasCapability(server, "hoverProvider")) return;
  try {
    const hover = request(server, "textDocument/hover", { textDocument: textDocument(), position: lspPosition() }) as any;
    const text = hoverText(hover?.contents);
    if (text) gnista.letBind({ "message-log-max": null }, () => gnista.message(text));
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
  const point = gnista.makeMarker(gnista.point());
  for (const e of resolved) {
    gnista.deleteRegion(e.start, e.end);
    gnista.gotoChar(e.start);
    gnista.insert(e.text);
  }
  gnista.gotoChar(gnista.markerPosition(point)!);
  gnista.deleteMarker(point);
}

/** Applies a WorkspaceEdit to the files it names, visiting them, as eglot--apply-workspace-edit. */
function applyWorkspaceEdit(edit: any): void {
  const byFile: [string, { range: Range; newText: string }[]][] = [];
  for (const change of edit?.documentChanges ?? []) {
    if (change.textDocument) byFile.push([uriFile(change.textDocument.uri), change.edits]);
  }
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) byFile.push([uriFile(uri), edits as { range: Range; newText: string }[]]);
  for (const [file, edits] of byFile) {
    const buffer = gnista.findFileNoselect(file);
    gnista.withCurrentBuffer(buffer, () => applyTextEdits(edits));
  }
  if (byFile.length > 0) gnista.message(`[eglot] Edited ${byFile.length} file${byFile.length === 1 ? "" : "s"}`);
}

gnista.defineCommand({
  name: "eglot-rename",
  doc: "Rename the thing at point everywhere the server knows of it.",
  params: [{ name: "newname", prompt: () => "Rename to: " }],
  run: (newname) => {
    const server = requireServer();
    if (!hasCapability(server, "renameProvider")) gnista.userError("[eglot] Server can't rename");
    applyWorkspaceEdit(request(server, "textDocument/rename", { textDocument: textDocument(), position: lspPosition(), newName: newname }));
  },
});

gnista.defineCommand({
  name: "eglot-format-buffer",
  doc: "Have the server format the whole buffer.",
  run: () => {
    const server = requireServer();
    if (!hasCapability(server, "documentFormattingProvider")) gnista.userError("[eglot] Server can't format");
    const tabWidth = Number(gnista.variable("tab-width") ?? 8);
    const edits = request(server, "textDocument/formatting", {
      textDocument: textDocument(),
      options: { tabSize: tabWidth, insertSpaces: !truthy(gnista.variable("indent-tabs-mode")) },
    }) as { range: Range; newText: string }[] | null;
    if (edits) applyTextEdits(edits);
  },
});

gnista.defineCommand({
  name: "eglot-code-actions",
  doc: "Choose one of the changes the server offers for point, or the region, and make it.",
  run: () => {
    const server = requireServer();
    const [start, end] = gnista.regionActive() ? [Math.min(gnista.point(), gnista.mark()!), Math.max(gnista.point(), gnista.mark()!)] : [gnista.point(), gnista.point()];
    const here = diagnostics().filter((o) => gnista.overlayStart(o)! <= end && start <= gnista.overlayEnd(o)!);
    const actions = (request(server, "textDocument/codeAction", {
      textDocument: textDocument(),
      range: { start: lspPosition(start), end: lspPosition(end) },
      context: { diagnostics: here.map((o) => ({ range: { start: lspPosition(gnista.overlayStart(o)), end: lspPosition(gnista.overlayEnd(o)) }, message: String(gnista.overlayGet(o, "flymake-diagnostic")) })) },
    }) ?? []) as any[];
    if (actions.length === 0) gnista.userError("[eglot] No code actions here");
    const title = gnista.completingRead("[eglot] Pick an action: ", actions.map((a) => String(a.title)), { requireMatch: true });
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
    // Edits are sent once Gnista has been idle a moment, as eglot-send-changes-idle-time has it.
    gnista.runWithIdleTimer(Number(gnista.variable("eglot-send-changes-idle-time") ?? 0.5), true, () => {
      for (const server of servers) if (server.initialized && gnista.processLiveP(server.process)) flushChanges(server);
    }),
    gnista.runWithIdleTimer(0.5, true, showAtPoint),
  ];
}

function stopTimers(): void {
  for (const t of timers) gnista.cancelTimer(t);
  timers = [];
}
