import { LeafFormatError, parseStatementLeaf } from "@keelson/log";
import { type CheckDef, expect, pass } from "../check.ts";

/**
 * The statement is a SCITT signed statement (RFC 9943) with Keelson's claims, signed with ES256K
 * by the leg its mode names, whose legs' EIP-712 signatures are over its own countersign.
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
    expect(parsed.kind === "purchase", "not a purchase statement", ["/statement"]);
    expect(parsed.alibiId === view.input.alibi_id, "the statement is another Alibi's", [
      "/statement",
      "/alibi_id",
    ]);
    return pass({ kind: parsed.kind, signer: parsed.signer, mode: parsed.claims.mode });
  },
};
