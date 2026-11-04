# 0037. Pseudo-terminals, network processes and process codings

Status: accepted · 2026-10-30

## Context

Gnista's processes ran on pipes, decoded their output as UTF-8, and could only be programs ([ADR 0024](0024-processes-compiling-comments-and-indentation.md)). Several things in Emacs need more:
- **A terminal.** Shells, `M-x shell`, REPLs and anything that asks a question expect to run on one: line editing, job control and C-c only work there.
- **The network.** Language servers, IRC, `M-x server-start`'s socket and many packages talk over `make-network-process`.
- **Codings.** Output in a coding other than UTF-8 came in garbled.

[docs/plan.md](../plan.md) lists these tenth among the gaps in the core.

## Options considered

1. **A crate for each:** a pty crate and an async network runtime. The runtime would bring threads and dependencies the editor does not need. Its thread-per-stream model already suits it.
2. **The standard library and libc,** which the core already uses: `openpty` for terminals, `std::net` and `std::os::unix::net` for sockets, each read on a thread of its own as pipes are.

## Decision

Option 2. No new dependency. The user asked for this item, network processes included, so the core now opens sockets, but only when code asks for one, and only with the agent's permission while it acts.

**Terminals.**
- **Pty by default.** `make-process` runs a program on a pseudo-terminal by default, as Emacs's `process-connection-type` t does. `connectionType: "pipe"` asks for pipes.
- **How it is set up.** The terminal is set up as Emacs's `child_setup_tty` does: no echo, no carriage return added before newlines, C-c and C-\ as signals, eight bits, and no erase or kill characters. The program runs in a session of its own with the terminal as its controlling one.
- **The functions.** `process-send-eof` sends C-d there, as Emacs does, and the program can go on reading. `interrupt-process`, `quit-process`, `stop-process` and `continue-process` with CURRENT-GROUP signal the job in the foreground, as a shell's C-c C-c needs. `process-tty-name` and `set-process-window-size` answer from it.

**Network processes** (`make-network-process`):
- **What connects.** A TCP client to a host and port, or to a local socket with `family: "local"`. A server listens on a port, or any free port for `t`, or on a local socket.
- **Server connections.** Each connection a server accepts becomes a process of its own, named `SERVER <HOST:PORT>`. It gets the server's filter, sentinel and codings, and a buffer of its own when the server has the default filter. Its sentinel is told `open from HOST`, as Emacs's `server_accept_connection` does.
- **Statuses and events:**
  - `process-status` is `open`, `closed` or `listen`, and `process-type` is `network`.
  - `process-contact` gives `(HOST SERVICE)` or a part by key.
  - Deleting a connection tells its sentinel `deleted`; the other side closing tells it `connection broken by remote peer`, both as Emacs words them.

**Codings.**
- **Choosing them.** Each process has a decoding and an encoding coding system ([ADR 0035](0035-coding-systems-and-charsets.md)), from `default-process-coding-system`, from `coding-system-for-read` and `-write` when bound, or as given (`coding`). `set-process-coding-system` and `process-coding-system` change and read them.
- **Splitting.** A UTF-8 character split between two reads is put back together, as Emacs's decoding carryover does.

**Deleting.** A program on a terminal finishes exiting only once what it wrote has been read. So `delete-process` keeps taking that program's output while it waits for it, and keeps other processes' output for later. Without that, a program that had filled its terminal (such as `yes`) could never be reaped.

The tests are in `tests/processes.rs`:
- a terminal by default and pipes on request;
- C-d and C-c on a terminal;
- Latin-1 both ways and UTF-8 split across reads;
- a TCP server and client talking, with Emacs's statuses and events;
- a local socket;
- the agent's permission to connect.

Batch Emacs cannot be compared on these, as they depend on timing and the machine.

## Consequences

Shells, REPLs and network clients can be written as Emacs's are; comint and `M-x shell` come next. Running on a terminal by default changes nothing visible for compilation and grep, as `TERM=dumb` keeps programs from colouring their output.

Not done yet:
- non-blocking connects (`:nowait`) and datagrams;
- TLS;
- `make-pipe-process` and serial processes;
- `process-send-region` over a coding system's state;
- the `:log` function of a server.

## Dependencies introduced

None.
