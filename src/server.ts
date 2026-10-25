import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ListToolsRequestSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { notify, openUrl } from "./desktop.js";
import { describeJob, getJob, listJobs, run, runShell, stopJob, waitForJob, writeToJob } from "./exec.js";
import { checkCommand } from "./guard.js";
import { checkOwnRepoNames, checkRepoName, findFreeName, firstFree, githubLogin, summarizeChecks } from "./names.js";
import {
  UserError,
  bumpVersion,
  createGithubRepo,
  gitCommit,
  inspectPackage,
  publishPackage,
  runChecks,
  setupTrustedPublishing,
  startLogin,
  tagAndRelease,
  verifyInstall,
  watchWorkflow,
} from "./ops.js";
import { playbook } from "./playbook.js";
import { checkTool, compactPreflight, installCommand, npmAuth, preflight, TOOL_CATALOG } from "./preflight.js";
import { scaffoldProject } from "./scaffold.js";
import { CI_WORKFLOW_FILE, RELEASE_WORKFLOW_FILE, ciWorkflow, releaseWorkflow, repoOnlyReleaseWorkflow } from "./workflows.js";
import { VERSION } from "./version.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Longest a single call waits for a job or workflow. Many MCP clients cancel a tool call after
 * 60 seconds, so waiting tools return before that and say to call again.
 */
export const MAX_WAIT_SECONDS = 45;
const PROGRESS_INTERVAL_MS = 15_000;

/**
 * Wrap a handler: JSON output, and friendly errors instead of stack traces. While the tool runs,
 * it sends progress notifications when the client asked for them, so clients that extend their
 * timeout on progress don't cancel long installs or builds.
 */
function handler<A>(fn: (args: A) => Promise<unknown>): (args: A, extra?: Extra) => Promise<ToolResult> {
  return async (args: A, extra?: Extra) => {
    const token = extra?._meta?.progressToken;
    let ticks = 0;
    const keepAlive =
      token !== undefined && extra
        ? setInterval(() => {
            ticks += 1;
            extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ticks, message: "Still working" } }).catch(() => undefined);
          }, PROGRESS_INTERVAL_MS)
        : undefined;
    try {
      const value = await fn(args);
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
    } catch (error) {
      const message = error instanceof UserError || error instanceof TypeError || error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    } finally {
      if (keepAlive) clearInterval(keepAlive);
    }
  };
}

const dirArg = z.string();
const registryArg = z.enum(["npm", "pypi", "crates"]);
const targetArg = z.enum(["repo", "package", "both"]);
const waitNote = `Max ${MAX_WAIT_SECONDS} s per call; call again while running`;
const privateNote = "Private repo: Ubuntu-only CI to save Actions minutes";
const shellNote = "List of commands (PowerShell on Windows, sh elsewhere)";

const abs = (dir: string): string => resolve(dir);
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

/** Explain common ways a login or publish job ends badly, and what to do next. */
export function jobHint(running: boolean, exitCode: number | null, output: string): string | undefined {
  if (running || exitCode === 0) return undefined;
  if (/E429|Too Many Requests|rate limit/i.test(output)) {
    return "The registry rate-limited publishing (npm caps how many packages and versions an account can publish, and does not say the limit). Nothing was published. Do NOT retry soon: each failed attempt can extend the block. publish_package now refuses for 24 hours; tell the user, and wait, or ask npm support (https://www.npmjs.com/support) to lift it.";
  }
  if (/E403.*(previously published|cannot publish over)/i.test(output)) return "This version already exists. Run bump_version, commit, and publish the new version.";
  if (/E403|E404/.test(output) && /similar to existing|too similar/i.test(output)) return "npm rejected the name as too similar to an existing package. Use check_names to pick another name (a scoped @you/name always works).";
  if (/expired|E401|timed out|timeout/i.test(output)) return "The approval link expired or the login is no longer valid. Start the same tool again for a fresh link (call login first if npm whoami fails).";
  return undefined;
}

/**
 * Every tools/list result is sent to the model on each turn, so drop what carries no meaning for
 * it: the JSON Schema dialect URL on every input schema and the default "forbidden" task setting.
 */
