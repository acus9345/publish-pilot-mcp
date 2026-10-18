import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateCiCostHint, releaseWorkflowCreatesRelease, runCommandList } from "../src/ops.js";
import { ciWorkflow, releaseWorkflow, repoOnlyReleaseWorkflow } from "../src/workflows.js";
import { tempDir } from "./helpers.js";

async function withWorkflow(file: string, content: string): Promise<string> {
  const dir = await tempDir();
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(join(dir, ".github", "workflows", file), content);
  return dir;
}

describe("runCommandList", () => {
  it("runs a list in order and stops at the first failure", async () => {
    const dir = await tempDir();
    const result = await runCommandList(['node -e "console.log(11)"', 'node -e "process.exit(3)"', 'node -e "console.log(33)"'], { cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.step)).toEqual(["command 1/3", "command 2/3", "not run"]);
    expect(result.steps[0]!.output).toContain("11");
    expect(result.steps[2]!.command).toContain("console.log(33)");
  });

  it("passes when every command succeeds", async () => {
    const result = await runCommandList(['node -e "console.log(1)"', 'node -e "console.log(2)"'], { cwd: await tempDir() });
    expect(result.ok).toBe(true);
    expect(result.hint).toBeUndefined();
  });

  it("warns that a joined command line only reports the last command", async () => {
    const result = await runCommandList('node -e "process.exit(1)"; node -e "console.log(2)"', { cwd: await tempDir() });
    expect(result.hint).toMatch(/Pass a list of commands/);
  });
});

describe("releaseWorkflowCreatesRelease", () => {
  it("detects publish-pilot's release workflows", async () => {
    expect(await releaseWorkflowCreatesRelease(await withWorkflow("release.yml", repoOnlyReleaseWorkflow()))).toBe(true);
    expect(await releaseWorkflowCreatesRelease(await withWorkflow("release.yml", releaseWorkflow("npm")))).toBe(true);
  });

  it("is false without a release workflow, or one that doesn't release on tags", async () => {
    expect(await releaseWorkflowCreatesRelease(await tempDir())).toBe(false);
    expect(await releaseWorkflowCreatesRelease(await withWorkflow("release.yml", "on:\n  push:\n    branches: [main]\njobs: {}\n"))).toBe(false);
  });
});

describe("privateCiCostHint", () => {
  it("warns about Windows/macOS runners in a private repo's CI", async () => {
    const hint = await privateCiCostHint(await withWorkflow("ci.yml", ciWorkflow("npm")));
    expect(hint).toMatch(/windows-latest and macos-latest/);
    expect(hint).toMatch(/add_workflows with private: true/);
  });

  it("is quiet for Ubuntu-only CI or no CI", async () => {
    expect(await privateCiCostHint(await withWorkflow("ci.yml", ciWorkflow("npm", { lean: true })))).toBeUndefined();
    expect(await privateCiCostHint(await tempDir())).toBeUndefined();
  });
});
