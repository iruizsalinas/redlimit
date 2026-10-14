import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
let fixture: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "redlimit-release-"));
  mkdirSync(join(fixture, "scripts"));
  cpSync(join(root, "scripts/check-release.mjs"), join(fixture, "scripts/check-release.mjs"));
});
afterAll(() => {
  expect(dirname(fixture)).toBe(resolve(tmpdir()));
  expect(basename(fixture)).toMatch(/^redlimit-release-/);
  rmSync(fixture, { recursive: true, force: true });
});

function check(options: { ref?: string; type?: string; repo?: string; version?: string; lockVersion?: string; rootVersion?: string } = {}) {
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ ...manifest, version: options.version ?? manifest.version }));
  writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({
    ...lock, version: options.lockVersion ?? lock.version,
    packages: { "": { ...lock.packages[""], version: options.rootVersion ?? lock.packages[""].version } },
  }));
  return spawnSync(process.execPath, [join(fixture, "scripts/check-release.mjs")], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: join(fixture, "outputs"),
      GITHUB_REF_TYPE: options.type ?? "branch",
      GITHUB_REF_NAME: options.ref ?? "main",
      GITHUB_REPOSITORY: options.repo ?? "iruizsalinas/redlimit" },
  });
}

test("accepts a stable version on main and emits the existing v-prefixed tag format", () => {
  writeFileSync(join(fixture, "outputs"), "");
  const result = check();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(readFileSync(join(fixture, "outputs"), "utf8")).toBe(`tag=v${manifest.version}\n`);
});

test.each([
  [{ ref: "feature" }, "Releases must run from the main branch"],
  [{ type: "tag" }, "Releases must run from the main branch"],
  [{ repo: "someone/fork" }, "Package repository must match"],
  [{ version: "2.0.0-beta.1" }, "Only stable versions"],
  [{ lockVersion: "999.0.0" }, "Lockfile version must match"],
  [{ rootVersion: "999.0.0" }, "Lockfile root version must match"],
] as const)("rejects an invalid release: %j", (options, message) => {
  const result = check(options);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
});
