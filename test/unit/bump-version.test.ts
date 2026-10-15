import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { bumpPackage, nextVersion } from "../../scripts/bump-version.mjs";

let fixture: string | undefined;
afterEach(() => {
  if (fixture) {
    expect(dirname(fixture)).toBe(resolve(tmpdir()));
    expect(basename(fixture)).toMatch(/^package-bump-/);
    rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  }
});

test.each([
  ["1.0.5", "patch", "1.0.6"],
  ["2.0.6", "patch", "2.0.7"],
  ["0.6.1", "minor", "0.7.0"],
  ["1.9.9", "minor", "1.10.0"],
  ["0.6.1", "major", "1.0.0"],
  ["1.9.9", "major", "2.0.0"],
  ["1.0.5", "current", "1.0.5"],
])("bumps %s with %s to %s", (version, bump, expected) => {
  expect(nextVersion(version, bump)).toBe(expected);
});

test.each([
  ["1.0.5", "invalid"], ["1.0.5-beta.1", "patch"], ["01.0.5", "patch"],
  ["1.0", "patch"], ["1.0.9007199254740991", "patch"],
])("rejects invalid version or bump: %s %s", (version, bump) => {
  expect(() => nextVersion(version, bump)).toThrow();
});

function setup(lockVersion = "1.0.5", rootVersion = "1.0.5") {
  fixture = mkdtempSync(join(tmpdir(), "package-bump-"));
  const manifest = { name: "fixture", version: "1.0.5", private: true, devDependencies: { tool: "1.0.5" } };
  const lock = { name: "fixture", version: lockVersion, lockfileVersion: 3, packages: {
    "": { name: "fixture", version: rootVersion, devDependencies: { tool: "1.0.5" } },
    "node_modules/tool": { version: "1.0.5", integrity: "unchanged" },
  } };
  writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(fixture, "package-lock.json"), JSON.stringify(lock));
  return { root: fixture, manifest, lock };
}

test("updates both manifests without changing locked dependencies or package metadata", () => {
  const { root, manifest, lock } = setup();
  expect(bumpPackage(root, "patch")).toBe("1.0.6");
  manifest.version = lock.version = lock.packages[""].version = "1.0.6";
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual(manifest);
  expect(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))).toEqual(lock);
});

test("current leaves both files byte-for-byte unchanged", () => {
  const { root } = setup();
  const before = ["package.json", "package-lock.json"].map(file => readFileSync(join(root, file), "utf8"));
  expect(bumpPackage(root, "current")).toBe("1.0.5");
  expect(["package.json", "package-lock.json"].map(file => readFileSync(join(root, file), "utf8"))).toEqual(before);
});

test.each([["1.0.4", "1.0.5"], ["1.0.5", "1.0.4"]])("rejects lockfile drift before writing either file: %s %s", (lockVersion, rootVersion) => {
  const { root } = setup(lockVersion, rootVersion);
  const before = ["package.json", "package-lock.json"].map(file => readFileSync(join(root, file), "utf8"));
  expect(() => bumpPackage(root, "patch")).toThrow();
  expect(["package.json", "package-lock.json"].map(file => readFileSync(join(root, file), "utf8"))).toEqual(before);
});
