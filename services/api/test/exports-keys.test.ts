import { purchaseFacts } from "@keelson/interop";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import { v2Bundle } from "../../../packages/alibi/test/v2.ts";
import { exportKeysFor, legExportSigner, legIssuer } from "../src/routes/exports.ts";
import { type LegClient, LegError } from "../src/tee/client.ts";

const f = purchaseFacts(v2Bundle());
const cnf = f.mandate.agent?.cnf?.jwk as { kty: "EC"; crv: "P-256"; x: string; y: string };

describe("exportKeysFor", async () => {
  const { privateKey } = await generateKeyPair("ES256");
  const hostedAgent = { jwk: { ...cnf, kid: "hosted" }, key: privateKey };
  const issuer = { jwk: { ...cnf, kid: "issuer" }, sign: async () => "jws" };
  const agentHttp = {
    kid: "http",
    jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "x", kid: "http" },
    key: privateKey,
  };

  test("the owner's export may be closed and signed by the hosted agent", () => {
    const k = exportKeysFor("full", { hostedAgent, agentHttpKey: agentHttp }, issuer, f);
    expect(k.agent).toBe(hostedAgent);
    expect(k.agentHttp).toBe(agentHttp);
  });

  test("anyone else gets nothing signed by the agent", () => {
    const k = exportKeysFor("public", { hostedAgent, agentHttpKey: agentHttp }, issuer, f);
    expect(k.agent).toBeUndefined();
    expect(k.agentHttp).toBeUndefined();
  });
});

describe("legExportSigner", () => {
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y", kid: "k" };
  const failing = (e: Error) => legExportSigner({ signExport: async () => Promise.reject(e) }, jwk);

  test.each([
    ["a leg without the route", new LegError("a", "problem", undefined, 404)],
    ["a leg without its log or issuer", new LegError("a", "problem", "export.leg", 503)],
    ["a timeout", new LegError("a", "timeout")],
    ["an unreachable leg", new LegError("a", "unreachable")],
  ])("%s is the signer being unavailable", async (_, e) => {
    await expect(failing(e).sign("JWT", {}, "s")).rejects.toMatchObject({
      reason: "signer_unavailable",
    });
  });

  test.each(["export.receipt", "export.profile", "export.facts"])(
    "%s is a refused binding",
    async (code) => {
      await expect(
        failing(new LegError("a", "problem", code, 400)).sign("JWT", {}, "s"),
      ).rejects.toMatchObject({
        name: "BindingError",
      });
    },
  );
});

test("the issuer's key is read again from leg A's health after a while, so a rotation is followed", async () => {
  const one = await exportJWK((await generateKeyPair("ES256", { extractable: true })).publicKey);
  const two = await exportJWK((await generateKeyPair("ES256", { extractable: true })).publicKey);
  let served = one;
  let now = 0;
  // Only the issuer member of the health answer is read.
  const leg = {
    health: async () => ({ issuer: served }) as unknown as Awaited<ReturnType<LegClient["health"]>>,
    signExport: async () => ({ jws: "" }),
  };
  const resolve = legIssuer(leg, { ttlMs: 60_000, clock: () => now });
  expect((await resolve())?.jwk.x).toBe(one.x);
  served = two;
  expect((await resolve())?.jwk.x).toBe(one.x);
  now = 61_000;
  expect((await resolve())?.jwk.x).toBe(two.x);
});
