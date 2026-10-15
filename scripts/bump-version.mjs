import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function nextVersion(version, bump) {
  assert.ok(["patch", "minor", "major", "current"].includes(bump), "Choose patch, minor, major, or current");
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Only stable versions can be bumped");
  const parts = version.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version numbers exceed the supported range");
  if (bump === "current") return version;
  const index = { major: 0, minor: 1, patch: 2 }[bump];
  parts[index]++;
  assert.ok(Number.isSafeInteger(parts[index]), "Version numbers exceed the supported range");
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  return parts.join(".");
}

export function bumpPackage(root, bump) {
  const manifestPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const version = nextVersion(manifest.version, bump);
  assert.equal(lock.name, manifest.name, "Lockfile package name must match package.json");
  assert.equal(lock.version, manifest.version, "Lockfile version must match package.json");
  assert.equal(lock.packages?.[""]?.version, manifest.version, "Lockfile root version must match package.json");
  if (bump !== "current") {
    manifest.version = lock.version = lock.packages[""].version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.log(`Release version: ${bumpPackage(root, process.argv[2])}`);
}
