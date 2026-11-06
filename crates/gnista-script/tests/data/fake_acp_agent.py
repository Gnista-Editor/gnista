"""An ACP agent for acp.ts's and agent-shell.ts's tests: it plays a script
of steps from the JSON file it is given, one message to a line on its
standard input and output, as acp.el's fakes replay a recording.

Each step is one of:

  {"send": {...}}       write this message, with "jsonrpc": "2.0" added
  {"expect": {...}}     read the client's next message and check it holds
                        these keys and values (a subset); a mismatch is
                        written to standard error and ends it with status 2
  {"stderr": "text"}    write this to standard error
  {"write": [path, text]} write a file, as an agent's own tools do
  {"sleep": seconds}
  {"exit": status}

Once the steps are done it waits for its input to close. Every message it
reads is written to the file $FAKE_ACP_LOG names, one to a line, if set.
"""
import json
import os
import sys
import time

log = os.environ.get("FAKE_ACP_LOG")


def send(message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    if not line:
        return None
    if log:
        with open(log, "a") as f:
            f.write(line if line.endswith("\n") else line + "\n")
    return json.loads(line)


def holds(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and holds(actual[k], v) for k, v in expected.items())
    return actual == expected


def main():
    with open(sys.argv[1]) as f:
        steps = json.load(f)
    for step in steps:
        if "send" in step:
            send(step["send"])
        elif "expect" in step:
            got = read()
            if got is None or not holds(got, step["expect"]):
                sys.stderr.write("expected %s, got %s\n" % (json.dumps(step["expect"]), json.dumps(got)))
                sys.stderr.flush()
                sys.exit(2)
        elif "stderr" in step:
            sys.stderr.write(step["stderr"])
            sys.stderr.flush()
        elif "write" in step:
            with open(step["write"][0], "w") as f:
                f.write(step["write"][1])
        elif "sleep" in step:
            time.sleep(step["sleep"])
        elif "exit" in step:
            sys.exit(step["exit"])
    while read() is not None:
        pass


main()
