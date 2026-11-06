// ERT, after Emacs's ert.el: tests defined with ertDeftest and checked
// with should, run from the command line with
//
//   gnista --batch -l test/foo-tests.ts -f ert-run-tests-batch-and-exit
//
// or in the editor with M-x ert. A test file is a module, so it imports what
// it tests and this package by name:
//
//   import { ertDeftest, should, shouldEqual } from "ert";
//   ertDeftest("foo-adds", () => shouldEqual(add(1, 2), 3));
//
// Lisp's should sees the form it is given, and reports it when it fails;
// JavaScript passes only the value, so should takes a function to show its
// source, should(() => x > 1), or a description after the value.
// shouldEqual stands for (should (equal A B)), showing both values.
//
// Not preloaded: a test file loads it by importing it.

export interface ErtTestOptions {
  doc?: string;
  tags?: string[];
  /** "failed" for a test known to fail, as :expected-result :failed. */
  expectedResult?: "passed" | "failed";
}

export interface ErtTest {
  name: string;
  doc: string;
  tags: string[];
  expectedResult: "passed" | "failed";
  body: () => unknown;
  /** The file it was defined in, if known. */
  file?: string;
}

/** What running a test came to, as ERT's ert-test-result types. */
export interface ErtResult {
  test: ErtTest;
  status: "passed" | "failed" | "skipped";
  /** The condition it failed or was skipped with. */
  condition?: { symbol: string; message: string };
  seconds: number;
  /** Whether the status is the one the test expected; a skip counts as expected. */
  expected: boolean;
}

/**
 * Which tests to run, as ERT's selectors: true for all, an Emacs regexp
 * their names match, a test's name in a one-element list, or a tag.
 */
export type ErtSelector = true | string | [string] | { tag: string };

gnista.defineError("ert-test-failed", "error");
gnista.defineError("ert-test-skipped", "error");

const tests = new Map<string, ErtTest>();

/** Defines a test, or replaces one of the same name, as ert-deftest. */
export function ertDeftest(name: string, body: () => unknown, options: ErtTestOptions = {}): string {
  tests.set(name, {
    name,
    doc: options.doc ?? "",
    tags: options.tags ?? [],
    expectedResult: options.expectedResult ?? "passed",
    body,
  });
  return name;
}

/** Forgets a test, as ert-delete-test. */
export function ertDeleteTest(name: string): void {
  tests.delete(name);
}

/** Forgets every test, as ert-delete-all-tests. */
export function ertDeleteAllTests(): void {
  tests.clear();
}

/** The test of a name, as ert-get-test. */
export function ertGetTest(name: string): ErtTest | undefined {
  return tests.get(name);
}

/** The text of a check: a function's body, or the description given. */
function formOf(check: unknown, description: string | undefined): string {
  if (description !== undefined) return description;
  if (typeof check === "function") return String(check).replace(/^\(\)\s*=>\s*/, "");
  return show(check);
}

function valueOf(check: unknown): unknown {
  return typeof check === "function" ? (check as () => unknown)() : check;
}

/** A value as a failure shows it. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (typeof value === "function") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Fails the running test with a message, as ert-fail. */
export function ertFail(message: string): never {
  return gnista.signal("ert-test-failed", message);
}

/** Checks that a value, or what a function returns, is true, as should. */
export function should(check: unknown, description?: string): void {
  const value = valueOf(check);
  if (!value) ertFail(`(should ${formOf(check, description)}) :value ${show(value)}`);
}

/** Checks that a value, or what a function returns, is false, as should-not. */
export function shouldNot(check: unknown, description?: string): void {
  const value = valueOf(check);
  if (value) ertFail(`(should-not ${formOf(check, description)}) :value ${show(value)}`);
}

/** Whether two values are equal as Lisp's equal compares: structurally. */
export function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Checks that two values are equal, as (should (equal ACTUAL EXPECTED)). */
export function shouldEqual(actual: unknown, expected: unknown, description?: string): void {
  if (!equal(actual, expected)) {
    const what = description === undefined ? "" : ` ${description}`;
    ertFail(`(should (equal${what})) :actual ${show(actual)} :expected ${show(expected)}`);
  }
}