export function slimToolList(server: McpServer): void {
  const inner = server.server;
  const setRequestHandler = inner.setRequestHandler.bind(inner) as (schema: unknown, handler: (...args: unknown[]) => unknown) => void;
  (inner as { setRequestHandler: unknown }).setRequestHandler = (schema: unknown, handle: (...args: unknown[]) => unknown) =>
    setRequestHandler(
      schema,
      schema === ListToolsRequestSchema
        ? async (...args: unknown[]) => {
            const result = (await handle(...args)) as { tools: Record<string, unknown>[] };
            for (const tool of result.tools) {
              delete (tool.inputSchema as Record<string, unknown> | undefined)?.$schema;
              if ((tool.execution as { taskSupport?: string } | undefined)?.taskSupport === "forbidden") delete tool.execution;
            }
            return result;
          }
        : handle,
    );
}

/** Build the publish-pilot MCP server with all tools and the publish_project prompt. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "publish-pilot", version: VERSION },
    {
      instructions:
        "Publishes projects to GitHub and npm, PyPI or crates.io. Start with the publish_project prompt or preflight. Logins and publishes return a job id; poll job_status. Never enter passwords or 2FA codes: the user does sign-in and Authorize/Approve/Save clicks.",
    },
  );

  slimToolList(server);

  // ---------------------------------------------------------------- preflight
  server.registerTool(
    "preflight",
    {
      description: "Check tools (git, gh, registry CLI), logins and git identity. Run first.",
      inputSchema: { target: targetArg, registry: registryArg.optional() },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ target, registry }) => compactPreflight(await preflight(target, registry))),
  );

  server.registerTool(
    "install_tool",
    {
      description: "Install a tool with winget, brew or apt.",
      inputSchema: { name: z.enum(Object.keys(TOOL_CATALOG) as [string, ...string[]]) },
      annotations: { destructiveHint: false },
    },
    handler(async ({ name }) => {
      const before = await checkTool(name);
      if (before.installed) return { alreadyInstalled: true, ...before };
      const cmd = installCommand(name);
      if (!cmd) throw new UserError(`No install recipe for ${name}.`);
      const result = await run(cmd.cmd, cmd.args, { timeoutMs: 900_000 });
      const after = await checkTool(name);
      if (after.installed) return { installed: true, version: after.version };
      return {
        installed: false,
        command: result.command,
        output: (result.stdout + "\n" + result.stderr).trim().slice(-3000),
        hint: "If the install succeeded but the tool is still not found, restart the MCP client (PATH is read at start-up).",
      };
    }),
  );

  server.registerTool(
    "check_names",
    {
      description: "Check a package name on its registry and a repo name on your GitHub. If taken, returns the first free alternative (npm: @user/name first).",
      inputSchema: {
        registry: registryArg.optional(),
        packageName: z.string().optional(),
        repoName: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ registry, packageName, repoName }) => {
      if (packageName && !registry) throw new UserError("Pass 'registry' together with 'packageName'.");
      // Everything runs at once. One GraphQL call answers both the login and every repo name.
      const repoCandidates = repoName ? [repoName, `${repoName}-kit`, `${repoName}-tool`, `${repoName}-lib`] : [];
      const repos = repoName ? checkOwnRepoNames(repoCandidates) : Promise.resolve(null);
      const ownerPromise = repos.then((r) => r?.owner ?? githubLogin());
      const npmUser = packageName && registry === "npm" ? npmAuth().then((a) => a.account) : undefined;
      const checkRepo = async (): Promise<unknown> => {
        if (!repoName) return undefined;
        const fast = await repos;
        const owner = await ownerPromise;
        if (!owner) return { requested: repoName, available: null, reason: "Log in to GitHub (login tool) to check repo names." };
        const freeAt = fast?.checks.findIndex((c) => c.valid && c.available === true) ?? -1;
        const { chosen, checks } = fast
          ? { chosen: freeAt === -1 ? null : repoCandidates[freeAt]!, checks: freeAt === -1 ? fast.checks : fast.checks.slice(0, freeAt + 1) }
          : await firstFree(repoName, repoCandidates.slice(1), (name) => checkRepoName(owner, name));
        return { requested: repoName, chosen, url: chosen ? `https://github.com/${owner}/${chosen}` : null, ...summarizeChecks(checks) };
      };
      const checkPackage = async (): Promise<unknown> => {
        if (!packageName || !registry) return undefined;
        const user = Promise.all([npmUser, ownerPromise]).then(([u, o]) => u ?? o ?? undefined);
        const { chosen, checks } = await findFreeName(registry, packageName, user);
        return { requested: packageName, chosen, ...summarizeChecks(checks) };
      };
      const [githubUser, pkg, repo] = await Promise.all([ownerPromise, checkPackage(), checkRepo()]);
      const out: Record<string, unknown> = { githubUser };
      if (pkg) out.package = pkg;
      if (repo) out.repo = repo;
      return out;
    }),
  );

  // ---------------------------------------------------------------- logins and jobs
  server.registerTool(
    "login",
    {
      description:
        "Start a browser login. Returns a job with the URL and code; the user signs in and approves. Poll job_status until running is false.",
      inputSchema: {
        service: z.enum(["github", "npm", "pypi", "crates"]),
        openBrowser: z.boolean().default(true),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ service, openBrowser }) => startLogin(service, openBrowser)),
  );

  server.registerTool(
    "job_status",
    {
      description: "Status and output of a login/publish job; without id, lists jobs.",
      inputSchema: {
        id: z.string().optional(),
        waitSeconds: z.number().int().min(0).max(600).default(0).describe(waitNote),
        sendEnter: z.boolean().default(false).describe("Answer a 'Press ENTER' prompt"),
        stop: z.boolean().default(false),
      },
      annotations: { openWorldHint: false },
    },
    handler(async ({ id, waitSeconds, sendEnter, stop }) => {
      if (!id) return listJobs().map((j) => describeJob(j, 300));
      const job = getJob(id);
      if (!job) throw new UserError(`No job with id ${id}. Call job_status without an id to list jobs.`);
      if (stop) stopJob(job);
      if (sendEnter) writeToJob(job, "\n");
      await waitForJob(job, Math.min(waitSeconds, MAX_WAIT_SECONDS) * 1000);
      const info = describeJob(job);
      const hint = jobHint(job.running, job.exitCode, job.output);
      if (hint) info.hint = hint;
      return info;
    }),
  );

  // ---------------------------------------------------------------- build
  server.registerTool(
    "scaffold_project",
    {
      description:
        "Create a project: source, test, README, LICENSE, CHANGELOG, .gitignore, manifest (0.1.0). With repoUrl, also CI and release workflows. Never overwrites files.",
      inputSchema: {
        dir: dirArg,
        name: z.string(),
        description: z.string(),
        registry: registryArg,
        license: z.string().default("MIT"),
        repoUrl: z.string().optional().describe("https://github.com/owner/repo"),
        cli: z.boolean().default(false).describe("Add a CLI entry point"),
        workflows: z.enum(["none", "ci", "ci+release", "ci+repo-release"]).optional().describe("Default follows target"),
        target: targetArg.optional().describe("Default both with repoUrl, else package. repo: never published to a registry"),
        private: z.boolean().default(false).describe(privateNote),
      },
      annotations: { destructiveHint: false },
    },
    handler(async (args) => {
      if (args.repoUrl && !GITHUB_REPO_URL.test(args.repoUrl)) throw new UserError("repoUrl must look like https://github.com/owner/repo.");
      const [name, email] = await Promise.all([run("git", ["config", "user.name"]), run("git", ["config", "user.email"])]);
      const author = name.stdout ? `${name.stdout}${email.stdout ? ` <${email.stdout}>` : ""}` : undefined;
      const result = await scaffoldProject({ ...args, dir: abs(args.dir), author });
      return { ...result, author: author ?? "(git config user.name not set)", next: "Write the real code and tests, then run_checks." };
    }),
  );

  server.registerTool(
    "add_workflows",
    {
      description:
        "Write ci.yml and release.yml (on v* tags: test, publish via OIDC unless the version exists, GitHub release from CHANGELOG). Keeps existing files unless overwrite.",
      inputSchema: {
        dir: dirArg,
        registry: registryArg.optional().describe("Omit for repo-only"),
        release: z.enum(["none", "registry", "github-only"]).default("registry"),
        private: z.boolean().default(false).describe(privateNote),
        overwrite: z.boolean().default(false),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, registry, release, private: isPrivate, overwrite }) => {
      const base = join(abs(dir), ".github", "workflows");
      const files: Record<string, string> = {};
      if (registry) files[CI_WORKFLOW_FILE] = ciWorkflow(registry, { lean: isPrivate });
      if (release === "registry") {
        if (!registry) throw new UserError("release 'registry' needs a registry. Use release 'github-only' for a repo-only project.");
        files[RELEASE_WORKFLOW_FILE] = releaseWorkflow(registry);
      }
      if (release === "github-only") files[RELEASE_WORKFLOW_FILE] = repoOnlyReleaseWorkflow();
      const written: string[] = [];
      const kept: string[] = [];
      for (const [file, content] of Object.entries(files)) {
        const path = join(base, file);
        if (existsSync(path) && !overwrite) {
          kept.push(file);
          continue;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        written.push(file);
      }
      return { written, kept, folder: base };
    }),
  );

  server.registerTool(
    "run_checks",
    {
      description: "Secret scan, install, lint, typecheck, build, test (npm scripts, .venv + pytest, or cargo). Stops at the first failure.",
      inputSchema: { dir: dirArg },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir }) => runChecks(abs(dir))),
  );

  server.registerTool(
    "inspect_package",
    {
      description: "Publish dry run: files that would ship, junk/secret warnings, registry check.",
      inputSchema: { dir: dirArg },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ dir }) => inspectPackage(abs(dir))),
  );

  // ---------------------------------------------------------------- release
  server.registerTool(
    "git_commit",
    {
      description: "Stage all and commit (git init -b main if needed). Refuses if secrets would be committed.",
      inputSchema: { dir: dirArg, message: z.string().describe("Commit message.") },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, message }) => gitCommit(abs(dir), message)),
  );

  server.registerTool(
    "create_github_repo",
    {
      description: "Create the GitHub repo from the folder and push. If it is already this folder's origin, just pushes.",
      inputSchema: {
        dir: dirArg,
        name: z.string(),
        visibility: z.enum(["public", "private"]).default("public"),
        description: z.string().optional(),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, name, visibility, description }) => createGithubRepo(abs(dir), name, visibility, description)),
  );

  server.registerTool(
    "publish_package",
    {
      description:
        "Publish to the registry; returns a job (npm approval opens in a terminal). Skips existing versions, and refuses for 24 h after an E429.",
      inputSchema: {
        dir: dirArg,
        dryRun: z.boolean().default(false),
        openBrowser: z.boolean().default(true),
        force: z.boolean().default(false).describe("Ignore the E429 wait; only if the user says the block was lifted"),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, dryRun, openBrowser, force }) => publishPackage(abs(dir), { dryRun, openBrowser, force })),
  );

  server.registerTool(
    "setup_trusted_publishing",
    {
      description:
        "Link the package to release.yml for OIDC publishing. npm: npm trust (package must exist; user approves 2FA). PyPI/crates: opens the settings page with the values; user clicks Save.",
      inputSchema: {
        dir: dirArg,
        repo: z.string().describe("owner/name"),
        workflowFile: z.string().default(RELEASE_WORKFLOW_FILE),
        openBrowser: z.boolean().default(true),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, repo, workflowFile, openBrowser }) => setupTrustedPublishing(abs(dir), repo, workflowFile, openBrowser)),
  );

  server.registerTool(
    "tag_and_release",
    {
      description:
        "Tag v<manifest version>, push branch and tag together, and create the GitHub release from CHANGELOG unless release.yml does. Never moves tags.",
      inputSchema: {
        dir: dirArg,
        version: z.string().optional(),
        createRelease: z.boolean().optional(),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, version, createRelease }) => tagAndRelease(abs(dir), { version, createRelease })),
  );

  server.registerTool(
    "watch_workflow",
    {
      description:
        "Result of the workflow run for HEAD (default release.yml), with failed logs.",
      inputSchema: {
        dir: dirArg,
        workflow: z.string().default(RELEASE_WORKFLOW_FILE),
        ref: z.string().optional().describe("Tag or branch"),
        waitSeconds: z.number().int().min(0).max(600).default(MAX_WAIT_SECONDS).describe(waitNote),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ dir, workflow, ref, waitSeconds }) => watchWorkflow(abs(dir), workflow, Math.min(waitSeconds, MAX_WAIT_SECONDS), ref)),
  );

  server.registerTool(
    "bump_version",
    {
      description:
        "Bump the version and add notes to CHANGELOG (no notes: Unreleased becomes the version). Does not commit.",
      inputSchema: {
        dir: dirArg,
        level: z.enum(["patch", "minor", "major"]).default("patch"),
        notes: z.string().default("").describe("Markdown"),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, level, notes }) => bumpVersion(abs(dir), level, notes)),
  );

  server.registerTool(
    "verify_install",
    {
      description:
        "In a fresh temp folder, install the published package (or clone repoUrl) and run commands in order, stopping at the first failure. Its executables are on PATH.",
      inputSchema: {
        registry: registryArg.optional(),
        name: z.string().optional(),
        version: z.string().optional(),
        repoUrl: z.string().optional(),
        command: z.union([z.string(), z.array(z.string()).min(1)]).describe(shellNote),
      },
      annotations: { destructiveHint: false },
    },
    handler(async (args) => verifyInstall(args)),
  );

  // ---------------------------------------------------------------- desktop and shell
  server.registerTool(
    "notify",
    {
      description: "Desktop notification, e.g. 'Ready for your approval'. url opens a github.com, npmjs.com, pypi.org or crates.io page.",
      inputSchema: { message: z.string(), title: z.string().default("publish-pilot"), url: z.string().optional() },
      annotations: { destructiveHint: false },
    },
    handler(async ({ title, message, url }) => {
      const [shown, page] = await Promise.all([notify(title, message), url ? openUrl(url) : undefined]);
      return page ? { shown, ...page } : { shown };
    }),
  );

  server.registerTool(
    "run_command",
    {
      description: "Run a shell command (PowerShell on Windows, sh elsewhere). Destructive ones (force-push, deleting tags/repos/releases, unpublish, rm -r) are refused.",
      inputSchema: {
        command: z.string(),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(1800).default(300),
      },
      annotations: { destructiveHint: true },
    },
    handler(async ({ command, cwd, timeoutSeconds }) => {
      const refused = checkCommand(command);
      if (refused) throw new UserError(refused);
      const result = await runShell(command, { cwd: cwd ? abs(cwd) : undefined, timeoutMs: timeoutSeconds * 1000 });
      const out: Record<string, unknown> = { exitCode: result.exitCode, stdout: result.stdout.slice(-20_000) };
      if (result.stderr) out.stderr = result.stderr.slice(-10_000);
      if (result.timedOut) out.timedOut = true;
      return out;
    }),
  );

  // ---------------------------------------------------------------- prompt
  server.registerPrompt(
    "publish_project",
    {
      description: "Step-by-step plan to take a project from nothing to a published GitHub repo and/or package using these tools.",
      argsSchema: {
        target: z.string().optional().describe("repo, package or both"),
        name: z.string().optional().describe("Package name"),
        description: z.string().optional().describe("Short description"),
        registry: z.string().optional().describe("npm, pypi or crates"),
        visibility: z.string().optional().describe("public or private"),
        license: z.string().optional().describe("SPDX id, default MIT"),
        what: z.string().optional().describe("What the package should do"),
        dir: z.string().optional().describe("Project folder"),
      },
    },
    (args) => ({ messages: [{ role: "user", content: { type: "text", text: playbook(args) } }] }),
  );

  return server;
}
