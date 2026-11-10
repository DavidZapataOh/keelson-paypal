import { type Hex, hexToBytes } from "viem";
import { z } from "zod";
import { getCollateral, type SignerAttestation } from "./attest.ts";

const hex = (pattern: RegExp) => z.custom<Hex>((v) => typeof v === "string" && pattern.test(v));
const Hex32 = hex(/^0x[0-9a-f]{64}$/);
const Hex65 = hex(/^0x[0-9a-f]{130}$/);
const Address = hex(/^0x[0-9a-fA-F]{40}$/);

const PayPalObservationSchema = z.strictObject({
  authorization_id: z.string(),
  /** Absent from legs that predate binding a hold to its order. */
  order_id: z.string().optional(),
  status: z.string(),
  currency: z.string(),
  authorized_minor: z.number().int(),
  captured_minor: z.number().int(),
  /** Absent from legs that predate counting every capture of the order. */
  order_captured_minor: z.number().int().optional(),
  payee_merchant_id: z.string(),
  expires_at_ms: z.number().int(),
  custom_id: z.string(),
  raw_authorization: z.string(),
  raw_order: z.string(),
  read_at_ms: z.number().int(),
});

/**
 * What leg A observed and leg B signs over, forwarded to leg B as received. It has exactly the
 * engine's fields: nothing leg A did not read may ride along.
 *
 * @internal
 */
