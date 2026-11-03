"""A language server for eglot's tests: it answers the requests eglot sends
about a document whose words are its identifiers, and reports a warning at
every word "bad"."""
import json
import re
import sys

docs = {}


def send(message):
    body = json.dumps({"jsonrpc": "2.0", **message}).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    sys.stdout.buffer.flush()


def read():
    length = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        if line in (b"\r\n", b"\n"):
            break
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":")[1])
    return json.loads(sys.stdin.buffer.read(length))


def word_at(text, line, character):
    row = text.split("\n")[line]
    for m in re.finditer(r"\w+", row):
        if m.start() <= character <= m.end():
            return m.group(0)
    return None


def places(uri, word, first_only):
    out = []
    for n, row in enumerate(docs[uri].split("\n")):
        for m in re.finditer(r"\b%s\b" % re.escape(word), row):
            out.append({"uri": uri, "range": {"start": {"line": n, "character": m.start()}, "end": {"line": n, "character": m.end()}}})
            if first_only:
                return out
    return out


def diagnose(uri):
    diagnostics = []
    for n, row in enumerate(docs[uri].split("\n")):
        for m in re.finditer(r"\bbad\b", row):
            diagnostics.append({"range": {"start": {"line": n, "character": m.start()}, "end": {"line": n, "character": m.end()}}, "severity": 2, "source": "fake", "message": "bad word"})
    send({"method": "textDocument/publishDiagnostics", "params": {"uri": uri, "diagnostics": diagnostics}})


while True:
    msg = read()
    method, params, mid = msg.get("method"), msg.get("params"), msg.get("id")
    if method == "initialize":
        send({"id": mid, "result": {"capabilities": {"textDocumentSync": 1, "completionProvider": {}, "hoverProvider": True, "definitionProvider": True, "referencesProvider": True, "renameProvider": True, "documentFormattingProvider": True}}})
    elif method == "textDocument/didOpen":
        docs[params["textDocument"]["uri"]] = params["textDocument"]["text"]
        diagnose(params["textDocument"]["uri"])
    elif method == "textDocument/didChange":
        docs[params["textDocument"]["uri"]] = params["contentChanges"][-1]["text"]
        diagnose(params["textDocument"]["uri"])
    elif method == "textDocument/definition":
        uri, pos = params["textDocument"]["uri"], params["position"]
        word = word_at(docs[uri], pos["line"], pos["character"])
        send({"id": mid, "result": places(uri, word, True) if word else []})
    elif method == "textDocument/references":
        uri, pos = params["textDocument"]["uri"], params["position"]
        word = word_at(docs[uri], pos["line"], pos["character"])
        send({"id": mid, "result": places(uri, word, False) if word else []})
    elif method == "textDocument/completion":
        # The words of the document, not the one being typed, as a server offers.
        uri, pos = params["textDocument"]["uri"], params["position"]
        typed = word_at(docs[uri], pos["line"], pos["character"])
        words = sorted(set(re.findall(r"\w+", docs[uri])) - {typed})
        send({"id": mid, "result": {"isIncomplete": False, "items": [{"label": w} for w in words]}})
    elif method == "textDocument/hover":
        uri, pos = params["textDocument"]["uri"], params["position"]
        word = word_at(docs[uri], pos["line"], pos["character"])
        send({"id": mid, "result": {"contents": {"kind": "plaintext", "value": "the word %s" % word}} if word else None})
    elif method == "textDocument/rename":
        uri, pos = params["textDocument"]["uri"], params["position"]
        word = word_at(docs[uri], pos["line"], pos["character"])
        edits = [{"range": p["range"], "newText": params["newName"]} for p in places(uri, word, False)]
        send({"id": mid, "result": {"changes": {uri: edits}}})
    elif method == "textDocument/formatting":
        text = docs[params["textDocument"]["uri"]]
        lines = text.split("\n")
        send({"id": mid, "result": [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": len(lines) - 1, "character": len(lines[-1])}}, "newText": "\n".join(l.rstrip() for l in lines)}]})
    elif method == "shutdown":
        send({"id": mid, "result": None})
    elif method == "exit":
        sys.exit(0)
    elif mid is not None:
        send({"id": mid, "result": None})
