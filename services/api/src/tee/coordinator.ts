import { DST, type Json, sha256, toHex, ulidToBytes32 } from "@keelson/core";
import {
  CHAIN_IDS,
  type Countersign,
  countersignDigest,
  keelsonDomain,
} from "@keelson/core/eip712";
import { and, type Db, eq, teeSignatures } from "@keelson/db";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { type Address, getAddress, type Hex, hexToBytes, recoverAddress } from "viem";
import { publishEvent } from "../events.ts";
import {
  type Countersigned,
  type CountersignJson,
  type CountersignRequest,
  LegError,
  type Observation,
} from "./client.ts";
import { activeSigner, type Leg, refreshLeg, revokeSigner, type TeeConfig } from "./signers.ts";
import { chosenStatement, statementAsk, supportsStatements } from "./statements.ts";

/** The channel the coordinator raises its alarms on. */
const TEE_EVENTS = "public:tee";

type CoordinatorSlug =
  | "tee-unavailable"
  | "paypal-unavailable"
  | "tee-divergence"
  | "tee-unregistered-signer"
  | "tee-contradiction";

/** A refusal to countersign; it never carries a signature. */
export class CoordinatorError extends Error {
  readonly slug: CoordinatorSlug;
  readonly status: 502 | 503;

  constructor(slug: CoordinatorSlug, message: string, status: 502 | 503) {
    super(message);
    this.name = "CoordinatorError";
    this.slug = slug;
    this.status = status;
  }
}

/** What a countersign must say about the purchase it was requested for. */
export interface CountersignExpectation {
  cartHash: Hex;
  amount: bigint;
  merchantId: Hex;
  /** ISO 4217 numeric code. */
  currency: number;
  mandateHash: Hex;
}

export interface CoordinatorDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  tee: TeeConfig;
  /** The `verifyingContract` of the EIP-712 domain both legs were booted with. */
  verifyingContract: Address;
  now?: () => Date;
}

interface CoordinatedCountersign {
  mode: "2of2" | "degraded";
  countersign: CountersignJson;
  digest: Hex;
  signatures: { tdx: Hex; nitro: Hex | null };
  signers: { tdx: Address; nitro: Address | null };
  trace: Json;
  observation: Observation;
  /** The purchase's SCITT statement, standard base64, when the legs that answered sign them. */
  statement: string | null;
}

const DOMAIN_CHAIN = CHAIN_IDS.arbitrumSepolia;

const HEALTH_TTL_MS = 60_000;
const health = new Map<Leg, { supports: boolean; at: number }>();

/**
 * Whether a leg signs SCITT statements, from its `/v1/health` (cached a minute, read again after
 * any failure): a leg on an older engine refuses a request carrying the field.
 */
async function legSupportsStatements(deps: CoordinatorDeps, leg: Leg): Promise<boolean> {
  const cached = health.get(leg);
  if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.supports;
  try {
    const supports = supportsStatements(await deps.tee.client[leg].health());
    health.set(leg, { supports, at: Date.now() });
    return supports;
  } catch {
    health.delete(leg);
    return false;
  }
}

/** The 32-byte measurement of a `tdx:<hex>` or `nitro:<hex>` id. */
const measurementHex = (id: string | undefined) =>
  id && /^(tdx|nitro):[0-9a-f]{64}$/.test(id) ? (`0x${id.split(":")[1]}` as Hex) : null;

/** The typed `Countersign` message of its JSON form. */
export function countersignMessage(c: CountersignJson): Countersign {
  return {
    requestId: c.requestId,
    mandateHash: c.mandateHash,
    mandateCommitment: c.mandateCommitment,
    cartHash: c.cartHash,
    agentId: BigInt(c.agentId),
    merchantId: c.merchantId,
    amount: BigInt(c.amount),
    currency: Number(c.currency),
    category: Number(c.category),
    evidenceRoot: c.evidenceRoot,
    evalHash: c.evalHash,
    policySetHash: c.policySetHash,
    decision: Number(c.decision),
    failedFieldsMask: Number(c.failedFieldsMask),
    issuedAt: Number(c.issuedAt),
    expiresAt: Number(c.expiresAt),
  };
}

