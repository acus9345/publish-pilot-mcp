import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addChangelogEntry, bumpSemver, changelogSection, readManifest, writeManifestVersion, type BumpLevel, type ManifestKind } from "./changelog.js";
import { openUrl } from "./desktop.js";
import { describeJob, run, runShell, startJob, startTerminalJob, waitForJob, type Job, type RunResult } from "./exec.js";
import { checkRepoName, githubLogin } from "./names.js";
import { authFor, type Registry } from "./preflight.js";
import { scanFiles, scanProject, type SecretFinding } from "./secrets.js";
import { RELEASE_WORKFLOW_FILE } from "./workflows.js";

/** Thrown for problems the user (or model) can fix; the message says how. */
export class UserError extends Error {}

export interface StepResult {
  step: string;
  command: string;
  ok: boolean;
  skipped?: boolean;
  output: string;
}

interface PackResult {
  files: { path: string; size: number }[];
  size: number;
  unpackedSize: number;
}

/** Normalise `npm pack --json` output: an array in npm ≤ 11, an object keyed by package name in npm 12+. */
export function parsePackJson(text: string): PackResult | null {
  const value = extractJson(text);
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? ("files" in value ? [value] : Object.values(value)) : [];
  const first = items.find((item): item is PackResult => Boolean(item) && typeof item === "object" && Array.isArray((item as PackResult).files));
  return first ?? null;
}

/** Pull the first complete top-level JSON object or array out of mixed output (npm prints script logs around it). */
export function extractJson(text: string): unknown {
  const opener = /[[{]/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const start = match.index;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(text.slice(start, i + 1));
            if (value && typeof value === "object") return value;
          } catch {
            // not JSON; try the next opener
          }
          break;
        }
      }
    }
  }
  return null;
}

function tail(text: string, chars = 3000): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

function step(name: string, result: RunResult): StepResult {
  const output = result.output;
  return { step: name, command: result.command, ok: result.ok, output: tail(result.timedOut ? `${output}\n(timed out)` : output) };
}

async function requireManifest(dir: string): Promise<{ kind: ManifestKind; name: string; version: string }> {
  if (!existsSync(dir)) throw new UserError(`The folder ${dir} does not exist. Pass the project folder as 'dir'.`);
  const manifest = await readManifest(dir);
  if (!manifest) throw new UserError(`No package.json, pyproject.toml or Cargo.toml in ${dir}. Run scaffold_project first or pass the right folder.`);
  if (!manifest.name) throw new UserError(`The manifest in ${dir} has no name. Add a "name" field.`);
  return manifest;
}

/** Path to the Python inside the project's .venv, creating the venv when needed. */
async function venvPython(dir: string): Promise<{ python: string; created?: StepResult }> {
  const python = process.platform === "win32" ? join(dir, ".venv", "Scripts", "python.exe") : join(dir, ".venv", "bin", "python");
  if (existsSync(python)) return { python };
  const created = await run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", ".venv"], { cwd: dir, timeoutMs: 180_000 });
  return { python, created: step("create virtualenv", created) };
}

/**
 * The files in `dist/` built for this name and version. Older builds stay in dist/ after a
 * version bump, and uploading them again makes twine fail with "File already exists".
 */
export function currentDistFiles(files: string[], name: string, version: string): string[] {
  const v = version.toLowerCase();
  // Wheels always use the normalised name (my_pkg); sdists from older backends may keep my-pkg.
  const prefixes = [...new Set([name.replace(/[-_.]+/g, "_").toLowerCase(), name.toLowerCase()])].map((n) => `${n}-${v}`);
  return files.filter((file) => {
    const lower = file.toLowerCase();
    return prefixes.some((p) => (lower.startsWith(`${p}-`) && lower.endsWith(".whl")) || lower === `${p}.tar.gz`);
  });
}

async function pypiDist(dir: string, name: string, version: string): Promise<string[]> {
  const all = existsSync(join(dir, "dist")) ? await readdir(join(dir, "dist")) : [];
  return currentDistFiles(all, name, version).map((f) => `dist/${f}`);
}

