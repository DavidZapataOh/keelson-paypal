import { and, type Db, desc, eq, gt, isNull, ne, teeSigners } from "@keelson/db";
import type { Logger } from "pino";
import { type Address, getAddress, type Hex, hexToBytes, type PublicClient } from "viem";
import { type ChainDeps, ensureRegisteredOnChain } from "../chain/registry.ts";
import { type Expectations, type SignerAttestation, verifySigner } from "./attest.ts";
import type { LegClient } from "./client.ts";

export type Leg = "a" | "b";

/** The `tee_kind` of each leg: 1 is TDX, 2 is Nitro. */
const TEE_KIND = { a: 1, b: 2 } as const;

/** How long a registered signer stays valid. */
const SIGNER_TTL_MS = 72 * 3_600_000;
/** How often each leg is made to re-attest. Nitro documents stop verifying about 3 h after issue. */
const REFRESH_INTERVAL_MS = 50 * 60_000;
/** A signer whose attestation last verified longer ago than this is treated as down. */
export const ATTESTATION_MAX_AGE_MS = 2 * 3_600_000;

export type LegExpectations = Omit<Expectations, "now"> & {
  /**
   * Earlier builds still admitted during a rotation: a signer attesting one of them, with its
   * own image digest and measurement, is admitted like one of the current build.
   */
  previous?: readonly Pick<Expectations, "engineBuildId" | "measurements">[];
};

/** What the coordinator needs to reach and admit the two legs. */
export interface TeeConfig {
  client: Record<Leg, LegClient>;
  expect: Record<Leg, LegExpectations>;
  /** Arbitrum Sepolia, read for the block both legs attest over. */
  rpc: PublicClient;
  /** When set, a signer is admitted only once it is registered in the VerdictVerifier. */
  chain?: ChainDeps;
}

interface RegisteredSigner {
  address: Address;
  teeKind: 1 | 2;
  measurement: string;
  binding: SignerAttestation["binding"];
  attestation: SignerAttestation;
  registeredAt: Date;
  verifiedAt: Date;
  expiresAt: Date;
}

const toBuffer = (address: string) => Buffer.from(hexToBytes(address as Hex));
const toAddress = (bytes: Buffer): Address => getAddress(`0x${bytes.toString("hex")}`);

function fromRow(row: typeof teeSigners.$inferSelect): RegisteredSigner {
  return {
    address: toAddress(row.address),
    teeKind: row.teeKind as 1 | 2,
    measurement: row.measurement,
    binding: row.binding as SignerAttestation["binding"],
    attestation: row.attestation as SignerAttestation,
    registeredAt: row.registeredAt,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
  };
}

class RegistrationError extends Error {}

/** Verifies against the current build, then each earlier one; the current build's error wins. */
async function verifyAgainstBuilds(
  attestation: SignerAttestation,
  expect: LegExpectations,
  now: Date,
): ReturnType<typeof verifySigner> {
  const { previous = [], ...current } = expect;
  try {
    return await verifySigner(attestation, { ...current, now });
  } catch (err) {
    for (const build of previous) {
      try {
        return await verifySigner(attestation, { ...current, ...build, now });
      } catch {}
    }
    throw err;
  }
}

/**
 * Fetches the leg's attestation, verifies it, and admits its signer, after registering it in the
 * VerdictVerifier and waiting for the receipt when `chain` is set, so no countersign precedes its
 * on-chain registration. The previous signer of the leg is marked superseded. Both legs must attest the pinned issuer; without a pin, leg B takes
 * the one leg A's registered signer attests and is refused when there is none.
 *
 * @internal
 */
