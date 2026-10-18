import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_WAIT_SECONDS, createServer, jobHint } from "../src/server.js";
import { tempDir } from "./helpers.js";

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string => (result.content as { text: string }[])[0]!.text;

describe("MCP server", () => {
  it("lists every tool with a description", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_workflows",
        "bump_version",
        "check_names",
        "create_github_repo",
        "git_commit",
        "inspect_package",
        "install_tool",
        "job_status",
        "login",
        "notify",
        "open_url",
        "preflight",
        "publish_package",
        "run_checks",
        "run_command",
        "scaffold_project",
        "scan_secrets",
        "setup_trusted_publishing",
        "tag_and_release",
        "verify_install",
        "watch_workflow",
      ].sort(),
    );
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(20);
  });

  it("serves the publish_project prompt with inputs filled in", async () => {
    const prompt = await client.getPrompt({ name: "publish_project", arguments: { target: "both", registry: "npm" } });
    const body = (prompt.messages[0]!.content as { text: string }).text;
    expect(body).toContain("Publish to: both");
    expect(body).toContain("Package name and short description: ASK");
    expect(body).toContain("Never delete, force-push or unpublish");
  });

  it("refuses destructive commands with a helpful message", async () => {
    const result = await client.callTool({ name: "run_command", arguments: { command: "git push --force" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Error: Refused.*new version/);
  });

  it("refuses to open non-registry URLs", async () => {
    const result = await client.callTool({ name: "open_url", arguments: { url: "https://example.com" } });
    expect(JSON.parse(text(result))).toMatchObject({ opened: false });
  });

  it("scans for secrets", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, ".env"), "X=1");
    const result = await client.callTool({ name: "scan_secrets", arguments: { dir } });
    expect(JSON.parse(text(result))).toMatchObject({ clean: false, findings: [{ file: ".env" }] });
  });

  it("gives a friendly error for a folder without a manifest", async () => {
    const result = await client.callTool({ name: "run_checks", arguments: { dir: await tempDir() } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No package.json.*scaffold_project/);
  });

  it("validates arguments", async () => {
    const result = await client.callTool({ name: "preflight", arguments: { target: "nope" } });
    expect(result.isError).toBe(true);
  });

  it("refuses to commit secrets", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await writeFile(join(dir, ".env"), "X=1");
    const result = await client.callTool({ name: "git_commit", arguments: { dir, message: "init" } });
    expect(JSON.parse(text(result))).toMatchObject({ ok: false, refused: true });
  });

  it("bumps the version and changelog", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }));
    await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [0.1.0] - 2026-01-01\n\n- First.\n");
    const result = await client.callTool({ name: "bump_version", arguments: { dir, notes: "- Fix." } });
    expect(JSON.parse(text(result))).toMatchObject({ from: "0.1.0", to: "0.1.1" });
  });

  it("explains failed jobs", () => {
    expect(jobHint(false, 1, "npm error code E429\n429 Too Many Requests")).toMatch(/rate-limited.*Nothing was published/);
    expect(jobHint(false, 1, "E403 You cannot publish over the previously published versions")).toMatch(/bump_version/);
    expect(jobHint(false, 1, "npm error code E401")).toMatch(/fresh link/);
    expect(jobHint(true, null, "E429")).toBeUndefined();
    expect(jobHint(false, 0, "E429")).toBeUndefined();
    expect(jobHint(false, 1, "something else")).toBeUndefined();
  });

  it("returns long waits before common 60-second client timeouts", async () => {
    expect(MAX_WAIT_SECONDS).toBeLessThan(60);
    const { tools } = await client.listTools();
    for (const name of ["job_status", "watch_workflow"]) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as unknown as { properties: { waitSeconds: { description: string } } };
      expect(schema.properties.waitSeconds.description).toMatch(/Capped at 45 s/);
    }
  });

  it("sends progress notifications during long calls when asked", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    const progressClient = new Client({ name: "progress", version: "0.0.0" });
    await progressClient.connect(clientTransport);
    const dir = await tempDir();
    const updates: number[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const call = progressClient.callTool(
        { name: "run_command", arguments: { command: 'node -e "setTimeout(() => {}, 300)"', cwd: dir } },
        undefined,
        { onprogress: (p) => updates.push(p.progress) },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      vi.advanceTimersByTime(31_000);
      await call;
    } finally {
      vi.useRealTimers();
      await progressClient.close();
    }
    expect(updates).toEqual([1, 2]);
  });

  it("lists jobs (none yet)", async () => {
    const result = await client.callTool({ name: "job_status", arguments: {} });
    expect(JSON.parse(text(result))).toEqual([]);
  });
});
