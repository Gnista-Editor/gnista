# How we work

Gnista was built in about a week, 27 October to 3 November 2026, in one long Claude Code session: 189 commits, from a terminal editor to Org mode, Dired, a shell, bidirectional text, images, the editor on its own thread and prompts that return their answer. This page says how that session works and what it taught us, so that the next stretch goes better. [CLAUDE.md](../CLAUDE.md) holds the rules every change follows; this is the why and the how.

## One session, followed from a phone

- **The work stays in one session.** Mark follows and steers it over Remote Control from his phone. A sub-agent or another session needs the laptop to watch or answer, so the work is done here, in order, unless he asks for something else.
- **Long commands run in the background**: the full test suite, release builds, the fuzzers, the bench, recording oracle cases. The session waits for them to finish rather than polling, and says what it is doing when it has been quiet for a while.
- **Wait on a file or a process id, never on `pgrep -f` with the command's text**: the waiting loop's own command line holds that text, so it matches itself and never ends. Stop waits that are no longer needed, so the app does not list them for hours.
- **Each turn ends with a message that stands on its own**: what changed, what was checked and how, what is not done or not verified. It is read on a phone, perhaps hours later, without the transcript.
- **Each finished piece is committed and pushed**, so its progress shows away from the laptop and a stopped session loses nothing. Files are staged by name; `test.org` and other personal files are never committed.

## The session outlives its memory

- **Over a week the conversation is summarised many times**, and what is only in the conversation is lost or blurred. So the state lives in the repository: decisions in [ADRs](adr/), plans with their steps in docs ([multithreading.md](multithreading.md), [plan.md](plan.md)), measurements in [performance.md](performance.md), where Gnista differs from Emacs in [differences.md](differences.md), ideas for later in [departures.md](departures.md).
- **A plan of several steps gets a doc** with a table of its steps and each one's state, updated as each lands, with what was measured and what was decided. After a summary, the doc is where the work resumes from.
- **CLAUDE.md is read at every turn and after every summary.** It keeps what every change needs and points to the rest: what Gnista does is in [features.md](features.md), what each file holds in [layout.md](layout.md), the decisions in the [ADR index](adr/README.md).

## Behaving like Emacs

- **Ask Emacs rather than guess.** An oracle case in `tests/emacs/cases/` records what GNU Emacs does with some keys, and the tests compare Gnista with it. The fuzzers find what nobody thought to test: random documents and keys, recorded in Emacs and compared.
- **Fix the fuzzer's seeds before a change that could alter behaviour.** Note how many differences fixed seeds show before (Org: seeds 7 and 11 at 1,000 cases, 7 and 1 differences on 2026-11-03) and check they are the same after.
- **Port Emacs's Lisp closely**, its names, messages and structure too ([ADR 0013](adr/0013-following-org-closely.md)). Following Org's code is faster than rediscovering its behaviour, and its cache, markers and change hooks turned out to be what Gnista needed as well.

## Measure before optimising

- **Split the time before choosing the fix.** Profiling the slow keys into interpretation, host calls and primitives ([multithreading.md](multithreading.md), step 0a) is what said to fix Org's heading index before changing engines; the index fix took RET at a heading from 18 to 2.3 ms.
- **Time Emacs on the same file the same way**, as [performance.md](performance.md) does, so "faster than Emacs" is a measurement.
- **The machine is often busy with builds.** Compare like with like, measured under the same load, and note the load when it is high.
- **What made Org slow in QuickJS**: `Object.freeze` on every object, spreading and slicing large arrays, `matchAll` (it compiles its regexp again on every call), and walking every heading where a binary search would do. Update in place and move things lazily, as Org's own element cache does.
- **Try a risky dependency in a spike outside the workspace** first (`spikes/v8`, with an empty `[workspace]`), so nothing in Gnista depends on it until it is decided.

## Large mechanical changes

- **Script the change, then let the compiler finish it.** The 402 entries of the binding table were converted by a script, with their result types filled in from the compiler's type errors, and the hundred that did not fit the script by hand.
- **Compare what is generated before and after.** `gnista.d.ts` was compared declaration by declaration, ignoring order, which showed the table changed nothing a script sees.
- **Don't edit sources while a test run's build is compiling**: the run then tests a mix of old and new. Wait until its test binaries are listed. A second `cargo build` alongside only waits for the lock.

## Tests on this Mac

- **cargo-nextest**, one test binary per crate, and dependencies optimised in debug builds: the whole suite runs in about half a minute.
- **Developer Tools must be on for the app running the builds** (System Settings, Privacy & Security, Developer Tools): Claude.app for the session's builds, Terminal.app for your own.
- **When new test programs are slow to start, count the files in `target/debug/deps`.** macOS's check of a new program looks through its folder, and cargo leaves every debug build's object files there: at a million files each new program waited 45 s. `make tidy` deletes those over a day old; `make check` runs it first.
- **Run `make check` before pushing a change to the engines, the natives or the packages**: every test and clippy on V8 and on QuickJS, which builds in `target/quickjs` so switching engines does not rebuild the workspace.
- **Check a fix with a change that makes a new program**: relinking a file that was only touched can give the same binary, which macOS has already let run.
- **The GUI's snapshot tests are run on their own** (`cargo test -p gnista-gui --test window --test images`), when drawing changes: each process spends a minute getting the GPU from Metal.
