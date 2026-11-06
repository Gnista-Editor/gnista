// Coding agents in a buffer, after Emacs's agent-shell
// (https://github.com/xenodium/agent-shell): M-x agent-shell starts an agent
// that speaks the Agent Client Protocol, such as Claude Code through
// claude-agent-acp, Gemini CLI or Codex, in the current project, and talks
// to it in an Org buffer, as Gnista's own agent buffer does (ADR 0019):
//
//   * You       what you ask, sent with C-c RET
//   * Agent     its reply as it streams in; each tool call a line, its
//               output or diff in a block below, folded once the turn ends,
//               and its plan as a checklist
//
// The agent asks before its tools act, and Gnista asks you, when nothing
// else is asking. It reads files through the buffers visiting them, so it
// sees what is not saved yet, and writes them through those buffers, an
// edit that undoes, then saves. C-c C-k stops the turn. Logging in is the
// agent's: log in with it in a terminal once, and Gnista never sees a key
// (ADR 0061). The protocol is acp.ts's.
//
// This follows agent-shell's design, not its code: the buffer is Gnista's
// Org agent buffer, not shell-maker's.

import * as acp from "acp";
import { findBufferVisiting } from "files";
import { current as projectRoot } from "project";
import { executableFind, truthy } from "subr";

gnista.defineVariable({
  name: "agent-shell-agents",
  value: [
    ["claude", ["claude-agent-acp"]],
    ["gemini", ["gemini", "--experimental-acp"]],
    ["codex", ["codex-acp"]],
    ["goose", ["goose", "acp"]],
  ],
  doc:
    "The agents M-x agent-shell can start: a list of [name, command], or [name, command, environment], the command a " +
    'program and its arguments that speak the Agent Client Protocol, and the environment "VAR=value" strings. ' +
    "Claude Code's is claude-agent-acp: npm install -g @agentclientprotocol/claude-agent-acp.",
});
gnista.defineVariable({
  name: "agent-shell-gnista-tools",
  value: true,
  doc:
    "Whether agents also get Gnista's own tools, its commands, keys and buffers, through gnista-mcp connected to this " +
    "editor, as an MCP server of their session. Writing files, discarding unsaved work, quitting and running code " +
    "through them ask you first. Needs this Gnista to answer on a socket (gnista-mcp-socket) and gnista-mcp beside " +
    "it or on PATH.",
});
gnista.defineVariable({
  name: "agent-shell-default-agent",
  value: null,
  doc: "The agent M-x agent-shell starts without asking, by its name in agent-shell-agents; null to ask.",
});

/** The most of a tool call's output the buffer shows. */
const SHOWN_OUTPUT = 4000;

// A region the buffer keeps up to date, a tool call's or the plan's, lies
// between two markers: its start advances past text put in at it, so
// rewriting a region before it leaves it where it is, and its end does
// not, so text put in after it is not taken into it.

/** A tool call as the buffer shows it, kept up to date as the agent reports. */
interface ToolCall {
  title: string;
  status: string;
  /** The files it names, by its diffs and locations. */
  paths: Set<string>;
  /** Its text, rendered: the line and its block. */
  content: string;
  /** Where its line starts, and where its block ends. */
  start: gnista.Marker;
  end: gnista.Marker;
}

/** A question the agent asked, waiting for the user. */
interface Permission {
  id: number | string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}

interface Shell {
  agent: string;
  command: string[];
  env: string[];
  buffer: string;
  directory: string;
  client: acp.Client;
  sessionId?: string;
  /** Whether a turn is going: from sending until the agent answers the prompt. */
  busy: boolean;
  /** Whether C-c C-k stopped the turn while it was starting. */
  cancelled: boolean;
  /** What is open at the buffer's end: the agent's text, its thinking in a block, or nothing. */
  open: "text" | "thought" | undefined;
  toolCalls: Map<string, ToolCall>;
  plan?: { start: gnista.Marker; end: gnista.Marker };
  /** Where this turn's blocks start, to fold them once it ends. */
  blocks: gnista.Marker[];
  permissions: Permission[];
  asking: boolean;
  askTimer?: number;
  usage?: { used: number; size: number };
  mode?: string;
  /** The end of what the agent wrote to standard error, for when it fails. */
  stderrTail: string;
}

const shells = new Map<string, Shell>();

