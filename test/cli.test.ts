import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { run } from "../src/exec.js";

const cli = new URL("../dist/cli.js", import.meta.url);
const cliPath = decodeURIComponent(cli.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const built = existsSync(cliPath);

describe.skipIf(!built)("cli (built)", () => {
  it("--version prints the package version", async () => {
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const result = await run(process.execPath, [cliPath, "--version"]);
    expect(result.stdout).toBe(version);
  });

  it("--help shows usage and setup examples", async () => {
    const result = await run(process.execPath, [cliPath, "--help"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("claude mcp add publish-pilot -- npx -y publish-pilot-mcp");
    expect(result.stdout).toContain("doctor");
  });

  it("explains unknown arguments", async () => {
    const result = await run(process.execPath, [cliPath, "--nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown argument "--nope"');
  });

  it("explains bad doctor arguments", async () => {
    const result = await run(process.execPath, [cliPath, "doctor", "everything"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Example: publish-pilot-mcp doctor both npm");
  });

  it("answers an MCP initialize request on stdio", async () => {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const result = await run(process.execPath, [cliPath], { input: `${init}\n`, timeoutMs: 15_000 });
    expect(result.stdout).toContain('"name":"publish-pilot"');
  });
});
