import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.js";

export type Registry = "npm" | "pypi" | "crates";
export type Target = "repo" | "package" | "both";

export interface ToolInfo {
  name: string;
  installed: boolean;
  version?: string;
  /** winget id used by `install_tool` on Windows. */
  wingetId?: string;
  neededFor: string;
}

export interface AuthInfo {
  service: "github" | Registry;
  loggedIn: boolean;
  /** Account name when it can be read without exposing a token. */
  account?: string;
  detail: string;
}

/** Install hints per tool. winget ids are the official packages. */
export const TOOL_CATALOG: Record<string, { versionArgs: string[]; wingetId: string; brew: string; apt: string }> = {
  git: { versionArgs: ["--version"], wingetId: "Git.Git", brew: "git", apt: "git" },
  gh: { versionArgs: ["--version"], wingetId: "GitHub.cli", brew: "gh", apt: "gh" },
  node: { versionArgs: ["--version"], wingetId: "OpenJS.NodeJS.LTS", brew: "node", apt: "nodejs" },
  npm: { versionArgs: ["--version"], wingetId: "OpenJS.NodeJS.LTS", brew: "node", apt: "npm" },
  python: { versionArgs: ["--version"], wingetId: "Python.Python.3.13", brew: "python", apt: "python3" },
  cargo: { versionArgs: ["--version"], wingetId: "Rustlang.Rustup", brew: "rustup", apt: "cargo" },
};

/** Which CLI tools a target + registry combination needs. */
export function requiredTools(target: Target, registry?: Registry): string[] {
  const tools = ["git"];
  if (target !== "package") tools.push("gh");
  if (target !== "repo") {
    if (registry === "npm" || registry === undefined) tools.push("node", "npm");
    if (registry === "pypi") tools.push("python");
    if (registry === "crates") tools.push("cargo");
  }
  return tools;
}

function pythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/** Check one tool. Never throws. */
export async function checkTool(name: string): Promise<ToolInfo> {
  const entry = TOOL_CATALOG[name];
  const cmd = name === "python" ? pythonCommand() : name;
  const result = await run(cmd, entry?.versionArgs ?? ["--version"], { timeoutMs: 20_000 });
  const firstLine = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim();
  // The Windows Store "python" alias prints an install hint and fails.
  const installed = result.ok && !/Microsoft Store/i.test(firstLine ?? "");
  return {
    name,
    installed,
    version: installed ? firstLine : undefined,
    wingetId: entry?.wingetId,
    neededFor: name === "gh" ? "GitHub repo" : name === "git" ? "always" : "package build/publish",
  };
}

