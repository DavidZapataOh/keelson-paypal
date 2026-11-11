import { decodeSign1, RECEIPTS, TST_CTT } from "@keelson/scitt";
import { getAddress } from "viem";
import { z } from "zod";

/** The largest bundle Keelson issues or decodes. */
export const MAX_ALIBI_BYTES = 256 * 1024;

/** The media type of an Alibi bundle. */
export const ALIBI_MEDIA_TYPE = "application/vnd.keelson.alibi.v1+json";
/** The media type of a v2 Alibi bundle: a SCITT transparent statement and its preimages. */
export const ALIBI_MEDIA_TYPE_V2 = "application/vnd.keelson.alibi.v2+json";
/** The media type of a v2 Alibi's public receipt. */
export const RECEIPT_MEDIA_TYPE_V2 = "application/vnd.keelson.alibi-receipt.v2+json";
/** The media type of a SCITT statement file (RFC 9943). */
export const STATEMENT_MEDIA_TYPE = "application/scitt-statement+cose";

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`));
const hex32 = hex(32);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
/** An EIP-55 checksummed address: one spelling per address. */
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => getAddress(a) === a, "not an EIP-55 checksummed address");
const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const json = z.record(z.string(), z.json());
const teeKind = z.enum(["tdx", "nitro"]);

/** The EIP-712 `Countersign` message, every integer as a decimal string. */
const countersignSchema = z.strictObject({
  requestId: hex32,
  mandateHash: hex32,
  mandateCommitment: hex32,
  cartHash: hex32,
  agentId: decimal,
  merchantId: hex32,
  amount: decimal,
  currency: decimal,
  category: decimal,
  evidenceRoot: hex32,
  evalHash: hex32,
  policySetHash: hex32,
  decision: decimal,
  failedFieldsMask: decimal,
  issuedAt: decimal,
  expiresAt: decimal,
});

const anchor = z.strictObject({
  chain_id: z.int().positive(),
  contract: address,
  tx_hash: hex32,
  block_number: decimal,
  anchored_size: decimal,
  anchored_root: hex32,
  /** The signed note carried by the anchor transaction. */
  checkpoint: z.string(),
  consistency: z.strictObject({ from: decimal, to: decimal, proof: z.array(hex32) }),
});

const timestamps = z.array(
  z.strictObject({ tsa: z.string().regex(/^[a-z0-9-]+$/), token: base64 }),
);

const evalSection = z.looseObject({
  v: z.literal("keelson.eval/1"),
  decision: z.enum(["allow", "deny"]),
  context: json,
  fields: z.array(z.json()),
});

const mandateSection = z.strictObject({
  sd_jwt: z.string(),
  disclosures: z.array(z.string()),
  payload_sd: json,
  user_auth: json,
  issuer_jwk: json,
});

const manifestSection = z.strictObject({
  public: z.strictObject({
    v: z.literal("keelson.manifest/1"),
    root: hex32,
    items: z.array(z.strictObject({ type: z.string(), media_type: z.string(), leaf: hex32 })),
  }),
  disclosures: z.array(
    z.strictObject({
      index: z.int().nonnegative(),
      type: z.string(),
      media_type: z.string(),
      content_hash: hex32,
      salt: hex32,
      path: z.array(hex32),
      size: z.int().positive(),
    }),
  ),
});

const zkSection = z
  .strictObject({
    /**
     * Leg A's C1 `mandate_predicate` proof: UltraHonk for the EVM over `C_m, amount, currency,
     * category, merchant_id, now, cart_hash, operator_id`, the countersign's fields.
     */
    c1: z.strictObject({ proof: base64, public_inputs: z.array(hex32).length(8) }).optional(),
    /**
     * The mandate's C3 `anonymous_mandate` proof: UltraHonk for the EVM over `C_m, M mod r,
     * user_set_root, rp_id_hash`, and the transaction that published `user_set_root` to
     * `RegisteredUserSet`.
     */
    c3: z
      .strictObject({
        proof: base64,
        public_inputs: z.array(hex32).length(4),
        root_tx: hex32,
      })
      .optional(),
  })
  .optional();

const cardSection = z
  .strictObject({
    issuer: z.string().min(1),
    /** The issuer's card token; the card number is never kept. */
    card_token: z.string().min(1),
    last_four: z.string().regex(/^[0-9]{4}$/),
    /** The salt of the leaf's payment commitment, which opens to the issuer and card token. */
    ref_salt: hex32,
    /** The issuer-side controls the card was issued with. */
    controls: json,
    /**
     * Each card network authorization of the card, with both legs' signed EIP-712
     * `CardAuthorization`. Reported by the issuer; the legs' signatures are the evidence.
     */
    authorizations: z.array(
      z.strictObject({
        id: z.string().min(1),
        amount_minor: decimal,
        currency: z.string().length(3),
        mcc: z.string().regex(/^[0-9]{4}$/),
        merchant_name: z.string(),
        merchant_country: z.string(),
        /** The acquirer's id for the merchant, which the legs' `merchantHash` commits to. */
        network_id: z.string(),
        approved: z.boolean(),
        verdicts: z.array(
          z.strictObject({
            kind: teeKind,
            authorization: z.record(z.string(), z.string()),
            digest: hex32,
            signature: hex(65),
            signer: address,
          }),
        ),
      }),
    ),
    /** The capture the card network settled, as the issuer reported it. Not signed. */
    settlement: z
      .strictObject({
        transaction_token: z.string(),
        settled_minor: decimal,
        settled_at: z.string(),
      })
      .optional(),
  })
  .optional();

const paypalSection = z
  .strictObject({
    order_id: z.string().min(1),
    authorization_id: z.string().min(1),
    custom_id: z.string(),
    ref_salt: hex32,
    capture_id: z.string().optional(),
    invoice_id: z.string().optional(),
    /** The payee's PayPal merchant id, which the invoice id's digest binds. */
    merchant_id: z.string().optional(),
    /**
     * A live purchase only: the PayPal transaction of the buyer's own payment at the store, as
     * PayPal reported it to the buyer. Not signed.
     */
    transaction_id: z.string().optional(),
    /**
     * A live purchase only: the store's PayPal order as PayPal's checkout stated it right before
     * the pay click. For `AUTHORIZE`, the most PayPal lets the store capture: 115% of the
     * authorization or USD 75 more, whichever is less (115% in other currencies). Not signed.
     */
    store_order: z
      .strictObject({
        intent: z.enum(["SALE", "AUTHORIZE"]),
        payee_id: z.string(),
        capture_ceiling_minor: decimal.optional(),
      })
      .optional(),
  })
  .optional();

export const alibiSchema = z.strictObject({
  type: z.literal(ALIBI_MEDIA_TYPE),
  alibi_id: ulid,
  /** The exact leaf bytes, standard base64. */
  leaf: base64,
  /** The leaf's JSON body. */
  leaf_view: json,
  /** c2sp.org/tlog-proof@v1, its checkpoint carrying the witness cosignatures. */
  tlog_proof: z.string(),
  anchor: anchor.optional(),
  policy: z.strictObject({ origin: z.string(), text: z.string() }),
  timestamps,
  tee: z.strictObject({
    domain: z.strictObject({
      name: z.literal("Keelson"),
      version: z.literal("1"),
      chain_id: z.int().positive(),
      verifying_contract: address,
    }),
    countersign: countersignSchema,
    digest: hex32,
    mode: z.enum(["2of2", "degraded"]),
    signatures: z
      .array(z.strictObject({ kind: teeKind, signer: address, signature: hex(65) }))
      .min(1)
      .max(2),
    attestations: z
      .array(
        z.strictObject({
          kind: teeKind,
          signer: address,
          measurement: z.string(),
          binding: json,
          document: z.json(),
        }),
      )
      .min(1)
      .max(2),
  }),
  /** The `keelson.eval/1` trace. */
  eval: evalSection,
  mandate: mandateSection,
  manifest: manifestSection,
  /** The disclosed `api.cart` item: the cart the countersign's `cartHash` names. */
  cart: json.optional(),
  channel3_observation: json.optional(),
  /** The store's product endpoint notarized with TLSNotary: the disclosed `tlsn.web_fact` item. */
  web_fact: json.optional(),
  /**
   * The disclosed `api.checkout` item: the PayPal amount the legs evaluated, the checkout total
   * the countersign names and its breakdown into items, tax, shipping and discount.
   */
  checkout: json.optional(),
  /**
   * The disclosed `api.fx_reference` item: the reference rates the API issued for the countersign,
   * each held as its digest.
   */
  fx_reference: json.optional(),
  /**
   * A live purchase PayPal converted to the buyer's currency: the countersigned amount, what PayPal
   * charged the buyer at its rate, and the reference rate the evidence binds, with the spread
   * between them. Reported by the agent from PayPal's checkout. Not signed.
   */
  conversion: z
    .strictObject({
      v: z.literal("keelson.conversion/1"),
      merchant: z.strictObject({ currency: z.string(), value: z.string() }),
      buyer: z.strictObject({ currency: z.string(), value: z.string() }),
      rate: z.string(),
      reference: z.strictObject({
        rate: z.string(),
        provider: z.string(),
        source: z.string(),
        as_of: z.string(),
      }),
      spread_bps: z.int().nonnegative(),
      max_spread_bps: z.int().nonnegative(),
      locale: z.string(),
    })
    .optional(),
  zk: zkSection,
  /** A card purchase: the single-use card, every card authorization and the settled capture. */
  card: cardSection,
  /** A PayPal purchase: its order, authorization, capture and invoice. */
  paypal: paypalSection,
});

/** What the public log already publishes about one Alibi. */
export const receiptSchema = z.strictObject({
  alibi_id: ulid,
  leaf: base64,
  /** Unpadded base64url, as in the verify URL. */
  leaf_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  tlog_proof: z.string(),
  anchor: anchor.optional(),
  timestamps,
});

/** A transparent statement: tag 18, unprotected labels limited to receipts (394) and RFC 3161 tokens (270). */
const transparentStatement = base64.superRefine((b64, ctx) => {
  try {
    const s = decodeSign1(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const extra = [...s.unprotected.keys()].filter((k) => k !== RECEIPTS && k !== TST_CTT);
    if (extra.length)
      ctx.addIssue({ code: "custom", message: `unprotected label ${extra[0]} is not allowed` });
    const receipts = s.unprotected.get(RECEIPTS);
    if (receipts !== undefined && (!Array.isArray(receipts) || receipts.length > 1)) {
      ctx.addIssue({ code: "custom", message: "at most one receipt" });
    }
    const tokens = s.unprotected.get(TST_CTT);
    if (tokens !== undefined && (!Array.isArray(tokens) || tokens.length > 4)) {
      ctx.addIssue({ code: "custom", message: "at most four RFC 3161 tokens" });
    }
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
  }
});

const cmwRecord = z.tuple([
  z.string(),
  z.string().regex(/^[A-Za-z0-9_-]+$/),
  z.int().min(1).max(31),
]);

export const alibiSchemaV2 = z.strictObject({
  type: z.literal(ALIBI_MEDIA_TYPE_V2),
  alibi_id: ulid,
  /** The transparent statement (RFC 9943), standard base64. */
  statement: transparentStatement,
  /** c2sp.org/tlog-proof@v1 of the same leaf, its checkpoint carrying the witness cosignatures. */
  tlog_proof: z.string(),
  anchor: anchor.optional(),
  policy: z.strictObject({ origin: z.string(), text: z.string() }),
  /** The legs' evidence: an RFC 9999 JSON collection. */
  attestation: z.strictObject({
    __cmwc_t: z.string(),
    tdx: cmwRecord,
    nitro: cmwRecord.optional(),
  }),
  eval: evalSection,
  mandate: mandateSection,
  manifest: manifestSection,
  cart: json.optional(),
  channel3_observation: json.optional(),
  web_fact: json.optional(),
  checkout: json.optional(),
  zk: zkSection,
  card: cardSection,
  paypal: paypalSection,
});

export const receiptSchemaV2 = z.strictObject({
  type: z.literal(RECEIPT_MEDIA_TYPE_V2),
  alibi_id: ulid,
  statement: transparentStatement,
  tlog_proof: z.string().optional(),
  anchor: anchor.optional(),
});

export type AlibiBundle = z.infer<typeof alibiSchema>;
export type AlibiBundleV2 = z.infer<typeof alibiSchemaV2>;
export type AlibiReceiptV2 = z.infer<typeof receiptSchemaV2>;
/** Any Alibi or public receipt, of either version. */
export type AnyAlibi = AlibiBundle | AlibiReceipt | AlibiBundleV2 | AlibiReceiptV2;
export type AlibiReceipt = z.infer<typeof receiptSchema>;
export type AlibiAnchor = z.infer<typeof anchor>;
