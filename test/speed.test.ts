import { execFileSync } from "node:child_process";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cached, clearCache } from "../src/cache.js";
import { firstFree, type NameCheck } from "../src/names.js";
import { compactRunLog, denoise, npmInstallCurrent, runCommandList, tagAndRelease } from "../src/ops.js";
import { compactPreflight } from "../src/preflight.js";
import { tempDir } from "./helpers.js";

describe("small results", () => {
  it("drops npm chatter", () => {
    const text = "npm notice run x@1.0.0 build\nnpm notice run tsc\nreal line\n\nnpm notice 1.1kB LICENSE\nnpm error code E403\nnpm error A complete log of this run can be found in: C:\\x.log";
    expect(denoise(text)).toBe("real line\nnpm error code E403");
  });

  it("keeps only a summary of successful steps but the full output of the user's commands", async () => {
    const dir = await tempDir();
    const result = await runCommandList(['node -e "console.log(1);console.log(2);console.log(3)"'], { cwd: dir });
    expect(result.steps[0]).toMatchObject({ ok: true, command: 'node -e "console.log(1);console.log(2);console.log(3)"', output: "1\n2\n3" });
  });

  it("shortens failed workflow logs", () => {
    const log = "release\tRun npm test\t2026-10-19T05:50:10.1234567Z ##[group]Run npm test\nrelease\tRun npm test\t2026-10-19T05:50:11.0000000Z FAIL a.test.ts\nrelease\tRun npm test\t2026-10-19T05:50:11.1000000Z ##[endgroup]";
    expect(compactRunLog(log)).toBe("## release / Run npm test\nRun npm test\nFAIL a.test.ts");
  });

  it("reports preflight as versions and accounts", () => {
    const report = {
      target: "both" as const,
      registry: "npm" as const,
      tools: [
        { name: "git", installed: true, version: "git version 2.45.1.windows.1", neededFor: "always" },
        { name: "gh", installed: false, neededFor: "GitHub repo" },
      ],
      missingTools: ["gh"],
      auth: [{ service: "npm" as const, loggedIn: true, account: "me", detail: "" }],
      gitIdentity: { name: "Me", email: "me@example.com" },
      nextSteps: ["Install gh"],
    };
    expect(compactPreflight(report)).toEqual({ ready: false, tools: { git: "2.45.1", gh: false }, auth: { npm: "me" }, git: "Me <me@example.com>", next: ["Install gh"] });
    expect(compactPreflight({ ...report, tools: [report.tools[0]!], missingTools: [] })).not.toHaveProperty("next");
  });
});

describe("npmInstallCurrent", () => {
  it("is true only when node_modules was installed after the last manifest change", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), "{}");
    expect(await npmInstallCurrent(dir)).toBe(false);
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
    const old = new Date(Date.now() - 60_000);
    const installed = new Date(Date.now() - 30_000);
    await utimes(join(dir, "package.json"), old, old);
    await utimes(join(dir, "node_modules", ".package-lock.json"), installed, installed);
    expect(await npmInstallCurrent(dir)).toBe(true);
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect(await npmInstallCurrent(dir)).toBe(false);
  });
});

describe("cached", () => {
  it("shares one call between concurrent and later callers", async () => {
    let calls = 0;
    const fn = async (): Promise<number> => ++calls;
    const [a, b] = await Promise.all([cached("t:a", 60_000, fn), cached("t:a", 60_000, fn)]);
    expect([a, b, await cached("t:a", 60_000, fn)]).toEqual([1, 1, 1]);
    clearCache("t:");
    expect(await cached("t:a", 60_000, fn)).toBe(2);
  });

  it("checks again when the result should not be kept, failed or expired", async () => {
    let calls = 0;
    const fn = async (): Promise<number> => ++calls;
    await cached("t:b", 60_000, fn, () => false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cached("t:b", 60_000, fn, () => false)).toBe(2);
    await cached("t:c", 60_000, () => Promise.reject(new Error("x"))).catch(() => undefined);
    expect(await cached("t:c", 60_000, fn)).toBe(3);
    await cached("t:d", -1, fn);
    expect(await cached("t:d", -1, fn)).toBe(5);
  });
});

describe("firstFree", () => {
  const checker = (taken: string[], seen: string[]) => async (name: string): Promise<NameCheck> => {
    seen.push(name);
    return { name, valid: true, available: !taken.includes(name) };
  };

  it("checks only the first name when it is free", async () => {
    const seen: string[] = [];
    expect((await firstFree("a", ["b", "c"], checker([], seen))).chosen).toBe("a");
    expect(seen).toEqual(["a"]);
  });

  it("picks the first free alternative in order, even if a later one answers first", async () => {
    const result = await firstFree("a", Promise.resolve(["b", "c", "d"]), async (name) => {
      await new Promise((resolve) => setTimeout(resolve, name === "c" ? 1 : 20));
      return { name, valid: true, available: name !== "a" };
    });
    expect(result.chosen).toBe("b");
    expect(result.checks.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("reports every check when nothing is free", async () => {
    const result = await firstFree("a", ["b"], checker(["a", "b"], []));
    expect(result).toMatchObject({ chosen: null, checks: [{ name: "a" }, { name: "b" }] });
  });
});

describe("tagAndRelease", () => {
  it("pushes the branch and the tag in one push", async () => {
    const remote = await tempDir();
    const dir = await tempDir();
    const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(remote, "init", "--bare", "-b", "main");
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }));
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "init");
    git(dir, "remote", "add", "origin", remote);
    const result = await tagAndRelease(dir, { createRelease: false });
    expect(result).toMatchObject({ ok: true, tag: "v1.2.3" });
    expect(git(remote, "rev-parse", "main")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(git(remote, "rev-parse", "v1.2.3^{commit}")).toBe(git(dir, "rev-parse", "HEAD"));
  }, 30_000);
});
