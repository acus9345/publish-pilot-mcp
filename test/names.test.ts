import { describe, expect, it } from "vitest";
import { checkPackageName, nameAlternatives, normalizePypiName, validatePackageName } from "../src/names.js";

describe("validatePackageName", () => {
  it("accepts good names", () => {
    expect(validatePackageName("npm", "my-tool")).toBeNull();
    expect(validatePackageName("npm", "@me/my-tool")).toBeNull();
    expect(validatePackageName("pypi", "My_Tool.2")).toBeNull();
    expect(validatePackageName("crates", "my_tool")).toBeNull();
  });

  it("explains bad names", () => {
    expect(validatePackageName("npm", "")).toMatch(/empty/);
    expect(validatePackageName("npm", "MyTool")).toMatch(/lowercase.*mytool/);
    expect(validatePackageName("npm", "_private")).toMatch(/cannot start/);
    expect(validatePackageName("npm", "a".repeat(215))).toMatch(/214/);
    expect(validatePackageName("pypi", "-bad-")).toMatch(/start and end/);
    expect(validatePackageName("crates", "1tool")).toMatch(/start with a letter/);
    expect(validatePackageName("crates", "x".repeat(65))).toMatch(/64/);
  });
});

describe("alternatives", () => {
  it("suggests a scoped npm name first", () => {
    expect(nameAlternatives("npm", "tool", "Octocat")[0]).toBe("@octocat/tool");
  });
  it("never suggests the same name", () => {
    expect(nameAlternatives("pypi", "tool")).not.toContain("tool");
  });
  it("normalises PyPI names", () => {
    expect(normalizePypiName("My__Tool.Name")).toBe("my-tool-name");
  });
});

describe("checkPackageName (network)", () => {
  it("reports a well-known npm package as taken", async () => {
    const result = await checkPackageName("npm", "react");
    expect(result.valid).toBe(true);
    expect([false, null]).toContain(result.available);
  });

  it("reports a random npm name as free", async () => {
    const result = await checkPackageName("npm", `pp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect([true, null]).toContain(result.available);
  });

  it("does not hit the network for invalid names", async () => {
    const result = await checkPackageName("npm", "Bad Name");
    expect(result).toMatchObject({ valid: false, available: false });
  });
});