/** Install, lint, build and test. Stops at the first failing step. */
export async function runChecks(dir: string): Promise<{ ok: boolean; steps: StepResult[] }> {
  const manifest = await requireManifest(dir);
  const steps: StepResult[] = [];
  const go = async (name: string, cmd: string, args: string[], timeoutMs = 600_000): Promise<boolean> => {
    const result = step(name, await run(cmd, args, { cwd: dir, timeoutMs }));
    steps.push(result);
    return result.ok;
  };
  if (manifest.kind === "npm") {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const installArgs = existsSync(join(dir, "package-lock.json")) ? ["ci"] : ["install"];
    if (!(await go("install", "npm", installArgs))) return { ok: false, steps };
    for (const script of ["lint", "typecheck", "build", "test"]) {
      if (!scripts[script]) {
        steps.push({ step: script, command: `npm run ${script}`, ok: true, skipped: true, output: `No "${script}" script in package.json.` });
        continue;
      }
      if (!(await go(script, "npm", ["run", script]))) return { ok: false, steps };
    }
    return { ok: true, steps };
  }
  if (manifest.kind === "pypi") {
    const { python, created } = await venvPython(dir);
    if (created) {
      steps.push(created);
      if (!created.ok) return { ok: false, steps };
    }
    if (!(await go("install", python, ["-m", "pip", "install", "--upgrade", "pip", "-e", ".", "pytest", "build", "twine"]))) return { ok: false, steps };
    if (!(await go("test", python, ["-m", "pytest"]))) return { ok: false, steps };
    if (!(await go("build", python, ["-m", "build"]))) return { ok: false, steps };
    return { ok: true, steps };
  }
  const clippy = await run("cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], { cwd: dir, timeoutMs: 600_000 });
  steps.push({ ...step("lint (clippy)", clippy), ...(clippy.ok ? {} : /no such command|not installed/i.test(clippy.stderr) ? { ok: true, skipped: true } : {}) });
  if (!steps[0]!.ok) return { ok: false, steps };
  if (!(await go("build", "cargo", ["build"]))) return { ok: false, steps };
  if (!(await go("test", "cargo", ["test"]))) return { ok: false, steps };
  return { ok: true, steps };
}

const JUNK = /(^|\/)(\.env(\..*)?|.*\.log|\.DS_Store|Thumbs\.db|node_modules\/.*|coverage\/.*|\.nyc_output\/.*|.*\.tgz|\.npmrc|\.pypirc|\.vscode\/.*|\.idea\/.*)$/i;

/** List what would be published, flag junk and secrets, and run the registry's dry run. */
export async function inspectPackage(dir: string): Promise<Record<string, unknown>> {
  const manifest = await requireManifest(dir);
  let files: string[] = [];
  /** Paths, relative to `dir`, of source files that end up in the package, for the secret scan. */
  let sourceFiles: string[] = [];
  const steps: StepResult[] = [];
  if (manifest.kind === "npm") {
    const pack = await run("npm", ["pack", "--dry-run", "--json"], { cwd: dir, timeoutMs: 300_000 });
    steps.push({ ...step("npm pack --dry-run", pack), output: pack.ok ? "(file list parsed below)" : tail(pack.stderr) });
    const parsed = pack.ok ? parsePackJson(pack.stdout) : null;
    if (pack.ok && !parsed) steps.push({ step: "parse file list", command: "", ok: false, output: tail(pack.stdout) });
    if (parsed) {
      files = parsed.files.map((f) => f.path);
      steps.push({ step: "size", command: "", ok: true, output: `${parsed.size} bytes packed, ${parsed.unpackedSize} bytes unpacked, ${files.length} files` });
    }
    steps.push(step("npm publish --dry-run", await run("npm", ["publish", "--dry-run", ...(manifest.name.startsWith("@") ? ["--access", "public"] : [])], { cwd: dir, timeoutMs: 300_000 })));
  } else if (manifest.kind === "pypi") {
    const { python, created } = await venvPython(dir);
    if (created) steps.push(created);
    steps.push(step("install build tools", await run(python, ["-m", "pip", "install", "--upgrade", "build", "twine"], { cwd: dir, timeoutMs: 300_000 })));
    steps.push(step("build", await run(python, ["-m", "build"], { cwd: dir, timeoutMs: 300_000 })));
    const dist = await pypiDist(dir, manifest.name, manifest.version);
    if (dist.length === 0) steps.push({ step: "find dist files", command: "", ok: false, output: `No wheel or sdist for ${manifest.name} ${manifest.version} in dist/.` });
    else steps.push(step("twine check", await run(python, ["-m", "twine", "check", ...dist], { cwd: dir, timeoutMs: 120_000 })));
    for (const archive of dist.filter((f) => f.endsWith(".whl"))) {
      const list = await run(python, ["-m", "zipfile", "-l", archive], { cwd: dir });
      files.push(...list.stdout.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean));
    }
    // The sdist holds the project's own files under "<name>-<version>/": map them back for the secret scan.
    for (const archive of dist.filter((f) => f.endsWith(".tar.gz"))) {
      const list = await run(python, ["-m", "tarfile", "-l", archive], { cwd: dir });
      const entries = list.stdout.split(/\r?\n/).map((l) => l.trim().replace(/\/$/, "")).filter(Boolean);
      const inProject = entries.map((e) => e.split("/").slice(1).join("/")).filter(Boolean);
      sourceFiles.push(...inProject);
    }
  } else {
    const list = await run("cargo", ["package", "--list", "--allow-dirty"], { cwd: dir, timeoutMs: 300_000 });
    steps.push({ ...step("cargo package --list", list), output: list.ok ? "(file list parsed below)" : tail(list.stderr) });
    files = list.stdout.split(/\r?\n/).filter(Boolean);
    steps.push(step("cargo publish --dry-run", await run("cargo", ["publish", "--dry-run", "--allow-dirty"], { cwd: dir, timeoutMs: 600_000 })));
  }
  if (manifest.kind !== "pypi") sourceFiles = files;
  const junk = [...new Set([...files, ...sourceFiles])].filter((f) => JUNK.test(f.replace(/\\/g, "/")));
  const secrets: SecretFinding[] = await scanFiles(dir, [...new Set(sourceFiles)].filter((f) => existsSync(join(dir, f))));
  const problems = [
    ...junk.map((f) => `Junk file would be published: ${f}. Exclude it ("files" in package.json, .npmignore, or the manifest's include/exclude).`),
    ...secrets.map((s) => `Possible secret (${s.kind}) in ${s.file}${s.line ? `:${s.line}` : ""}. Remove it before publishing.`),
    ...steps.filter((s) => !s.ok).map((s) => `Step failed: ${s.step}. See its output.`),
  ];
  return {
    package: manifest.name,
    version: manifest.version,
    ok: problems.length === 0,
    problems,
    files,
    ...(manifest.kind === "pypi" ? { sdistFiles: sourceFiles } : {}),
    steps,
  };
}

