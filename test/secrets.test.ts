import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanProject } from "../src/secrets.js";
import { fake, tempDir } from "./helpers.js";

describe("scanProject", () => {
  it("finds .env files and tokens, without returning the values", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, ".env"), "SECRET=1\n");
    await writeFile(join(dir, ".env.example"), "SECRET=\n");
    await writeFile(join(dir, "config.js"), `const t = "${fake("gh" + "p_")}";\n`);
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "leak.js"), fake("np" + "m_"));
    const findings = await scanProject(dir);
    expect(findings).toContainEqual({ file: ".env", kind: ".env file" });
    expect(findings).toContainEqual({ file: "config.js", line: 1, kind: "GitHub token" });
    expect(findings.some((f) => f.file === ".env.example")).toBe(false);
    expect(findings.some((f) => f.file.includes("node_modules"))).toBe(false);
    expect(JSON.stringify(findings)).not.toContain("a1B2c3");
  });

  it("is clean for an empty folder", async () => {
    expect(await scanProject(await tempDir())).toEqual([]);
  });

  it("skips very large files instead of hanging", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "big.txt"), "x".repeat(2_000_000));
    expect(await scanProject(dir)).toEqual([]);
  });
});
