import { referenceItem } from "@keelson/agent";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { issuedReference } from "../src/fx.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const app = createApp({
  db: testDb,
  kv: testKv,
  log: pino({ level: "silent" }),
  authenticate: headerPrincipal,
});
const asAgent = {
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: "fx-agent",
    scopes: ["countersign:write"],
  }),
};
const keelson = { request: (path: string, init: RequestInit) => app.request(path, init) };

describe("reference exchange rates", () => {
  test("are served for the merchant's currency, current, to every other currency", async () => {
    const res = await app.request("/v1/fx/reference/USD", { headers: asAgent });
    expect(res.status).toBe(200);
    const ref = (await res.json()) as {
      base: string;
      provider: string;
      as_of: string;
      rates: Record<string, string>;
    };
    expect(ref).toMatchObject({ base: "USD", provider: "ExchangeRate-API" });
    expect(Date.now() - Date.parse(ref.as_of)).toBeLessThan(48 * 3600_000);
    for (const code of ["COP", "BRL", "JPY", "EUR", "MXN", "KWD", "INR", "GBP"]) {
      expect(ref.rates[code], code).toMatch(/^[0-9]+(\.[0-9]+)?$/);
    }
    expect(ref.rates.USD).toBeUndefined();
  });

  test("are served only to an agent client, and only from a PayPal currency", async () => {
    expect((await app.request("/v1/fx/reference/USD")).status).toBe(401);
    expect((await app.request("/v1/fx/reference/XYZ", { headers: asAgent })).status).toBe(422);
  });

  test("bind into the agent's evidence as the item the countersign accepts", async () => {
    const fx = await referenceItem(keelson, asAgent, "USD");
    expect(fx?.item.type).toBe("api.fx_reference");
    expect(await issuedReference(testKv, fx?.item.bytes as Uint8Array)).toBe(true);
    const text = Buffer.from(fx?.item.bytes as Uint8Array).toString();
    expect(text).toContain('"v":"keelson.fx_reference_commitment/1"');
    expect(text).not.toContain(String(fx?.reference.rates.COP));
  });
});
