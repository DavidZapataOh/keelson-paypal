import { type AlibiBundleV2, leafHashOf, statementOf } from "@keelson/alibi";
import { parseStatementLeaf, ulidOfRequestId } from "@keelson/log";
import { decodeSign1, encodeSign1, leafHash, RECEIPTS, verifyReceipt } from "@keelson/scitt";
import { base64url } from "jose";
import type { StatementFacts } from "./facts.ts";

/** A purchase's SCITT Transparent Statement, as an export carries it. */
export interface AlibiRef {
  /** The Transparent Statement, base64url. */
  statement: string;
  /** SHA-256(0x00 ‖ registered statement), base64url. */
  leafHash: string;
  /** Where the statement is served, `application/scitt-statement+cose`. */
  uri: string;
}

/** Why a statement does not verify: the statement itself, or its receipt. */
export class StatementError extends Error {
  readonly code: "statement" | "receipt";

  constructor(code: StatementError["code"], detail: string) {
    super(`${code}: ${detail}`);
    this.name = "StatementError";
    this.code = code;
  }
}

/**
 * Verifies a purchase's Transparent Statement offline and returns its countersigned facts: the
 * registered statement (its unprotected header emptied) hashes to `ref.leafHash`, is signed by the
 * leg its mode names over both legs' EIP-712 signatures of one digest, and its RFC 9942 receipt
 * verifies under one of `receiptKeys`.
 */
export function verifyStatement(
  ref: AlibiRef,
  o: { receiptKeys: ReadonlyMap<string, Uint8Array> },
): StatementFacts {
  let registered: Uint8Array;
  let receipts: unknown;
  try {
    const s = decodeSign1(base64url.decode(ref.statement));
    receipts = s.unprotected.get(RECEIPTS);
    registered = encodeSign1({ ...s, unprotected: new Map() });
  } catch (e) {
    throw new StatementError("statement", (e as Error).message);
  }
  if (base64url.encode(leafHash(registered)) !== ref.leafHash) {
    throw new StatementError("statement", "the leaf hash is not the statement's");
  }
  let parsed: ReturnType<typeof parseStatementLeaf>;
  try {
    parsed = parseStatementLeaf(registered);
  } catch (e) {
    throw new StatementError("statement", (e as Error).message);
  }
  if (parsed.kind !== "purchase") throw new StatementError("statement", "not a purchase statement");
  if (!Array.isArray(receipts) || receipts.length !== 1 || !(receipts[0] instanceof Uint8Array)) {
    throw new StatementError("receipt", "expected exactly one receipt");
  }
  try {
    verifyReceipt(receipts[0], registered, o.receiptKeys);
  } catch (e) {
    throw new StatementError("receipt", (e as Error).message);
  }
  const c = parsed.claims.countersign;
  return {
    request_id: ulidOfRequestId(c.requestId),
    mandate_hash: c.mandateHash.toLowerCase(),
    cart_hash: c.cartHash.toLowerCase(),
    agent_id: String(c.agentId),
    merchant_id: c.merchantId.toLowerCase(),
    amount_minor: String(c.amount),
    currency: String(c.currency),
    decision: Number(c.decision) === 1 ? "allow" : "deny",
    issued_at: Number(c.issuedAt),
  };
}

/** Where the API serves an Alibi's statement. */
const STATEMENT_URI = "https://api.keelson.finance/v1/alibis";

/** The reference an export carries for a v2 Alibi's Transparent Statement. */
export function refOf(b: AlibiBundleV2): AlibiRef {
  return {
    statement: base64url.encode(statementOf(b)),
    leafHash: base64url.encode(leafHashOf(b)),
    uri: `${STATEMENT_URI}/${b.alibi_id}.cose`,
  };
}
