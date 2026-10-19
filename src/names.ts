import { cached } from "./cache.js";
import { run } from "./exec.js";
import { AUTH_TTL_MS, type Registry } from "./preflight.js";

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

/** Does the URL exist? HEAD only: a popular npm package's full record is several MB. */
export async function urlExists(url: string): Promise<boolean | null> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
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

/** The GitHub login of the authenticated gh user, if any. Remembered for a few minutes once known. */
export function githubLogin(): Promise<string | null> {
  return cached(
    "auth:github-login",
    AUTH_TTL_MS,
    async () => {
      const result = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 20_000 });
      return result.ok && result.stdout ? result.stdout.trim() : null;
    },
    (login) => login !== null,
  );
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

/**
 * Return the first free name among `first` and then `rest`, in order. `first` is checked alone
 * (it is usually free) while `rest` may still be loading; when it is taken, the rest are checked
 * at the same time.
 */
export async function firstFree(
  first: string,
  rest: string[] | Promise<string[]>,
  check: (name: string) => Promise<NameCheck>,
): Promise<{ chosen: string | null; checks: NameCheck[] }> {
  const firstCheck = await check(first);
  const free = (c: NameCheck): boolean => c.valid && c.available === true;
  if (free(firstCheck)) return { chosen: first, checks: [firstCheck] };
  const names = await rest;
  const others = await Promise.all(names.map(check));
  const index = others.findIndex(free);
  return index === -1 ? { chosen: null, checks: [firstCheck, ...others] } : { chosen: names[index]!, checks: [firstCheck, ...others.slice(0, index + 1)] };
}

/** Return the first free name among `name` and its alternatives. `user` (for scoped names) may still be loading. */
export function findFreeName(registry: Registry, name: string, user?: string | Promise<string | undefined>): Promise<{ chosen: string | null; checks: NameCheck[] }> {
  return firstFree(name, Promise.resolve(user).then((u) => nameAlternatives(registry, name, u)), (candidate) => checkPackageName(registry, candidate));
}

/**
 * Your GitHub login and whether each repo name is free under it, in one GraphQL request.
 * `null` when gh can't answer (not installed, logged out, offline).
 */
export async function checkOwnRepoNames(names: string[]): Promise<{ owner: string; checks: NameCheck[] } | null> {
  const valid = names.filter((n) => GITHUB_RE.test(n));
  const fields = valid.map((n, i) => `r${i}: repository(name: ${JSON.stringify(n)}) { id }`).join(" ");
  const result = await run("gh", ["api", "graphql", "-f", `query=query { viewer { login ${fields} } }`], { timeoutMs: 20_000 });
  let viewer: Record<string, unknown> | undefined;
  let errors: { type?: string; path?: string[] }[] = [];
  try {
    const body = JSON.parse(result.stdout) as { data?: { viewer?: Record<string, unknown> }; errors?: typeof errors };
    viewer = body.data?.viewer;
    errors = body.errors ?? [];
  } catch {
    return null;
  }
  const owner = typeof viewer?.login === "string" ? viewer.login : null;
  // Unknown names come back as NOT_FOUND errors; any other error means the answer can't be trusted.
  if (!viewer || !owner || errors.some((e) => e.type !== "NOT_FOUND")) return null;
  const checks = names.map((name): NameCheck => {
    const i = valid.indexOf(name);
    if (i === -1) return { name, valid: false, available: false, reason: "GitHub repo names may only contain letters, digits, '.', '-' and '_'." };
    return viewer[`r${i}`] ? { name, valid: true, available: false, reason: `github.com/${owner}/${name} already exists.` } : { name, valid: true, available: true };
  });
  return { owner, checks };
}
