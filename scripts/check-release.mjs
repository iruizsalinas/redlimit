import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(process.env.GITHUB_REF_TYPE, "branch", "Releases must run from the main branch");
assert.equal(process.env.GITHUB_REF_NAME, "main", "Releases must run from the main branch");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "Only stable versions are published by this workflow");
const tag = `v${manifest.version}`;
assert.equal(lock.version, manifest.version, "Lockfile version must match package.json");
assert.equal(lock.packages[""].version, manifest.version, "Lockfile root version must match package.json");
assert.equal(manifest.repository.url, `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`,
  "Package repository must match the publishing repository");
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
}
console.log(`Validated release ${tag}`);
