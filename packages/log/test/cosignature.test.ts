import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  LOG_ORIGINS,
  LOG_WITNESSES,
  verifyCosignatures,
  verifyWitnessedCheckpoint,
} from "../src/index.ts";

// Published checkpoints of log.keelson.finance, fetched 2026-11-09.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/checkpoints/${name}.txt`, import.meta.url), "utf8");
const sandbox = fixture("alibi-2026-1-54");
const live = fixture("alibi-live-2026-1-0");
const witnesses = LOG_WITNESSES[LOG_ORIGINS[421614] as string] as {
  vkeys: readonly string[];
  quorum: number;
};
const now = new Date("2026-11-09T07:00:00Z");

const lines = (signed: string, prefix: string) =>
  signed.split("\n").filter((l) => l.startsWith(`— ${prefix}`));
const without = (signed: string, drop: string[]) =>
  signed
    .split("\n")
    .filter((l) => !drop.includes(l))
    .join("\n");

describe("witness cosignatures", () => {
  test.each([
    ["sandbox", sandbox],
    ["live", live],
  ])("the %s checkpoint carries the quorum of its own witnesses", (_, signed) => {
    const out = verifyCosignatures(signed, witnesses, now);
    expect(out.cosigners.length).toBeGreaterThanOrEqual(2);
    for (const c of out.cosigners) expect(c).toMatch(/^witness-[123]\.keelson\.finance$/);
    expect(out.times).toHaveLength(out.cosigners.length);
  });

  test("one cosignature is not a quorum, even when repeated", () => {
    const cosigs = lines(sandbox, "witness-");
    const one = without(sandbox, cosigs.slice(1));
    expect(() => verifyCosignatures(one, witnesses, now)).toThrow("witness quorum not met: 1 of 2");
    const repeated = one.replace(cosigs[0] as string, `${cosigs[0]}\n${cosigs[0]}`);
    expect(() => verifyCosignatures(repeated, witnesses, now)).toThrow(
      "witness quorum not met: 1 of 2",
    );
  });

  test("a cosignature with a flipped byte does not count", () => {
    const [first] = lines(sandbox, "witness-") as [string];
    const [prefix, b64] = first.split(" ").slice(1) as [string, string];
    const sig = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    sig[40] = (sig[40] as number) ^ 1;
    const flipped = sandbox.replace(first, `— ${prefix} ${btoa(String.fromCharCode(...sig))}`);
    expect(() => verifyCosignatures(flipped, witnesses, now)).toThrow(
      "witness quorum not met: 1 of 2",
    );
  });

  test("cosignatures of another checkpoint do not count", () => {
    const body = sandbox.slice(0, sandbox.indexOf("\n\n") + 2);
    const foreign = `${body}${lines(live, "witness-").join("\n")}\n`;
    expect(() => verifyCosignatures(foreign, witnesses, now)).toThrow(
      "witness quorum not met: 0 of 2",
    );
  });

  test("a cosignature from the future does not count", () => {
    expect(() => verifyCosignatures(sandbox, witnesses, new Date("2026-01-01T00:00:00Z"))).toThrow(
      "witness quorum not met: 0 of 2",
    );
  });

  test("a quorum outside 1..n or a key listed twice is refused", () => {
    for (const quorum of [0, -1, Number.NaN, 4]) {
      expect(() => verifyCosignatures(sandbox, { ...witnesses, quorum }, now)).toThrow(RangeError);
    }
    const [w1] = witnesses.vkeys as [string];
    expect(() => verifyCosignatures(sandbox, { vkeys: [w1, w1], quorum: 2 }, now)).toThrow(
      "listed twice",
    );
  });

  test("a witnessed checkpoint is checked under the keys pinned for its origin", () => {
    expect(verifyWitnessedCheckpoint(sandbox, now).size).toBe(54n);
    expect(verifyWitnessedCheckpoint(live, now).size).toBe(0n);
    const body = sandbox.slice(0, sandbox.indexOf("\n\n") + 2);
    const unsigned = body + lines(sandbox, "witness-").join("\n");
    expect(() => verifyWitnessedCheckpoint(unsigned, now)).toThrow("not signed");
    expect(() =>
      verifyWitnessedCheckpoint(sandbox.replace(/^log\.keelson\.finance/, "x.example"), now),
    ).toThrow("pinned");
  });

  test("log keys are not witness keys", () => {
    expect(() =>
      verifyCosignatures(
        sandbox,
        {
          vkeys: [
            "log.keelson.finance/alibi/2026-1+2e11a7ea+AfBrbrDNyb9uyXNtg3PXXnVxKQBcMGqa1OlCtxlttUBX",
          ],
          quorum: 1,
        },
        now,
      ),
    ).toThrow("cosignature/v1 key");
  });
});
