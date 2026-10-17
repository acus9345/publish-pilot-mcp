import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addChangelogEntry, bumpSemver, changelogSection, readManifest, writeManifestVersion } from "../src/changelog.js";
import { tempDir } from "./helpers.js";

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-01-02

### Added

- Feature B.

## [0.1.0] - 2026-01-01

- First release.
`;

describe("bumpSemver", () => {
  it("bumps each level", () => {
    expect(bumpSemver("0.1.0")).toBe("0.1.1");
    expect(bumpSemver("0.1.9", "minor")).toBe("0.2.0");
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
    expect(bumpSemver("1.2.3-beta.1")).toBe("1.2.4");
  });
  it("explains bad versions", () => {
    expect(() => bumpSemver("")).toThrow(/not a semantic version/);
    expect(() => bumpSemver("v1")).toThrow(/1\.2\.3/);
  });
});

describe("changelog", () => {
  it("extracts one version's notes", () => {
    expect(changelogSection(CHANGELOG, "0.2.0")).toBe("### Added\n\n- Feature B.");
    expect(changelogSection(CHANGELOG, "v0.1.0")).toBe("- First release.");
    expect(changelogSection(CHANGELOG, "0.3.0")).toBeNull();
    expect(changelogSection("", "0.1.0")).toBeNull();
  });

  it("does not confuse 0.1.0 with 10.1.0", () => {
    expect(changelogSection("## [10.1.0]\n\nwrong\n\n## [0.1.0]\n\nright\n", "0.1.0")).toBe("right");
  });

  it("adds a new entry above the latest release", () => {
    const updated = addChangelogEntry(CHANGELOG, "0.2.1", "- Fix.", "2026-02-03");
    expect(updated.indexOf("## [0.2.1] - 2026-02-03")).toBeLessThan(updated.indexOf("## [0.2.0]"));
    expect(updated.indexOf("## [Unreleased]")).toBeLessThan(updated.indexOf("## [0.2.1]"));
    expect(changelogSection(updated, "0.2.1")).toBe("- Fix.");
  });

  it("handles a large changelog", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `## [0.0.${i}]\n\n- change ${i}\n`).join("\n");
    expect(changelogSection(big, "0.0.4999")).toBe("- change 4999");
  });
});

describe("manifests", () => {
  it("reads and writes package.json and package-lock.json", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "x", version: "0.1.0", packages: { "": { version: "0.1.0" } } }));
    expect(await readManifest(dir)).toEqual({ kind: "npm", name: "x", version: "0.1.0" });
    await writeManifestVersion(dir, "0.1.1");
    expect((await readManifest(dir))?.version).toBe("0.1.1");
    const lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"));
    expect(lock.packages[""].version).toBe("0.1.1");
  });

  it("reads and writes pyproject.toml without touching other versions", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "pyproject.toml"), '[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "pkg"\nversion = "0.1.0"\n\n[tool.x]\nversion = "9.9.9"\n');
    await writeManifestVersion(dir, "0.2.0");
    const text = await readFile(join(dir, "pyproject.toml"), "utf8");
    expect(text).toContain('version = "0.2.0"');
    expect(text).toContain('version = "9.9.9"');
    expect(await readManifest(dir)).toEqual({ kind: "pypi", name: "pkg", version: "0.2.0" });
  });

  it("reads Cargo.toml", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "krate"\nversion = "1.0.0"\n\n[dependencies]\nserde = { version = "1" }\n');
    expect(await readManifest(dir)).toEqual({ kind: "crates", name: "krate", version: "1.0.0" });
  });

  it("returns null for an empty folder", async () => {
    expect(await readManifest(await tempDir())).toBeNull();
  });
});