gnista.defineMajorMode({
  name: "agent-shell-mode",
  modeName: "Agent Shell",
  parent: "org-mode",
  doc:
    "The mode of a conversation with a coding agent, started with M-x agent-shell.\n\n" +
    "Type a request under the last * You heading and send it with C-c RET. The agent's reply streams in under " +
    "* Agent; each tool call is a line, with its output or diff in the block below it, folded once the turn ends " +
    "(TAB shows it). The agent asks before its tools act. C-c C-k stops the turn.",
  bindings: { "C-c RET": "agent-shell-send", "C-c C-k": "agent-shell-interrupt" },
  setup: () => {
    gnista.call("visual-line-mode");
    // Agents' tools, gnista-mcp's included, act in other windows than this one.
    gnista.setVariable("agent-buffer", true);
  },
});

// --- The buffer -----------------------------------------------------------------

/** Runs `fn` in the shell's buffer, if it is still there. */
function inBuffer<T>(shell: Shell, fn: () => T): T | undefined {
  if (gnista.getBuffer(shell.buffer) === undefined) return undefined;
  return gnista.withCurrentBuffer(shell.buffer, fn);
}

/**
 * Puts text in the shell's buffer at `at`, its end by default, keeping
 * point and the windows that were at the end there, as output follows in a
 * shell. Returns where it went.
 */
function put(shell: Shell, text: string, at?: number): number {
  return (
    inBuffer(shell, () => {
      const end = gnista.bufferSize();
      const where = at ?? end;
      const point = gnista.point();
      const following = gnista.windowList().filter((w) => gnista.windowBuffer(w) === shell.buffer && gnista.windowPoint(w) === end);
      gnista.gotoChar(where);
      gnista.insert(text);
      const after = point === end || point > where ? point + text.length : point;
      gnista.gotoChar(point === end ? gnista.bufferSize() : after);
      for (const w of following) {
        if (w !== gnista.selectedWindow()) gnista.setWindowPoint(w, gnista.bufferSize());
      }
      return where;
    }) ?? 0
  );
}

/** Replaces the text from `start` to `end` in the shell's buffer, keeping point after it where it was. */
function replace(shell: Shell, start: number, end: number, text: string): void {
  inBuffer(shell, () => {
    const point = gnista.point();
    gnista.deleteRegion(start, end);
    gnista.gotoChar(start);
    gnista.insert(text);
    const moved = point >= end ? point - (end - start) + text.length : Math.min(point, start + text.length);
    gnista.gotoChar(moved);
  });
}

function atLineStart(shell: Shell): boolean {
  return inBuffer(shell, () => gnista.bufferSize() === 0 || gnista.bufferText(gnista.bufferSize() - 1, gnista.bufferSize()) === "\n") ?? true;
}

/** Ends the buffer's last line, if it is not ended. */
function startLine(shell: Shell): void {
  if (!atLineStart(shell)) put(shell, "\n");
}

/** The agent's text, a line that starts with * indented so it makes no heading. */
function putReply(shell: Shell, text: string): void {
  let lineStart = atLineStart(shell);
  let out = "";
  for (const c of text) {
    if (lineStart && c === "*") out += " ";
    out += c;
    lineStart = c === "\n";
  }
  put(shell, out);
}

/** Text in an example block, each line indented, so nothing in it reads as Org or ends the block. */
function exampleBlock(text: string, label = ""): string {
  let shown = [...text].slice(0, SHOWN_OUTPUT).join("");
  if ([...text].length > SHOWN_OUTPUT) shown += "…";
  const lines = shown.replace(/\n$/, "").split("\n").map((l) => `  ${l}`);
  return `#+begin_example\n${label}${lines.join("\n")}\n#+end_example\n`;
}

/** Closes what is open at the end: the agent's paragraph, or its thinking's block. */
function closeOpen(shell: Shell): void {
  if (shell.open === "thought") {
    startLine(shell);
    put(shell, "#+end_example\n");
  } else if (shell.open === "text") {
    startLine(shell);
  }
  shell.open = undefined;
}

/** A note in brackets on a line of its own. */
function note(shell: Shell, text: string): void {
  closeOpen(shell);
  startLine(shell);
  put(shell, `[${text}]\n`);
}

// --- Tool calls, plans and diffs --------------------------------------------------