/** `git init` (branch main) when needed, refuse if secrets would be committed, then commit everything. */
export async function gitCommit(dir: string, message: string): Promise<Record<string, unknown>> {
  if (!message.trim()) throw new UserError("The commit message is empty. Pass a short message such as 'Initial commit'.");
  const steps: StepResult[] = [];
  if (!existsSync(join(dir, ".git"))) {
    const init = await run("git", ["init", "-b", "main"], { cwd: dir });
    steps.push(step("git init", init));
    if (!init.ok) return { ok: false, steps };
  }
  if (!existsSync(join(dir, ".gitignore"))) throw new UserError("There is no .gitignore. Add one (scaffold_project creates it) so node_modules, build output and .env files are not committed.");
  const findings = await scanProject(dir);
  if (findings.length > 0) {
    return {
      ok: false,
      refused: true,
      reason: "Possible secrets would be committed. Remove them or add the files to .gitignore, then try again.",
      findings,
    };
  }
  steps.push(step("git add", await run("git", ["add", "-A"], { cwd: dir })));
  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: dir });
  if (staged.ok) return { ok: true, nothingToCommit: true, steps };
  const commit = await run("git", ["commit", "-m", message], { cwd: dir });
  steps.push(step("git commit", commit));
  const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir });
  return { ok: commit.ok, commit: head.stdout, steps };
}

/**
 * What to do when the repo name is already taken on GitHub: push when this folder's origin is that
 * repo; connect and push when it is empty and the folder has no origin (a create_github_repo that was
 * interrupted after gh made the repo); otherwise refuse, so an unrelated repo is never touched.
 */
export function existingRepoAction(origin: string | null, url: string, isEmpty: boolean | null): "push" | "connect" | "refuse" {
  const same = (a: string): boolean => a.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase() === url.toLowerCase();
  if (origin) return same(origin) ? "push" : "refuse";
  return isEmpty === true ? "connect" : "refuse";
}

/** Create the GitHub repo from the local folder and push. Refuses to touch an existing repo it didn't create. */
export async function createGithubRepo(dir: string, name: string, visibility: "public" | "private", description?: string): Promise<Record<string, unknown>> {
  const auth = await authFor("github");
  if (!auth.loggedIn) throw new UserError(`${auth.detail} The repo can be created once you are logged in.`);
  const owner = await githubLogin();
  if (!owner) throw new UserError("Could not read your GitHub username from gh. Run `gh auth status` to check the login.");
  if (!existsSync(join(dir, ".git"))) throw new UserError("This folder is not a git repo yet. Run git_commit first.");
  const remote = await run("git", ["remote", "get-url", "origin"], { cwd: dir });
  const check = await checkRepoName(owner, name);
  const url = `https://github.com/${owner}/${name}`;
  if (check.available === false) {
    const view = remote.ok ? null : await run("gh", ["repo", "view", `${owner}/${name}`, "--json", "isEmpty", "--jq", ".isEmpty"], { cwd: dir, timeoutMs: 30_000 });
    const isEmpty = view?.ok ? view.stdout.trim() === "true" : null;
    const action = existingRepoAction(remote.ok ? remote.stdout : null, url, isEmpty);
    const steps: StepResult[] = [];
    if (action === "connect") {
      const add = await run("git", ["remote", "add", "origin", `${url}.git`], { cwd: dir });
      steps.push(step("git remote add origin", add));
      if (!add.ok) return { ok: false, url, steps };
    }
    if (action !== "refuse") {
      const push = await run("git", ["push", "-u", "origin", "HEAD"], { cwd: dir, timeoutMs: 300_000 });
      steps.push(step("git push", push));
      return { ok: push.ok, alreadyExisted: true, ...(action === "connect" ? { reusedEmptyRepo: true } : {}), url, steps };
    }
    throw new UserError(`${check.reason ?? "That repo name is not available."} Pick another name (for example ${name}-kit) and call create_github_repo again.`);
  }
  const args = ["repo", "create", name, `--${visibility}`, "--source", ".", "--remote", "origin", "--push"];
  if (description) args.push("--description", description);
  const create = await run("gh", args, { cwd: dir, timeoutMs: 300_000 });
  return { ok: create.ok, url, visibility, steps: [step("gh repo create", create)] };
}

