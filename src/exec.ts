import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.js";

/** Result of a finished command. Output is already redacted. */
export interface RunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in the order the command wrote them. */
  output: string;
  /** True when the command exited with code 0. */
  ok: boolean;
  /** True when the command could not start (usually: not installed). */
  notFound: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_OUTPUT = 200_000;
const IS_WINDOWS = process.platform === "win32";
/** Commands that are .cmd/.ps1 shims on Windows and must go through cmd.exe. */
const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "code"]);

/** Quote one argument for cmd.exe. */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Human readable form of a command, for reports. */
export function formatCommand(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL";

/** Environment for child processes. MCP clients often start servers with a trimmed env, so restore what Windows needs. */
export function childEnv(extra?: NodeJS.ProcessEnv, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra, NO_COLOR: "1", FORCE_COLOR: "0", GH_NO_UPDATE_NOTIFIER: "1", NO_UPDATE_NOTIFIER: "1" };
  if (IS_WINDOWS && !Object.keys(env).some((k) => k.toUpperCase() === "PATHEXT")) env.PATHEXT = DEFAULT_PATHEXT;
  return env;
}

function spawnProcess(cmd: string, args: readonly string[], opts: RunOptions): ChildProcess {
  const env = childEnv(opts.env);
  if (IS_WINDOWS && WINDOWS_SHIMS.has(cmd.toLowerCase())) {
    const line = [cmd, ...args.map(quoteWindowsArg)].join(" ");
    return spawn(line, { cwd: opts.cwd, env, shell: true, windowsHide: true });
  }
  return spawn(cmd, [...args], { cwd: opts.cwd, env, windowsHide: true });
}

/** Collapse progress bars: keep only the last carriage-return segment of each line, and strip ANSI codes. */
export function cleanOutput(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- matching ANSI escape codes is the point
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r$/, "").split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

function append(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
}

/** TextDecoder labels for the Windows console code pages TextDecoder supports. */
const CODE_PAGE_LABELS: Record<number, string> = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
};

let consoleCodePage: number | null | undefined;

/** The Windows console (OEM) code page, e.g. 950 on Chinese (Hong Kong) Windows. `null` when unknown. */
function windowsCodePage(): number | null {
  if (consoleCodePage !== undefined) return consoleCodePage;
  const result = spawnSync("cmd.exe", ["/d", "/c", "chcp"], { encoding: "latin1", windowsHide: true, timeout: 5000 });
  const match = /(\d+)\s*$/.exec(String(result.stdout ?? "").trim());
  consoleCodePage = match ? Number(match[1]) : null;
  return consoleCodePage;
}

/**
 * Decode a command's output. Most tools write UTF-8, but on non-English Windows, Windows
 * PowerShell 5.1 and other console programs write the console code page (950 for Chinese (Hong
 * Kong)), which reads as garbage when decoded as UTF-8. Invalid UTF-8 is decoded with that code page.
 */
export function decodeOutput(bytes: Buffer, codePage?: number): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const page = codePage ?? (IS_WINDOWS ? windowsCodePage() : null);
    const label = page ? CODE_PAGE_LABELS[page] : undefined;
    return label ? new TextDecoder(label).decode(bytes) : bytes.toString("utf8");
  }
}

