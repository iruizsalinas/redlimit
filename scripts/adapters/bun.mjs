import * as runner from 'bun:test';
export { expect } from './expect.mjs';
export const describe = (name, options, body) => runner.describe(name, typeof options === 'function' ? options : body);
export const it = (name, body) => runner.it(name, body, 120_000);
it.each = rows => (name, body) => rows.forEach((row, index) => {
  const args = Array.isArray(row) ? row : [row];
  it(name + ' [' + index + ': ' + String(args[0]) + ']', () => body(...args));
});
export const { beforeAll, afterAll, beforeEach, afterEach } = runner;