/** Is `name@version` already on the registry? `null` when unknown. */
export async function versionExists(kind: ManifestKind, name: string, version: string): Promise<boolean | null> {
  const url =
    kind === "npm"
      ? `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`
      : kind === "pypi"
        ? `https://pypi.org/pypi/${name}/${version}/json`
        : `https://crates.io/api/v1/crates/${name}/${version}`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": "publish-pilot-mcp" }, signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

/**
 * Is this npm package on the registry? `"staging"` while npm is still processing its first
 * publish (only a `0.0.0-stage` placeholder is listed), `null` when unknown.
 */
export function npmPackageState(packument: unknown): boolean | "staging" {
  const versions = packument && typeof packument === "object" ? (packument as { versions?: Record<string, { stub?: boolean }> }).versions : undefined;
  const all = Object.entries(versions ?? {});
  if (all.length === 0) return false;
  return all.some(([version, info]) => !info?.stub && version !== "0.0.0-stage") ? true : "staging";
}

async function packageOnRegistry(name: string): Promise<boolean | "staging" | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return false;
    return response.ok ? npmPackageState(await response.json()) : null;
  } catch {
    return null;
  }
}

const APPROVAL_URL = /^https:\/\/(www\.)?npmjs\.com\/(login|auth)\//i;

/** npm's default debug-log folder (inside its cache). */
function defaultNpmLogsDir(): string {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache", "_logs")
    : join(homedir(), ".npm", "_logs");
}

/**
 * The error lines of the newest npm debug log written since `since`. A visible window's output
 * can't be captured, so this is how the job learns why npm failed. One-time auth ids are hidden.
 */
export async function npmLogErrors(since: number, logsDir = defaultNpmLogsDir()): Promise<string | undefined> {
  if (!existsSync(logsDir)) return undefined;
  const logs = [];
  for (const name of await readdir(logsDir)) {
    if (!name.endsWith("-debug-0.log")) continue;
    const info = await stat(join(logsDir, name));
    if (info.mtimeMs >= since) logs.push({ name, mtime: info.mtimeMs });
  }
  const newest = logs.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return undefined;
  const lines = (await readFile(join(logsDir, newest.name), "utf8"))
    .split(/\r?\n/)
    .filter((line) => /^\d+ error |http fetch (PUT|POST|DELETE) \d{3}/.test(line))
    .map((line) => line.replace(/^\d+ /, "").replace(/(auth\/cli\/|authId=)[\w-]+/g, "$1***"));
  return lines.length ? `[npm debug log]\n${lines.slice(-15).join("\n")}` : undefined;
}

/**
 * npm only shows its 2FA / login link and waits for approval when it runs in a real terminal,
 * so npm approval steps run through startTerminalJob (a visible window on Windows).
 */
function npmApprovalJob(args: string[], dir: string | undefined, label: string, openBrowser: boolean): Job {
  const startedAt = Date.now() - 1000;
  return startTerminalJob("npm", args, {
    cwd: dir,
    label,
    intro: "npm may ask you to approve in the browser. Press Enter here to open the page if it does not open by itself, then approve. This window waits for you.",
    onUrl: (url) => {
      if (openBrowser && APPROVAL_URL.test(url)) void openUrl(url);
    },
    // Visible windows (Windows, macOS) can't be captured; read npm's own log instead.
    finalize: process.platform === "linux" ? undefined : () => npmLogErrors(startedAt),
  });
}

const WINDOW_NOTE =
  process.platform === "linux"
    ? "If an npm page opened in the browser, approve it there."
    : `A ${process.platform === "win32" ? "PowerShell" : "Terminal"} window opened for this step. If npm shows 'Press ENTER to open in the browser', press Enter in that window, then approve on npmjs.com.`;

/** Wait briefly for an approval URL / device code, then describe the job. */
async function settle(job: Job, seconds = 25): Promise<Record<string, unknown>> {
  await waitForJob(job, seconds * 1000, (j) => j.urls.some((u) => /npmjs\.com\/(login|auth)|github\.com\/login\/device/.test(u)) || j.codes.length > 0);
  return describeJob(job);
}

