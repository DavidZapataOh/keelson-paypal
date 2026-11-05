import { describe, expect, it, vi } from "vitest";
import { adjudicate, requireEvidence } from "../src/disputes.js";
import type { PayPalFetch } from "../src/rest.js";

describe("sandbox-only dispute actions", () => {
  const f = vi.fn() as unknown as PayPalFetch;

  it("refuses require-evidence in production", async () => {
    await expect(
      requireEvidence(f, { env: "production" }, "PP-D-1", "SELLER_EVIDENCE"),
    ).rejects.toThrow(/sandbox only/);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses adjudicate in production", async () => {
    await expect(adjudicate(f, { env: "production" }, "PP-D-1", "SELLER_FAVOR")).rejects.toThrow(
      /sandbox only/,
    );
    expect(f).not.toHaveBeenCalled();
  });
});
