export { expect } from './expect.mjs';
let current;
export function describe(name, options, body) {
  const parent = current;
  const suite = { name, items: [], before: [], after: [], beforeEach: [], afterEach: [] };
  if (parent) parent.items.push(suite);
  current = suite;
  try { (typeof options === 'function' ? options : body)(); } finally { current = parent; }
  if (!parent) Deno.test(name, async context => run(suite, context, []));
}
export function it(name, body) { current.items.push({ name, body }); }
it.each = rows => (name, body) => rows.forEach((row, index) => {
  const args = Array.isArray(row) ? row : [row];
  it(name + ' [' + index + ': ' + String(args[0]) + ']', () => body(...args));
});
export const beforeAll = body => current.before.push(body);
export const afterAll = body => current.after.push(body);
export const beforeEach = body => current.beforeEach.push(body);
export const afterEach = body => current.afterEach.push(body);
async function run(suite, context, ancestors) {
  const chain = [...ancestors, suite];
  const failures = [];
  try {
    for (const hook of suite.before) await hook();
    for (const item of suite.items) {
      const passed = await context.step(item.name, async child => {
        if (item.items) return run(item, child, chain);
        try {
          for (const level of chain) for (const hook of level.beforeEach) await hook();
          await item.body();
        } finally {
          for (const level of [...chain].reverse()) for (const hook of level.afterEach) await hook();
        }
      });
      if (!passed) failures.push(item.name);
    }
    if (failures.length) throw new Error('Failed tests: ' + failures.join(', '));
  } finally { for (const hook of suite.after) await hook(); }
}