/** Start a browser login for a service. Returns a job to poll with job_status. */
export async function startLogin(service: "github" | Registry, openBrowser = true): Promise<Record<string, unknown>> {
  const auth = await authFor(service);
  if (auth.loggedIn) return { alreadyLoggedIn: true, ...auth };
  if (service === "github") {
    const job = startJob("gh", ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"], { label: "GitHub login" });
    await waitForJob(job, 20_000, (j) => j.codes.length > 0);
    // gh waits for Enter before it opens the browser and starts polling.
    job.child.stdin?.write("\n");
    job.child.on("close", (code) => {
      if (code === 0) void run("gh", ["auth", "setup-git"]);
    });
    await waitForJob(job, 3_000);
    return {
      ...describeJob(job),
      forUser: `Open https://github.com/login/device, enter the code ${job.codes[0] ?? "(see outputTail)"}, then sign in and click Authorize. Poll job_status until running is false.`,
    };
  }
  if (service === "npm") {
    const job = npmApprovalJob(["login", "--auth-type=web", "--registry", "https://registry.npmjs.org/"], undefined, "npm login", openBrowser);
    return { ...(await settle(job)), forUser: `${WINDOW_NOTE} Sign in (and complete 2FA). Poll job_status until running is false.` };
  }
  if (service === "pypi") {
    const page = "https://pypi.org/manage/account/publishing/";
    if (openBrowser) await openUrl(page);
    return {
      started: false,
      page,
      forUser:
        "PyPI needs no local login with trusted publishing: add a pending publisher on this page (owner, repo, workflow release.yml) and the release workflow publishes. For manual uploads instead, create an API token at https://pypi.org/manage/account/token/ and save it in ~/.pypirc yourself.",
    };
  }
  const page = "https://crates.io/settings/tokens/new";
  if (openBrowser) await openUrl(page);
  return {
    started: false,
    page,
    forUser: "Create a token with the publish-new and publish-update scopes on this page, then run `cargo login` in your own terminal and paste it there. Never paste the token into chat.",
  };
}

/** How long to stay away from a registry after it rate-limits publishing. Every failed attempt can extend the block. */
export const RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_FILE = join(homedir(), ".publish-pilot", "rate-limits.json");
/** npm (E429), twine ("429 Too Many Requests") and cargo ("status 429 Too Many Requests") rate-limit errors. */
export const RATE_LIMITED = /E429|Too Many Requests|status 429|rate.?limit|published too many/i;

/** Where to ask a registry to lift a rate limit. */
const RATE_LIMIT_HELP: Record<ManifestKind, string> = {
  npm: "npm support (https://www.npmjs.com/support)",
  pypi: "PyPI support (https://pypi.org/help/)",
  crates: "crates.io support (help@crates.io)",
};

/** When the registry last rate-limited publishing of `key` (e.g. "npm:my-pkg"), if recorded. */
export async function lastRateLimit(key: string, file = RATE_LIMIT_FILE): Promise<Date | null> {
  try {
    const value = (JSON.parse(await readFile(file, "utf8")) as Record<string, string>)[key];
    return value ? new Date(value) : null;
  } catch {
    return null;
  }
}

/** Remember that publishing `key` was rate-limited at `when`. */
export async function recordRateLimit(key: string, when = new Date(), file = RATE_LIMIT_FILE): Promise<void> {
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  } catch {
    // first record
  }
  data[key] = when.toISOString();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Record a rate limit if `job` (a real publish) ends with one, so the next publish_package waits. */
export function recordRateLimitOnFailure(job: Job, key: string, file = RATE_LIMIT_FILE): Promise<void> {
  return waitForJob(job, RATE_LIMIT_COOLDOWN_MS).then(async () => {
    if (!job.running && job.exitCode !== 0 && RATE_LIMITED.test(job.output)) await recordRateLimit(key, new Date(), file);
  });
}

const NEVER_RETRY_429 = "Never retry after a 429 / rate-limit error: each failed attempt can extend the block, and publish_package will wait 24 hours.";

/** Publish the package in `dir`. Skips when the version is already on the registry or a recent rate limit says to wait. */
export async function publishPackage(dir: string, opts: { dryRun?: boolean; openBrowser?: boolean; force?: boolean; rateLimitFile?: string } = {}): Promise<Record<string, unknown>> {
  const manifest = await requireManifest(dir);
  const exists = await versionExists(manifest.kind, manifest.name, manifest.version);
  if (exists && !opts.dryRun) {
    return { skipped: true, reason: `${manifest.name}@${manifest.version} is already published. Bump the version (bump_version) to publish again.` };
  }
  const limitKey = `${manifest.kind}:${manifest.name}`;
  const limitedAt = await lastRateLimit(limitKey, opts.rateLimitFile);
  if (limitedAt && !opts.dryRun && !opts.force && Date.now() - limitedAt.getTime() < RATE_LIMIT_COOLDOWN_MS) {
    const retryAfter = new Date(limitedAt.getTime() + RATE_LIMIT_COOLDOWN_MS);
    return {
      skipped: true,
      rateLimited: true,
      lastRateLimit: limitedAt.toISOString(),
      retryAfter: retryAfter.toISOString(),
      reason: `The registry rate-limited publishing ${manifest.name} at ${limitedAt.toISOString()}. Every failed attempt can extend the block, so publish-pilot waits 24 hours before trying again (after ${retryAfter.toISOString()}). Pass force: true only if the block is known to be lifted (for example, ${RATE_LIMIT_HELP[manifest.kind]} confirmed it).`,
    };
  }
  const auth = await authFor(manifest.kind);
  if (!auth.loggedIn && !opts.dryRun) throw new UserError(`${auth.detail} Then call publish_package again.`);
  const openBrowser = opts.openBrowser ?? true;
  const watch = (job: Job): void => {
    if (!opts.dryRun) void recordRateLimitOnFailure(job, limitKey, opts.rateLimitFile);
  };
  if (manifest.kind === "npm") {
    const args = ["publish", ...(manifest.name.startsWith("@") ? ["--access", "public"] : []), ...(opts.dryRun ? ["--dry-run"] : [])];
    const label = `npm publish ${manifest.name}@${manifest.version}`;
    const job = opts.dryRun ? startJob("npm", args, { cwd: dir, label }) : npmApprovalJob(args, dir, label, openBrowser);
    watch(job);
    const info = await settle(job, 40);
    return {
      ...info,
      package: manifest.name,
      version: manifest.version,
      forUser: job.running
        ? `${WINDOW_NOTE} Poll job_status; if it ends with an expired/401 error, call publish_package again for a fresh link. ${NEVER_RETRY_429}`
        : undefined,
      next: opts.dryRun
        ? undefined
        : "npm stages new publishes: after the job succeeds, the version can take a minute or two to appear (a brand-new package first shows a 0.0.0-stage placeholder). Wait for it before setup_trusted_publishing or verify_install.",
    };
  }
  if (manifest.kind === "pypi") {
    const { python } = await venvPython(dir);
    const dist = await pypiDist(dir, manifest.name, manifest.version);
    if (dist.length === 0) throw new UserError(`dist/ has no wheel or sdist for ${manifest.name} ${manifest.version}. Run run_checks (it builds) or inspect_package first.`);
    // twine has no dry run: `twine check` validates exactly the files that would be uploaded.
    const args = opts.dryRun ? ["-m", "twine", "check", ...dist] : ["-m", "twine", "upload", "--non-interactive", ...dist];
    const job = startJob(python, args, { cwd: dir, label: opts.dryRun ? "twine check" : `twine upload ${manifest.name} ${manifest.version}` });
    watch(job);
    return { ...(await settle(job, 60)), package: manifest.name, version: manifest.version, files: dist, forUser: opts.dryRun ? undefined : NEVER_RETRY_429 };
  }
  const job = startJob("cargo", ["publish", ...(opts.dryRun ? ["--dry-run"] : [])], { cwd: dir, label: `cargo publish ${manifest.name} ${manifest.version}` });
  watch(job);
  return { ...(await settle(job, 60)), package: manifest.name, version: manifest.version, forUser: opts.dryRun ? undefined : NEVER_RETRY_429 };
}

/** Connect the package to the GitHub release workflow with trusted publishing (OIDC). */
export async function setupTrustedPublishing(dir: string, repo: string, workflowFile = RELEASE_WORKFLOW_FILE, openBrowser = true): Promise<Record<string, unknown>> {
  const manifest = await requireManifest(dir);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UserError(`'${repo}' is not in owner/name form, for example octocat/my-tool.`);
  const [owner, repoName] = repo.split("/") as [string, string];
  const values = { owner, repository: repoName, workflow: workflowFile, environment: "(leave empty)" };
  if (manifest.kind === "npm") {
    const packageExists = await packageOnRegistry(manifest.name);
    const page = `https://www.npmjs.com/package/${manifest.name}/access`;
    if (packageExists === false) {
      // Checked against the live registry: POST /-/package/<name>/trust answers 404 "Package not found".
      return {
        ok: false,
        reason: "npm can only add a trusted publisher to a package that already exists. Publish the first version with publish_package, then call this again.",
        page,
        values,
      };
    }
    if (packageExists === "staging") {
      return {
        ok: false,
        staging: true,
        reason: "npm is still processing the first publish (only a 0.0.0-stage placeholder is listed). Wait a minute or two, then call this again.",
        page,
        values,
      };
    }
    const job = npmApprovalJob(["trust", "github", manifest.name, "--repository", repo, "--file", workflowFile, "--allow-publish", "--yes"], dir, "npm trust github", openBrowser);
    const info = await settle(job, 40);
    return {
      ...info,
      page,
      values,
      forUser: `${WINDOW_NOTE} If the npm CLI cannot do it, open the page above, choose GitHub Actions under Trusted Publisher, fill in the values and click Save.`,
      next: "Push a v* tag with tag_and_release within 48 hours: npm expires trusted-publisher setups that have not published by then.",
    };
  }
  if (manifest.kind === "pypi") {
    const exists = await versionExists("pypi", manifest.name, manifest.version);
    const page = exists === false ? "https://pypi.org/manage/account/publishing/" : `https://pypi.org/manage/project/${manifest.name}/settings/publishing/`;
    if (openBrowser) await openUrl(page);
    return { ok: true, page, values: { "PyPI project name": manifest.name, ...values }, forUser: "Fill in these values in the GitHub tab of the form on the page that opened, then click Add." };
  }
  const page = `https://crates.io/crates/${manifest.name}/settings`;
  if (openBrowser) await openUrl(page);
  return { ok: true, page, values, forUser: "Under Trusted Publishing add a GitHub configuration with these values, then save. The crate must already exist (publish 0.1.0 once with publish_package)." };
}

/** Tag `v<version>` (from the manifest unless given), push branch and tag, optionally create the GitHub release. */
export async function tagAndRelease(dir: string, opts: { version?: string; createRelease?: boolean } = {}): Promise<Record<string, unknown>> {
  const manifest = await requireManifest(dir);
  const version = (opts.version ?? manifest.version).replace(/^v/, "");
  if (version !== manifest.version) throw new UserError(`The manifest says ${manifest.version} but you asked for ${version}. Run bump_version first so they match.`);
  const tag = `v${version}`;
  const steps: StepResult[] = [];
  const status = await run("git", ["status", "--porcelain"], { cwd: dir });
  if (status.stdout) throw new UserError("There are uncommitted changes. Commit them with git_commit before tagging.");
  const existing = await run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: dir });
  if (!existing.ok) steps.push(step("git tag", await run("git", ["tag", "-a", tag, "-m", tag], { cwd: dir })));
  steps.push(step("push branch", await run("git", ["push", "origin", "HEAD"], { cwd: dir, timeoutMs: 300_000 })));
  steps.push(step("push tag", await run("git", ["push", "origin", tag], { cwd: dir, timeoutMs: 300_000 })));
  if (opts.createRelease) {
    const view = await run("gh", ["release", "view", tag], { cwd: dir });
    if (view.ok) steps.push({ step: "gh release create", command: "", ok: true, skipped: true, output: `Release ${tag} already exists.` });
    else {
      const changelog = existsSync(join(dir, "CHANGELOG.md")) ? await readFile(join(dir, "CHANGELOG.md"), "utf8") : "";
      const notes = changelogSection(changelog, version) ?? `Release ${tag}`;
      const notesFile = join(await mkdtemp(join(tmpdir(), "publish-pilot-")), "notes.md");
      await writeFile(notesFile, notes);
      steps.push(step("gh release create", await run("gh", ["release", "create", tag, "--title", tag, "--notes-file", notesFile, "--verify-tag"], { cwd: dir, timeoutMs: 120_000 })));
    }
  }
  const remote = await run("git", ["remote", "get-url", "origin"], { cwd: dir });
  return { ok: steps.every((s) => s.ok), tag, repo: remote.stdout.replace(/\.git$/, ""), steps };
}

