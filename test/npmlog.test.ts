import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startJob, waitForJob } from "../src/exec.js";
import { RATE_LIMITED, lastRateLimit, npmLogErrors, publishPackage, recordRateLimit, recordRateLimitOnFailure } from "../src/ops.js";
import { tempDir } from "./helpers.js";

const LOG = [
  "0 verbose cli node npm-cli.js",
  "35 http fetch PUT https://registry.npmjs.org/x attempt 1 failed with 429",
  "38 http fetch PUT 429 https://registry.npmjs.org/x 72191ms attempt #3",
  "42 error code E429",
  "43 error 429 Too Many Requests - PUT https://registry.npmjs.org/x - rate limited exceeded",
  "44 error Open https://www.npmjs.com/auth/cli/87364972-c663-4373-818a-de80da2da600",
].join("\n");

describe("npmLogErrors", () => {
  it("returns the error lines of the newest log since a time, hiding auth ids", async () => {
    const dir = await tempDir();
    const old = join(dir, "2026-01-01T00_00_00_000Z-debug-0.log");
    await writeFile(old, "1 error old failure\n");
    await utimes(old, new Date(2000, 0, 1), new Date(2000, 0, 1));
    await writeFile(join(dir, "2026-10-17T14_55_07_597Z-debug-0.log"), LOG);
    const text = await npmLogErrors(Date.now() - 60_000, dir);
    expect(text).toContain("error code E429");
    expect(text).toContain("http fetch PUT 429");
    expect(text).toContain("auth/cli/***");
    expect(text).not.toContain("87364972");
    expect(text).not.toContain("old failure");
    expect(text).not.toContain("verbose cli");
  });

  it("returns undefined when there is no log", async () => {
    expect(await npmLogErrors(Date.now(), join(await tempDir(), "missing"))).toBeUndefined();
  });
});

describe("rate-limit guard", () => {
  it("records and reads the last E429 per package", async () => {
    const file = join(await tempDir(), "nested", "rate-limits.json");
    expect(await lastRateLimit("npm:x", file)).toBeNull();
    const when = new Date("2026-10-17T15:01:00Z");
    await recordRateLimit("npm:x", when, file);
    await recordRateLimit("npm:y", new Date(), file);
    expect((await lastRateLimit("npm:x", file))?.toISOString()).toBe(when.toISOString());
  });

  it("publish_package refuses within 24 hours of an E429 and says when to try", async () => {
    const dir = await tempDir();
    const name = `pp-never-published-${Date.now()}`;
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "0.1.0" }));
    const file = join(dir, "limits.json");
    await recordRateLimit(`npm:${name}`, new Date(Date.now() - 60 * 60 * 1000), file);
    const result = await publishPackage(dir, { rateLimitFile: file, openBrowser: false });
    expect(result).toMatchObject({ skipped: true, rateLimited: true });
    expect(String(result.reason)).toMatch(/can extend the block/);
    expect(new Date(String(result.retryAfter)).getTime()).toBeGreaterThan(Date.now() + 22 * 60 * 60 * 1000);
  });

  it("publish_package also waits after a PyPI rate limit", async () => {
    const dir = await tempDir();
    const name = `pp-never-published-${Date.now()}`;
    await writeFile(join(dir, "pyproject.toml"), `[project]\nname = "${name}"\nversion = "0.1.0"\n`);
    const file = join(dir, "limits.json");
    await recordRateLimit(`pypi:${name}`, new Date(), file);
    const result = await publishPackage(dir, { rateLimitFile: file, openBrowser: false });
    expect(result).toMatchObject({ skipped: true, rateLimited: true });
    expect(String(result.reason)).toContain("PyPI support");
  });

  it.each([
    ["npm", "npm error code E429\nnpm error 429 Too Many Requests - PUT https://registry.npmjs.org/x - rate limited exceeded"],
    ["twine", "ERROR    HTTPError: 429 Too Many Requests from https://upload.pypi.org/legacy/"],
    ["cargo", "error: failed to publish to registry at https://crates.io\n\nCaused by:\n  the remote server responded with an error (status 429 Too Many Requests): You have published too many new crates in a short period of time."],
  ])("recognises %s rate-limit errors", (_tool, output) => {
    expect(RATE_LIMITED.test(output)).toBe(true);
  });

  it("does not mistake other failures for a rate limit", () => {
    expect(RATE_LIMITED.test("ERROR    HTTPError: 400 Bad Request\nFile already exists ('x-0.1.0.tar.gz', with blake2_256 hash '4290aa')")).toBe(false);
    expect(RATE_LIMITED.test("Packaged 429 files, 3.6KiB")).toBe(false);
  });

  it("records a rate limit when a publish job fails with one, and not otherwise", async () => {
    const file = join(await tempDir(), "limits.json");
    const fail = startJob(process.execPath, ["-e", "console.error('HTTPError: 429 Too Many Requests'); process.exit(1)"], { label: "t" });
    await recordRateLimitOnFailure(fail, "pypi:a", file);
    expect(await lastRateLimit("pypi:a", file)).not.toBeNull();
    const ok = startJob(process.execPath, ["-e", "console.log('rate limit docs')"], { label: "t" });
    await recordRateLimitOnFailure(ok, "pypi:b", file);
    expect(await lastRateLimit("pypi:b", file)).toBeNull();
  });
});

describe("job finalize", () => {
  it("appends finalize text before the job is marked finished", async () => {
    const job = startJob(process.execPath, ["-e", "process.exit(2)"], { label: "t", finalize: async () => "from finalize" });
    await waitForJob(job, 10_000);
    expect(job.running).toBe(false);
    expect(job.exitCode).toBe(2);
    expect(job.output).toContain("from finalize");
  });
});
