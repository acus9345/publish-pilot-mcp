import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Registry } from "./preflight.js";
import { CI_WORKFLOW_FILE, RELEASE_WORKFLOW_FILE, ciWorkflow, releaseWorkflow, repoOnlyReleaseWorkflow } from "./workflows.js";

export interface ScaffoldOptions {
  /** Folder to create the project in. Existing files are never overwritten. */
  dir: string;
  name: string;
  description: string;
  registry: Registry;
  /** SPDX id, default MIT. */
  license?: string;
  /** "Name <email>" — usually from git config. */
  author?: string;
  /** https://github.com/owner/repo */
  repoUrl?: string;
  /** Add a command-line entry point with --help and --version. */
  cli?: boolean;
  /** Which GitHub workflows to add. Default: CI plus the release workflow that fits `target` when repoUrl is set. */
  workflows?: "none" | "ci" | "ci+release" | "ci+repo-release";
  /**
   * What will be published. "repo" means GitHub only: the README explains clone-and-build
   * instead of a registry install, and the manifest blocks accidental registry publishing.
   * Default "both" when repoUrl is set, otherwise "package".
   */
  target?: "repo" | "package" | "both";
  /** The GitHub repo will be private: CI runs on Ubuntu only, because private repos pay for Actions minutes. */
  private?: boolean;
}

export interface ScaffoldResult {
  written: string[];
  skipped: string[];
}

const MIT = `MIT License

Copyright (c) [year] [fullname]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** Full license text for an SPDX id. MIT is built in; others come from GitHub's license API. */
export async function licenseText(spdx: string, holder: string, year = new Date().getFullYear()): Promise<string> {
  const fill = (text: string): string =>
    text
      .replace(/\[year\]|\[yyyy\]|<year>/g, String(year))
      .replace(/\[fullname\]|\[name of copyright owner\]|<copyright holders>|\[owner\]/g, holder);
  if (spdx.toUpperCase() === "MIT") return fill(MIT);
  try {
    const response = await fetch(`https://api.github.com/licenses/${spdx.toLowerCase()}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "publish-pilot-mcp" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const body = ((await response.json()) as { body?: string }).body;
      if (body) return fill(body);
    }
  } catch {
    // fall through
  }
  throw new Error(`Could not get the text for license '${spdx}'. Use an SPDX id GitHub knows (MIT, Apache-2.0, ISC, BSD-3-Clause, GPL-3.0, MPL-2.0, Unlicense) or add LICENSE yourself.`);
}

/** Turn a package name into a valid identifier for Python modules / Rust crates. */
export function moduleName(name: string): string {
  const id = name.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(id) ? `pkg_${id}` : id || "package";
}

function authorParts(author?: string): { name: string; email?: string } {
  const match = /^\s*([^<]+?)\s*(?:<([^>]+)>)?\s*$/.exec(author ?? "");
  return { name: match?.[1] ?? "Author", email: match?.[2] };
}

const GITATTRIBUTES = "* text=auto eol=lf\n*.bat text eol=crlf\n*.cmd text eol=crlf\n*.ps1 text eol=crlf\n";

const GITIGNORE: Record<Registry, string> = {
  npm: "node_modules/\ndist/\ncoverage/\n*.tgz\n*.log\n.env\n.env.*\n!.env.example\n.DS_Store\n",
  pypi: "__pycache__/\n*.py[cod]\n.venv/\nvenv/\nbuild/\ndist/\n*.egg-info/\n.pytest_cache/\n.mypy_cache/\n.env\n.env.*\n!.env.example\n.DS_Store\n",
  crates: "target/\nCargo.lock.bak\n.env\n.env.*\n!.env.example\n.DS_Store\n",
};

function changelog(): string {
  return `# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - ${new Date().toISOString().slice(0, 10)}

### Added

- First release.
`;
}

/** The publish target, with defaults filled in. */
export function scaffoldTarget(o: Pick<ScaffoldOptions, "target" | "repoUrl">): "repo" | "package" | "both" {
  return o.target ?? (o.repoUrl ? "both" : "package");
}

