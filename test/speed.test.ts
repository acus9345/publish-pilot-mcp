import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cached, clearCache } from "../src/cache.js";
import { firstFree, type NameCheck } from "../src/names.js";
import { tagAndRelease } from "../src/ops.js";
import { tempDir } from "./helpers.js";

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
