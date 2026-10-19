import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { notify, openUrl } from "./desktop.js";
import { describeJob, getJob, listJobs, run, runShell, stopJob, waitForJob, writeToJob } from "./exec.js";
import { checkCommand } from "./guard.js";
import { checkOwnRepoNames, checkRepoName, findFreeName, firstFree, githubLogin } from "./names.js";
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
import { checkTool, installCommand, npmAuth, preflight, TOOL_CATALOG } from "./preflight.js";
import { scaffoldProject } from "./scaffold.js";
import { scanProject } from "./secrets.js";
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

const dirArg = z.string().describe("Project folder (absolute path, or relative to the server's working directory).");
const registryArg = z.enum(["npm", "pypi", "crates"]).describe("Package registry: npm, pypi (PyPI) or crates (crates.io).");
const targetArg = z.enum(["repo", "package", "both"]).describe("What to publish: a GitHub repo, a registry package, or both.");

const abs = (dir: string): string => resolve(dir);

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

/** Build the publish-pilot MCP server with all tools and the publish_project prompt. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "publish-pilot", version: VERSION },
    {
      instructions:
        "publish-pilot takes a project from an empty folder to a published GitHub repo and/or npm, PyPI or crates.io package. Start with the publish_project prompt or call preflight. Long-running logins and publishes return a job id: poll it with job_status. Never enter passwords or 2FA codes for the user; leave sign-in, 2FA and Authorize/Approve/Save clicks to them.",
    },
  );

  // ---------------------------------------------------------------- preflight
  server.registerTool(
    "preflight",
    {
      title: "Preflight check",
      description: "Check that git, gh and the registry CLI are installed, which accounts are logged in, and the git identity. Starts no logins. Run this first.",
      inputSchema: { target: targetArg, registry: registryArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ target, registry }) => preflight(target, registry)),
  );

  server.registerTool(
    "install_tool",
    {
      title: "Install a missing tool",
      description: `Install a CLI tool with winget (Windows), brew (macOS) or apt (Linux). Known tools: ${Object.keys(TOOL_CATALOG).join(", ")}. After installing on Windows you may need to restart the MCP client so PATH updates.`,
      inputSchema: { name: z.enum(Object.keys(TOOL_CATALOG) as [string, ...string[]]).describe("Tool to install.") },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ name }) => {
      const before = await checkTool(name);
      if (before.installed) return { alreadyInstalled: true, ...before };
      const cmd = installCommand(name);
      if (!cmd) throw new UserError(`No install recipe for ${name}.`);
      const result = await run(cmd.cmd, cmd.args, { timeoutMs: 900_000 });
      const after = await checkTool(name);
      return {
        installed: after.installed,
        command: result.command,
        output: (result.stdout + "\n" + result.stderr).trim().slice(-3000),
        hint: after.installed ? undefined : "If the install succeeded but the tool is still not found, restart the MCP client (PATH is read at start-up).",
      };
    }),
  );

  server.registerTool(
    "check_names",
    {
      title: "Check package and repo names",
      description: "Check that a package name is valid and free on the registry and that the GitHub repo name is free. When taken, returns the best free alternative (for npm, a scoped @user/name first).",
      inputSchema: {
        registry: registryArg.optional(),
        packageName: z.string().optional().describe("Package name to check on the registry."),
        repoName: z.string().optional().describe("GitHub repo name to check under your account."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
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
        return { owner, requested: repoName, chosen, url: chosen ? `https://github.com/${owner}/${chosen}` : null, checks };
      };
      const checkPackage = async (): Promise<unknown> => {
        if (!packageName || !registry) return undefined;
        const user = Promise.all([npmUser, ownerPromise]).then(([u, o]) => u ?? o ?? undefined);
        const { chosen, checks } = await findFreeName(registry, packageName, user);
        return { requested: packageName, chosen, checks };
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
      title: "Start a browser login",
      description:
        "Start the browser-based login for github (gh auth login --web), npm (npm login --auth-type=web), pypi or crates. Returns at once with a job id, the one-time code and the URL; the user signs in, does 2FA and clicks Authorize. Poll job_status every 1–2 minutes until running is false.",
      inputSchema: {
        service: z.enum(["github", "npm", "pypi", "crates"]).describe("Which account to log in to."),
        openBrowser: z.boolean().default(true).describe("Open the login page in the default browser."),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ service, openBrowser }) => startLogin(service, openBrowser)),
  );

  server.registerTool(
    "job_status",
    {
      title: "Check a background job",
      description: "Get the status and recent output of a login or publish job. Optionally wait up to waitSeconds for it to finish, or send Enter to it. Without an id, lists all jobs.",
      inputSchema: {
        id: z.string().optional().describe("Job id from login, publish_package or setup_trusted_publishing."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(0)
          .describe(`Wait up to this long for the job to finish. Capped at ${MAX_WAIT_SECONDS} s per call so the call returns before common 60 s client timeouts; call again while running is true.`),
        sendEnter: z.boolean().default(false).describe("Send Enter to the job (for 'Press ENTER' prompts)."),
        stop: z.boolean().default(false).describe("Stop the job (e.g. to restart a publish whose link expired)."),
      },
      annotations: { openWorldHint: false },
    },
    handler(async ({ id, waitSeconds, sendEnter, stop }) => {
      if (!id) return listJobs().map((j) => describeJob(j, 500));
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
      title: "Scaffold a project",
      description:
        "Create a standard project: source, tests, README, LICENSE, CHANGELOG, .gitignore, .gitattributes and a manifest (version 0.1.0, author from git config, repo URL, publishConfig for scoped npm). Adds CI and release workflows when repoUrl is set. For target 'repo' the README explains clone-and-build and the manifest blocks registry publishing; for private repos CI runs on Ubuntu only. Never overwrites existing files.",
      inputSchema: {
        dir: dirArg,
        name: z.string().describe("Package name."),
        description: z.string().describe("One-line description."),
        registry: registryArg,
        license: z.string().default("MIT").describe("SPDX license id."),
        repoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/).optional().describe("https://github.com/owner/repo"),
        cli: z.boolean().default(false).describe("Add a command-line entry point with --help and --version (npm, pypi)."),
        workflows: z.enum(["none", "ci", "ci+release", "ci+repo-release"]).optional().describe("Default with repoUrl: ci+release for target 'both', ci+repo-release for 'repo', ci for 'package'."),
        target: targetArg.optional().describe("What will be published. Default 'both' when repoUrl is set, otherwise 'package'."),
        private: z.boolean().default(false).describe("The GitHub repo will be private: CI runs on Ubuntu only to save paid Actions minutes."),
      },
      annotations: { destructiveHint: false },
    },
    handler(async (args) => {
      const [name, email] = await Promise.all([run("git", ["config", "user.name"]), run("git", ["config", "user.email"])]);
      const author = name.stdout ? `${name.stdout}${email.stdout ? ` <${email.stdout}>` : ""}` : undefined;
      const result = await scaffoldProject({ ...args, dir: abs(args.dir), author });
      return { ...result, author: author ?? "(git config user.name not set)", next: "Write the real code and tests, then run_checks." };
    }),
  );

  server.registerTool(
    "add_workflows",
    {
      title: "Add GitHub workflows",
      description:
        "Write .github/workflows/ci.yml (install, lint, build, test on push and PR) and optionally release.yml (on v* tags: test, build, publish with trusted publishing via OIDC — skipped if the version exists — then a GitHub release from the CHANGELOG). Existing files are kept unless overwrite is true.",
      inputSchema: {
        dir: dirArg,
        registry: registryArg.optional().describe("Omit for a repo-only project."),
        release: z.enum(["none", "registry", "github-only"]).default("registry").describe("registry: publish + GitHub release; github-only: just a GitHub release."),
        private: z.boolean().default(false).describe("Private repo: CI runs on Ubuntu only (Windows minutes count 2x, macOS 10x)."),
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
      title: "Install, lint, build and test",
      description: "Run the project's install, lint, typecheck, build and test steps (npm scripts, a Python .venv with pytest + build, or cargo clippy/build/test). Stops at the first failure and returns its output.",
      inputSchema: { dir: dirArg },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir }) => runChecks(abs(dir))),
  );

  server.registerTool(
    "scan_secrets",
    {
      title: "Scan for secrets",
      description: "Look for .env files, private keys and tokens in everything that would be committed. Reports file and line, never the secret itself.",
      inputSchema: { dir: dirArg },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ dir }) => {
      const findings = await scanProject(abs(dir));
      return { clean: findings.length === 0, findings };
    }),
  );

  server.registerTool(
    "inspect_package",
    {
      title: "Publish dry run",
      description: "Run the registry dry run (npm pack/publish --dry-run, twine check, cargo publish --dry-run), list the files that would be published, and flag junk or secrets.",
      inputSchema: { dir: dirArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ dir }) => inspectPackage(abs(dir))),
  );

  // ---------------------------------------------------------------- release
  server.registerTool(
    "git_commit",
    {
      title: "Commit",
      description: "git init (branch main) if needed, refuse when secrets or .env files would be committed, then stage everything and commit.",
      inputSchema: { dir: dirArg, message: z.string().describe("Commit message.") },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, message }) => gitCommit(abs(dir), message)),
  );

  server.registerTool(
    "create_github_repo",
    {
      title: "Create the GitHub repo and push",
      description: "gh repo create <name> --public|--private --source=. --push. Needs a commit and a GitHub login. If the repo already exists and is this folder's origin, just pushes.",
      inputSchema: {
        dir: dirArg,
        name: z.string().describe("Repo name (without owner)."),
        visibility: z.enum(["public", "private"]).default("public"),
        description: z.string().optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ dir, name, visibility, description }) => createGithubRepo(abs(dir), name, visibility, description)),
  );

  server.registerTool(
    "publish_package",
    {
      title: "Publish the package",
      description:
        "Publish from the terminal (npm publish [--access public], twine upload, cargo publish). Skips when the version already exists, and for 24 hours after the registry answered E429 (retries can extend a rate-limit block). Returns a job; npm approval runs in a real terminal. If an approval link expires, call again.",
      inputSchema: {
        dir: dirArg,
        dryRun: z.boolean().default(false),
        openBrowser: z.boolean().default(true).describe("Open approval pages in the default browser."),
        force: z.boolean().default(false).describe("Publish even within 24 hours of an E429. Only when the user confirms the block was lifted."),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ dir, dryRun, openBrowser, force }) => publishPackage(abs(dir), { dryRun, openBrowser, force })),
  );

  server.registerTool(
    "setup_trusted_publishing",
    {
      title: "Set up trusted publishing",
      description:
        "Connect the package to the GitHub release workflow (OIDC, no stored tokens). npm: runs `npm trust github` (the user approves with 2FA) and returns the settings page as fallback. PyPI/crates.io: opens the settings page and returns the exact values to fill in. The user clicks Save.",
      inputSchema: {
        dir: dirArg,
        repo: z.string().describe("owner/name of the GitHub repo."),
        workflowFile: z.string().default(RELEASE_WORKFLOW_FILE),
        openBrowser: z.boolean().default(true),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ dir, repo, workflowFile, openBrowser }) => setupTrustedPublishing(abs(dir), repo, workflowFile, openBrowser)),
  );

  server.registerTool(
    "tag_and_release",
    {
      title: "Tag, push and release",
      description:
        "Create tag v<version> from the manifest, push the branch and tag, and create the GitHub release with notes from CHANGELOG.md unless the repo's release.yml already does that on tags. Never moves or deletes tags.",
      inputSchema: {
        dir: dirArg,
        version: z.string().optional().describe("Must match the manifest; defaults to it."),
        createRelease: z
          .boolean()
          .optional()
          .describe("Default: create the release here only when .github/workflows/release.yml doesn't create one. Pass true or false to force."),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ dir, version, createRelease }) => tagAndRelease(abs(dir), { version, createRelease })),
  );

  server.registerTool(
    "watch_workflow",
    {
      title: "Watch a workflow run",
      description:
        "Wait for the workflow run (default release.yml) for the folder's current commit, optionally on a branch or tag, and report its result with the failing log on failure. Matching the commit avoids reporting an older run right after a push.",
      inputSchema: {
        dir: dirArg,
        workflow: z.string().default(RELEASE_WORKFLOW_FILE),
        ref: z.string().optional().describe("Only runs for this tag/branch, e.g. v0.1.1."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(50)
          .describe(`Capped at ${MAX_WAIT_SECONDS} s per call so the call returns before common 60 s client timeouts; while the run is in progress, call again.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ dir, workflow, ref, waitSeconds }) => watchWorkflow(abs(dir), workflow, Math.min(waitSeconds, MAX_WAIT_SECONDS), ref)),
  );

  server.registerTool(
    "bump_version",
    {
      title: "Bump the version",
      description:
        "Bump the manifest version (patch/minor/major) and record it in CHANGELOG.md: given notes become a new entry; without notes, a non-empty 'Unreleased' section becomes the new version. Does not commit.",
      inputSchema: {
        dir: dirArg,
        level: z.enum(["patch", "minor", "major"]).default("patch"),
        notes: z.string().default("").describe("Markdown for the CHANGELOG entry, e.g. '### Fixed\\n\\n- Release workflow.'"),
      },
      annotations: { destructiveHint: false },
    },
    handler(async ({ dir, level, notes }) => bumpVersion(abs(dir), level, notes)),
  );

  server.registerTool(
    "verify_install",
    {
      title: "Verify like a new user",
      description:
        "In a brand-new temp folder, install the published package from the real registry (or git clone the repo, private ones included) and run the README's commands one by one, stopping at the first that fails. Installed executables are on PATH.",
      inputSchema: {
        registry: registryArg.optional(),
        name: z.string().optional(),
        version: z.string().optional(),
        repoUrl: z.string().optional().describe("https://github.com/owner/repo — clone instead of installing."),
        command: z
          .union([z.string(), z.array(z.string()).min(1)])
          .describe("Commands to run in the folder (PowerShell on Windows, sh elsewhere). Prefer a list: each one must succeed before the next runs."),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async (args) => verifyInstall(args)),
  );

  // ---------------------------------------------------------------- desktop and shell
  server.registerTool(
    "notify",
    {
      title: "Desktop notification",
      description: "Show a desktop notification, e.g. 'Ready for your approval'.",
      inputSchema: { title: z.string().default("publish-pilot"), message: z.string() },
      annotations: { destructiveHint: false },
    },
    handler(async ({ title, message }) => ({ shown: await notify(title, message) })),
  );

  server.registerTool(
    "open_url",
    {
      title: "Open a page in the browser",
      description: "Open an https page on github.com, npmjs.com, pypi.org or crates.io in the default browser. Other hosts are refused.",
      inputSchema: { url: z.string() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    handler(async ({ url }) => openUrl(url)),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a shell command",
      description: "Run a command line (PowerShell on Windows, sh elsewhere) and return its output, redacted of tokens. Destructive commands (force-push, deleting tags/repos/releases, unpublish, recursive delete) are refused.",
      inputSchema: {
        command: z.string(),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).max(1800).default(300),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ command, cwd, timeoutSeconds }) => {
      const refused = checkCommand(command);
      if (refused) throw new UserError(refused);
      const result = await runShell(command, { cwd: cwd ? abs(cwd) : undefined, timeoutMs: timeoutSeconds * 1000 });
      return {
        exitCode: result.exitCode,
        ok: result.ok,
        timedOut: result.timedOut,
        stdout: result.stdout.slice(-20_000),
        stderr: result.stderr.slice(-10_000),
      };
    }),
  );

  // ---------------------------------------------------------------- prompt
  server.registerPrompt(
    "publish_project",
    {
      title: "Publish a project end to end",
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