/** Run a command to completion. Never throws; failures are reported in the result. */
export function run(cmd: string, args: readonly string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const command = formatCommand(cmd, args);
  return new Promise((resolve) => {
    // Raw chunks in arrival order, decoded once at the end so multi-byte characters split across chunks survive.
    const chunks: { err: boolean; data: Buffer }[] = [];
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    const collect = (err: boolean, data: Buffer): void => {
      chunks.push({ err, data });
      bytes += data.length;
      while (bytes > MAX_OUTPUT && chunks.length > 1) bytes -= chunks.shift()!.data.length;
    };
    const text = (pick: (c: { err: boolean }) => boolean): string =>
      cleanOutput(redact(decodeOutput(Buffer.concat(chunks.filter(pick).map((c) => c.data))))).trim();
    const finish = (exitCode: number | null, notFound = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        stdout: text((c) => !c.err),
        stderr: text((c) => c.err),
        output: text(() => true),
        ok: exitCode === 0 && !timedOut,
        notFound,
        timedOut,
      });
    };
    try {
      child = spawnProcess(cmd, args, opts);
    } catch (error) {
      const stderr = String(error);
      resolve({ command, exitCode: null, stdout: "", stderr, output: stderr, ok: false, notFound: true, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d: Buffer) => collect(false, d));
    child.stderr?.on("data", (d: Buffer) => collect(true, d));
    child.on("error", (error: NodeJS.ErrnoException) => {
      collect(true, Buffer.from(error.message));
      finish(null, error.code === "ENOENT");
    });
    child.on("close", (code) => {
      // cmd.exe reports a missing program as exit code 9009.
      const missing = IS_WINDOWS && code === 9009;
      finish(code, missing || (!IS_WINDOWS && code === 127));
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/**
 * Rewrite `a && b` for Windows PowerShell 5.1, which has no `&&` (only PowerShell 7 does): run each
 * part only if the previous one succeeded, and exit with its exit code if it failed. `&&` inside
 * quotes is left alone.
 */
export function powershell51Command(commandLine: string): string {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "&" && commandLine[i + 1] === "&") {
      parts.push(commandLine.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  parts.push(commandLine.slice(start).trim());
  if (parts.length === 1) return commandLine;
  return parts.join("; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }; ");
}

/** Make PowerShell write UTF-8 so its own messages decode correctly whatever the Windows language. */
const POWERSHELL_UTF8 = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; $OutputEncoding = [System.Text.Encoding]::UTF8; ";

let pwshAvailable: Promise<boolean> | undefined;

/** Whether PowerShell 7 (pwsh) is installed. It supports `&&` and UTF-8 natively. */
function hasPwsh(): Promise<boolean> {
  pwshAvailable ??= run("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { timeoutMs: 20_000 }).then((r) => r.ok);
  return pwshAvailable;
}

/**
 * Run a whole command line through the platform shell: PowerShell on Windows (PowerShell 7 when
 * installed, else Windows PowerShell 5.1 with `&&` rewritten), sh elsewhere.
 */
export async function runShell(commandLine: string, opts: RunOptions = {}): Promise<RunResult> {
  if (!IS_WINDOWS) return run("/bin/sh", ["-c", commandLine], opts);
  const flags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
  if (await hasPwsh()) return run("pwsh", [...flags, POWERSHELL_UTF8 + commandLine], opts);
  return run("powershell.exe", [...flags, POWERSHELL_UTF8 + powershell51Command(commandLine)], opts);
}

// ---------------------------------------------------------------------------
// Background jobs: long-running interactive commands (logins, publishes that
// wait for browser approval). The model polls them with `job_status`.
// ---------------------------------------------------------------------------

export interface Job {
  id: string;
  label: string;
  command: string;
  startedAt: number;
  output: string;
  exitCode: number | null;
  running: boolean;
  /** URLs seen in the output, in order of appearance. */
  urls: string[];
  /** One-time device codes seen in the output (e.g. GitHub's XXXX-XXXX). */
  codes: string[];
  child: ChildProcess;
  listeners: Set<() => void>;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

const URL_RE = /https:\/\/[^\s"'<>)\]]+/g;
const CODE_RE = /\b(?:one-time code|code)[^A-Z0-9]{1,20}([A-Z0-9]{4}-[A-Z0-9]{4})\b/gi;

export interface JobOptions extends RunOptions {
  label: string;
  /** Called once for each new URL detected in the output. */
  onUrl?: (url: string) => void;
  /** Runs after the process exits and before the job is marked finished; returned text is appended to the output. */
  finalize?: (job: Job) => Promise<string | void>;
}

/** Start a command in the background and return immediately. */
export function startJob(cmd: string, args: readonly string[], opts: JobOptions): Job {
  jobCounter += 1;
  const id = `job-${jobCounter}`;
  const child = spawnProcess(cmd, args, opts);
  const job: Job = {
    id,
    label: opts.label,
    command: formatCommand(cmd, args),
    startedAt: Date.now(),
    output: "",
    exitCode: null,
    running: true,
    urls: [],
    codes: [],
    child,
    listeners: new Set(),
  };
  const notify = (): void => job.listeners.forEach((fn) => fn());
  const onData = (d: Buffer): void => {
    const text = redact(d.toString());
    job.output = append(job.output, text);
    for (const match of job.output.matchAll(URL_RE)) {
      const url = match[0].replace(/[.,;:]+$/, "");
      if (!job.urls.includes(url)) {
        job.urls.push(url);
        opts.onUrl?.(url);
      }
    }
    for (const match of job.output.matchAll(CODE_RE)) {
      const code = match[1]!.toUpperCase();
      if (!job.codes.includes(code)) job.codes.push(code);
    }
    notify();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (error) => {
    job.output = append(job.output, `\n${error.message}`);
    job.running = false;
    notify();
  });
  child.on("close", (code) => {
    job.exitCode = code;
    const finish = (): void => {
      job.running = false;
      notify();
    };
    if (!opts.finalize) return finish();
    opts
      .finalize(job)
      .then((extra) => {
        if (extra) job.output = append(job.output, `\n${redact(extra)}`);
      })
      .catch(() => undefined)
      .finally(finish);
  });
  jobs.set(id, job);
  return job;
}

/** Quote a string for PowerShell (single quotes, '' escapes). */
export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Quote a string for POSIX sh. */
export function shQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a command that needs a real terminal (npm hides 2FA links and skips its approval
 * prompt without one). Windows: a visible PowerShell window; macOS: a Terminal window. On both,
 * the job ends with the window's exit code. Linux: the `script` utility provides a
 * pseudo-terminal, so output is still captured and URLs are detected.
 */
export function startTerminalJob(cmd: string, args: readonly string[], opts: JobOptions & { intro?: string }): Job {
  if (process.platform === "win32") {
    const script = [
      `$host.UI.RawUI.WindowTitle = ${psQuote(`publish-pilot: ${opts.label}`)}`,
      ...(opts.cwd ? [`Set-Location -LiteralPath ${psQuote(opts.cwd)}`] : []),
      `Write-Host ${psQuote(opts.intro ?? "publish-pilot started this command. Follow any prompt below.")} -ForegroundColor Yellow`,
      `& ${[cmd, ...args].map(psQuote).join(" ")}`,
      "$code = $LASTEXITCODE",
      "if ($code -ne 0) { Write-Host 'It failed (see above). This window closes in 60 seconds.' -ForegroundColor Red; Start-Sleep 60 } else { Write-Host 'Done. This window closes in 5 seconds.' -ForegroundColor Green; Start-Sleep 5 }",
      "exit $code",
    ].join("\n");
    const launcher =
      "$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$env:PP_ENCODED -PassThru -Wait; exit $p.ExitCode";
    return startJob("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launcher], {
      ...opts,
      env: { ...opts.env, PP_ENCODED: Buffer.from(script, "utf16le").toString("base64") },
    });
  }
  const line = [cmd, ...args].map(shQuote).join(" ");
  if (process.platform === "darwin") {
    // macOS script(1) needs a terminal on its own stdin, which an MCP server never has,
    // so open a Terminal window and wait for the exit code it writes.
    const resultFile = join(tmpdir(), `publish-pilot-${process.pid}-${Date.now()}.exit`);
    const inWindow = [
      ...(opts.cwd ? [`cd ${shQuote(opts.cwd)}`] : []),
      `echo ${shQuote(opts.intro ?? "publish-pilot started this command. Follow any prompt below.")}`,
      line,
      `echo $? > ${shQuote(resultFile)}`,
    ].join("; ");
    const waiter = [
      `osascript -e 'on run argv' -e 'tell application "Terminal"' -e 'activate' -e 'do script (item 1 of argv)' -e 'end tell' -e 'end run' "$PP_SCRIPT" > /dev/null || exit 1`,
      `while [ ! -s ${shQuote(resultFile)} ]; do sleep 1; done`,
      `exit "$(cat ${shQuote(resultFile)})"`,
    ].join("\n");
    return startJob("/bin/sh", ["-c", waiter], { ...opts, env: { ...opts.env, PP_SCRIPT: inWindow } });
  }
  return startJob("script", ["-qec", line, "/dev/null"], opts);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}

/** Send text (e.g. "\n" for "Press ENTER") to a running job. */
export function writeToJob(job: Job, text: string): boolean {
  if (!job.running || !job.child.stdin?.writable) return false;
  job.child.stdin.write(text);
  return true;
}

export function stopJob(job: Job): void {
  if (job.running) job.child.kill();
}

/** Wait until the job exits, or `predicate` returns true, or the timeout passes. */
export function waitForJob(job: Job, timeoutMs: number, predicate?: (job: Job) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): boolean => !job.running || (predicate?.(job) ?? false);
    if (check() || timeoutMs <= 0) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      job.listeners.delete(listener);
      resolve();
    };
    const listener = (): void => {
      if (check()) done();
    };
    const timer = setTimeout(done, timeoutMs);
    job.listeners.add(listener);
  });
}

/** Plain-object view of a job that is safe to return to the model. */
export function describeJob(job: Job, tailChars = 4000): Record<string, unknown> {
  return {
    id: job.id,
    label: job.label,
    command: job.command,
    running: job.running,
    exitCode: job.exitCode,
    secondsRunning: Math.round((Date.now() - job.startedAt) / 1000),
    urls: job.urls,
    codes: job.codes,
    outputTail: cleanOutput(job.output).slice(-tailChars).trim(),
  };
}
