import { describe, expect, it } from "vitest";
import { extractJson, parsePackJson, prependPath } from "../src/ops.js";

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

describe("prependPath", () => {
  it("keeps the existing PATH key name", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    expect(prependPath("/bin2", { Path: "/usr/bin" })).toEqual({ Path: `/bin2${sep}/usr/bin` });
    expect(prependPath("/bin2", {})).toEqual({ PATH: "/bin2" });
  });
});
