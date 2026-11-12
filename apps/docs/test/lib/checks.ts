import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { docFiles, fences, REPO } from "./markdown";

export interface Check {
  file: string;
  line: number;
  id: string;
  script: string;
  expect: RegExp;
}

export interface CheckResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

/** Shell blocks marked `{% check="id" %}` (Markdoc) or `check=id` (GitHub Markdown); the last line is `# expect: <regex>`. */
export function extractChecks(markdown: string, file: string): Check[] {
  return fences(markdown).flatMap((f) => {
    const id =
      f.info.match(/\{%[^%]*\bcheck="([^"]+)"[^%]*%\}/)?.[1] ?? f.info.match(/^check=(\S+)$/)?.[1];
    if (f.lang !== "sh" || !id) return [];
    const lines = f.body.trimEnd().split("\n");
    const last = lines.at(-1)?.match(/^#\s*expect:\s*(.+)$/);
    if (!last?.[1]) throw new Error(`missing expect at ${file}:${f.line}`);
    return [
      {
        file,
        line: f.line,
        id,
        script: lines.slice(0, -1).join("\n"),
        expect: new RegExp(last[1], "m"),
      },
    ];
  });
}

export const allChecks = () => docFiles().flatMap((f) => extractChecks(readFileSync(f, "utf8"), f));

function once(script: string, timeoutMs: number): Promise<Omit<CheckResult, "ok">> {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn("bash", ["-euo", "pipefail", "-c", script], {
      cwd: REPO,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const finish = (code: number | null) =>
      done({ stdout, stderr, code, ms: Math.round(performance.now() - started) });
    child.on("error", (e) => {
      stderr += String(e);
      finish(null);
    });
    child.on("close", finish);
  });
}

/** Runs a check with bash, retrying once after a pause so a brief outage does not fail it. */
export async function runCheck(
  check: Check,
  {
    timeoutMs = 60_000,
    retries = 1,
    retryDelayMs = 5_000,
  }: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<CheckResult> {
  for (let attempt = 0; ; attempt++) {
    const r = await once(check.script, timeoutMs);
    const ok = r.code === 0 && check.expect.test(r.stdout);
    if (ok || attempt >= retries) return { ok, ...r };
    await new Promise((wait) => setTimeout(wait, retryDelayMs));
  }
}