/** Is the GitHub CLI logged in? */
export async function githubAuth(): Promise<AuthInfo> {
  const result = await run("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs: 20_000 });
  if (result.notFound) return { service: "github", loggedIn: false, detail: "GitHub CLI (gh) is not installed. Run install_tool with name 'gh'." };
  const text = `${result.stdout}\n${result.stderr}`;
  const account = /Logged in to github\.com (?:account )?(\S+)/i.exec(text)?.[1];
  return result.ok
    ? { service: "github", loggedIn: true, account, detail: `Logged in to github.com${account ? ` as ${account}` : ""}.` }
    : { service: "github", loggedIn: false, detail: "Not logged in to GitHub. Run the login tool with service 'github'." };
}

/** Is npm logged in to the public registry? */
export async function npmAuth(): Promise<AuthInfo> {
  const result = await run("npm", ["whoami", "--registry", "https://registry.npmjs.org/"], { timeoutMs: 30_000 });
  if (result.notFound) return { service: "npm", loggedIn: false, detail: "npm is not installed. Run install_tool with name 'node'." };
  const account = result.stdout.split(/\r?\n/).pop()?.trim();
  return result.ok && account
    ? { service: "npm", loggedIn: true, account, detail: `Logged in to npm as ${account}.` }
    : { service: "npm", loggedIn: false, detail: "Not logged in to npm. Run the login tool with service 'npm'." };
}

/** PyPI has no login command: credentials live in ~/.pypirc or TWINE_* env vars. */
export function pypiAuth(): AuthInfo {
  const hasFile = existsSync(join(homedir(), ".pypirc"));
  const hasEnv = Boolean(process.env.TWINE_PASSWORD || process.env.TWINE_API_KEY);
  return hasFile || hasEnv
    ? { service: "pypi", loggedIn: true, detail: `PyPI credentials found (${hasFile ? "~/.pypirc" : "TWINE_* environment variables"}).` }
    : {
        service: "pypi",
        loggedIn: false,
        detail: "No PyPI credentials. Prefer trusted publishing: register a pending publisher at https://pypi.org/manage/account/publishing/ and let the release workflow publish.",
      };
}

/** crates.io credentials are stored by `cargo login`. */
export function cratesAuth(): AuthInfo {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const found = ["credentials.toml", "credentials"].some((f) => existsSync(join(cargoHome, f))) || Boolean(process.env.CARGO_REGISTRY_TOKEN);
  return found
    ? { service: "crates", loggedIn: true, detail: "crates.io credentials found." }
    : { service: "crates", loggedIn: false, detail: "Not logged in to crates.io. Run the login tool with service 'crates'." };
}

export async function authFor(service: AuthInfo["service"]): Promise<AuthInfo> {
  switch (service) {
    case "github":
      return githubAuth();
    case "npm":
      return npmAuth();
    case "pypi":
      return pypiAuth();
    case "crates":
      return cratesAuth();
  }
}

export interface PreflightReport {
  target: Target;
  registry?: Registry;
  tools: ToolInfo[];
  missingTools: string[];
  auth: AuthInfo[];
  gitIdentity: { name?: string; email?: string };
  nextSteps: string[];
}

/** Check tools, logins and git identity for a target. Starts no logins. */
export async function preflight(target: Target, registry?: Registry): Promise<PreflightReport> {
  const toolNames = requiredTools(target, registry);
  const tools = await Promise.all(toolNames.map(checkTool));
  const missingTools = tools.filter((t) => !t.installed).map((t) => t.name);

  const services: AuthInfo["service"][] = [];
  if (target !== "package" && !missingTools.includes("gh")) services.push("github");
  if (target !== "repo" && registry && !missingTools.some((t) => t !== "git")) services.push(registry);
  const auth = await Promise.all(services.map(authFor));

  const [name, email] = await Promise.all([
    run("git", ["config", "user.name"], { timeoutMs: 10_000 }),
    run("git", ["config", "user.email"], { timeoutMs: 10_000 }),
  ]);
  const gitIdentity = { name: name.stdout || undefined, email: email.stdout || undefined };

  const nextSteps: string[] = [];
  for (const tool of missingTools) nextSteps.push(`Install ${tool}: call install_tool with name '${tool}'.`);
  if (!gitIdentity.name || !gitIdentity.email) nextSteps.push("Set a git identity: git config --global user.name \"Your Name\" and user.email.");
  for (const a of auth) if (!a.loggedIn) nextSteps.push(a.detail);
  if (nextSteps.length === 0) nextSteps.push("Everything needed is installed and logged in.");
  return { target, registry, tools, missingTools, auth, gitIdentity, nextSteps };
}

/** The command that installs a tool on this OS. */
export function installCommand(name: string): { cmd: string; args: string[] } | null {
  const entry = TOOL_CATALOG[name];
  if (!entry) return null;
  if (process.platform === "win32") {
    return { cmd: "winget", args: ["install", "--id", entry.wingetId, "-e", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements", "--silent"] };
  }
  if (process.platform === "darwin") return { cmd: "brew", args: ["install", entry.brew] };
  return { cmd: "sudo", args: ["apt-get", "install", "-y", entry.apt] };
}
