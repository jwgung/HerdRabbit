// Just enough of bun:test's expect for tests ported from herdr-web-ui.
import assert from "node:assert/strict";

export function expect(actual) {
  const matchers = (negate) => {
    const check = (pass, message) => assert.ok(negate ? !pass : pass, message);
    return {
      toBe: (expected) => negate ? assert.notStrictEqual(actual, expected) : assert.strictEqual(actual, expected),
      toEqual: (expected) => negate ? assert.notDeepStrictEqual(actual, expected) : assert.deepStrictEqual(actual, expected),
      toBeNull: () => check(actual === null, `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to be null`),
      toBeUndefined: () => check(actual === undefined, `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to be undefined`),
      toContain: (part) => check(actual.includes(part), `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to contain ${JSON.stringify(part)}`),
      toBeLessThanOrEqual: (limit) => check(actual <= limit, `expected ${actual} ${negate ? "not " : ""}<= ${limit}`),
      toBeGreaterThan: (limit) => check(actual > limit, `expected ${actual} ${negate ? "not " : ""}> ${limit}`),
    };
  };
  return { ...matchers(false), not: matchers(true) };
}