function readme(o: ScaffoldOptions, mod: string): string {
  const repoOnly = scaffoldTarget(o) === "repo";
  const clone = o.repoUrl ? `git clone ${o.repoUrl}.git\ncd ${o.repoUrl.split("/").pop()}\n` : "";
  const build =
    o.registry === "npm" ? "npm install\nnpm run build\nnpm test" : o.registry === "pypi" ? "python -m pip install -e . pytest\npython -m pytest" : "cargo build\ncargo test";
  const install = repoOnly
    ? `This project is not published to a package registry. Clone it and build it:\n\n\`\`\`sh\n${clone}${o.registry === "npm" ? "npm install\nnpm run build" : o.registry === "pypi" ? "python -m pip install -e ." : "cargo build"}\n\`\`\`${o.registry === "crates" && o.repoUrl ? `\n\nTo use it from another Rust project:\n\n\`\`\`sh\ncargo add ${o.name} --git ${o.repoUrl}\n\`\`\`` : ""}`
    : `\`\`\`sh\n${o.registry === "npm" ? `npm install ${o.name}` : o.registry === "pypi" ? `pip install ${o.name}` : `cargo add ${o.name}`}\n\`\`\``;
  const npmImport = repoOnly ? "./dist/index.js" : o.name;
  const usage =
    o.registry === "npm"
      ? `${repoOnly ? "Inside the project folder, after building:\n\n" : ""}\`\`\`js\nimport { greet } from "${npmImport}";\n\nconsole.log(greet("world")); // Hello, world!\n\`\`\``
      : o.registry === "pypi"
        ? `\`\`\`python\nfrom ${mod} import greet\n\nprint(greet("world"))  # Hello, world!\n\`\`\``
        : `\`\`\`rust\nfn main() {\n    println!("{}", ${mod}::greet("world")); // Hello, world!\n}\n\`\`\``;
  return `# ${o.name}

${o.description}

## Install

${install}

## Quick start

${usage}

## ${repoOnly ? "Run the tests" : "Build from source"}

\`\`\`sh
${repoOnly ? "" : clone}${build}
\`\`\`

## Troubleshooting

- **Install fails**: make sure you use a supported runtime version (see the manifest's engines / requires-python / rust-version).

## License

${o.license ?? "MIT"}
`;
}

function npmFiles(o: ScaffoldOptions, author: { name: string; email?: string }): Record<string, string> {
  const scoped = o.name.startsWith("@");
  const bin = o.name.replace(/^@[^/]+\//, "");
  const repoOnly = scaffoldTarget(o) === "repo";
  const pkg: Record<string, unknown> = {
    name: o.name,
    version: "0.1.0",
    // npm refuses to publish a package marked private, so a repo-only project can't be published by accident.
    ...(repoOnly ? { private: true } : {}),
    description: o.description,
    license: o.license ?? "MIT",
    author: author.email ? `${author.name} <${author.email}>` : author.name,
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    ...(o.cli ? { bin: { [bin]: "dist/cli.js" } } : {}),
    files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
    scripts: { build: "tsc", test: 'npm run build && node --test "test/**/*.test.js"', prepack: "npm run build" },
    engines: { node: ">=22" },
    ...(o.repoUrl
      ? { repository: { type: "git", url: `git+${o.repoUrl}.git` }, homepage: `${o.repoUrl}#readme`, bugs: { url: `${o.repoUrl}/issues` } }
      : {}),
    ...(scoped && !repoOnly ? { publishConfig: { access: "public" } } : {}),
    devDependencies: { "@types/node": "^22.0.0", typescript: "^6.0.3" },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: ["node"],
          outDir: "dist",
          rootDir: "src",
          declaration: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
    "src/index.ts": `/**
 * Return a friendly greeting.
 * @param name Who to greet. Must be a non-empty string.
 * @example greet("world") // "Hello, world!"
 */
export function greet(name: string): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError('greet(name): name must be a non-empty string, for example greet("world").');
  }
  return \`Hello, \${name.trim()}!\`;
}
`,
    "test/index.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../dist/index.js";

test("greets by name", () => {
  assert.equal(greet("world"), "Hello, world!");
});

test("rejects empty input with a helpful message", () => {
  assert.throws(() => greet(""), /non-empty string/);
});
`,
  };
  if (o.cli) {
    files["src/cli.ts"] = `#!/usr/bin/env node
import { createRequire } from "node:module";
import { greet } from "./index.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(\`Usage: ${bin} [name]

Examples:
  ${bin} world     Prints "Hello, world!"

Options:
  -h, --help       Show this help
  -v, --version    Show the version\`);
} else if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
} else {
  try {
    console.log(greet(args[0] ?? "world"));
  } catch (error) {
    console.error(\`Error: \${(error as Error).message}\`);
    process.exitCode = 1;
  }
}
`;
  }
  return files;
}

function pypiFiles(o: ScaffoldOptions, author: { name: string; email?: string }, mod: string): Record<string, string> {
  const authors = author.email ? `{ name = "${author.name}", email = "${author.email}" }` : `{ name = "${author.name}" }`;
  const urls = o.repoUrl ? `\n[project.urls]\nHomepage = "${o.repoUrl}"\nIssues = "${o.repoUrl}/issues"\n` : "";
  const scripts = o.cli ? `\n[project.scripts]\n${o.name} = "${mod}.__main__:main"\n` : "";
  const files: Record<string, string> = {
    "pyproject.toml": `[build-system]
requires = ["hatchling>=1.27"]
build-backend = "hatchling.build"

[project]
name = "${o.name}"
version = "0.1.0"
description = "${o.description.replace(/"/g, '\\"')}"
readme = "README.md"
license = "${o.license ?? "MIT"}"
license-files = ["LICENSE"]
authors = [${authors}]
requires-python = ">=3.11"
dependencies = []
classifiers = ["Programming Language :: Python :: 3", "Typing :: Typed"${scaffoldTarget(o) === "repo" ? ', "Private :: Do Not Upload"' : ""}]
${urls}${scripts}
[tool.hatch.build.targets.wheel]
packages = ["src/${mod}"]
`,
    [`src/${mod}/__init__.py`]: `"""${o.description}"""

__all__ = ["greet", "__version__"]
__version__ = "0.1.0"


def greet(name: str) -> str:
    """Return a friendly greeting, for example greet("world") == "Hello, world!"."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError('greet(name): name must be a non-empty string, for example greet("world").')
    return f"Hello, {name.strip()}!"
`,
    [`src/${mod}/py.typed`]: "",
    [`tests/test_${mod}.py`]: `import pytest

from ${mod} import greet


def test_greet() -> None:
    assert greet("world") == "Hello, world!"


def test_greet_rejects_empty() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        greet("")
`,
  };
  if (o.cli) {
    files[`src/${mod}/__main__.py`] = `"""Command-line entry point: python -m ${mod} [name]"""

import argparse
import sys

from . import __version__, greet


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="${o.name}", description="${o.description.replace(/"/g, '\\"')}")
    parser.add_argument("name", nargs="?", default="world", help="who to greet (default: world)")
    parser.add_argument("-v", "--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    try:
        print(greet(args.name))
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
  }
  return files;
}

function cratesFiles(o: ScaffoldOptions, author: { name: string; email?: string }, mod: string): Record<string, string> {
  const authorLine = author.email ? `${author.name} <${author.email}>` : author.name;
  return {
    "Cargo.toml": `[package]
name = "${o.name}"
version = "0.1.0"
edition = "2024"
rust-version = "1.85"
description = "${o.description.replace(/"/g, '\\"')}"
license = "${o.license ?? "MIT"}"
authors = ["${authorLine}"]
readme = "README.md"
${o.repoUrl ? `repository = "${o.repoUrl}"\n` : ""}${scaffoldTarget(o) === "repo" ? "publish = false\n" : ""}
[lib]
name = "${mod}"
`,
    "src/lib.rs": `//! ${o.description}

/// Return a friendly greeting.
///
/// \`\`\`
/// assert_eq!(${mod}::greet("world"), "Hello, world!");
/// \`\`\`
pub fn greet(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return String::from("Hello!");
    }
    format!("Hello, {name}!")
}

