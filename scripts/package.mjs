import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const staging = resolve(root, ".publish");
const artifacts = resolve(root, ".ci");
const source = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const fields = ["name", "version", "description", "type", "main", "module", "types",
  "exports", "files", "keywords", "author", "contributors", "repository", "homepage",
  "bugs", "license", "engines", "sideEffects", "funding", "dependencies",
  "peerDependencies", "peerDependenciesMeta", "optionalDependencies"];
const manifest = Object.fromEntries(fields.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));

assert.equal(staging, resolve(root, ".publish"));
assert.notEqual(staging, resolve(root));
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(artifacts, { recursive: true });
await cp(resolve(root, "dist"), resolve(staging, "dist"), { recursive: true });
for (const file of ["README.md", "LICENSE"]) {
  await cp(resolve(root, file), resolve(staging, file));
}
await writeFile(resolve(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

assert.ok(process.env.npm_execpath, "Run this script through npm run package or npm run package:prepare");
const result = execFileSync(process.execPath, [process.env.npm_execpath,
  "pack", staging, "--json", "--ignore-scripts", "--pack-destination", artifacts,
  "--cache", resolve(artifacts, "npm-cache")], { cwd: root, encoding: "utf8" });
const [packed] = JSON.parse(result);
assert.equal(packed.name, source.name);
assert.equal(packed.version, source.version);
assert.equal(packed.filename, `${source.name}-${source.version}.tgz`);
const files = new Set(packed.files.map(file => file.path));
for (const file of ["package.json", "README.md", "LICENSE", "dist/index.js",
  "dist/index.cjs", "dist/index.d.ts", "dist/index.d.cts"]) {
  assert.ok(files.has(file), `Missing package file: ${file}`);
}
for (const file of files) {
  assert.ok(["package.json", "README.md", "LICENSE"].includes(file) || file.startsWith("dist/"),
    `Unexpected package file: ${file}`);
}
await writeFile(resolve(artifacts, "package-artifact.json"), `${JSON.stringify({
  name: packed.name, version: packed.version, filename: packed.filename,
}, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `tarball=.ci/${packed.filename}\n`);
}
console.log(`Prepared .ci/${packed.filename} without development dependencies or repository scripts.`);
