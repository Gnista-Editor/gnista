// Basic functions packages share, after Emacs's subr.el and subr-x.el.
// Import them by feature name, as Lisp requires subr-x:
//
//   import { truthy, forwardLine } from "subr";

/** Whether a value counts as true, as anything but nil does in Emacs: not null, undefined or false. */
export const truthy = (v: ember.Value | undefined): boolean => v !== undefined && v !== null && v !== false;

/** A variable's value as a number, or `fallback` if it is not one. */
export function numberValue(name: string, fallback: number): number {
  const v = ember.variable(name);
  return typeof v === "number" ? v : fallback;
}

/** A regexp matching `s` itself, as Emacs's regexp-quote. */
export const regexpQuote = (s: string): string => s.replace(/[[*.\\?+^$]/g, "\\$&");

/** How many characters a string has, as buffer positions count them, not UTF-16 units. */
export function charCount(s: string): number {
  return /[\uD800-\uDFFF]/.test(s) ? Array.from(s).length : s.length;
}

/**
 * Moves point `n` lines forward, back if negative, to the start of a line,
 * as Emacs's forward-line: within the accessible text, returning how many
 * lines it fell short.
 */
export function forwardLine(n: number): number {
  const start = ember.point();
  const line = ember.lineOf(start);
  const first = ember.lineOf(ember.pointMin());
  const last = ember.lineOf(ember.pointMax());
  if (n <= 0) {
    ember.gotoChar(Math.max(ember.pointMin(), ember.lineStart(Math.max(first, line + n))));
    return Math.min(0, line + n - first);
  }
  if (line + n <= last) {
    ember.gotoChar(ember.lineStart(line + n));
    return 0;
  }
  ember.gotoChar(ember.pointMax());
  let shortfall = n - (last - line);
  if (ember.point() !== start && ember.bufferText(ember.point() - 1, ember.point()) !== "\n") shortfall--;
  return shortfall;
}