/**
 * Checks that a function signals an error, of the condition `type` if
 * given, and returns what was signalled, as should-error.
 */
export function shouldError(fn: () => unknown, options: { type?: string } = {}): { symbol: string; message: string } {
  let caught: { symbol: string; message: string } | undefined;
  try {
    fn();
  } catch (e) {
    const conditions = gnista.errorConditions(e);
    const symbol = (e as { symbol?: string })?.symbol ?? "error";
    const message = e instanceof Error ? e.message : String(e);
    if (options.type !== undefined && !conditions.includes(options.type)) {
      ertFail(`(should-error ${formOf(fn, undefined)} :type ${options.type}) signalled ${symbol}: ${message}`);
    }
    caught = { symbol, message };
  }
  if (caught === undefined) ertFail(`(should-error ${formOf(fn, undefined)}) did not signal an error`);
  return caught;
}

/** Skips the running test unless a condition holds, as skip-unless. */
export function skipUnless(condition: unknown, description?: string): void {
  if (!condition) gnista.signal("ert-test-skipped", `(skip-unless ${description ?? show(condition)})`);
}

/** Skips the running test if a condition holds, as skip-when. */
export function skipWhen(condition: unknown, description?: string): void {
  if (condition) gnista.signal("ert-test-skipped", `(skip-when ${description ?? show(condition)})`);
}

/** The tests a selector selects, in the order they were defined, as ert-select-tests. */
export function ertSelectTests(selector: ErtSelector): ErtTest[] {
  const all = [...tests.values()];
  if (selector === true || selector === "t") return all;
  if (Array.isArray(selector)) return all.filter((t) => t.name === selector[0]);
  if (typeof selector === "object") return all.filter((t) => t.tags.includes(selector.tag));
  return all.filter((t) => gnista.stringMatch(selector, t.name) !== undefined);
}

/** Runs one test, as ert-run-test. */
export function ertRunTest(test: ErtTest): ErtResult {
  const start = Date.now();
  let status: ErtResult["status"] = "passed";
  let condition: ErtResult["condition"];
  try {
    test.body();
  } catch (e) {
    const symbol = (e as { symbol?: string })?.symbol ?? (e instanceof Error ? e.name : "error");
    const message = e instanceof Error ? e.message : String(e);
    condition = { symbol, message };
    status = gnista.errorConditions(e).includes("ert-test-skipped") ? "skipped" : "failed";
  }
  const seconds = (Date.now() - start) / 1000;
  const expected = status === "skipped" || status === test.expectedResult;
  return { test, status, condition, seconds, expected };
}

/** The tally of a run, as ERT's stats. */
export interface ErtStats {
  results: ErtResult[];
  expected: number;
  unexpected: number;
  skipped: number;
  seconds: number;
}

/**
 * Runs the tests a selector selects, calling `listener` before and after
 * each, as ert-run-tests does with its listener.
 */
export function ertRunTests(
  selector: ErtSelector,
  listener: (event: "test-started" | "test-ended", test: ErtTest, result?: ErtResult) => void = () => {},
): ErtStats {
  const start = Date.now();
  const results: ErtResult[] = [];
  for (const test of ertSelectTests(selector)) {
    listener("test-started", test);
    const result = ertRunTest(test);
    results.push(result);
    listener("test-ended", test, result);
  }
  return {
    results,
    expected: results.filter((r) => r.expected && r.status !== "skipped").length,
    unexpected: results.filter((r) => !r.expected).length,
    skipped: results.filter((r) => r.status === "skipped").length,
    seconds: (Date.now() - start) / 1000,
  };
}

function statusWord(r: ErtResult): string {
  if (r.status === "skipped") return "skipped";
  if (r.expected) return r.status;
  return r.status === "failed" ? "FAILED" : "PASSED";
}