export async function registerLeg(
  db: Db,
  leg: Leg,
  client: LegClient,
  expect: LegExpectations,
  now: Date = new Date(),
  chain?: ChainDeps,
): Promise<RegisteredSigner> {
  const attestation = await client.attestation();
  let pinned = expect;
  if (leg === "b" && !expect.issuerJwkThumbprint) {
    const a = await activeSigner(db, TEE_KIND.a, now);
    if (!a) throw new RegistrationError("leg b has no issuer to attest: leg a has no signer");
    pinned = { ...expect, issuerJwkThumbprint: a.binding.issuerJwkThumbprint };
  }
  const verified = await verifyAgainstBuilds(attestation, pinned, now);
  if (verified.teeKind !== TEE_KIND[leg]) {
    throw new RegistrationError(`leg ${leg} attests a signer of another TEE kind`);
  }
  if (chain) await ensureRegisteredOnChain(chain, attestation, verified, now);

  const address = toBuffer(verified.signer);
  const values = {
    address,
    teeKind: verified.teeKind,
    measurement: verified.measurement,
    binding: attestation.binding,
    attestation,
    verifiedAt: now,
    expiresAt: new Date(now.getTime() + SIGNER_TTL_MS),
  };
  const row = await db.transaction(async (tx) => {
    const [known] = await tx
      .select({ revokedAt: teeSigners.revokedAt })
      .from(teeSigners)
      .where(eq(teeSigners.address, address));
    if (known?.revokedAt) throw new RegistrationError("the signer is revoked");
    await tx
      .update(teeSigners)
      .set({ revokedAt: now, revokedReason: "superseded" })
      .where(
        and(
          eq(teeSigners.teeKind, verified.teeKind),
          ne(teeSigners.address, address),
          isNull(teeSigners.revokedAt),
        ),
      );
    const [stored] = await tx
      .insert(teeSigners)
      .values({ ...values, registeredAt: now })
      .onConflictDoUpdate({
        target: teeSigners.address,
        set: {
          measurement: values.measurement,
          binding: values.binding,
          attestation: values.attestation,
          verifiedAt: values.verifiedAt,
          expiresAt: values.expiresAt,
        },
        setWhere: isNull(teeSigners.revokedAt),
      })
      .returning();
    return stored;
  });
  if (!row) throw new RegistrationError("the signer is revoked");
  return fromRow(row);
}

/**
 * The signer a leg's signatures are accepted from: registered, not revoked, not expired and
 * attested recently.
 */
export async function activeSigner(
  db: Db,
  teeKind: 1 | 2,
  now: Date = new Date(),
): Promise<RegisteredSigner | null> {
  const [row] = await db
    .select()
    .from(teeSigners)
    .where(
      and(
        eq(teeSigners.teeKind, teeKind),
        isNull(teeSigners.revokedAt),
        gt(teeSigners.expiresAt, now),
        gt(teeSigners.verifiedAt, new Date(now.getTime() - ATTESTATION_MAX_AGE_MS)),
      ),
    )
    .orderBy(desc(teeSigners.registeredAt))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function revokeSigner(db: Db, address: Address, reason: string): Promise<void> {
  await db
    .update(teeSigners)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(teeSigners.address, toBuffer(address)), isNull(teeSigners.revokedAt)));
}

/** Has the leg attest over a fresh block, then admits it again. */
export async function refreshLeg(db: Db, leg: Leg, tee: TeeConfig): Promise<RegisteredSigner> {
  const block = leg === "b" ? await tee.rpc.getBlock() : undefined;
  await tee.client[leg].refresh(block && { number: block.number, hash: block.hash });
  return registerLeg(db, leg, tee.client[leg], tee.expect[leg], new Date(), tee.chain);
}

/**
 * Re-attests and re-admits both legs now and every 50 minutes. A leg that cannot be refreshed
 * keeps its last verification, which expires, and then counts as down. Leg A goes first because
 * leg B must attest A's issuer.
 */
export function startSignerRefresh(deps: { db: Db; log: Logger; tee: TeeConfig }): () => void {
  const run = async () => {
    for (const leg of ["a", "b"] as const) {
      try {
        const signer = await refreshLeg(deps.db, leg, deps.tee);
        deps.log.info({ leg, signer: signer.address }, "tee signer admitted");
      } catch (err) {
        deps.log.warn({ err, leg }, "tee signer could not be refreshed");
      }
    }
  };
  void run();
  const timer = setInterval(() => void run(), REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