const unreachable = (err: unknown): boolean =>
  err instanceof LegError && (err.kind === "timeout" || err.kind === "unreachable");

/** Leg A is down on a timeout, a refused connection or a server error. */
const down = (err: unknown): boolean =>
  unreachable(err) || (err instanceof LegError && (err.status ?? 0) >= 500);

const divergence = () => new CoordinatorError("tee-divergence", "The signers disagree.", 502);

/** Leg B's refusals that say nothing about the request: its clock, its load or its boot. */
const NOT_JUDGED = new Set(["clock_skew", "busy", "not_ready"]);

/** Leg B answered without judging the request, so a retry may be countersigned by both legs. */
const notJudged = (err: unknown): boolean =>
  err instanceof LegError &&
  err.kind === "problem" &&
  (err.code === undefined ? (err.status ?? 0) >= 500 : NOT_JUDGED.has(err.code));

const readmitting = new Map<Leg, Promise<void>>();

/** How long a request waits for a restarted leg's new signer to be attested and admitted. */
const READMIT_WAIT_MS = 15_000;

/**
 * Admits the leg's new signer after a restart, once per leg at a time, and waits at most
 * {@link READMIT_WAIT_MS} for it.
 */
async function readmit(deps: CoordinatorDeps, leg: Leg): Promise<void> {
  let pending = readmitting.get(leg);
  if (!pending) {
    pending = refreshLeg(deps.db, leg, deps.tee)
      .then(() => undefined)
      .catch((err: unknown) => deps.log.warn({ err, leg }, "tee signer could not be admitted"))
      .finally(() => readmitting.delete(leg));
    readmitting.set(leg, pending);
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    pending,
    new Promise((resolve) => {
      timer = setTimeout(resolve, READMIT_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

function emit(deps: CoordinatorDeps, type: string, requestId: string, extra: Json = {}): void {
  void publishEvent(deps, TEE_EVENTS, requestId, { type, requestId, ...(extra as object) }).catch(
    (err: unknown) => deps.log.error({ err, type, requestId }, "tee event could not be published"),
  );
}

const evalHash = (jcs: Uint8Array): Hex => {
  const prefix = new TextEncoder().encode(DST.eval);
  const input = new Uint8Array(prefix.length + 1 + jcs.length);
  input.set(prefix, 0);
  input.set(jcs, prefix.length + 1);
  return toHex(sha256(input));
};

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Checks that a leg's answer is for this request and purchase, that its trace is the one it
 * hashed, that it has not expired, and that its digest is the one its registered signer signed.
 */
async function checked(
  deps: CoordinatorDeps,
  leg: Leg,
  answer: Countersigned,
  req: CountersignRequest,
  want: CountersignExpectation,
): Promise<{ signer: Address; digest: Hex; signature: Hex; trace: Json }> {
  const requestId = req.request_id;
  const refuse = (what: string) => {
    deps.log.warn({ leg, requestId, what }, "tee answer refused");
    emit(deps, "tee.divergence", requestId, { leg, what });
    return divergence();
  };
  const c = answer.countersign;
  let typed: Countersign;
  try {
    typed = countersignMessage(c);
  } catch {
    throw refuse("the countersign has a malformed number");
  }
  if (!sameHex(c.requestId, ulidToBytes32(requestId))) throw refuse("another request");
  if (
    !sameHex(c.cartHash, want.cartHash) ||
    typed.amount !== want.amount ||
    !sameHex(c.merchantId, want.merchantId) ||
    typed.currency !== want.currency ||
    !sameHex(c.mandateHash, want.mandateHash)
  ) {
    throw refuse("another purchase");
  }
  if (typed.expiresAt <= Math.floor((deps.now?.() ?? new Date()).getTime() / 1000)) {
    throw refuse("expired");
  }
  const jcs = Buffer.from(answer.trace_jcs, "base64");
  let trace: Json;
  try {
    trace = JSON.parse(jcs.toString("utf8")) as Json;
  } catch {
    throw refuse("the trace is not JSON");
  }
  if (!sameHex(evalHash(jcs), c.evalHash)) throw refuse("the trace is not the one hashed");

  const digest = countersignDigest(typed, keelsonDomain(DOMAIN_CHAIN, deps.verifyingContract));
  const unregistered = async (why: string) => {
    deps.log.warn({ leg, requestId, why }, "tee signer refused");
    emit(deps, "tee.unregistered", requestId, { leg });
    return new CoordinatorError(
      "tee-unregistered-signer",
      "A countersignature is not from a registered signer.",
      502,
    );
  };
  if (digest.toLowerCase() !== answer.digest) {
    throw await unregistered("the digest is not that of the countersign");
  }
  const signature = answer.signature as Hex;
  const recovered = getAddress(await recoverAddress({ hash: digest, signature }));
  if (recovered !== getAddress(answer.signer)) {
    throw await unregistered("the signature is not the answer's signer's");
  }
  let registered = await activeSigner(deps.db, leg === "a" ? 1 : 2);
  if (recovered !== registered?.address) {
    // A restarted leg has a new signer the registry has not seen: its attestation is verified
    // and the signer admitted before the answer counts. One the registry knows is refused.
    const known = await deps.db.query.teeSigners.findFirst({
      columns: { address: true },
      where: (t, { eq }) => eq(t.address, Buffer.from(hexToBytes(recovered))),
    });
    if (!known) {
      await readmit(deps, leg);
      registered = await activeSigner(deps.db, leg === "a" ? 1 : 2);
    }
    if (recovered !== registered?.address) {
      throw await unregistered("the signer is not the registered one");
    }
  }
  return { signer: recovered, digest, signature, trace };
}

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * Records what each signer signed for the request. A signer that already signed another digest
 * for it is revoked and nothing is returned.
 */
async function record(
  deps: CoordinatorDeps,
  requestId: string,
  signed: { signer: Address; digest: Hex; signature: Hex }[],
): Promise<void> {
  for (const s of signed) {
    const row = {
      requestId,
      signer: Buffer.from(hexToBytes(s.signer)),
      digest: Buffer.from(hexToBytes(s.digest)),
      signature: Buffer.from(hexToBytes(s.signature)),
    };
    let conflict = false;
    try {
      const [inserted] = await deps.db
        .insert(teeSignatures)
        .values(row)
        .onConflictDoNothing()
        .returning({ requestId: teeSignatures.requestId });
      conflict = inserted === undefined;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      conflict = true;
    }
    if (!conflict) continue;
    const [existing] = await deps.db
      .select()
      .from(teeSignatures)
      .where(and(eq(teeSignatures.requestId, requestId), eq(teeSignatures.signer, row.signer)));
    if (existing?.digest.equals(row.digest)) continue;
    await revokeSigner(deps.db, s.signer, "contradiction");
    emit(deps, "tee.contradiction", requestId, {
      signer: s.signer,
      digests: [existing ? toHex(existing.digest) : null, s.digest],
    });
    throw new CoordinatorError(
      "tee-contradiction",
      "A signer signed two digests for one request.",
      502,
    );
  }
}

/**
 * Sends the request to leg A, forwards leg A's observation with the identical request to leg B,
 * and returns the countersignature only when both digests are byte-equal. With leg B down it
 * answers `degraded` with leg A's signature alone; with leg A down, or leg B answering that it
 * could not judge the request, it signs nothing and the request may be retried.
 */
export async function countersign2of2(
  deps: CoordinatorDeps,
  req: CountersignRequest,
  want: CountersignExpectation,
  refSalt?: Hex,
): Promise<CoordinatedCountersign> {
  const unavailable = () =>
    new CoordinatorError("tee-unavailable", "A TEE signer is not available.", 503);

  const signerA = await activeSigner(deps.db, 1);
  if (!signerA) {
    void readmit(deps, "a");
    throw unavailable();
  }
  const signerB = await activeSigner(deps.db, 2);
  const measurements = {
    tdx: measurementHex(signerA.measurement),
    nitro: measurementHex(signerB?.measurement),
  };
  const [statementsA, statementsB] = await Promise.all([
    legSupportsStatements(deps, "a"),
    legSupportsStatements(deps, "b"),
  ]);
  const askA =
    measurements.tdx === null
      ? undefined
      : statementAsk({
          supports: statementsA,
          measurements: { tdx: measurements.tdx, nitro: measurements.nitro },
          refSalt,
        });
  let a: Countersigned;
  try {
    a = await deps.tee.client.a.countersign(askA ? { ...req, statement: askA } : req);
  } catch (err) {
    if (err instanceof LegError) {
      deps.log.warn(
        { leg: "a", requestId: req.request_id, kind: err.kind, code: err.code, status: err.status },
        "leg a did not countersign",
      );
      // Leg A could not read PayPal; the request itself may succeed when retried.
      if (err.code === "paypal") {
        throw new CoordinatorError("paypal-unavailable", "PayPal could not be read.", 503);
      }
    }
    if (down(err)) throw unavailable();
    if (err instanceof LegError && err.code === "malformed_response") throw divergence();
    throw err;
  }
  const first = await checked(deps, "a", a, req, want);

  // Leg B has no root to open the salt with.
  const { authorization_id: _read, sealed_salt: _salt, ...forB } = req;
  let b: Countersigned | undefined;
  if (signerB) {
    const askB =
      a.statement && measurements.tdx !== null
        ? statementAsk({
            supports: statementsB,
            measurements: { tdx: measurements.tdx, nitro: measurements.nitro },
            refSalt,
            legA: { signer: a.signer, signature: a.signature },
          })
        : undefined;
    try {
      b = await deps.tee.client.b.countersign({
        ...forB,
        observation: a.observation,
        ...(askB ? { statement: askB } : {}),
      });
    } catch (err) {
      if (!unreachable(err)) {
        const code = err instanceof LegError ? (err.code ?? null) : null;
        deps.log.warn(
          {
            leg: "b",
            requestId: req.request_id,
            code,
            status: err instanceof LegError ? (err.status ?? null) : null,
          },
          "leg b did not countersign",
        );
        if (notJudged(err)) throw unavailable();
        emit(deps, "tee.divergence", req.request_id, { digests: [first.digest, null], code });
        throw divergence();
      }
    }
  }

  const { trace } = first;
  if (!b) {
    await record(deps, req.request_id, [first]);
    deps.log.warn({ requestId: req.request_id }, "leg b is down, countersigned by leg a alone");
    emit(deps, "tee.degraded", req.request_id, { digest: first.digest });
    return {
      mode: "degraded",
      countersign: a.countersign,
      digest: first.digest,
      signatures: { tdx: first.signature, nitro: null },
      signers: { tdx: first.signer, nitro: null },
      trace,
      observation: a.observation,
      statement: chosenStatement("degraded", a.statement, undefined),
    };
  }

  const second = await checked(deps, "b", b, req, want);
  if (first.digest !== second.digest) {
    emit(deps, "tee.divergence", req.request_id, { digests: [first.digest, second.digest] });
    throw divergence();
  }
  await record(deps, req.request_id, [first, second]);
  return {
    mode: "2of2",
    countersign: a.countersign,
    digest: first.digest,
    signatures: { tdx: first.signature, nitro: second.signature },
    signers: { tdx: first.signer, nitro: second.signer },
    trace,
    observation: a.observation,
    statement: chosenStatement("2of2", a.statement, b.statement),
  };
}
