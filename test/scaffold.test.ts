import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { licenseText, moduleName, scaffoldProject } from "../src/scaffold.js";
import { tempDir } from "./helpers.js";

const base = { description: "Does a thing.", license: "MIT", author: "Ada Lovelace <ada@example.com>" };

describe("scaffoldProject", () => {
  it("creates a complete npm project with workflows", async () => {
    const dir = await tempDir();
    const result = await scaffoldProject({ ...base, dir, name: "@ada/thing", registry: "npm", repoUrl: "https://github.com/ada/thing", cli: true });
    for (const file of ["package.json", "tsconfig.json", "src/index.ts", "src/cli.ts", "test/index.test.js", "README.md", "LICENSE", "CHANGELOG.md", ".gitignore", ".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      expect(result.written).toContain(file);
    }
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({
      name: "@ada/thing",
      version: "0.1.0",
      license: "MIT",
      author: "Ada Lovelace <ada@example.com>",
      publishConfig: { access: "public" },
      bin: { thing: "dist/cli.js" },
      repository: { url: "git+https://github.com/ada/thing.git" },
    });
    const license = await readFile(join(dir, "LICENSE"), "utf8");
    expect(license).toContain(`Copyright (c) ${new Date().getFullYear()} Ada Lovelace`);
  });

  it("never overwrites existing files", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "README.md"), "mine");
    const result = await scaffoldProject({ ...base, dir, name: "thing", registry: "npm" });
    expect(result.skipped).toContain("README.md");
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("mine");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  it("creates a Python project", async () => {
    const dir = await tempDir();
    await scaffoldProject({ ...base, dir, name: "my-thing", registry: "pypi", cli: true });
    const pyproject = await readFile(join(dir, "pyproject.toml"), "utf8");
    expect(pyproject).toContain('name = "my-thing"');
    expect(pyproject).toContain('my-thing = "my_thing.__main__:main"');
    expect(existsSync(join(dir, "src/my_thing/__init__.py"))).toBe(true);
    expect(existsSync(join(dir, "src/my_thing/py.typed"))).toBe(true);
  });

  it("creates a Rust project", async () => {
    const dir = await tempDir();
    await scaffoldProject({ ...base, dir, name: "my-thing", registry: "crates", repoUrl: "https://github.com/ada/my-thing" });
    const cargo = await readFile(join(dir, "Cargo.toml"), "utf8");
    expect(cargo).toContain('name = "my-thing"');
    expect(cargo).toContain('repository = "https://github.com/ada/my-thing"');
    expect(await readFile(join(dir, "src/lib.rs"), "utf8")).toContain("my_thing::greet");
  });

  it("repo-only npm projects document clone-and-build and can't be published by accident", async () => {
    const dir = await tempDir();
    const result = await scaffoldProject({ ...base, dir, name: "@ada/thing", registry: "npm", repoUrl: "https://github.com/ada/thing", target: "repo", private: true });
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.publishConfig).toBeUndefined();
    const readme = await readFile(join(dir, "README.md"), "utf8");
    expect(readme).not.toContain("npm install @ada/thing");
    expect(readme).toContain("git clone https://github.com/ada/thing.git");
    expect(readme).toContain('from "./dist/index.js"');
    expect(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8")).toContain("os: [ubuntu-latest]");
    const release = await readFile(join(dir, ".github/workflows/release.yml"), "utf8");
    expect(release).toContain("gh release create");
    expect(release).not.toContain("npm publish");
    expect(result.written).toContain(".github/workflows/release.yml");
  });

  it("repo-only Python and Rust projects block registry uploads", async () => {
    const py = await tempDir();
    await scaffoldProject({ ...base, dir: py, name: "thing", registry: "pypi", target: "repo" });
    expect(await readFile(join(py, "pyproject.toml"), "utf8")).toContain('"Private :: Do Not Upload"');
    const rs = await tempDir();
    await scaffoldProject({ ...base, dir: rs, name: "thing", registry: "crates", target: "repo", repoUrl: "https://github.com/ada/thing" });
    expect(await readFile(join(rs, "Cargo.toml"), "utf8")).toContain("publish = false");
    expect(await readFile(join(rs, "README.md"), "utf8")).toContain("cargo add thing --git https://github.com/ada/thing");
  });

  it("public package projects keep the full CI matrix and registry install", async () => {
    const dir = await tempDir();
    await scaffoldProject({ ...base, dir, name: "thing", registry: "npm", repoUrl: "https://github.com/ada/thing" });
    expect(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8")).toContain("macos-latest");
    expect(await readFile(join(dir, "README.md"), "utf8")).toContain("npm install thing");
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).private).toBeUndefined();
  });

  it("escapes quotes in descriptions", async () => {
    const dir = await tempDir();
    await scaffoldProject({ ...base, description: 'Say "hi"', dir, name: "q", registry: "pypi" });
    expect(await readFile(join(dir, "pyproject.toml"), "utf8")).toContain('description = "Say \\"hi\\""');
  });
});

describe("helpers", () => {
  it("makes module names", () => {
    expect(moduleName("@scope/My-Tool")).toBe("my_tool");
    expect(moduleName("1st.tool")).toBe("pkg_1st_tool");
    expect(moduleName("---")).toBe("package");
  });

  it("explains unknown licenses", async () => {
    await expect(licenseText("NOT-A-LICENSE", "x")).rejects.toThrow(/SPDX/);
  });
});
