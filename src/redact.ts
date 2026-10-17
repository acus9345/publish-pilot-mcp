/**
 * Secret redaction. Every piece of command output that leaves this server
 * goes through {@link redact} so tokens never reach the model, logs, or chat.
 */

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained tokens
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm tokens
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g, // PyPI tokens
  /\bcio[A-Za-z0-9]{20,}\b/g, // crates.io tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Anthropic style keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /(_authToken\s*=\s*)\S+/g, // .npmrc auth lines
  /(Authorization:\s*(?:Bearer|token)\s+)\S+/gi,
  /(password\s*[=:]\s*)\S+/gi,
];

/** Replace anything that looks like a credential with `***`. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match: string, prefix?: unknown) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}***` : "***",
    );
  }
  return out;
}
