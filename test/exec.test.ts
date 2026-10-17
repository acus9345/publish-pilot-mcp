import { describe, expect, it } from "vitest";
import { childEnv, cleanOutput, describeJob, psQuote, quoteWindowsArg, run, runShell, shQuote, startJob, startTerminalJob, waitForJob, writeToJob } from "../src/exec.js";
import { fake } from "./helpers.js";

const node = process.execPath;

describe("run", () => {
  it("captures output and exit code", async () => {
    const result = await run(node, ["-e", "console.log('hi'); console.error('warn'); process.exit(3)"]);
    expect(result).toMatchObject({ exitCode: 3, stdout: "hi", stderr: "warn", ok: false, notFound: false });
  });

  it("reports a missing program instead of throwing", async () => {
    const result = await run("definitely-not-a-real-program-xyz", ["--version"]);
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });

  it("redacts tokens in output", async () => {
    const token = fake("gh" + "o_");
    const result = await run(node, ["-e", `console.log(${JSON.stringify(`token ${token}`)})`]);
    expect(result.stdout).toBe("token ***");
  });

  it("times out", async () => {
    const result = await run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("passes arguments with spaces and quotes intact", async () => {
    const result = await run(node, ["-e", "console.log(process.argv[1])", 'a "quoted" arg with spaces']);
    expect(result.stdout).toBe('a "quoted" arg with spaces');
  });

  it("runs npm through the Windows shim", async () => {
    const result = await run("npm", ["--version"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("runs a shell command line", async () => {
    const result = await runShell("echo hello");
    expect(result.stdout).toBe("hello");
  });
});

describe("childEnv", () => {
  it.runIf(process.platform === "win32")("restores PATHEXT when the client stripped it", () => {
    expect(childEnv(undefined, { PATH: "C:\\x" }).PATHEXT).toContain(".EXE");
    expect(childEnv(undefined, { PATH: "C:\\x", PathExt: ".EXE" }).PATHEXT).toBeUndefined();
  });

  it("turns off colors", () => {
    expect(childEnv(undefined, {})).toMatchObject({ NO_COLOR: "1" });
  });
});

describe("cleanOutput", () => {
  it("keeps only the final state of progress bars and strips colors", () => {
    expect(cleanOutput("10%\r50%\r100% done\r\nnext\x1b[32m ok\x1b[0m")).toBe("100% done\nnext ok");
    expect(cleanOutput("")).toBe("");
  });
});

describe("quoteWindowsArg", () => {
  it("leaves simple args alone and quotes the rest", () => {
    expect(quoteWindowsArg("publish")).toBe("publish");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("a&b")).toBe('"a&b"');
  });
});

describe("quoting", () => {
  it("quotes for PowerShell", () => {
    expect(psQuote("C:\\my file\\x")).toBe("'C:\\my file\\x'");
    expect(psQuote("it's")).toBe("'it''s'");
  });
  it("quotes for sh only when needed", () => {
    expect(shQuote("publish")).toBe("publish");
    expect(shQuote("@scope/pkg")).toBe("@scope/pkg");
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe.runIf(process.platform !== "win32")("startTerminalJob (pseudo-terminal)", () => {
  it("runs the command with a TTY and captures output", async () => {
    const job = startTerminalJob(node, ["-e", "console.log(process.stdout.isTTY ? 'tty' : 'pipe')"], { label: "tty test" });
    await waitForJob(job, 15_000);
    expect(job.exitCode).toBe(0);
    expect(job.output).toContain("tty");
  });
});

describe("jobs", () => {
  it("detects URLs and device codes and accepts input", async () => {
    const script = [
      "console.log('! First copy your one-time code: AB12-CD34');",
      "console.log('Open https://github.com/login/device to continue.');",
      "process.stdin.once('data', d => { console.log('got ' + d.toString().trim()); process.exit(0); });",
    ].join("");
    const job = startJob(node, ["-e", script], { label: "test" });
    await waitForJob(job, 5000, (j) => j.codes.length > 0 && j.urls.length > 0);
    expect(job.codes).toEqual(["AB12-CD34"]);
    expect(job.urls).toEqual(["https://github.com/login/device"]);
    expect(writeToJob(job, "yes\n")).toBe(true);
    await waitForJob(job, 5000);
    const info = describeJob(job);
    expect(info).toMatchObject({ running: false, exitCode: 0 });
    expect(String(info.outputTail)).toContain("got yes");
  });
});
