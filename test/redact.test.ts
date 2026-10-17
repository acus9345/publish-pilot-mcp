import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import { fake } from "./helpers.js";

describe("redact", () => {
  it("hides GitHub, npm and PyPI tokens", () => {
    const text = `token ${fake("gh" + "o_")} and ${fake("np" + "m_")} and ${fake("pyp" + "i-", 60)}`;
    const out = redact(text);
    expect(out).not.toMatch(/a1B2c3D4e5/);
    expect(out.match(/\*\*\*/g)).toHaveLength(3);
  });

  it("keeps the key name of .npmrc auth lines", () => {
    const key = "_auth" + "Token=";
    expect(redact(`//registry.npmjs.org/:${key}abcdef123456`)).toBe(`//registry.npmjs.org/:${key}***`);
  });

  it("leaves ordinary text alone", () => {
    expect(redact("")).toBe("");
    expect(redact("Logged in to github.com account octocat")).toBe("Logged in to github.com account octocat");
  });

  it("handles large input quickly", () => {
    const big = "x".repeat(2_000_000) + " " + fake("gh" + "p_");
    const started = Date.now();
    expect(redact(big).endsWith("***")).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
