import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BumpLevel = "patch" | "minor" | "major";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Bump a semver string. Throws a helpful error for non-semver input. */
export function bumpSemver(version: string, level: BumpLevel = "patch"): string {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) throw new Error(`'${version}' is not a semantic version like 1.2.3. Fix the version in the manifest first.`);
  let [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (level === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (level === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

/** Extract the notes for one version from a Keep a Changelog style file. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const v = version.replace(/^v/, "");
  const heading = (line: string): boolean => /^##\s/.test(line);
  const start = lines.findIndex((line) => heading(line) && new RegExp(`(^|[\\s\\[v])${v.replace(/\./g, "\\.")}(\\]|\\s|$)`).test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(heading);
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || null;
}

/**
 * Turn a non-empty "## [Unreleased]" section into "## [version] - date".
 * Returns null when there is no Unreleased section or it has no notes.
 */
export function promoteUnreleased(changelog: string, version: string, date = new Date().toISOString().slice(0, 10)): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+\[?unreleased\]?\s*$/i.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  if (!(end === -1 ? rest : rest.slice(0, end)).join("\n").trim()) return null;
  lines[start] = `## [${version}] - ${date}`;
  return lines.join("\n");
}

/** Insert a new version section at the top of a changelog (below the title/intro). */
export function addChangelogEntry(changelog: string, version: string, notes: string, date = new Date().toISOString().slice(0, 10)): string {
  const entry = `## [${version}] - ${date}\n\n${notes.trim()}\n`;
  const lines = changelog.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^##\s/.test(line) && !/unreleased/i.test(line));
  if (firstSection === -1) return `${changelog.trimEnd()}\n\n${entry}`;
  return [...lines.slice(0, firstSection), entry, ...lines.slice(firstSection)].join("\n");
}

export type ManifestKind = "npm" | "pypi" | "crates";

/** Find the project's manifest. */
export function detectManifest(dir: string): { kind: ManifestKind; file: string } | null {
  if (existsSync(join(dir, "package.json"))) return { kind: "npm", file: join(dir, "package.json") };
  if (existsSync(join(dir, "pyproject.toml"))) return { kind: "pypi", file: join(dir, "pyproject.toml") };
  if (existsSync(join(dir, "Cargo.toml"))) return { kind: "crates", file: join(dir, "Cargo.toml") };
  return null;
}

/** Read name and version from the manifest in `dir`. */
export async function readManifest(dir: string): Promise<{ kind: ManifestKind; name: string; version: string } | null> {
  const manifest = detectManifest(dir);
  if (!manifest) return null;
  const text = await readFile(manifest.file, "utf8");
  if (manifest.kind === "npm") {
    const pkg = JSON.parse(text) as { name?: string; version?: string };
    return { kind: "npm", name: pkg.name ?? "", version: pkg.version ?? "0.0.0" };
  }
  const section = manifest.kind === "pypi" ? "project" : "package";
  const block = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(text)?.[1] ?? "";
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? "";
  const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? "0.0.0";
  return { kind: manifest.kind, name, version };
}

/** Write a new version into the manifest (and package-lock.json for npm). */
export async function writeManifestVersion(dir: string, version: string): Promise<string[]> {
  const manifest = detectManifest(dir);
  if (!manifest) throw new Error(`No package.json, pyproject.toml or Cargo.toml found in ${dir}.`);
  const changed: string[] = [];
  if (manifest.kind === "npm") {
    for (const file of ["package.json", "package-lock.json"]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const json = JSON.parse(await readFile(path, "utf8")) as { version?: string; packages?: Record<string, { version?: string }> };
      json.version = version;
      if (json.packages?.[""]) json.packages[""].version = version;
      await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
      changed.push(file);
    }
    return changed;
  }
  const text = await readFile(manifest.file, "utf8");
  const section = manifest.kind === "pypi" ? "project" : "package";
  const updated = text.replace(new RegExp(`(\\[${section}\\][\\s\\S]*?\\n\\s*version\\s*=\\s*")[^"]+(")`), `$1${version}$2`);
  await writeFile(manifest.file, updated);
  changed.push(manifest.kind === "pypi" ? "pyproject.toml" : "Cargo.toml");
  return changed;
}