/** Old and new text as lines taken out and put in, the lines both share at the ends left out. */
export function diffLines(path: string, oldText: string | null | undefined, newText: string): string {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines = [`--- ${path}`, `+++ ${path}`, `@@ line ${start + 1} @@`];
  for (const l of a.slice(start, endA)) lines.push(`-${l}`);
  for (const l of b.slice(start, endB)) lines.push(`+${l}`);
  return lines.join("\n");
}

/** What a tool call's content shows: its text, diffs and terminals, one after another. */
function toolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c?.type === "content" && c.content?.type === "text") parts.push(String(c.content.text ?? ""));
    else if (c?.type === "content" && c.content?.type === "resource_link") parts.push(String(c.content.uri ?? c.content.name ?? ""));
    else if (c?.type === "diff") parts.push(diffLines(String(c.path ?? ""), c.oldText, String(c.newText ?? "")));
    else if (c?.type === "terminal") parts.push(`[terminal ${c.terminalId}]`);
  }
  return parts.filter((p) => p !== "").join("\n");
}

const STATUS: { [status: string]: string } = { pending: " …", in_progress: " …", completed: "", failed: " [failed]" };

function renderToolCall(call: ToolCall): string {
  const line = `→ ${call.title.replace(/\n/g, " ")}${STATUS[call.status] ?? ""}\n`;
  return call.content === "" ? line : line + exampleBlock(call.content, call.status === "failed" ? "Failed:\n" : "");
}

/** Shows a tool call, or brings one shown up to date. */
function showToolCall(shell: Shell, update: acp.Json, first: boolean): void {
  const id = String(update.toolCallId ?? "");
  let call = shell.toolCalls.get(id);
  if (call === undefined) {
    closeOpen(shell);
    startLine(shell);
    const at = inBuffer(shell, () => gnista.bufferSize()) ?? 0;
    call = {
      title: String(update.title ?? update.kind ?? "tool"),
      status: String(update.status ?? "pending"),
      content: "",
      paths: new Set(),
      start: gnista.makeMarker(at, { buffer: shell.buffer, advances: true }),
      end: gnista.makeMarker(at, { buffer: shell.buffer }),
    };
    shell.toolCalls.set(id, call);
  } else if (first) {
    return;
  }
  if (update.title) call.title = String(update.title);
  const finished = update.status && update.status !== call.status && (update.status === "completed" || update.status === "failed");
  if (update.status) call.status = String(update.status);
  for (const c of Array.isArray(update.content) ? update.content : []) if (c?.type === "diff" && c.path) call.paths.add(String(c.path));
  for (const l of Array.isArray(update.locations) ? update.locations : []) if (l?.path) call.paths.add(String(l.path));
  if (update.content !== undefined && update.content !== null) call.content = toolContent(update.content);
  else if (update.rawOutput !== undefined && call.content === "" && (call.status === "completed" || call.status === "failed")) {
    call.content = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2);
  }
  const start = gnista.markerPosition(call.start) ?? 0;
  const end = gnista.markerPosition(call.end) ?? start;
  const text = renderToolCall(call);
  replace(shell, start, end, text);
  gnista.setMarker(call.start, start, shell.buffer);
  gnista.setMarker(call.end, start + text.length, shell.buffer);
  if (finished) revertTouched(call.paths);
}

/**
 * Brings the buffers visiting files a tool call touched up to date, where
 * the agent wrote them itself rather than through fs/write_text_file, as
 * Claude Code's adapter does: a buffer with no unsaved changes whose file
 * changed is reverted, as auto-revert-mode would; one with changes is left
 * for the user.
 */
function revertTouched(paths: Set<string>): void {
  for (const path of paths) {
    const buffer = findBufferVisiting(path);
    if (buffer === undefined) continue;
    gnista.withCurrentBuffer(buffer, () => {
      if (!gnista.bufferModified() && gnista.visitedFileChanged() && gnista.fileExists(path)) gnista.call("revert-buffer-quick");
    });
  }
}

const PLAN_MARK: { [status: string]: string } = { pending: "[ ]", in_progress: "[-]", completed: "[X]" };

