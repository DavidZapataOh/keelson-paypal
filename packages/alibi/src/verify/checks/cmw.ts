import { readCollection, TEE_EVIDENCE_TYPE, TEE_LEGS_COLLECTION } from "@keelson/scitt";
import { type CheckDef, expect, pass } from "../check.ts";

/** The evidence is an RFC 9999 collection with one evidence record per leg the statement names. */
export const cmw: CheckDef = {
  id: "rats.cmw",
  step: 3,
  reads: ["/attestation"],
  run(_input, { view }) {
    if (!view) return { status: "absent", reads: [] };
    if (!("attestation" in view.input)) return { status: "undisclosed", reads: [] };
    let records: ReturnType<typeof readCollection>;
    try {
      records = readCollection(view.input.attestation);
    } catch (err) {
      expect(false, (err as Error).message, ["/attestation"]);
    }
    expect(view.input.attestation.__cmwc_t === TEE_LEGS_COLLECTION, "collection type", [
      "/attestation",
    ]);
    const legs = view.parsed?.kind === "purchase" ? view.parsed.claims.legs.map((l) => l.kind) : [];
    expect(
      [...records.keys()].join() === legs.join() &&
        [...records.values()].every((r) => r.type === TEE_EVIDENCE_TYPE && r.ind === 4),
      `the evidence is for [${[...records.keys()]}], the statement's legs are [${legs}]`,
      ["/attestation", "/statement"],
    );
    return pass({ legs: legs.join(" ") });
  },
};
