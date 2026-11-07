import { type Json, toHex } from "@keelson/core";
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

/** The channel the coordinator raises its alarms on. */
export const TEE_EVENTS = "public:tee";

export type CoordinatorSlug =
  | "tee-unavailable"
  | "tee-divergence"
  | "tee-unregistered-signer"
  | "tee-contradiction";

/** A refusal to countersign; it never carries a signature. */
export class CoordinatorError extends Error {
  constructor(
    readonly slug: CoordinatorSlug,
    message: string,
    readonly status: 502 | 503,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export interface CoordinatorDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  tee: TeeConfig;
  /** The `verifyingContract` of the EIP-712 domain both legs were booted with. */
  verifyingContract: Address;
}

export interface CoordinatedCountersign {
  mode: "2of2" | "degraded";
  countersign: CountersignJson;
  digest: Hex;
  signatures: { tdx: Hex; nitro: Hex | null };
  signers: { tdx: Address; nitro: Address | null };
  trace: Json;
  observation: Observation;
}

const DOMAIN_CHAIN = CHAIN_IDS.arbitrumSepolia;

function message(c: CountersignJson): Countersign {
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

const down = (err: unknown): boolean =>
  err instanceof LegError &&
  (err.kind === "timeout" || err.kind === "unreachable" || (err.status ?? 0) >= 500);

const readmitting = new Set<Leg>();

/** Admits the leg's new signer after a restart without holding the request that noticed it. */
function readmit(deps: CoordinatorDeps, leg: Leg): void {
  if (readmitting.has(leg)) return;
  readmitting.add(leg);
  void refreshLeg(deps.db, leg, deps.tee)
    .catch((err: unknown) => deps.log.warn({ err, leg }, "tee signer could not be admitted"))
    .finally(() => readmitting.delete(leg));
}

function emit(deps: CoordinatorDeps, type: string, requestId: string, extra: Json = {}): void {
  void publishEvent(deps, TEE_EVENTS, requestId, { type, requestId, ...(extra as object) }).catch(
    (err: unknown) => deps.log.error({ err, type, requestId }, "tee event could not be published"),
  );
}

/**
 * Checks that a leg's answer is the digest of its own countersign, signed by the signer
 * registered for that leg.
 */
async function checked(
  deps: CoordinatorDeps,
  leg: Leg,
  answer: Countersigned,
  requestId: string,
): Promise<{ signer: Address; digest: Hex; signature: Hex }> {
  const digest = countersignDigest(
    message(answer.countersign),
    keelsonDomain(DOMAIN_CHAIN, deps.verifyingContract),
  );
  const unregistered = async (why: string) => {
    // A restarted leg has a new signer the registry has not seen; one it knows is merely misfiled.
    const known = await deps.db.query.teeSigners.findFirst({
      columns: { address: true },
      where: (t, { eq }) => eq(t.address, Buffer.from(hexToBytes(answer.signer as Hex))),
    });
    if (!known) readmit(deps, leg);
    emit(deps, "tee.unregistered", requestId, { leg });
    return new CoordinatorError("tee-unregistered-signer", `leg ${leg}: ${why}`, 502);
  };
  if (digest.toLowerCase() !== answer.digest) {
    throw await unregistered("the digest is not that of the countersign");
  }
  const signature = answer.signature as Hex;
  const recovered = getAddress(await recoverAddress({ hash: digest, signature }));
  const registered = await activeSigner(deps.db, leg === "a" ? 1 : 2);
  if (recovered !== registered?.address || recovered !== getAddress(answer.signer)) {
    throw await unregistered("the signer is not the registered one");
  }
  return { signer: recovered, digest, signature };
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

const parseTrace = (answer: Countersigned): Json =>
  JSON.parse(Buffer.from(answer.trace_jcs, "base64").toString("utf8")) as Json;

/**
 * Sends the request to leg A, forwards leg A's observation with the identical request to leg B,
 * and returns the countersignature only when both digests are byte-equal. With leg B down it
 * answers `degraded` with leg A's signature alone; with leg A down it signs nothing.
 */
export async function countersign2of2(
  deps: CoordinatorDeps,
  req: CountersignRequest,
): Promise<CoordinatedCountersign> {
  const unavailable = (leg: Leg) =>
    new CoordinatorError("tee-unavailable", `Leg ${leg} cannot countersign right now.`, 503);

  if (!(await activeSigner(deps.db, 1))) {
    readmit(deps, "a");
    throw unavailable("a");
  }
  let a: Countersigned;
  try {
    a = await deps.tee.client.a.countersign(req);
  } catch (err) {
    if (down(err)) throw unavailable("a");
    throw err;
  }
  const first = await checked(deps, "a", a, req.request_id);

  const { authorization_id: _read, ...forB } = req;
  let b: Countersigned | undefined;
  if (await activeSigner(deps.db, 2)) {
    try {
      b = await deps.tee.client.b.countersign({ ...forB, observation: a.observation });
    } catch (err) {
      if (!down(err)) {
        emit(deps, "tee.divergence", req.request_id, {
          digests: [first.digest, null],
          code: err instanceof LegError ? (err.code ?? null) : null,
        });
        throw new CoordinatorError("tee-divergence", "The legs disagree.", 502);
      }
    }
  }

  const trace = parseTrace(a);
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
    };
  }

  const second = await checked(deps, "b", b, req.request_id);
  if (first.digest !== second.digest) {
    emit(deps, "tee.divergence", req.request_id, { digests: [first.digest, second.digest] });
    throw new CoordinatorError("tee-divergence", "The legs disagree.", 502);
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
  };
}