#[cfg(test)]
mod tests {
    use super::greet;

    #[test]
    fn greets_by_name() {
        assert_eq!(greet("world"), "Hello, world!");
    }

    #[test]
    fn handles_empty_input() {
        assert_eq!(greet("  "), "Hello!");
    }
}
`,
  };
}

/** Create a standard project skeleton. Never overwrites existing files. */
export async function scaffoldProject(o: ScaffoldOptions): Promise<ScaffoldResult> {
  const author = authorParts(o.author);
  const mod = moduleName(o.name);
  const files: Record<string, string> = {
    "README.md": readme(o, mod),
    "CHANGELOG.md": changelog(),
    ".gitignore": GITIGNORE[o.registry],
    ".gitattributes": GITATTRIBUTES,
    ...(o.registry === "npm" ? npmFiles(o, author) : o.registry === "pypi" ? pypiFiles(o, author, mod) : cratesFiles(o, author, mod)),
  };
  const workflows = o.workflows ?? (o.repoUrl ? (scaffoldTarget(o) === "both" ? "ci+release" : scaffoldTarget(o) === "repo" ? "ci+repo-release" : "ci") : "none");
  if (workflows !== "none") files[`.github/workflows/${CI_WORKFLOW_FILE}`] = ciWorkflow(o.registry, { lean: o.private });
  if (workflows === "ci+release") files[`.github/workflows/${RELEASE_WORKFLOW_FILE}`] = releaseWorkflow(o.registry);
  if (workflows === "ci+repo-release") files[`.github/workflows/${RELEASE_WORKFLOW_FILE}`] = repoOnlyReleaseWorkflow();

  const result: ScaffoldResult = { written: [], skipped: [] };
  const licensePath = join(o.dir, "LICENSE");
  if (existsSync(licensePath)) result.skipped.push("LICENSE");
  else {
    await mkdir(o.dir, { recursive: true });
    await writeFile(licensePath, await licenseText(o.license ?? "MIT", author.name));
    result.written.push("LICENSE");
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(o.dir, rel);
    if (existsSync(path)) {
      result.skipped.push(rel);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    result.written.push(rel);
  }
  return result;
}
