import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { login } from "../../src/index.ts";
import { hasBuyer, judge, type User } from "./user.ts";

const quickstart = fileURLToPath(new URL("../../examples/quickstart.mjs", import.meta.url));
const live = process.env.KEELSON_LIVE === "1";

describe.skipIf(!live || !hasBuyer)(
  "the quickstart (live, PayPal sandbox)",
  { timeout: 360_000 },
  () => {
    let user: User;
    let credentials: string;
    beforeAll(async () => {
      user = await judge();
      credentials = join(await mkdtemp(join(tmpdir(), "keelson-quickstart-")), "credentials.json");
      await login({ path: credentials, open: (url) => user.approveLogin(url), log: () => {} });
    }, 180_000);
    afterAll(() => user?.close());

    test("buys and verifies offline within budget", async () => {
      const started = Date.now();
      let human = 0;
      const child = spawn("node", [quickstart], {
        env: { ...process.env, KEELSON_CREDENTIALS: credentials },
      });
      let stdout = "";
      const approved = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", async (chunk: Buffer) => {
          stdout += chunk.toString();
          const url = /Approve with your passkey: (\S+)/.exec(stdout)?.[1];
          if (url && !human) {
            human = -1;
            const t = Date.now();
            await user.approveRequest(url, { hold: true }).then(resolve, reject);
            human = Date.now() - t;
          }
        });
      });
      const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)));
      await approved;
      const automated = Date.now() - started - human;
      const line = `quickstart: ${Date.now() - started} ms in all, ${automated} ms automated`;
      console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
      expect(code).toBe(0);
      expect(stdout).toMatch(/Alibi: verified-offline/);
      expect(automated).toBeLessThanOrEqual(90_000);
    });
  },
);