/** Shows the agent's plan as a checklist, replacing the plan it showed before in this turn. */
function showPlan(shell: Shell, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  const text = `Plan:\n${entries.map((e) => `- ${PLAN_MARK[e?.status] ?? "[ ]"} ${String(e?.content ?? "").replace(/\n/g, " ")}`).join("\n")}\n`;
  if (shell.plan === undefined) {
    closeOpen(shell);
    startLine(shell);
    const at = put(shell, text);
    shell.plan = { start: gnista.makeMarker(at, { buffer: shell.buffer, advances: true }), end: gnista.makeMarker(at + text.length, { buffer: shell.buffer }) };
    return;
  }
  const start = gnista.markerPosition(shell.plan.start) ?? 0;
  const end = gnista.markerPosition(shell.plan.end) ?? start;
  replace(shell, start, end, text);
  gnista.setMarker(shell.plan.end, start + text.length, shell.buffer);
}

/** Takes in what the agent reports of its session. */
function onUpdate(shell: Shell, notification: acp.Json): void {
  if (notification.method !== "session/update") return;
  const params = notification.params ?? {};
  if (shell.sessionId !== undefined && params.sessionId !== shell.sessionId) return;
  const update = params.update ?? {};
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content?.type === "text") {
        if (shell.open === "thought") closeOpen(shell);
        if (shell.open === undefined) startLine(shell);
        shell.open = "text";
        putReply(shell, String(update.content.text ?? ""));
      }
      break;
    case "agent_thought_chunk":
      if (update.content?.type === "text") {
        if (shell.open !== "thought") {
          closeOpen(shell);
          startLine(shell);
          put(shell, "Thinking:\n");
          const at = put(shell, "#+begin_example\n");
          shell.blocks.push(gnista.makeMarker(at, { buffer: shell.buffer, advances: true }));
          shell.open = "thought";
        }
        // Indented, as in every example block, so a line of it cannot end the block.
        const text = String(update.content.text ?? "");
        const indented = text.replace(/\n(?!$)/g, "\n  ");
        put(shell, atLineStart(shell) ? `  ${indented}` : indented);
      }
      break;
    case "tool_call":
      showToolCall(shell, update, true);
      break;
    case "tool_call_update":
      showToolCall(shell, update, false);
      break;
    case "plan":
      showPlan(shell, update.entries);
      break;
    case "usage_update":
      if (typeof update.used === "number") shell.usage = { used: update.used, size: Number(update.size ?? 0) };
      break;
    case "current_mode_update":
      if (update.currentModeId) shell.mode = String(update.currentModeId);
      break;
    default:
      // user_message_chunk (a session replayed), available_commands_update and the rest.
      break;
  }
}

// --- What the agent asks -------------------------------------------------------------

