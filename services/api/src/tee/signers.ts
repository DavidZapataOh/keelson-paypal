import { type Expectations, type SignerAttestation, verifySigner } from "@keelson/attest";
import { and, type Db, desc, eq, gt, isNull, ne, teeSigners } from "@keelson/db";
import type { Logger } from "pino";
import { type Address, getAddress, type Hex, hexToBytes, type PublicClient } from "viem";
import type { LegClient } from "./client.ts";

export type Leg = "a" | "b";

/** The `tee_kind` of each leg: 1 is TDX, 2 is Nitro. */
export const TEE_KIND = { a: 1, b: 2 } as const;

/** How long a registered signer stays valid. */
export const SIGNER_TTL_MS = 72 * 3_600_000;
/** How often each leg is made to re-attest. Nitro documents stop verifying about 3 h after issue. */
export const REFRESH_INTERVAL_MS = 50 * 60_000;
/** A signer whose attestation last verified longer ago than this is treated as down. */
export const ATTESTATION_MAX_AGE_MS = 2 * 3_600_000;

export type LegExpectations = Omit<Expectations, "now">;

/** What the coordinator needs to reach and admit the two legs. */
export interface TeeConfig {
  client: Record<Leg, LegClient>;
  expect: Record<Leg, LegExpectations>;
  /** Arbitrum Sepolia, read for the block both legs attest over. */
  rpc: PublicClient;
}

export interface RegisteredSigner {
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

export class RegistrationError extends Error {}

/**
 * Fetches the leg's attestation, verifies it, and admits its signer. The previous signer of the
 * leg is marked superseded. Leg B must attest the issuer leg A's registered signer attests.
 */
export async function registerLeg(
  db: Db,
  leg: Leg,
  client: LegClient,
  expect: LegExpectations,
  now: Date = new Date(),
): Promise<RegisteredSigner> {
  const attestation = await client.attestation();
  let pinned = expect;
  if (leg === "b" && !expect.issuerJwkThumbprint) {
    const a = await activeSigner(db, TEE_KIND.a, now);
    if (a) pinned = { ...expect, issuerJwkThumbprint: a.binding.issuerJwkThumbprint };
  }
  const verified = await verifySigner(attestation, { ...pinned, now });
  if (verified.teeKind !== TEE_KIND[leg]) {
    throw new RegistrationError(`leg ${leg} attests a signer of another TEE kind`);
  }

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
  return registerLeg(db, leg, tee.client[leg], tee.expect[leg]);
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
