import { readFileSync } from "node:fs";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { capabilitiesOf } from "../src/tee/statements.ts";
import { testDb, testKv } from "./setup.ts";

const deployedLegB = JSON.parse(
  readFileSync(new URL("./fixtures/health-b-62dcd607.json", import.meta.url), "utf8"),
);

describe("engine capabilities", () => {
  test("the deployed leg B reports none of the new features, and is sent none", () => {
    expect(capabilitiesOf(deployedLegB)).toEqual({
      statements: false,
      decoys: false,
      status_list: false,
      paypal_reads: false,
    });
  });

  test("a leg reports each feature on its own", () => {
    expect(capabilitiesOf({ ...deployedLegB, decoys: 1 })).toEqual({
      statements: false,
      decoys: true,
      status_list: false,
      paypal_reads: false,
    });
    expect(capabilitiesOf({ ...deployedLegB, statements: 1, status_list: 1 })).toEqual({
      statements: true,
      decoys: false,
      status_list: true,
      paypal_reads: false,
    });
  });

  test("leg B says when it reads PayPal itself", () => {
    expect(capabilitiesOf({ ...deployedLegB, paypal_reads: 1 }).paypal_reads).toBe(true);
  });

  test("leg A's clock is read when it reports one, and absent on an older engine", () => {
    expect(capabilitiesOf(deployedLegB).clock).toBeUndefined();
    expect(capabilitiesOf({ ...deployedLegB, clock: "unverified" }).clock).toBe("unverified");
    expect(capabilitiesOf({ ...deployedLegB, clock: "verified" }).clock).toBe("verified");
    expect(capabilitiesOf({ ...deployedLegB, clock: "soon" }).clock).toBeUndefined();
  });

  test("without TEE legs the API offers no decoys", async () => {
    const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });
    const res = await app.request("/v1/engine/capabilities");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decoys: false });
  });
});
