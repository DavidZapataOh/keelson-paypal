import { describe, expect, it } from "vitest";
import type { PayPalConfig } from "../src/config.js";
import { adjudicate, requireEvidence } from "../src/disputes.js";
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
