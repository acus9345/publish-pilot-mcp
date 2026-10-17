import { run } from "./exec.js";
import type { Registry } from "./preflight.js";

export interface NameCheck {
  name: string;
  valid: boolean;
  /** `true` free, `false` taken, `null` unknown (network problem). */
  available: boolean | null;
  reason?: string;
}

const NPM_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CRATES_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GITHUB_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Validate a package name against the registry's naming rules. Returns an error message or null. */
export function validatePackageName(registry: Registry, name: string): string | null {
  if (!name.trim()) return "The name is empty. Pick a short lowercase name such as 'my-tool'.";
  switch (registry) {
    case "npm":
      if (name.length > 214) return "npm names must be 214 characters or fewer.";
      if (name !== name.toLowerCase()) return `npm names must be lowercase. Try '${name.toLowerCase()}'.`;
      if (!NPM_RE.test(name)) return "npm names may only contain lowercase letters, digits, '-', '.', '_' and an optional @scope/ prefix, and cannot start with '.' or '_'.";
      return null;
    case "pypi":
      return PYPI_RE.test(name) ? null : "PyPI names may contain letters, digits, '.', '_' and '-', and must start and end with a letter or digit.";
    case "crates":
      return CRATES_RE.test(name) ? null : "crates.io names must start with a letter, use only letters, digits, '-' and '_', and be at most 64 characters.";
  }
}

/** PEP 503 normalisation, used by PyPI to compare names. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function registryUrl(registry: Registry, name: string): string {
  switch (registry) {
    case "npm":
      return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
    case "pypi":
      return `https://pypi.org/pypi/${normalizePypiName(name)}/json`;
    case "crates":
      return `https://crates.io/api/v1/crates/${name}`;
  }
}

async function urlExists(url: string): Promise<boolean | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "publish-pilot-mcp (https://github.com/acus9345/publish-pilot-mcp)", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return false;
    if (response.ok) return true;
    return null;
  } catch {
    return null;
  }
}

/** Check whether a package name is valid and free on its registry. */
export async function checkPackageName(registry: Registry, name: string): Promise<NameCheck> {
  const invalid = validatePackageName(registry, name);
  if (invalid) return { name, valid: false, available: false, reason: invalid };
  const exists = await urlExists(registryUrl(registry, name));
  if (exists === null) return { name, valid: true, available: null, reason: "Could not reach the registry. Check your internet connection and try again." };
  return { name, valid: true, available: !exists, reason: exists ? "Already taken on the registry." : undefined };
}

/** The GitHub login of the authenticated gh user, if any. */
export async function githubLogin(): Promise<string | null> {
  const result = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 });
  return result.ok && result.stdout ? result.stdout.trim() : null;
}

/** Check whether `owner/name` is free on GitHub (requires gh to be logged in for private repos). */
export async function checkRepoName(owner: string, name: string): Promise<NameCheck> {
  if (!GITHUB_RE.test(name)) return { name, valid: false, available: false, reason: "GitHub repo names may only contain letters, digits, '.', '-' and '_'." };
  const result = await run("gh", ["api", `repos/${owner}/${name}`, "--jq", ".full_name"], { timeoutMs: 20_000 });
  if (result.ok) return { name, valid: true, available: false, reason: `github.com/${owner}/${name} already exists.` };
  if (/Not Found|HTTP 404/i.test(result.stderr + result.stdout)) return { name, valid: true, available: true };
  const exists = await urlExists(`https://github.com/${owner}/${name}`);
  return { name, valid: true, available: exists === null ? null : !exists };
}

/** Candidate alternatives, best first. */
export function nameAlternatives(registry: Registry, name: string, user?: string): string[] {
  const base = name.replace(/^@[^/]+\//, "");
  const out: string[] = [];
  if (registry === "npm" && user) out.push(`@${user.toLowerCase()}/${base}`);
  const suffixes = registry === "npm" ? ["kit", "tool", "lib", "cli", "js"] : registry === "pypi" ? ["kit", "tool", "lib", "py"] : ["kit", "tool", "lib", "rs"];
  for (const suffix of suffixes) out.push(`${base}-${suffix}`);
  if (user) out.push(`${user.toLowerCase()}-${base}`);
  return [...new Set(out)].filter((n) => n !== name);
}

/** Return the first free name among `name` and its alternatives. */
export async function findFreeName(registry: Registry, name: string, user?: string): Promise<{ chosen: string | null; checks: NameCheck[] }> {
  const checks: NameCheck[] = [];
  for (const candidate of [name, ...nameAlternatives(registry, name, user)]) {
    const check = await checkPackageName(registry, candidate);
    checks.push(check);
    if (check.valid && check.available) return { chosen: candidate, checks };
  }
  return { chosen: null, checks };
}
