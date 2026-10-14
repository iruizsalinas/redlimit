import * as runner from 'node:test';
export { expect } from './expect.mjs';
export const describe = (name, options, body) => typeof options === 'function'
  ? runner.describe(name, { concurrency: false }, options)
  : runner.describe(name, { ...options, concurrency: false }, body);
export const it = (name, body) => runner.it(name, { timeout: 120_000 }, body);
it.each = rows => (name, body) => rows.forEach((row, index) => {
  const args = Array.isArray(row) ? row : [row];
  it(name + ' [' + index + ': ' + String(args[0]) + ']', () => body(...args));
});
export const { before: beforeAll, after: afterAll, beforeEach, afterEach } = runner;
