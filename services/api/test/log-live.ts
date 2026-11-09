import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_ORIGINS } from "@keelson/log";
import { VERIFYING_CONTRACT } from "../src/tee/config.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
    s.on("error", fail);
  });

export interface LocalLog {
  /** The private listener the API writes to. */
  url: string;
  /** The public, read-only listener. */
  publicUrl: string;
  token: string;
  /** The Ed25519 and ML-DSA-44 vkeys of each origin. */
  vkeys: Record<string, [string, string]>;
  stop(): Promise<void>;
}

/**
 * Builds and starts the log on a temporary directory with throwaway keys, reading the signers and
 * purchases of `databaseUrl`. These keys never sign for the public origins.
 */
export async function startLocalLog(databaseUrl: string): Promise<LocalLog> {
  const dir = mkdtempSync(join(tmpdir(), "keelson-log-"));
  const bin = join(dir, "log");
  execFileSync("go", ["build", "-o", bin, "./services/log"], { cwd: root, stdio: "inherit" });
  const env: Record<string, string> = {};
  const vkeys: Record<string, [string, string]> = {};
  for (const [origin, suffix] of [
    [LOG_ORIGINS[421614] as string, "SANDBOX"],
    [LOG_ORIGINS[42161] as string, "LIVE"],
  ] as const) {
    const name = suffix.toLowerCase();
    const out = execFileSync(
      "go",
      [
        "run",
        "./services/log/cmd/keygen",
        "-origin",
        origin,
        "-env",
        suffix,
        "-dir",
        dir,
        "-name",
        name,
      ],
      { cwd: root, encoding: "utf8" },
    );
    for (const line of out.trim().split("\n")) {
      const i = line.indexOf("=");
      env[line.slice(0, i)] = line.slice(i + 1);
    }
    vkeys[origin] = [
      readFileSync(join(dir, `${name}.vkey`), "utf8").trim(),
      readFileSync(join(dir, `${name}.mldsa.vkey`), "utf8").trim(),
    ];
  }
  // These keys have no witnesses: each checkpoint is published on the log's own signatures.
  const policyDir = join(dir, "policy");
  mkdirSync(policyDir);
  for (const [origin, [ed, ml]] of Object.entries(vkeys)) {
    const file = `${origin.slice(origin.indexOf("/") + 1).replaceAll("/", "-")}.policy`;
    writeFileSync(join(policyDir, file), `log ${ed}\nlog ${ml}\nquorum none\n`);
  }
  const token = randomBytes(32).toString("base64url");
  const [pub, priv] = [await freePort(), await freePort()];
  const child: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      ...env,
      PORT: String(pub),
      LOG_PRIVATE_ADDR: `127.0.0.1:${priv}`,
      LOG_DATA_DIR: join(dir, "data"),
      LOG_POLICY_DIR: policyDir,
      DATABASE_URL: databaseUrl,
      KEELSON_VERIFYING_CONTRACT: VERIFYING_CONTRACT,
      LOG_WRITE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
    },
    stdio: "ignore",
  });
  const publicUrl = `http://127.0.0.1:${pub}`;
  for (let i = 0; ; i++) {
    const up = await fetch(`${publicUrl}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (i > 100) throw new Error("the log did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url: `http://127.0.0.1:${priv}`,
    publicUrl,
    token,
    vkeys,
    stop: () =>
      new Promise((done) => {
        child.once("exit", () => done());
        child.kill("SIGTERM");
      }),
  };
}
