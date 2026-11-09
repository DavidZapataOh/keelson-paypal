import { DST, hashObject, newId } from "@keelson/core";
import { describe, expect, it } from "vitest";
import { parseVerdictRef, requestIdFromDigest } from "../src/ids.ts";
import { verdictRefund } from "../src/refunds.ts";

describe("verdictRefund", () => {
  const id = newId();
  const digest = hashObject(DST.verdict, { verdict_id: id });

  it("refunds the whole capture under the verdict's reference", () => {
    const { paypalRequestId, body } = verdictRefund(id, digest, "Refunded under verdict R61.");
    expect(paypalRequestId).toBe(requestIdFromDigest(digest));
    expect(body.amount).toBeUndefined();
    expect(body.customId).toHaveLength(48);
    expect(parseVerdictRef(body.customId as string)?.id).toBe(id);
    expect(body.noteToPayer).toBe("Refunded under verdict R61.");
  });

  it("keeps the note within PayPal's 255 characters", () => {
    expect(verdictRefund(id, digest, "x".repeat(300)).body.noteToPayer).toHaveLength(255);
  });
});