interface RunInfo {
  databaseId: number;
  status: string;
  conclusion: string;
  url: string;
  displayTitle: string;
  headBranch: string;
  headSha: string;
  event: string;
}

/** Pick the run to report: for `ref` (branch or tag) if given, and for commit `sha` if given. */
export function pickRun(runs: RunInfo[], ref?: string, sha?: string): RunInfo | undefined {
  return runs.find((r) => (!ref || r.headBranch === ref) && (!sha || r.headSha === sha));
}

/**
 * Wait for the run of a workflow for the folder's current commit (HEAD) and report the result,
 * with failing logs on failure. Matching the commit avoids reporting the previous run while
 * GitHub has not listed a just-pushed one yet.
 */
export async function watchWorkflow(dir: string, workflow = RELEASE_WORKFLOW_FILE, waitSeconds = 50, ref?: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitSeconds * 1000;
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: dir });
  const sha = head.ok ? head.stdout.trim() : undefined;
  let latest: RunInfo | undefined;
  for (;;) {
    const args = ["run", "list", "--workflow", workflow, "--limit", "20", "--json", "databaseId,status,conclusion,url,displayTitle,headBranch,headSha,event"];
    const list = await run("gh", args, { cwd: dir, timeoutMs: 30_000 });
    if (!list.ok) throw new UserError(`Could not list workflow runs: ${list.stderr || list.stdout}. Check that the repo exists on GitHub and gh is logged in.`);
    latest = pickRun(JSON.parse(list.stdout || "[]") as RunInfo[], ref, sha);
    if (latest?.status === "completed" || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(0, deadline - Date.now()))));
  }
  if (!latest) {
    return { found: false, commit: sha, hint: `No run of ${workflow} for commit ${sha?.slice(0, 7) ?? "HEAD"}${ref ? ` on ${ref}` : ""} yet. Runs can take a few seconds to appear after a push; call again. If it never appears, check the workflow's 'on:' triggers.` };
  }
  const result: Record<string, unknown> = { found: true, ...latest };
  if (latest.status !== "completed") result.hint = "Still running. Call watch_workflow again.";
  else if (latest.conclusion !== "success") {
    const logs = await run("gh", ["run", "view", String(latest.databaseId), "--log-failed"], { cwd: dir, timeoutMs: 60_000 });
    result.failedLog = tail(logs.stdout || logs.stderr, 6000);
    result.hint = "Fix the cause, then bump_version (patch), commit, and tag_and_release the new version. Never delete or move the old tag.";
  }
  return result;
}