export const ObservationSchema = z.strictObject({
  now_ms: z.number().int(),
  budget_left_minor: z.number().int(),
  user_key: z.strictObject({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string(),
    y: z.string(),
    kid: z.string().optional(),
  }),
  paypal: PayPalObservationSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

const CountersignJsonSchema = z.strictObject({
  requestId: Hex32,
  mandateHash: Hex32,
  mandateCommitment: Hex32,
  cartHash: Hex32,
  agentId: z.string(),
  merchantId: Hex32,
  amount: z.string(),
  currency: z.string(),
  category: z.string(),
  evidenceRoot: Hex32,
  evalHash: Hex32,
  policySetHash: Hex32,
  decision: z.string(),
  failedFieldsMask: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
});
export type CountersignJson = z.infer<typeof CountersignJsonSchema>;

/** A C1 `mandate_predicate` proof: UltraHonk for the EVM and its eight public inputs. */
const ZkProofSchema = z.strictObject({
  proof: z.base64(),
  public_inputs: z.array(Hex32).length(8),
});
export type ZkProof = z.infer<typeof ZkProofSchema>;

const CountersignedSchema = z.strictObject({
  countersign: CountersignJsonSchema,
  digest: Hex32,
  signature: Hex65,
  signer: Address,
  tee: z.number(),
  trace_jcs: z.string(),
  observation: ObservationSchema,
  /** Leg A's proof of an ALLOW whose request carried the sealed salt. */
  c1: ZkProofSchema.optional(),
});
export type Countersigned = z.infer<typeof CountersignedSchema>;

const MandateIssuedSchema = z.strictObject({
  mandate_hash: Hex32,
  user_credential: z.string(),
  open_mandate: z.string(),
  sealed_salt: z.string(),
});
export type MandateIssued = z.infer<typeof MandateIssuedSchema>;

const HealthSchema = z.looseObject({
  tee: z.number(),
  signer: Address,
  boot_epoch: z.number(),
  oci_digest: z.string(),
  now_ms: z.number(),
});
type Health = z.infer<typeof HealthSchema>;

const BindingSchema = z.object({
  chainId: z.string(),
  bondVault: Address,
  teeKind: z.union([z.literal(1), z.literal(2)]),
  signer: Address,
  policySetHash: Hex32,
  engineBuildId: Hex32,
  bootEpoch: z.string(),
  issuerJwkThumbprint: Hex32,
});
const BlockSchema = z.object({ number: z.union([z.number(), z.string()]), hash: Hex32 });

const AttestationSchema = z.discriminatedUnion("tee", [
  z.looseObject({
    tee: z.literal("tdx"),
    quote: z.string(),
    event_log: z.array(
      z.object({
        imr: z.number(),
        event_type: z.number(),
        digest: z.string(),
        event: z.string(),
        event_payload: z.string(),
      }),
    ),
    binding: BindingSchema,
    block: BlockSchema,
  }),
  z.looseObject({
    tee: z.literal("nitro"),
    document: z.string(),
    binding: BindingSchema,
    block: BlockSchema,
  }),
]);

const VerdictJsonSchema = z.strictObject({
  disputeId: Hex32,
  coverageId: Hex32,
  agentId: z.string(),
  payee: Address,
  amount: z.string(),
  ruleId: z.string(),
  liable: z.string(),
  fieldId: z.string(),
  evidenceHash: Hex32,
  inputsHash: Hex32,
  policySetHash: Hex32,
  checkpointRoot: Hex32,
  issuedAt: z.string(),
  deadline: z.string(),
});

export type VerdictJson = z.infer<typeof VerdictJsonSchema>;

const VerdictSignedSchema = z.strictObject({
  verdict: VerdictJsonSchema,
  chain_id: z.number().int(),
  digest: Hex32,
  signature: Hex65,
  signer: Address,
  tee: z.number(),
});

export type VerdictSigned = z.infer<typeof VerdictSignedSchema>;

/** The body of `POST /v1/verdict`: the dispute's facts and the verdict's settlement terms. */
export interface VerdictRequest {
  facts: Record<string, string | boolean>;
  input: {
    paypal_dispute_id: string;
    coverage_id: Hex;
    agent_id: string;
    payee: Hex;
    amount: string;
    failed_fields: { green?: number; amber?: number; gray?: number };
    evidence_hash: Hex;
    checkpoint_root: Hex;
    issued_at: number;
    deadline: number;
  };
  chain_id?: number;
}

/** The body of `POST /v1/countersign` on a leg, as the engine reads it. */
export interface CountersignRequest {
  request_id: string;
  closed_mandate: string;
  sub: string;
  cart: unknown;
  unit: unknown;
  evidence: Record<string, string[]>;
  evidence_root: Hex;
  /** Leg A reads this PayPal authorization; leg B takes `observation` instead. */
  authorization_id?: string;
  observation?: Observation;
  /** The mandate's commitment salt as leg A sealed it, standard base64; leg A proves C1 with it. */
  sealed_salt?: string;
}

/** The body of `POST /v1/mandates/register` on leg A. */
interface RegisterMandate {
  sub: string;
  payload_sd: unknown;
  disclosures: string[];
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string };
  /** The commitment salt, 16 bytes of lowercase hex. */
  salt: Hex;
  user_credential?: string;
}

interface ChainBlock {
  number: number | bigint;
  hash: Hex;
}

/** Attestation reads and refreshes are not on the countersign path; a refresh takes about 2 s. */
const ADMIN_TIMEOUT_MS = 15_000;

export class LegError extends Error {
  readonly leg: "a" | "b";
  readonly kind: "timeout" | "unreachable" | "problem";
  readonly code: string | undefined;
  readonly status: number | undefined;

  constructor(
    leg: "a" | "b",
    kind: "timeout" | "unreachable" | "problem",
    code?: string,
    status?: number,
  ) {
    super(`leg ${leg}: ${kind}${code ? ` (${code})` : ""}`);
    this.name = "LegError";
    this.leg = leg;
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

/** A client for one TEE leg. Requests are never retried. */
export class LegClient {
  readonly leg: "a" | "b";
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(leg: "a" | "b", url: string, token: string, timeoutMs: number) {
    this.leg = leg;
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { auth?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const { auth = true, timeoutMs = this.timeoutMs } = options;
    let res: Response;
    try {
      res = await fetch(new URL(path, this.url), {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      throw new LegError(this.leg, timedOut ? "timeout" : "unreachable");
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new LegError(this.leg, "timeout");
      }
      throw new LegError(this.leg, res.ok ? "unreachable" : "problem", undefined, res.status);
    }
    if (!res.ok) {
      const code = z.object({ code: z.string() }).safeParse(json);
      throw new LegError(
        this.leg,
        "problem",
        code.success ? code.data.code : undefined,
        res.status,
      );
    }
    return json;
  }

  private parse<T>(schema: z.ZodType<T>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new LegError(this.leg, "problem", "malformed_response");
    return parsed.data;
  }

  async countersign(req: CountersignRequest): Promise<Countersigned> {
    return this.parse(CountersignedSchema, await this.call("POST", "/v1/countersign", req));
  }

  async verdict(req: VerdictRequest): Promise<VerdictSigned> {
    return this.parse(VerdictSignedSchema, await this.call("POST", "/v1/verdict", req));
  }

  async registerMandate(req: RegisterMandate): Promise<MandateIssued> {
    return this.parse(MandateIssuedSchema, await this.call("POST", "/v1/mandates/register", req));
  }

  async health(): Promise<Health> {
    return this.parse(
      HealthSchema,
      await this.call("GET", "/v1/health", undefined, { auth: false }),
    );
  }

  /**
   * The leg's served attestation. For a TDX quote the Intel collateral is added so a verifier
   * needs no network.
   */
  async attestation(): Promise<SignerAttestation> {
    const att = this.parse(
      AttestationSchema,
      await this.call("GET", "/v1/attestation", undefined, {
        auth: false,
        timeoutMs: ADMIN_TIMEOUT_MS,
      }),
    );
    if (att.tee === "nitro") return att as SignerAttestation;
    const { event_log, ...rest } = att;
    const collateral = await getCollateral(hexToBytes(`0x${att.quote}`));
    // Intel terminates the chain with a NUL, which JSON stores such as jsonb cannot hold.
    const chain = (collateral as { pck_certificate_chain?: string }).pck_certificate_chain;
    if (chain)
      (collateral as { pck_certificate_chain?: string }).pck_certificate_chain = chain.replace(
        /\0+$/,
        "",
      );
    return { ...rest, eventLog: event_log, collateral } as SignerAttestation;
  }

  /**
   * Has the leg attest its signer over a newer block. Leg B cannot read the chain, so it takes
   * `block`; leg A reads the chain itself.
   */
  async refresh(block?: ChainBlock): Promise<void> {
    await this.call(
      "POST",
      "/v1/attestation/refresh",
      this.leg === "b" && block
        ? { block: { number: Number(block.number), hash: block.hash } }
        : undefined,
      { timeoutMs: ADMIN_TIMEOUT_MS },
    );
  }
}
