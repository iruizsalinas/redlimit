import { spawn } from 'node:child_process';
if (process.env.CI !== 'true' || !process.env.REDIS_URL) throw new Error('CI and REDIS_URL are required');
const runtime = process.argv[2];
const runs = {
  node: [[process.execPath, ['.ci/consumer/node-esm.test.mjs']], [process.execPath, ['.ci/consumer/node-cjs.test.mjs']]],
  bun: [['bun', ['test', '--no-env-file', './.ci/consumer/bun-esm.test.mjs']]],
  deno: [['deno', ['test', '--no-check', '--no-prompt', '--allow-env', '--allow-net=' + new URL(process.env.REDIS_URL).host, '--allow-read', '.ci/consumer/deno-esm.test.mjs']]],
};
if (!runs[runtime]) throw new Error('Unknown runtime: ' + runtime);
for (const [command, args] of runs[runtime]) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime suite exceeded 10 minutes')); }, 600_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(command + ' ' + args.join(' ') + ' exited with ' + (signal ?? code)));
    });
  });
}
