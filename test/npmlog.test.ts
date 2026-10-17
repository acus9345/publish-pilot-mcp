import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startJob, waitForJob } from "../src/exec.js";
import { npmLogErrors } from "../src/ops.js";
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

describe("job finalize", () => {
  it("appends finalize text before the job is marked finished", async () => {
    const job = startJob(process.execPath, ["-e", "process.exit(2)"], { label: "t", finalize: async () => "from finalize" });
    await waitForJob(job, 10_000);
    expect(job.running).toBe(false);
    expect(job.exitCode).toBe(2);
    expect(job.output).toContain("from finalize");
  });
});
