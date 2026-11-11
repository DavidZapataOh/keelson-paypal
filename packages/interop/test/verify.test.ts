import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import { CONFORMANCE, exportAll, FORMATS } from "../src/export.ts";
import { purchaseFacts, statementFacts } from "../src/facts.ts";
import { jwtPayload } from "../src/jose.ts";
import type { ExportSigner } from "../src/signer.ts";
import { ed25519Signer } from "../src/tap.ts";
import { localExportSigner } from "../src/testing.ts";
import { verifyExport } from "../src/verify.ts";
import { ALLOW_PAYPAL, alibi, factsFor, NOW, testAgent, testIssuer } from "./fixtures.ts";
import { RECEIPT_KEYS, v2Ref } from "./v2.ts";

const ref = v2Ref("allow-2of2");

async function keys() {
  const issuer = await testIssuer(ALLOW_PAYPAL);
  const agent = await testAgent();
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  return { issuer, agent, agentHttp: await ed25519Signer(await exportJWK(privateKey)) };
}

async function all() {
  const k = await keys();
  const f = factsFor(ALLOW_PAYPAL, k.agent);
  const x = await exportAll(f, ref, k, { now: NOW, bundle: alibi(ALLOW_PAYPAL) });
  return { k, x };
}

const failed = async (artifact: unknown, issuer: ExportSigner) =>
  (
    await verifyExport(artifact, { now: NOW, issuerKeys: [issuer.jwk], receiptKeys: RECEIPT_KEYS })
  ).checks
    .filter((c) => !c.ok)
    .map((c) => c.id);

describe("verifyExport", () => {
  test("one v2 Alibi exports to every format its facts allow, each verified offline", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network used");
    };
    try {
      const { k, x } = await all();
      // This Alibi does not disclose its cart, so UCP's required subtotal cannot be stated.
      expect(Object.keys(x).sort()).toEqual(["acp", "ap2", "tap", "visa", "vi"].sort());
      for (const [format, artifact] of Object.entries(x)) {
        expect(await failed(artifact, k.issuer), format).toEqual([]);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("every format names the official tool that checks it", () => {
    expect(Object.keys(CONFORMANCE).sort()).toEqual([...FORMATS].sort());
  });

  test("a forgery signed by any key but the issuer's fails the issuer check", async () => {
    const { k, x } = await all();
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const stranger = await localExportSigner(await exportJWK(privateKey), () =>
      statementFacts(purchaseFacts(alibi(ALLOW_PAYPAL))),
    );
    const acp = x.acp as { attestation: string };
    const resigned = await stranger.sign("JWT", jwtPayload(acp.attestation), ref.statement);
    expect(await failed({ ...acp, attestation: resigned }, k.issuer)).toContain("issuer");
  });

  test.each(["amount_minor", "currency", "decision", "request_id", "mandate_hash"] as const)(
    "%s changed in the signed facts fails against the statement, even signed by the issuer's key",
    async (field) => {
      const { k, x } = await all();
      const acp = x.acp as { attestation: string };
      const p = jwtPayload(acp.attestation) as { keelson: { facts: Record<string, unknown> } };
      const changed = typeof p.keelson.facts[field] === "number" ? 1 : "0x00";
      const forged = {
        ...p,
        keelson: { ...p.keelson, facts: { ...p.keelson.facts, [field]: changed } },
      };
      // Signed directly with the issuer's key material, bypassing the binding check the issuer runs.
      const key = (k.issuer as ExportSigner & { privateKey?: CryptoKey }).privateKey as CryptoKey;
      const attestation = await new SignJWT(forged)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: k.issuer.jwk.kid })
        .sign(key);
      expect(await failed({ ...acp, attestation }, k.issuer)).toContain("facts");
    },
  );

  test("another purchase's statement fails the facts", async () => {
    const { k, x } = await all();
    expect(await failed({ ...(x.acp as object), alibi: v2Ref("deny-2of2") }, k.issuer)).toEqual(
      expect.arrayContaining(["facts"]),
    );
  });

  test("a receipt from an unpinned key fails the receipt", async () => {
    const { k, x } = await all();
    const r = await verifyExport(x.ap2, {
      now: NOW,
      issuerKeys: [k.issuer.jwk],
      receiptKeys: new Map(),
    });
    expect(r.checks.find((c) => c.id === "receipt")?.ok).toBe(false);
  });
});
