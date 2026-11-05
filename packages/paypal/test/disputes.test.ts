import { describe, expect, it } from "vitest";
import type { PayPalConfig } from "../src/config.js";
import { adjudicate, evidenceForm, requireEvidence } from "../src/disputes.js";
import { createRestClient } from "../src/rest.js";
import { TokenCache } from "../src/token.js";

const production: PayPalConfig = {
  env: "production",
  baseUrl: "https://api-m.paypal.com",
  clientId: "id",
  clientSecret: "secret",
};

describe("sandbox-only dispute actions", () => {
  const f = createRestClient(production, new TokenCache(production));

  it("takes the environment from the client", () => {
    expect(f.env).toBe("production");
  });

  it("refuses require-evidence in production", async () => {
    await expect(requireEvidence(f, "PP-D-1", "SELLER_EVIDENCE")).rejects.toThrow(/sandbox only/);
  });

  it("refuses adjudicate in production", async () => {
    await expect(adjudicate(f, "PP-D-1", "SELLER_FAVOR")).rejects.toThrow(/sandbox only/);
  });
});

describe("evidence multipart body", () => {
  const input = {
    evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", documents: [{ name: "a.pdf" }] }],
  };

  it("sends input as a plain string field and files as evidence-file parts", () => {
    const form = evidenceForm(input, [
      { name: "a.pdf", bytes: new Uint8Array([1, 2, 3]) },
      { name: "b.png", bytes: new Uint8Array([4]) },
    ]);
    const entries = [...form.entries()];
    expect(entries.map(([k]) => k)).toEqual(["input", "evidence-file", "evidence-file"]);
    expect(typeof entries[0]?.[1]).toBe("string");
    expect(JSON.parse(entries[0]?.[1] as string)).toEqual(input);
    const files = entries.slice(1).map(([, v]) => v as File);
    expect(files.map((f) => f.name)).toEqual(["a.pdf", "b.png"]);
    expect(files.map((f) => f.type)).toEqual(["application/pdf", "image/png"]);
  });

  it("rejects oversized files and unknown types", () => {
    expect(() =>
      evidenceForm(input, [{ name: "a.pdf", bytes: new Uint8Array(10 * 1024 * 1024 + 1) }]),
    ).toThrow(RangeError);
    expect(() => evidenceForm(input, [{ name: "a.exe", bytes: new Uint8Array(1) }])).toThrow(
      TypeError,
    );
  });
});
