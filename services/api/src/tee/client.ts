import { Agent, fetch as undiciFetch } from "undici";
import { type Hex, hexToBytes } from "viem";
import { z } from "zod";
import { getCollateral, type SignerAttestation } from "./attest.ts";
import type { StatementAsk } from "./statements.ts";

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
  /** The same statement proved for recursion; legs that predate it send none. */
  recursive_proof: z.base64().optional(),
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
  /** The purchase's SCITT statement, standard base64; only legs that sign statements send it. */
  statement: z.base64().optional(),
});
export type Countersigned = z.infer<typeof CountersignedSchema>;

const CardAuthorizedSchema = z.strictObject({
  authorization: z.strictObject({
    requestId: Hex32,
    countersignDigest: Hex32,
    authorizationHash: Hex32,
    merchantHash: Hex32,
    mcc: z.string(),
    country: hex(/^0x[0-9a-f]{4}$/),
    amount: z.string(),
    currency: z.string(),
    decision: z.string(),
    failedMask: z.string(),
    issuedAt: z.string(),
  }),
  chain_id: z.number(),
  digest: Hex32,
  signature: Hex65,
  signer: Address,
  tee: z.number(),
});
export type CardAuthorized = z.infer<typeof CardAuthorizedSchema>;

const StatementSignedSchema = z.strictObject({ statement: z.base64() });
export type StatementSigned = z.infer<typeof StatementSignedSchema>;

const SettlementObservationSchema = z.strictObject({
  transaction: z.base64(),
  card: z.base64(),
  observed_at: z.number(),
});
export type SettlementObservation = z.infer<typeof SettlementObservationSchema>;

const CardSettledSchema = z.strictObject({
  settlement: z.strictObject({
    requestId: Hex32,
    cardRef: Hex32,
    transactionHash: Hex32,
    settledMinor: z.string(),
    currency: z.string(),
    status: z.string(),
    settledAt: z.string(),
    observedAt: z.string(),
  }),
  digest: Hex32,
  signature: Hex65,
  signer: Address,
  observation: SettlementObservationSchema,
  statement: z.base64(),
});
export type CardSettled = z.infer<typeof CardSettledSchema>;

/** `POST /v1/statements/card-authorization`: a decision both legs signed, as its own statement. */
export interface CardStatementRequest {
  authorization: Record<string, string>;
  signatures: { tdx: Hex; nitro?: Hex };
  measurements: { tdx: Hex; nitro?: Hex };
  parent: Hex;
  issuer: string;
  card_token: string;
  ref_salt: Hex;
  chain_id?: number;
}

/** `POST /v1/card/settlement`: leg A reads the settlement from the issuer; leg B checks its reading. */
export interface CardSettlementRequest {
  request_id: string;
  transaction_token: string;
  card_token: string;
  issuer: string;
  parent: Hex;
  ref_salt: Hex;
  measurements: { tdx: Hex; nitro?: Hex };
  observation?: SettlementObservation;
  leg_a?: { signer: string; signature: Hex };
  chain_id?: number;
}

/** `POST /v1/statements/bridge`: a v1 Alibi carried into a SCITT statement by leg A. */
export interface BridgeRequest {
  leaf: string;
  tlog_proof: string;
  countersign: CountersignJson;
  chain_id?: number;
}

/** A card network authorization, as the card issuer's real-time request reported it. */
export interface CardNetworkAuthorization {
  id: string;
  amount_minor: number;
  currency: string;
  mcc: string;
  merchant_name: string;
  merchant_country: string;
  network_id: string;
}

export interface CardAuthorizeRequest {
  countersign: CountersignJson;
  signature: Hex;
  payload_sd: unknown;
  disclosures: string[];
  /** The mandate's decoy salts; sent only when it has any, to legs that resolve them. */
  decoy_salts?: string[];
  authorization: CardNetworkAuthorization;
}

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
  /** 1 on a leg that signs SCITT statements. */
  statements: z.number().optional(),
  /** 1 on a leg that resolves decoy digests by their salts. */
  decoys: z.number().optional(),
  /** 1 on a leg that checks the mandate status list. */
  status_list: z.number().optional(),
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
  /** Asks for the purchase's SCITT statement; sent only to legs that sign them. */
  statement?: StatementAsk;
  /** The mandate's decoy salts; sent only when it has any, to legs that resolve them. */
  decoy_salts?: string[];
  /** The current status list token, for a mandate with a status list entry. */
  status_list?: string;
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
  /** The mandate's decoy salts; sent only when it has any, to legs that resolve them. */
  decoy_salts?: string[];
  /** The mandate's index in the status list, once both legs check it. */
  status_idx?: number;
}

interface ChainBlock {
  number: number | bigint;
  hash: Hex;
}

/** Attestation reads and refreshes are not on the countersign path; a refresh takes about 2 s. */
const ADMIN_TIMEOUT_MS = 15_000;
/**
 * The legs keep an idle connection open for at least 45 s, while Node's fetch drops it after 4 s,
 * so a call after a pause paid a new TLS handshake through leg A's gateway (about 380 ms).
 */
const legConnections = new Agent({ keepAliveTimeout: 60_000 });
/** Leg A waits up to 8 s for a proof still being made. */
const C1_TIMEOUT_MS = 10_000;

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
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(new URL(path, this.url), {
        dispatcher: legConnections,
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

  /**
   * Leg A's C1 proof of the ALLOW it answered under `requestId`, made after the countersign;
   * `null` when it has none to give.
   */
  async c1(requestId: string): Promise<ZkProof | null> {
    try {
      return this.parse(
        ZkProofSchema,
        await this.call("GET", `/v1/c1/${encodeURIComponent(requestId)}`, undefined, {
          timeoutMs: C1_TIMEOUT_MS,
        }),
      );
    } catch (err) {
      if (err instanceof LegError && err.code === "no_proof") return null;
      throw err;
    }
  }

  async verdict(req: VerdictRequest): Promise<VerdictSigned> {
    return this.parse(VerdictSignedSchema, await this.call("POST", "/v1/verdict", req));
  }

  /** Checks a card authorization against this leg's ALLOW; within the card issuer's deadline. */
  async cardAuthorize(req: CardAuthorizeRequest, timeoutMs: number): Promise<CardAuthorized> {
    return this.parse(
      CardAuthorizedSchema,
      await this.call("POST", "/v1/card/authorize", req, { timeoutMs }),
    );
  }

  async cardStatement(req: CardStatementRequest): Promise<StatementSigned> {
    return this.parse(
      StatementSignedSchema,
      await this.call("POST", "/v1/statements/card-authorization", req),
    );
  }

  async cardSettlement(req: CardSettlementRequest): Promise<CardSettled> {
    return this.parse(CardSettledSchema, await this.call("POST", "/v1/card/settlement", req));
  }

  /** `POST /v1/status/sign` on leg A: the status list token over `lst`. */
  async signStatus(req: { uri: string; lst: string }): Promise<{ token: string }> {
    return this.parse(
      z.strictObject({ token: z.string() }),
      await this.call("POST", "/v1/status/sign", req),
    );
  }

  async bridge(req: BridgeRequest): Promise<StatementSigned> {
    return this.parse(StatementSignedSchema, await this.call("POST", "/v1/statements/bridge", req));
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
