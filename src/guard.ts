/**
 * Safety rules shared by every tool: no destructive commands and
 * only real registry / GitHub hosts may be opened in the browser.
 */

const DESTRUCTIVE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--delete\b|\s:\S)/i, reason: "force-push or remote delete" },
  { pattern: /\bgit\s+tag\s+(-d|--delete)\b/i, reason: "deleting a tag" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "discarding local work" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "deleting untracked files" },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: "force-deleting a branch" },
  { pattern: /\bnpm\s+(unpublish|deprecate)\b/i, reason: "unpublishing or deprecating a package" },
  { pattern: /\bcargo\s+yank\b/i, reason: "yanking a crate" },
  { pattern: /\bgh\s+repo\s+(delete|archive)\b/i, reason: "deleting or archiving a repository" },
  { pattern: /\bgh\s+release\s+delete\b/i, reason: "deleting a release" },
  { pattern: /\bgh\s+auth\s+(logout|token)\b/i, reason: "logging out or printing a token" },
  { pattern: /\bnpm\s+(logout|token)\b/i, reason: "logging out or managing tokens" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\.\s*$)/i, reason: "recursive delete of a broad path" },
  { pattern: /\bRemove-Item\b[^\n]*-Recurse/i, reason: "recursive delete" },
  { pattern: /\b(rd|rmdir)\s+\/s\b/i, reason: "recursive delete" },
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: "formatting a drive" },
];

/** Returns why a command is refused, or `null` when it is allowed. */
export function checkCommand(command: string): string | null {
  for (const { pattern, reason } of DESTRUCTIVE) {
    if (pattern.test(command)) {
      return `Refused: this command looks destructive (${reason}). publish-pilot never deletes, force-pushes or unpublishes. Use a non-destructive fix instead, such as releasing a new version.`;
    }
  }
  return null;
}

export const ALLOWED_HOSTS = ["github.com", "npmjs.com", "pypi.org", "crates.io"] as const;

/** True when `url` is https and on github.com, npmjs.com, pypi.org or crates.io (or a subdomain). */
export function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
