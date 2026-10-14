import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = resolve(root, '.ci/consumer');
await mkdir(consumer, { recursive: true });
const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, encoding: 'utf8' });
const { filename } = JSON.parse(await readFile(resolve(root, '.ci/package-artifact.json'), 'utf8'));
await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
npm('install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', resolve(root, '.ci', filename));
const cases = (await readdir(resolve(root, 'test/integration'))).filter(name => name.endsWith('.test.ts')).map(name => './test/integration/' + name);
cases.push('./test/unit/duration.test.ts');
for (const runtime of ['node', 'bun', 'deno']) {
  for (const format of runtime === 'node' ? ['esm', 'cjs'] : ['esm']) {
    await build({
      stdin: { contents: cases.map(name => 'import ' + JSON.stringify(name)).join(';'), resolveDir: root },
      outfile: resolve(consumer, runtime + '-' + format + '.test.mjs'),
      bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', mainFields: ['module', 'main'],
      external: ['node:*', 'bun:test', 'redlimit', 'redis', 'ioredis'],
      plugins: [{ name: 'runtime-tests', setup(builder) {
        builder.onResolve({ filter: /^vitest$/ }, () => ({ path: resolve(root, 'scripts/adapters/' + runtime + '.mjs') }));
        builder.onResolve({ filter: /src\/ratelimit\.js$/ }, () => format === 'cjs'
          ? { path: 'package', namespace: 'cjs-package' } : { path: 'redlimit', external: true });
        builder.onLoad({ filter: /.*/, namespace: 'cjs-package' }, () => ({ contents: "import { createRequire } from 'node:module'; export const { Limiter } = createRequire(import.meta.url)('redlimit');" }));
      } }],
    });
  }
}
const types = "import { Limiter, type LimiterResult } from 'redlimit';\nconst limiter = new Limiter({ redis: {}, algorithm: 'fixed-window', limit: 1, window: '1s' });\nconst result: Promise<LimiterResult> = limiter.limit('key');\n// @ts-expect-error Invalid algorithm must be rejected.\nnew Limiter({ redis: {}, algorithm: 'invalid', limit: 1, window: '1s' });\n";
for (const extension of ['mts', 'cts']) await writeFile(resolve(consumer, 'types.' + extension), types);
if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_OUTPUT, 'tarball=.ci/' + filename + '\n');
}
console.log('Prepared ' + cases.length + ' shared test files and the npm package.');

