import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function isPublished(name, version, request = fetch) {
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  assert.ok(response.ok, `npm registry check failed: HTTP ${response.status}`);
  const published = await response.json();
  assert.equal(published.name, name, "Unexpected package in npm registry response");
  assert.equal(published.version, version, "Unexpected version in npm registry response");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const published = await isPublished(name, version);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `should_release=${!published}\n`);
  }
  console.log(published ? `${name}@${version} is already published; skipping.` : `${name}@${version} is not published.`);
}
