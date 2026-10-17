#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { preflight, type Registry, type Target } from "./preflight.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `publish-pilot-mcp ${VERSION}
MCP server that lets Claude take a project from nothing to a published
GitHub repo and npm / PyPI / crates.io package.

Usage:
  publish-pilot-mcp                      Start the MCP server on stdio (what MCP clients run)
  publish-pilot-mcp doctor [target] [registry]
                                         Check tools and logins, e.g. "doctor both npm"
  publish-pilot-mcp --help               Show this help
  publish-pilot-mcp --version            Show the version

Add it to Claude Code:
  claude mcp add publish-pilot -- npx -y publish-pilot-mcp

Add it to Claude Desktop (claude_desktop_config.json):
  { "mcpServers": { "publish-pilot": { "command": "npx", "args": ["-y", "publish-pilot-mcp"] } } }

Docs: https://github.com/acus9345/publish-pilot-mcp#readme`;

const TARGETS = ["repo", "package", "both"];
const REGISTRIES = ["npm", "pypi", "crates"];

async function doctor(args: string[]): Promise<number> {
  const [target = "both", registry = "npm"] = args;
  if (!TARGETS.includes(target) || !REGISTRIES.includes(registry)) {
    console.error(`Error: expected "doctor [repo|package|both] [npm|pypi|crates]", got "doctor ${args.join(" ")}".\nExample: publish-pilot-mcp doctor both npm`);
    return 2;
  }
  const report = await preflight(target as Target, registry as Registry);
  console.log(`publish-pilot doctor (${target}, ${registry})\n`);
  for (const tool of report.tools) console.log(`  ${tool.installed ? "OK " : "MISSING"}  ${tool.name}${tool.version ? `  ${tool.version}` : ""}`);
  for (const auth of report.auth) console.log(`  ${auth.loggedIn ? "OK " : "LOGIN"}  ${auth.detail}`);
  const id = report.gitIdentity;
  console.log(`  ${id.name && id.email ? "OK " : "SET"}  git identity: ${id.name ?? "(no user.name)"} <${id.email ?? "no user.email"}>`);
  console.log(`\nNext:\n${report.nextSteps.map((s) => `  - ${s}`).join("\n")}`);
  return report.missingTools.length === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") {
    console.log(HELP);
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(VERSION);
    return;
  }
  if (first === "doctor") {
    process.exitCode = await doctor(rest);
    return;
  }
  if (first !== undefined) {
    console.error(`Error: unknown argument "${first}".\nRun "publish-pilot-mcp --help" for usage.`);
    process.exitCode = 2;
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; human messages go to stderr.
  console.error(`publish-pilot-mcp ${VERSION} running on stdio. Press Ctrl+C to stop.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
