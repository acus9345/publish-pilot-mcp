import { describe, expect, it } from "vitest";
import { currentDistFiles, existingRepoAction, extractJson, npmPackageState, parsePackJson, pickRun, prependPath } from "../src/ops.js";

const entry = { name: "pkg", size: 10, unpackedSize: 20, files: [{ path: "a]b.js", size: 1 }] };

describe("extractJson", () => {
  it("finds JSON between script logs", () => {
    const out = `> pkg@1.0.0 prepack\n> tsc [--flags]\n\n${JSON.stringify([entry], null, 2)}\nnpm notice done\n`;
    expect(extractJson(out)).toEqual([entry]);
  });

  it("returns null when there is no JSON", () => {
    expect(extractJson("")).toBeNull();
    expect(extractJson("[not json")).toBeNull();
  });
});

describe("parsePackJson", () => {
  it("reads the npm 11 array format", () => {
    expect(parsePackJson(JSON.stringify([entry]))).toEqual(entry);
  });

  it("reads the npm 12 object format", () => {
    expect(parsePackJson(`> build\n${JSON.stringify({ pkg: entry })}`)).toEqual(entry);
  });

  it("returns null for unrelated JSON", () => {
    expect(parsePackJson('{"error": "x"}')).toBeNull();
  });
});

describe("pickRun", () => {
  const base = { status: "completed", conclusion: "success", url: "", displayTitle: "", event: "push", databaseId: 1 };
  const runs = [
    { ...base, databaseId: 2, headBranch: "main", headSha: "old" },
    { ...base, databaseId: 3, headBranch: "v0.1.0", headSha: "new" },
  ];
  it("matches the commit, not just the newest run", () => {
    expect(pickRun(runs, "main", "new")).toBeUndefined();
    expect(pickRun(runs, undefined, "new")?.databaseId).toBe(3);
    expect(pickRun(runs, "main")?.databaseId).toBe(2);
    expect(pickRun([], "main", "x")).toBeUndefined();
  });
});

describe("prependPath", () => {
  it("keeps the existing PATH key name", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    expect(prependPath("/bin2", { Path: "/usr/bin" })).toEqual({ Path: `/bin2${sep}/usr/bin` });
    expect(prependPath("/bin2", {})).toEqual({ PATH: "/bin2" });
  });
});

describe("currentDistFiles", () => {
  const files = ["my_pkg-0.1.0-py3-none-any.whl", "my_pkg-0.1.0.tar.gz", "my_pkg-0.2.0-py3-none-any.whl", "my_pkg-0.2.0.tar.gz", "other-0.2.0.tar.gz", ".gitignore"];

  it("keeps only the current version's wheel and sdist", () => {
    expect(currentDistFiles(files, "my-pkg", "0.2.0")).toEqual(["my_pkg-0.2.0-py3-none-any.whl", "my_pkg-0.2.0.tar.gz"]);
  });

  it("accepts sdists that keep the dashed name", () => {
    expect(currentDistFiles(["My-Pkg-1.0.0.tar.gz"], "My-Pkg", "1.0.0")).toEqual(["My-Pkg-1.0.0.tar.gz"]);
  });

  it("does not match a longer version with the same prefix", () => {
    expect(currentDistFiles(["my_pkg-0.2.0.post1.tar.gz", "my_pkg-0.2.01-py3-none-any.whl"], "my_pkg", "0.2.0")).toEqual([]);
  });
});

describe("npmPackageState", () => {
  it("treats a package with only the staging placeholder as still processing", () => {
    expect(npmPackageState({ versions: { "0.0.0-stage": { stub: true } } })).toBe("staging");
  });

  it("treats a real version as published", () => {
    expect(npmPackageState({ versions: { "0.0.0-stage": { stub: true }, "0.1.0": {} } })).toBe(true);
  });

  it("treats no versions as not published", () => {
    expect(npmPackageState({ versions: {} })).toBe(false);
    expect(npmPackageState(null)).toBe(false);
  });
});

describe("existingRepoAction", () => {
  const url = "https://github.com/ada/thing";

  it("pushes when origin is already that repo", () => {
    expect(existingRepoAction("https://github.com/Ada/thing.git", url, null)).toBe("push");
  });

  it("connects an empty repo when the folder has no origin (an interrupted create)", () => {
    expect(existingRepoAction(null, url, true)).toBe("connect");
  });

  it("refuses a repo with history, an unknown state, or a different origin", () => {
    expect(existingRepoAction(null, url, false)).toBe("refuse");
    expect(existingRepoAction(null, url, null)).toBe("refuse");
    expect(existingRepoAction("https://github.com/ada/other.git", url, true)).toBe("refuse");
  });
});
