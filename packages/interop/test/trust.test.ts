import { readFileSync } from "node:fs";
import { base64url, calculateJwkThumbprint } from "jose";
import { expect, test } from "vitest";
import { AGENT_HTTP_KEYS, EXPORT_ISSUER_KEYS } from "../src/trust.ts";

const deployment = JSON.parse(
  readFileSync(new URL("../../../contracts/deployments/421614.json", import.meta.url), "utf8"),
) as { tee: { issuerJwkThumbprint: string } };

test("the current issuer key is the one the VerdictVerifier binds into attestations", async () => {
  const [current] = EXPORT_ISSUER_KEYS;
  expect(current).toBeDefined();
  const thumbprint = await calculateJwkThumbprint(current as never);
  expect(`0x${Buffer.from(base64url.decode(thumbprint)).toString("hex")}`).toBe(
    deployment.tee.issuerJwkThumbprint,
  );
});

test.each(EXPORT_ISSUER_KEYS)(
  "issuer key $kid is a public P-256 key named by its thumbprint",
  async (k) => {
    expect(Object.keys(k).sort()).toEqual(["crv", "kid", "kty", "x", "y"]);
    expect(k.kid).toBe(await calculateJwkThumbprint(k));
  },
);

test("the hosted agent's request key is pinned", () => {
  expect(AGENT_HTTP_KEYS.length).toBeGreaterThan(0);
});

test.each(AGENT_HTTP_KEYS as Record<string, string>[])(
  "agent key $kid is a public Ed25519 key named by its thumbprint",
  async (k) => {
    expect(Object.keys(k).sort()).toEqual(["crv", "kid", "kty", "x"]);
    expect([k.kty, k.crv]).toEqual(["OKP", "Ed25519"]);
    expect(k.kid).toBe(await calculateJwkThumbprint(k));
  },
);
