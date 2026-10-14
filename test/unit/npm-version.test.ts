import { expect, test, vi } from "vitest";
import { isPublished } from "../../scripts/check-npm-version.mjs";

test("recognizes a published npm version", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ name: "redlimit", version: "1.0.5" }));
  await expect(isPublished("redlimit", "1.0.5", request)).resolves.toBe(true);
  expect(request.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/redlimit/1.0.5");
});

test("allows publishing a version absent from npm", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  await expect(isPublished("redlimit", "1.0.5", request)).resolves.toBe(false);
});

test.each([401, 403, 429, 500, 503])("stops on registry HTTP %i rather than treating the version as unpublished", async status => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
  await expect(isPublished("redlimit", "1.0.5", request)).rejects.toThrow(`HTTP ${status}`);
});

test("stops on network errors", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("Network unavailable"));
  await expect(isPublished("redlimit", "1.0.5", request)).rejects.toThrow("Network unavailable");
});

test.each([
  { name: "another-package", version: "1.0.5" },
  { name: "redlimit", version: "1.0.4" },
])("rejects unexpected metadata: %j", async metadata => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(metadata));
  await expect(isPublished("redlimit", "1.0.5", request)).rejects.toThrow("Unexpected");
});