/** "Edit `src/main.rs`" as "edit src/main.rs", for "Let claude ...?". */
function lowerFirst(title: string): string {
  const t = title.replace(/`/g, "");
  return t.length > 1 && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t;
}

/** The keys a permission question takes, and the option each picks: y once, ! always, n no. */
function choices(options: Permission["options"]): Map<string, string> {
  const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find((o) => o !== undefined)?.optionId;
  const keys = new Map<string, string>();
  const once = pick("allow_once", "allow_always");
  const always = pick("allow_always");
  const no = pick("reject_once", "reject_always");
  if (once) keys.set("y", once);
  if (always && always !== once) keys.set("!", always);
  if (no) keys.set("n", no);
  return keys;
}

/**
 * Asks the user the agent's permission questions, one at a time, once
 * nothing else waits for their keys: never inside another question, so the
 * agent can neither answer for the user nor take keys meant for something
 * else. Until then it looks again shortly.
 */
function askPermissions(shell: Shell): void {
  shell.askTimer = undefined;
  if (shell.asking || shell.permissions.length === 0) return;
  if (gnista.waitingForInput() !== undefined) {
    shell.askTimer = gnista.runWithTimer(0.1, null, () => askPermissions(shell));
    return;
  }
  const permission = shell.permissions[0];
  const keys = choices(permission.options);
  const listed = [...keys.keys()].map((k) => (k === "!" ? "! for always" : k)).join(", ").replace(/, ([^,]*)$/, " or $1");
  shell.asking = true;
  let answer: string | undefined;
  try {
    answer = gnista.readCharChoice(`Let ${shell.agent} ${lowerFirst(permission.title)}? (${listed}) `, [...keys.keys()].join(""));
  } catch {
    answer = undefined;
  } finally {
    shell.asking = false;
  }
  // C-c C-k may have answered it meanwhile.
  if (shell.permissions[0] !== permission) return;
  shell.permissions.shift();
  const optionId = answer === undefined ? undefined : keys.get(answer);
  const chosen = permission.options.find((o) => o.optionId === optionId);
  note(shell, chosen ? `${chosen.name}: ${permission.title}` : `Cancelled: ${permission.title}`);
  acp.sendResponse({
    client: shell.client,
    response: acp.makeSessionRequestPermissionResponse({ requestId: permission.id, ...(optionId ? { optionId } : { cancelled: true }) }),
  });
  if (shell.permissions.length > 0) shell.askTimer = gnista.runWithTimer(0, null, () => askPermissions(shell));
}

/** Answers every question still waiting as cancelled, as the turn stopped. */
function cancelPermissions(shell: Shell): void {
  for (const p of shell.permissions.splice(0)) {
    acp.sendResponse({ client: shell.client, response: acp.makeSessionRequestPermissionResponse({ requestId: p.id, cancelled: true }) });
  }
  if (shell.askTimer !== undefined) gnista.cancelTimer(shell.askTimer);
  shell.askTimer = undefined;
}

/** A file's lines from `line`, 1-based, at most `limit` of them. */
function someLines(text: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const from = Math.max(0, (line ?? 1) - 1);
  return lines.slice(from, limit === undefined ? undefined : from + limit).join("\n");
}

/** What a file holds: the text of the buffer visiting it, saved or not, or the file's. */
function readText(path: string): string {
  const visiting = findBufferVisiting(path);
  if (visiting !== undefined) return gnista.withCurrentBuffer(visiting, () => gnista.bufferText(0, gnista.bufferSize()));
  if (!gnista.fileReadableP(path)) gnista.signal("file-missing", `Opening input file: No such file or directory, ${path}`);
  const temp = gnista.getBufferCreate(" *agent-shell-read*");
  try {
    return gnista.withCurrentBuffer(temp, () => {
      gnista.deleteRegion(0, gnista.bufferSize());
      gnista.insertFileContents(path);
      return gnista.bufferText(0, gnista.bufferSize());
    });
  } finally {
    gnista.call("kill-buffer", temp.name!);
  }
}

/**
 * Writes a file through the buffer visiting it, or one made to visit it:
 * its text replaced, an edit that undoes, point kept at its line and
 * column, then saved.
 */
function writeText(path: string, content: string): void {
  const dir = gnista.fileNameDirectory(path);
  if (dir && !gnista.fileExistsP(dir)) gnista.makeDirectory(dir, { parents: true });
  const buffer = findBufferVisiting(path) ?? gnista.findFileNoselect(path);
  gnista.withCurrentBuffer(buffer, () => {
    if (gnista.bufferText(0, gnista.bufferSize()) !== content) {
      const point = gnista.point();
      const before = gnista.bufferText(0, point);
      const line = before.split("\n").length - 1;
      const column = point - (before.lastIndexOf("\n") + 1);
      gnista.deleteRegion(0, gnista.bufferSize());
      gnista.insert(content);
      const lines = content.split("\n");
      const row = Math.min(line, lines.length - 1);
      let at = 0;
      for (let i = 0; i < row; i++) at += lines[i].length + 1;
      gnista.gotoChar(at + Math.min(column, lines[row].length));
    }
    gnista.call("save-buffer");
  });
}

/** Answers what the agent asks of the editor. */
function onRequest(shell: Shell, request: acp.Json): void {
  const params = request.params ?? {};
  const fail = (e: unknown) => acp.makeError({ code: -32603, message: e instanceof Error ? e.message : String((e as any)?.message ?? e) });
  switch (request.method) {
    case "session/request_permission":
      shell.permissions.push({
        id: request.id,
        title: String(params.toolCall?.title ?? params.toolCall?.kind ?? "use a tool"),
        options: Array.isArray(params.options) ? params.options : [],
      });
      if (params.toolCall?.toolCallId) showToolCall(shell, params.toolCall, !shell.toolCalls.has(String(params.toolCall.toolCallId)));
      // Asked from a timer of its own, so the agent's updates go on coming in meanwhile.
      if (shell.askTimer === undefined && !shell.asking) shell.askTimer = gnista.runWithTimer(0, null, () => askPermissions(shell));
      break;
    case "fs/read_text_file": {
      let response: acp.Response;
      try {
        const line = typeof params.line === "number" ? params.line : undefined;
        const limit = typeof params.limit === "number" ? params.limit : undefined;
        response = acp.makeFsReadTextFileResponse({ requestId: request.id, content: someLines(readText(String(params.path)), line, limit) });
      } catch (e) {
        response = acp.makeFsReadTextFileResponse({ requestId: request.id, error: fail(e) });
      }
      acp.sendResponse({ client: shell.client, response });
      break;
    }
    case "fs/write_text_file": {
      let response: acp.Response;
      try {
        writeText(String(params.path), String(params.content ?? ""));
        response = acp.makeFsWriteTextFileResponse({ requestId: request.id });
      } catch (e) {
        response = acp.makeFsWriteTextFileResponse({ requestId: request.id, error: fail(e) });
      }
      acp.sendResponse({ client: shell.client, response });
      break;
    }
    default:
      acp.sendResponse({
        client: shell.client,
        response: { requestId: request.id, error: acp.makeError({ code: -32601, message: `Method not found: ${request.method}` }) as unknown as acp.Json },
      });
  }
}

// --- Sessions and turns --------------------------------------------------------------

function makeShellClient(shell: Shell): acp.Client {
  const client = acp.makeClient({ command: shell.command[0], commandParams: shell.command.slice(1), environmentVariables: shell.env, contextBuffer: shell.buffer });
  acp.subscribeToNotifications({ client, onNotification: (n) => onUpdate(shell, n) });
  acp.subscribeToRequests({ client, onRequest: (r) => onRequest(shell, r) });
  acp.subscribeToErrors({
    client,
    onError: (e: any) => {
      if (typeof e?.code === "number" && e.code === -32603) {
        shell.stderrTail = (shell.stderrTail + String(e.message ?? "")).slice(-2000);
      } else {
        // An API error the agent reported, parsed.
        note(shell, `${shell.agent}: ${String(e?.message ?? JSON.stringify(e))}`);
      }
    },
  });
  return client;
}

/** How to log in to an agent: Claude Code's adapter uses claude's own login. */
function loginHint(shell: Shell): string {
  if (shell.command.some((part) => part.includes("claude-agent-acp"))) return "run claude in a terminal and log in there (/login)";
  return `log in with ${shell.command.find((p) => !p.startsWith("-") && p !== "npx") ?? shell.command[0]} in a terminal`;
}

/** What an error the agent answered with says, with what it wrote to standard error if it stopped. */
function describe(shell: Shell, error: acp.RpcError | undefined): string {
  const message = String(error?.message ?? "failed");
  if (error?.code === -32000 || /auth/i.test(message)) {
    return `${shell.agent} needs you to log in: ${loginHint(shell)}, then send again (${message})`;
  }
  const tail = shell.stderrTail.trim();
  return tail !== "" && message.startsWith("Agent process ended") ? `${message}\n${tail.split("\n").slice(-5).join("\n")}` : message;
}

/** Ends the turn: a note if it did not end as asked, its blocks folded, and a heading for the next request. */
function finish(shell: Shell, text?: string): void {
  shell.busy = false;
  shell.cancelled = false;
  cancelPermissions(shell);
  closeOpen(shell);
  if (text) note(shell, text);
  if (shell.usage) note(shell, `${shell.usage.used} of ${shell.usage.size} tokens of context used`);
  startLine(shell);
  put(shell, "* You\n");
  inBuffer(shell, () => {
    gnista.saveExcursion(() => {
      for (const call of shell.toolCalls.values()) {
        const start = gnista.markerPosition(call.start);
        if (start !== undefined && call.content !== "") {
          // The block starts on the line after the call's.
          gnista.gotoChar(start + renderToolCall({ ...call, content: "" }).length);
          gnista.call("org-cycle");
        }
      }
      for (const block of shell.blocks) {
        const at = gnista.markerPosition(block);
        if (at !== undefined) {
          gnista.gotoChar(at);
          gnista.call("org-cycle");
        }
      }
    });
  });
  for (const call of shell.toolCalls.values()) {
    gnista.deleteMarker(call.start);
    gnista.deleteMarker(call.end);
  }
  shell.toolCalls.clear();
  for (const m of shell.blocks.splice(0)) gnista.deleteMarker(m);
  if (shell.plan) {
    gnista.deleteMarker(shell.plan.start);
    gnista.deleteMarker(shell.plan.end);
    shell.plan = undefined;
  }
}

/**
 * Gnista's own MCP server for a session: gnista-mcp, beside this program
 * or on PATH, connected to this editor's socket, so the agent's calls act in
 * the editor the user sees and ask before what they cannot undo. Undefined
 * when agent-shell-gnista-tools is off or either is missing.
 */
export function gnistaMcpServer(): acp.Json | undefined {
  if (!truthy(gnista.variable("agent-shell-gnista-tools"))) return undefined;
  const socket = gnista.variable("gnista-mcp-socket");
  if (typeof socket !== "string" || socket === "") return undefined;
  const dir = gnista.variable("invocation-directory");
  const beside = typeof dir === "string" ? `${dir}gnista-mcp` : undefined;
  const program = beside !== undefined && gnista.fileExecutableP(beside) ? beside : executableFind("gnista-mcp");
  if (program === undefined) return undefined;
  return { name: "gnista", command: program, args: ["--socket", socket], env: [] };
}

/** What the agent is told of Gnista's tools, after its own system prompt. */
const GNISTA_TOOLS_PROMPT =
  "You are running inside Gnista, a text editor that works the way Emacs works, and the user is talking to you " +
  "from it. The gnista MCP server's tools act in that editor, in the window the user works in: its commands by " +
  "name (find-file, save-buffer, org-agenda and the rest), keys, and the text of its buffers, unsaved changes " +
  "included. Use them to show the user what you are working on, or when they ask for something in the editor. " +
  "Writing files, discarding unsaved changes, quitting and running code through them wait for the user's approval; " +
  "if a call's result says the user allowed it, make the same call again.";

/** Sends the prompt, starting the agent and its session first if need be. */
function prompt(shell: Shell, text: string): void {
  const failed = (error: acp.RpcError) => finish(shell, `Error: ${describe(shell, error)}`);
  const send = () => {
    if (shell.cancelled) return finish(shell, "Stopped.");
    acp.sendRequest({
      client: shell.client,
      request: acp.makeSessionPromptRequest({ sessionId: shell.sessionId!, prompt: [{ type: "text", text }] }),
      onSuccess: (result: any) => {
        const reason = String(result?.stopReason ?? "end_turn");
        const notes: { [reason: string]: string } = {
          cancelled: "Stopped.",
          max_tokens: "The agent reached its most tokens for a reply.",
          max_turn_requests: "The agent reached its most requests for a turn.",
          refusal: "The agent declined.",
        };
        finish(shell, notes[reason]);
      },
      onFailure: failed,
    });
  };
  if (shell.sessionId !== undefined && acp.clientStartedP(shell.client)) return send();
  // A new agent, or one that stopped: start it, and a session in the project.
  if (shell.sessionId !== undefined) {
    acp.shutdown({ client: shell.client });
    shell.client = makeShellClient(shell);
    shell.sessionId = undefined;
    note(shell, `Starting ${shell.agent} again, in a new session.`);
  }
  shell.stderrTail = "";
  try {
    acp.sendRequest({
      client: shell.client,
      request: acp.makeInitializeRequest({
        protocolVersion: 1,
        clientInfo: { name: "gnista", title: "Gnista", version: String(gnista.variable("gnista-version") ?? "") },
        readTextFileCapability: true,
        writeTextFileCapability: true,
      }),
      onSuccess: () => {
        if (shell.cancelled) return finish(shell, "Stopped.");
        acp.sendRequest({
          client: shell.client,
          request: (() => {
            const server = gnistaMcpServer();
            return server
              ? acp.makeSessionNewRequest({ cwd: shell.directory, mcpServers: [server], meta: { systemPrompt: { append: GNISTA_TOOLS_PROMPT } } })
              : acp.makeSessionNewRequest({ cwd: shell.directory });
          })(),
          onSuccess: (result: any) => {
            shell.sessionId = String(result?.sessionId ?? "");
            if (result?.modes?.currentModeId) shell.mode = String(result.modes.currentModeId);
            send();
          },
          onFailure: failed,
        });
      },
      onFailure: failed,
    });
  } catch (e) {
    // Its program is not installed, most likely.
    const message = e instanceof Error ? e.message : String((e as any)?.message ?? e);
    finish(shell, `Error: ${message}${shell.command.some((p) => p.includes("claude-agent-acp")) ? "; npm install -g @agentclientprotocol/claude-agent-acp installs it" : ""}`);
  }
}

/** The agents agent-shell-agents names, as [name, command, environment]. */
function agents(): [string, string[], string[]][] {
  const list = gnista.variable("agent-shell-agents");
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is gnista.Value[] => Array.isArray(a) && typeof a[0] === "string" && Array.isArray(a[1]))
    .map((a) => [String(a[0]), (a[1] as gnista.Value[]).map(String), Array.isArray(a[2]) ? (a[2] as gnista.Value[]).map(String) : []]);
}

/** Opens a conversation with an agent, by its name in agent-shell-agents, in another window. */
export function start(name: string): string {
  const agent = agents().find((a) => a[0] === name);
  if (agent === undefined) gnista.userError(`No agent named ${name} in agent-shell-agents`);
  // The project's root, or the directory of the buffer it was started from.
  const directory = gnista.expandFileName(projectRoot() ?? ".");
  const buffer = `*agent-shell: ${name}*`;
  const exists = gnista.getBuffer(buffer) !== undefined && shells.has(buffer);
  gnista.call("pop-to-buffer", buffer);
  if (!exists) {
    gnista.call("agent-shell-mode");
    gnista.makeLocalVariable("default-directory");
    gnista.setVariable("default-directory", gnista.fileNameAsDirectory(directory));
    gnista.insert("* You\n");
    gnista.setBufferModified(false);
    const shell: Shell = {
      agent: name,
      command: agent![1],
      env: agent![2],
      buffer,
      directory,
      client: undefined as unknown as acp.Client,
      busy: false,
      cancelled: false,
      open: undefined,
      toolCalls: new Map(),
      blocks: [],
      permissions: [],
      asking: false,
      stderrTail: "",
    };
    shell.client = makeShellClient(shell);
    shells.set(buffer, shell);
  }
  return buffer;
}

gnista.defineCommand({
  name: "agent-shell",
  doc:
    "Talk to a coding agent in a buffer of its own, in another window: one of agent-shell-agents, asked for unless " +
    "agent-shell-default-agent names one. Type a request under * You and send it with C-c RET. The agent works in " +
    "the current project, and asks before its tools act.",
  run: async () => {
    const preset = gnista.variable("agent-shell-default-agent");
    const name =
      typeof preset === "string" && preset !== ""
        ? preset
        : await gnista.completingRead("Agent: ", agents().map((a) => a[0]), { requireMatch: true });
    start(name);
  },
});

gnista.defineCommand({
  name: "agent-shell-anthropic-start-claude-code",
  doc: "Talk to Claude Code, through claude-agent-acp, in a buffer of its own: M-x agent-shell with the claude agent.",
  run: () => {
    start("claude");
  },
});

/** The shell of the current buffer, or an error saying it is not one. */
function currentShell(): Shell {
  const shell = shells.get(gnista.bufferName() ?? "");
  if (shell === undefined) gnista.userError("Not an agent shell; use M-x agent-shell");
  return shell!;
}

gnista.defineCommand({
  name: "agent-shell-send",
  doc: "Send the request under the last * You heading to the agent.",
  run: () => {
    const shell = currentShell();
    const text = gnista.bufferText(0, gnista.bufferSize());
    const at = text.lastIndexOf("* You\n");
    if (at < 0) gnista.userError("Type a request under a * You heading");
    const request = text.slice(at + "* You\n".length).trim();
    if (request === "") gnista.userError("Type a request under the last * You heading first");
    if (shell.busy) gnista.userError("The agent is still working; C-c C-k stops it");
    shell.busy = true;
    shell.cancelled = false;
    startLine(shell);
    put(shell, "\n* Agent\n");
    gnista.gotoChar(gnista.bufferSize());
    prompt(shell, request);
  },
});

gnista.defineCommand({
  name: "agent-shell-interrupt",
  doc: "Stop the agent's turn in this buffer: it is told to cancel, and its questions are answered as cancelled.",
  run: () => {
    const shell = currentShell();
    if (!shell.busy) gnista.userError("The agent is not working on anything");
    cancelPermissions(shell);
    if (shell.sessionId !== undefined && acp.clientStartedP(shell.client)) {
      acp.sendNotification({ client: shell.client, notification: acp.makeSessionCancelNotification({ sessionId: shell.sessionId }) });
    } else {
      shell.cancelled = true;
    }
  },
});

// Killing a shell's buffer stops its agent.
gnista.addHook("kill-buffer-hook", () => {
  const name = gnista.bufferName() ?? "";
  const shell = shells.get(name);
  if (shell === undefined) return;
  shells.delete(name);
  cancelPermissions(shell);
  acp.shutdown({ client: shell.client });
});
