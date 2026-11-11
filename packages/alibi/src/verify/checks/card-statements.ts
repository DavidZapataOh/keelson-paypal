import { fromHex } from "@keelson/core";
import { cardRefCommit, type ParsedStatement, parseStatementLeaf } from "@keelson/log";
import { decodeSign1, encodeSign1, leafHash, RECEIPTS, verifyReceipt } from "@keelson/scitt";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fromBase64 } from "../../b64.ts";
import type { AlibiBundleV2 } from "../../schema.ts";
import { type CheckDef, expect, pass } from "../check.ts";

type CardV2 = NonNullable<AlibiBundleV2["card"]>;

/**
 * Each card authorization decision and the settlement are statements of their own: each verifies,
 * has a receipt under a pinned key, names this Alibi's leaf as its parent and commits to this card;
 * every authorization shown has its decision statement, and the settlement shown is the one the
 * legs read from the issuer, byte for byte.
 */
export const cardStatements: CheckDef = {
  id: "card.statements",
  step: 7,
  reads: ["/card"],
  run(_input, { view, receiptKeys }) {
    if (!view) return { status: "absent", reads: [] };
    if (!("attestation" in view.input)) return { status: "undisclosed", reads: [] };
    const card = view.input.card as CardV2 | undefined;
    if (!card) return { status: "absent", reads: [] };
    const parent = `0x${bytesToHex(leafHash(view.registered))}`;
    const cardRef = cardRefCommit(
      fromHex(card.ref_salt),
      card.issuer,
      card.card_token,
    ).toLowerCase();
    const purchaseLegs =
      view.parsed?.kind === "purchase"
        ? view.parsed.claims.legs.map((l) => l.signer.toLowerCase())
        : [];
    const parsed: Extract<ParsedStatement, { card: unknown }>[] = [];
    for (const [i, b64] of card.statements.entries()) {
      const at = [`/card/statements/${i}`];
      const transparent = decodeSign1(fromBase64(b64));
      const registered = encodeSign1({ ...transparent, unprotected: new Map() });
      let p: ParsedStatement;
      try {
        p = parseStatementLeaf(registered);
      } catch (err) {
        expect(false, `statement ${i}: ${(err as Error).message}`, at);
      }
      expect(
        p.kind === "card-authorization" || p.kind === "card-settlement",
        `statement ${i} is not a card statement`,
        at,
      );
      expect(
        p.alibiId === view.input.alibi_id && p.card.parent.toLowerCase() === parent,
        `statement ${i} is another purchase's`,
        at,
      );
      const ref = p.kind === "card-authorization" ? p.card.cardRef : p.card.settlement.cardRef;
      expect(ref.toLowerCase() === cardRef, `statement ${i} commits to another card`, [
        ...at,
        "/card/ref_salt",
        "/card/card_token",
      ]);
      expect(
        p.card.legs.every((l, k) => l.signer.toLowerCase() === purchaseLegs[k]),
        `statement ${i} is signed by legs that did not countersign the purchase`,
        at,
      );
      const receipts = transparent.unprotected.get(RECEIPTS);
      expect(Array.isArray(receipts) && receipts.length > 0, `statement ${i} has no receipt`, at);
      try {
        verifyReceipt((receipts as Uint8Array[])[0] as Uint8Array, registered, receiptKeys);
      } catch (err) {
        expect(false, `statement ${i}'s receipt: ${(err as Error).message}`, at);
      }
      parsed.push(p);
    }
    for (const [i, a] of card.authorizations.entries()) {
      const facts = a.verdicts[0]?.authorization;
      const matches = parsed.filter(
        (p) =>
          p.kind === "card-authorization" &&
          facts !== undefined &&
          p.card.authorization.authorizationHash === facts.authorizationHash &&
          String(p.card.authorization.decision) === facts.decision &&
          String(p.card.authorization.amount) === a.amount_minor,
      );
      expect(matches.length === 1, `authorization ${i} has ${matches.length} decision statements`, [
        `/card/authorizations/${i}`,
        "/card/statements",
      ]);
    }
    const settlements = parsed.filter((p) => p.kind === "card-settlement");
    if (card.settlement) {
      expect(settlements.length === 1, "the settlement has no statement", [
        "/card/settlement",
        "/card/statements",
      ]);
      const t = (settlements[0] as Extract<ParsedStatement, { kind: "card-settlement" }>).card
        .settlement;
      expect(
        t.transactionHash.toLowerCase() ===
          `0x${bytesToHex(sha256(fromBase64(card.settlement.raw)))}`,
        "the issuer's response is not the one the legs read",
        ["/card/settlement/raw"],
      );
      expect(
        String(t.settledMinor) === card.settlement.settled_minor,
        "settled_minor is not the legs'",
        ["/card/settlement/settled_minor"],
      );
    }
    return pass({ statements: String(parsed.length) });
  },
};
