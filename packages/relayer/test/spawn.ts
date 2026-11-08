import { type ChildProcess, spawn } from "node:child_process";
import type { Hex } from "viem";

export interface ChildRun {
  process: ChildProcess;
  done: Promise<{ code: number | null; results: Record<string, unknown>[] }>;
}

/** Starts `child.ts` relaying a deposit for each salt. */
export function runChild(config: {
  dbUrl: string;
  rpcUrl: string;
  sequencerUrl?: string;
  amount: bigint;
  salts: Hex[];
  kms?: boolean;
}): ChildRun {
  const child = spawn(process.execPath, [new URL("./child.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      RELAYER_CHILD: JSON.stringify({ ...config, amount: config.amount.toString() }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const done = new Promise<{ code: number | null; results: Record<string, unknown>[] }>(
    (resolve, reject) => {
      child.on("exit", (code, signal) => {
        if (signal) return resolve({ code: null, results: [] });
        if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
        resolve({ code, results: JSON.parse(out) as Record<string, unknown>[] });
      });
    },
  );
  return { process: child, done };
}
