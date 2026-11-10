import { getAddress } from "viem";
import { z } from "zod";

/** The largest bundle Keelson issues or decodes. */
export const MAX_ALIBI_BYTES = 256 * 1024;

/** The media type of an Alibi bundle. */
export const ALIBI_MEDIA_TYPE = "application/vnd.keelson.alibi.v1+json";

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
  eval: z.looseObject({
    v: z.literal("keelson.eval/1"),
    decision: z.enum(["allow", "deny"]),
    context: json,
    fields: z.array(z.json()),
  }),
  mandate: z.strictObject({
    sd_jwt: z.string(),
    disclosures: z.array(z.string()),
    payload_sd: json,
    user_auth: json,
    issuer_jwk: json,
  }),
  manifest: z.strictObject({
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
  }),
  channel3_observation: json.optional(),
  zk: z
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
    .optional(),
  paypal: z.strictObject({
    order_id: z.string().min(1),
    authorization_id: z.string().min(1),
    custom_id: z.string(),
    ref_salt: hex32,
    capture_id: z.string().optional(),
    invoice_id: z.string().optional(),
    /** The payee's PayPal merchant id, which the invoice id's digest binds. */
    merchant_id: z.string().optional(),
  }),
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

export type AlibiBundle = z.infer<typeof alibiSchema>;
export type AlibiReceipt = z.infer<typeof receiptSchema>;
export type AlibiAnchor = z.infer<typeof anchor>;
