import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createTee } from "../src/tee/config.ts";
import { loadMeasurements } from "../src/tee/measurements.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { testDb, testKv } from "./setup.ts";
import { asAgent, headerPrincipal, live, liveEnv } from "./tee-live.ts";

const log = pino({ level: "silent" });
const bare = createApp({ db: testDb, kv: testKv, log, authenticate: headerPrincipal });

describe("without TEE legs", () => {
  test("the attestations list is empty and the measurements are published", async () => {
    const res = await bare.request("/v1/tee/attestations");
    const body = (await res.json()) as {
      legs: unknown[];
      measurements: { tdx: string[]; provenance: string };
    };
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(body.legs).toEqual([]);
    expect(body.measurements.tdx).toEqual(loadMeasurements().tdx);
    expect(body.measurements.provenance).toMatch(
      /^https:\/\/github\.com\/DavidZapataOh\/keelson-paypal\/releases\/download\/sha256-[0-9a-f]{64}\/measurements\.json$/,
    );
  });

  test("status names no legs", async () => {
    const body = (await (await bare.request("/status")).json()) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(body.dependencies).sort()).toEqual(["db", "kv"]);
  });

  test("countersigning answers 503", async () => {
    const res = await bare.request("/v1/countersign", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k1", ...asAgent },
      body: JSON.stringify({
        authorizationId: "AUTH",
        closedMandate: "x",
        cart: {
          merchant: "m",
          currency: "USD",
          lines: [{ sku: "s", category: "c", qty: 1, unit_minor: 100 }],
          return_days: 30,
          returns_free: true,
        },
        unit: {},
        evidenceRoot: `0x${"00".repeat(32)}`,
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe.skipIf(!live)("with the live legs", { timeout: 60_000 }, () => {
  const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
  const app = createApp({ db: testDb, kv: testKv, log, tee });

  test("the attestations route lists both legs and status shows them up", async () => {
    await refreshLeg(testDb, "a", tee);
    await refreshLeg(testDb, "b", tee);
    const body = (await (await app.request("/v1/tee/attestations")).json()) as {
      legs: { tee: string; signer: string; verifiedAt: string; attestation: { tee: string } }[];
    };
    for (const leg of body.legs) {
      expect(Date.now() - Date.parse(leg.verifiedAt)).toBeLessThan(60_000);
    }
    expect(body.legs.map((l) => l.tee)).toEqual(["tdx", "nitro"]);
    const [healthA, healthB] = await Promise.all([tee.client.a.health(), tee.client.b.health()]);
    expect(body.legs[0]?.signer.toLowerCase()).toBe(healthA.signer.toLowerCase());
    expect(body.legs[1]?.signer.toLowerCase()).toBe(healthB.signer.toLowerCase());
    expect(body.legs[1]?.attestation.tee).toBe("nitro");

    const status = (await (await app.request("/status")).json()) as {
      dependencies: Record<string, string>;
    };
    expect(status.dependencies).toMatchObject({ teeA: "up", teeB: "up" });
  });
});
