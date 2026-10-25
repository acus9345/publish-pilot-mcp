import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.js";

/** Result of a finished command. Output is already redacted. */
export interface RunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
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

/** Run a command to completion. Never throws; failures are reported in the result. */
export function run(cmd: string, args: readonly string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const command = formatCommand(cmd, args);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    const finish = (exitCode: number | null, notFound = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        stdout: cleanOutput(redact(stdout)).trim(),
        stderr: cleanOutput(redact(stderr)).trim(),
        ok: exitCode === 0 && !timedOut,
        notFound,
        timedOut,
      });
    };
    try {
      child = spawnProcess(cmd, args, opts);
    } catch (error) {
      stderr = String(error);
      resolve({ command, exitCode: null, stdout, stderr, ok: false, notFound: true, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d: Buffer) => (stdout = append(stdout, d.toString())));
    child.stderr?.on("data", (d: Buffer) => (stderr = append(stderr, d.toString())));
    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr = append(stderr, error.message);
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

/** Run a whole command line through the platform shell (PowerShell on Windows, sh elsewhere). */
export function runShell(commandLine: string, opts: RunOptions = {}): Promise<RunResult> {
  return IS_WINDOWS
    ? run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", commandLine], opts)
    : run("/bin/sh", ["-c", commandLine], opts);
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
export function describeJob(job: Job, tailChars = 3000): Record<string, unknown> {
  const info: Record<string, unknown> = {
    id: job.id,
    label: job.label,
    running: job.running,
    exitCode: job.exitCode,
    seconds: Math.round((Date.now() - job.startedAt) / 1000),
  };
  if (job.urls.length) info.urls = job.urls;
  if (job.codes.length) info.codes = job.codes;
  const output = cleanOutput(job.output)
    .replace(/^npm (notice|warn run)\b.*$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (output) info.outputTail = output.slice(-tailChars);
  return info;
}