/** Bump the manifest version and add a CHANGELOG entry. Does not commit. */
export async function bumpVersion(dir: string, level: BumpLevel, notes: string): Promise<Record<string, unknown>> {
  const manifest = await requireManifest(dir);
  const next = bumpSemver(manifest.version, level);
  const changed = await writeManifestVersion(dir, next);
  const changelogPath = join(dir, "CHANGELOG.md");
  const current = existsSync(changelogPath) ? await readFile(changelogPath, "utf8") : "# Changelog\n";
  await writeFile(changelogPath, addChangelogEntry(current, next, notes || "### Fixed\n\n- Maintenance release."));
  changed.push("CHANGELOG.md");
  if (manifest.kind === "crates") await run("cargo", ["update", "--workspace"], { cwd: dir, timeoutMs: 120_000 });
  return { from: manifest.version, to: next, changed, next: "Commit with git_commit, then tag_and_release." };
}

/** Install from the real registry (or clone from GitHub) into a fresh temp folder and run a command there. */
export async function verifyInstall(opts: {
  registry?: Registry;
  name?: string;
  version?: string;
  repoUrl?: string;
  command: string;
}): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "publish-pilot-verify-"));
  const steps: StepResult[] = [];
  const add = async (name: string, promise: Promise<RunResult>): Promise<boolean> => {
    const result = step(name, await promise);
    steps.push(result);
    return result.ok;
  };
  if (opts.repoUrl) {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(opts.repoUrl.replace(/\.git$/, ""))) throw new UserError("repoUrl must look like https://github.com/owner/repo.");
    if (!(await add("git clone", run("git", ["clone", opts.repoUrl, "project"], { cwd: dir, timeoutMs: 300_000 })))) return { ok: false, dir, steps };
    const ok = await add("command", runShell(opts.command, { cwd: join(dir, "project"), timeoutMs: 600_000 }));
    return { ok, dir: join(dir, "project"), steps };
  }
  if (!opts.registry || !opts.name) throw new UserError("Pass either repoUrl, or registry and name.");
  const spec = opts.version ? `${opts.name}@${opts.version}` : opts.name;
  if (opts.registry === "npm") {
    if (!(await add("npm init", run("npm", ["init", "-y"], { cwd: dir })))) return { ok: false, dir, steps };
    if (!(await add("npm install", run("npm", ["install", spec, "--registry", "https://registry.npmjs.org/"], { cwd: dir, timeoutMs: 300_000 })))) return { ok: false, dir, steps };
  } else if (opts.registry === "pypi") {
    const { python, created } = await venvPython(dir);
    if (created) steps.push(created);
    const pin = opts.version ? `${opts.name}==${opts.version}` : opts.name;
    if (!(await add("pip install", run(python, ["-m", "pip", "install", "--no-cache-dir", pin], { cwd: dir, timeoutMs: 300_000 })))) return { ok: false, dir, steps };
  } else {
    if (!(await add("cargo new", run("cargo", ["new", "verify-app"], { cwd: dir, timeoutMs: 120_000 })))) return { ok: false, dir, steps };
    if (!(await add("cargo add", run("cargo", ["add", opts.version ? `${opts.name}@${opts.version}` : opts.name], { cwd: join(dir, "verify-app"), timeoutMs: 300_000 })))) return { ok: false, dir, steps };
  }
  // Put the installed package's executables first on PATH so README commands work as written.
  const binDir =
    opts.registry === "npm"
      ? join(dir, "node_modules", ".bin")
      : opts.registry === "pypi"
        ? join(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin")
        : undefined;
  const ok = await add(
    "command",
    runShell(opts.command, { cwd: opts.registry === "crates" ? join(dir, "verify-app") : dir, timeoutMs: 600_000, env: binDir ? prependPath(binDir) : undefined }),
  );
  return { ok, dir, steps };
}

/** Environment with `dir` prepended to PATH, respecting Windows' case-insensitive "Path" key. */
export function prependPath(dir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const separator = process.platform === "win32" ? ";" : ":";
  return { [key]: env[key] ? `${dir}${separator}${env[key]}` : dir };
}
