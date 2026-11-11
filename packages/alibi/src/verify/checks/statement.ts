import { LeafFormatError, leafHash, parseStatementLeaf } from "@keelson/log";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type CheckDef, expect, pass } from "../check.ts";

/**
 * The statement is a SCITT signed statement (RFC 9943) with Keelson's claims, signed with ES256K
 * by the leg its mode names, whose legs' EIP-712 signatures are over its own countersign. A bridge
 * statement carries a v1 Alibi's facts: leg A signed it, and the v1 leaf it names as its
 * predecessor is the one the bundle carries.
 */
export const statement: CheckDef = {
  id: "scitt.statement",
  step: 4,
  reads: ["/statement"],
  run(_input, { view }) {
    if (!view) return { status: "absent", reads: [] };
    let parsed: ReturnType<typeof parseStatementLeaf>;
    try {
      parsed = parseStatementLeaf(view.registered);
    } catch (err) {
      const code = err instanceof LeafFormatError ? `${err.code}: ` : "";
      expect(false, `${code}${(err as Error).message}`, ["/statement"]);
    }
    expect(parsed.kind === "purchase" || parsed.kind === "bridge", "not a purchase statement", [
      "/statement",
    ]);
    expect(parsed.alibiId === view.input.alibi_id, "the statement is another Alibi's", [
      "/statement",
      "/alibi_id",
    ]);
    if (parsed.kind === "purchase") {
      return pass({ kind: parsed.kind, signer: parsed.signer, mode: parsed.claims.mode });
    }
    const bridged = parsed.claims.predecessor.toLowerCase();
    if ("attestation" in view.input) {
      const v1 = view.predecessor;
      expect(v1 !== undefined, "the bridged v1 leaf is not in the bundle", ["/predecessor"]);
      expect(
        `0x${bytesToHex(leafHash(v1))}` === bridged,
        "the bundle's v1 leaf is not the one the bridge names",
        ["/statement", "/predecessor"],
      );
    }
    return pass({ kind: parsed.kind, signer: parsed.signer, mode: parsed.claims.mode, bridged });
  },
};
