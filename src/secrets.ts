import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { run } from "./exec.js";

export interface SecretFinding {
  file: string;
  line?: number;
  kind: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "coverage", ".turbo"]);
const SECRET_FILES: { test: (name: string) => boolean; kind: string }[] = [
  { test: (n) => /^\.env(\..+)?$/i.test(n) && !/\.(example|sample|template)$/i.test(n), kind: ".env file" },
  { test: (n) => /\.(pem|key|p12|pfx|keystore|jks)$/i.test(n), kind: "private key or certificate file" },
  { test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(n), kind: "SSH private key" },
  { test: (n) => n === ".pypirc", kind: "PyPI credentials file" },
  { test: (n) => n === "credentials.toml" || n === "credentials.json", kind: "credentials file" },
];
const CONTENT_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, kind: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, kind: "GitHub fine-grained token" },
  { re: /\bnpm_[A-Za-z0-9]{36,}\b/, kind: "npm token" },
  { re: /\bpypi-AgE[A-Za-z0-9_-]{50,}\b/, kind: "PyPI token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, kind: "AWS access key" },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/, kind: "API secret key" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, kind: "private key" },
  { re: /_authToken\s*=\s*(?!\$\{)[^\s]{8,}/, kind: "npm auth token in .npmrc" },
];
const MAX_FILE_BYTES = 1_000_000;

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

/** Files that would be committed: git's view when this is a repo, otherwise a filtered walk. */
export async function candidateFiles(root: string): Promise<string[]> {
  const git = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, timeoutMs: 30_000 });
  if (git.ok) return git.stdout.split(/\r?\n/).filter(Boolean);
  const out: string[] = [];
  await walk(root, root, out);
  return out;
}

/** Scan a list of files (relative to root) for secrets. Never returns the secret values. */
export async function scanFiles(root: string, files: readonly string[]): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const name = basename(file);
    const fileRule = SECRET_FILES.find((rule) => rule.test(name));
    if (fileRule) findings.push({ file: file.split(sep).join("/"), kind: fileRule.kind });
    const full = join(root, file);
    try {
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = await readFile(full, "utf8");
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split(/\r?\n/);
      lines.forEach((lineText, index) => {
        for (const { re, kind } of CONTENT_PATTERNS) {
          if (re.test(lineText)) findings.push({ file: file.split(sep).join("/"), line: index + 1, kind });
        }
      });
    } catch {
      // unreadable file: skip
    }
  }
  return findings;
}

/** Scan everything that would be committed under `root`. */
export async function scanProject(root: string): Promise<SecretFinding[]> {
  return scanFiles(root, await candidateFiles(root));
}