function selectorText(selector: ErtSelector): string {
  if (selector === true) return "t";
  if (Array.isArray(selector)) return selector[0];
  if (typeof selector === "object") return `(tag ${selector.tag})`;
  return JSON.stringify(selector);
}

function summary(stats: ErtStats): string[] {
  const n = stats.results.length;
  const lines = [
    `Ran ${n} test${n === 1 ? "" : "s"}, ${stats.expected} results as expected, ${stats.unexpected} unexpected` +
      (stats.skipped > 0 ? `, ${stats.skipped} skipped` : "") +
      ` (${stats.seconds.toFixed(3)} sec)`,
  ];
  const unexpected = stats.results.filter((r) => !r.expected);
  if (unexpected.length > 0) {
    lines.push("", `${unexpected.length} unexpected results:`);
    for (const r of unexpected) lines.push(`   ${statusWord(r)}  ${r.test.name}`);
  }
  return lines;
}

/**
 * Runs the tests a selector selects, printing each result and a summary,
 * as ert-run-tests-batch: in batch mode, to standard error.
 */
export function ertRunTestsBatch(selector: ErtSelector = true): ErtStats {
  const selected = ertSelectTests(selector).length;
  gnista.message(`Running ${selected} test${selected === 1 ? "" : "s"} (selector ${selectorText(selector)})`);
  let i = 0;
  const stats = ertRunTests(selector, (event, test, result) => {
    if (event !== "test-ended" || result === undefined) return;
    i++;
    if (result.condition !== undefined && !result.expected) {
      gnista.message(`Test ${test.name} condition:\n    (${result.condition.symbol} ${result.condition.message})`);
    }
    gnista.message(`   ${statusWord(result).padStart(7)}  ${i}/${selected}  ${test.name} (${result.seconds.toFixed(6)} sec)`);
  });
  gnista.message("");
  for (const line of summary(stats)) gnista.message(line);
  return stats;
}

/**
 * Runs the tests as ert-run-tests-batch does and exits, with status 0 if
 * every result was as expected and 1 if not, as ert-run-tests-batch-and-exit.
 */
export function ertRunTestsBatchAndExit(selector: ErtSelector = true): void {
  const stats = ertRunTestsBatch(selector);
  gnista.killEmacs(stats.unexpected === 0 ? 0 : 1);
}

gnista.defun("ert-run-tests-batch", (selector?: ErtSelector) => ertRunTestsBatch(selector ?? true));
gnista.defun("ert-run-tests-batch-and-exit", (selector?: ErtSelector) => ertRunTestsBatchAndExit(selector ?? true));

gnista.defineCommand({
  name: "ert",
  doc: 'Run the tests whose names match a regexp, "t" for all, and show the results in *ert*, as Emacs\'s ert.',
  params: [{ name: "selector", prompt: "Run tests (default t): ", history: "ert--selector-history" }],
  run: (selector: string) => {
    const chosen: ErtSelector = selector === "" || selector === "t" ? true : selector;
    const stats = ertRunTests(chosen);
    const lines = [`Selector: ${selectorText(chosen)}`, ""];
    for (const r of stats.results) {
      lines.push(`${statusWord(r).padEnd(8)}${r.test.name}`);
      if (r.condition !== undefined && !r.expected) lines.push(`    (${r.condition.symbol} ${r.condition.message})`);
    }
    lines.push("", ...summary(stats));
    const buffer = gnista.getBufferCreate("*ert*");
    gnista.withCurrentBuffer(buffer, () => {
      gnista.letBind({ "inhibit-read-only": true }, () => {
        gnista.deleteRegion(gnista.pointMin(), gnista.pointMax());
        gnista.insert(lines.join("\n") + "\n");
        gnista.gotoChar(gnista.pointMin());
      });
    });
    gnista.call("pop-to-buffer", "*ert*");
    gnista.message(`Ran ${stats.results.length} tests, ${stats.unexpected} unexpected`);
  },
});
