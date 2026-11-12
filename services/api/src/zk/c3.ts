// Loads reflect-metadata before @keelson/alibi/verify pulls in @keelson/attest (see tee/attest.ts).
import "../tee/attest.ts";
import { toBase64 } from "@keelson/alibi";
import { c3Statement, verifyC3 } from "@keelson/alibi/verify";
import { toHex } from "@keelson/core";
import { asc, type Db, mandates, passkey, sql, userSetRoots } from "@keelson/db";
import {
  type C3Assertion,
  c3Inputs,
  decodeMandate,
  type UserSet,
  userKeyHash,
  userSet,
} from "@keelson/mandate";
import type { Relayer } from "@keelson/relayer";
import type { Render } from "@renderinc/sdk";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { passkeyJwk, SignatureError } from "../mandate-signature.ts";
import { resumeAwaitingC3 } from "../pipeline/drive.ts";
import { prove } from "./bb.ts";
import { awaitingC3, proveAnonymousPurchase } from "./c1c3.ts";

/** How long the API keeps a new mandate's salt for its C3 proof: past it, the proof is not made. */
const C3_SALT_TTL_SECONDS = 3600;

/** The Valkey key of a new mandate's commitment salt, kept for its C3 proof. */
export const c3SaltKey = (mandateId: string): string => `c3:salt:${mandateId}`;

/**
 * A C3 proof as the API stores and serves it: base64 proof bytes and 32-byte hex inputs, and the
 * proof of the same witness for recursion, which composes it with a purchase's C1.
 */
export interface C3Proof {
  proof: string;
  public_inputs: string[];
  recursive_proof?: string | undefined;
}

/**
 * The registered-user tree now: every ES256 passkey's `user_key_hash`, in registration order.
 * Its root is recorded so that verifiers accept proofs made under it later.
 */
async function currentUserSet(db: Db): Promise<UserSet> {
  const rows = await db
    .select({ publicKey: passkey.publicKey })
    .from(passkey)
    .orderBy(asc(passkey.createdAt), asc(passkey.id));
  const leaves: bigint[] = [];
  for (const row of rows) {
    try {
      leaves.push(await userKeyHash(passkeyJwk(row)));
    } catch (err) {
      if (!(err instanceof SignatureError)) throw err;
    }
  }
  const set = await userSet(leaves);
  if (leaves.length > 0) {
    await db
      .insert(userSetRoots)
      .values({ root: Buffer.from(word(set.root)), size: leaves.length })
      .onConflictDoNothing();
  }
  return set;
}

const word = (x: bigint): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((x >> BigInt(8 * (31 - i))) & 0xffn));

/** The chain `RegisteredUserSet` holds Keelson's roots on. */
const ROOTS_CHAIN_ID = 421614;

/** The relayer key a registered-user root is published under (`0x` + 64 hex). */
export const rootKey = (root: string): string => `RegisteredUserSet.publish:${root}`;

/** How long a publish waits for its pending transaction before the caller tries again. */
const PUBLISH_WAIT_MS = 15_000;

/**
 * Publishes to `RegisteredUserSet`, oldest first, every recorded root of the registered-user tree
 * that the relayer has not confirmed on chain, so merchants check a C3 proof's root against the
 * chain rather than the API. A root already on chain is a no-op for the contract.
 *
 * @throws when a root could not be published yet; a later call publishes it.
 */
export async function publishUserSetRoots(deps: {
  db: Db;
  relayer: Relayer;
  log: Logger;
}): Promise<void> {
  const { db, relayer, log } = deps;
  const rows = await db
    .select({ root: userSetRoots.root, size: userSetRoots.size })
    .from(userSetRoots)
    .where(sql`not exists (
      select 1 from chain_txs t
      where t.chain_id = ${ROOTS_CHAIN_ID}
        and t.key = 'RegisteredUserSet.publish:0x' || encode(${userSetRoots.root}, 'hex')
        and t.status = 'confirmed'
    )`)
    .orderBy(asc(userSetRoots.createdAt), asc(userSetRoots.root));
  for (const row of rows) {
    const root = toHex(row.root);
    const { size } = row;
    let record = await relayer.submit({
      chainId: ROOTS_CHAIN_ID,
      contract: "RegisteredUserSet",
      functionName: "publish",
      args: [root, size],
      key: rootKey(root),
    });
    const deadline = Date.now() + PUBLISH_WAIT_MS;
    while (record.status === "pending" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      record = (await relayer.getById(record.id)) ?? record;
    }
    if (record.status !== "confirmed") {
      throw new Error(
        `root ${root} is ${record.status}${record.errorCode ? ` (${record.errorCode})` : ""}`,
      );
    }
    log.info({ root, size, tx: record.hash }, "registered-user root published");
  }
}

/**
 * Proves C3 for mandate `mandateId`, whose commitment opens under `salt` (`0x` + 16 bytes hex),
 * stores the proof on the mandate and returns it. A mandate that already has one keeps it.
 * The proof is checked against the pinned key and the mandate's own commitment and hash before
 * it is stored.
 */
export async function proveAnonymousMandate(
  deps: { db: Db; log: Logger },
  mandateId: string,
  salt: string,
): Promise<C3Proof> {
  const { db, log } = deps;
  const row = await db.query.mandates.findFirst({
    columns: {
      payloadSd: true,
      disclosures: true,
      userAuth: true,
      commitment: true,
      mandateHash: true,
      c3Proof: true,
    },
    where: (m, { eq: is }) => is(m.id, mandateId),
  });
  if (!row?.payloadSd || !row.disclosures || !row.userAuth || !row.commitment || !row.mandateHash) {
    throw new Error(`mandate ${mandateId} is not signed`);
  }
  if (row.c3Proof) return row.c3Proof;
  const started = performance.now();
  const users = await currentUserSet(db);
  const { inputs } = await c3Inputs({
    mandate: decodeMandate(row.payloadSd, row.disclosures),
    salt: Uint8Array.from(Buffer.from(salt.replace(/^0x/, ""), "hex")),
    payloadSd: row.payloadSd,
    assertion: row.userAuth as C3Assertion,
    users,
  });
  const proved = await prove("anonymous_mandate", inputs, ["evm", "noir-recursive"]);
  const c3: C3Proof = {
    proof: toBase64(proved.evm.proof),
    public_inputs: proved.evm.publicInputs,
    recursive_proof: toBase64(proved["noir-recursive"].proof),
  };
  const expected = c3Statement({
    mandateCommitment: toHex(row.commitment),
    mandateHash: toHex(row.mandateHash),
    userSetRoot: toHex(word(users.root)),
  });
  const holds = expected.every((x, i) => x === c3.public_inputs[i]);
  if (!holds || !(await verifyC3(c3.proof, c3.public_inputs))) {
    throw new Error(`the C3 proof of mandate ${mandateId} does not verify`);
  }
  await db
    .update(mandates)
    .set({ c3Proof: c3 })
    .where(sql`${mandates.id} = ${mandateId} and ${mandates.c3Proof} is null`);
  log.info(
    { mandateId, users: users.leaves.length, ms: Math.round(performance.now() - started) },
    "C3 proved",
  );
  return c3;
}

/**
 * Starts the C3 proof of a mandate just stored, then publishes its root with the relayer. With a workflow, the proof needs more memory than
 * the API instance has: the workflow task `proveAnonymousMandate` proves it and reads the salt from
 * Valkey, so that it never becomes a task argument, and composes the purchases logged before it.
 * Without one all of it happens in this process.
 */
export function c3Prover(
  deps: { db: Db; kv: RedisClientType; log: Logger; relayer?: Relayer | undefined },
  workflow?: { render: Render; slug: string },
): (mandateId: string, salt: string) => Promise<void> {
  const { db, kv, log, relayer } = deps;
  if (!workflow) {
    return async (mandateId, salt) => {
      await proveAnonymousMandate({ db, log }, mandateId, salt);
      if (relayer) await publishUserSetRoots({ db, relayer, log });
      await resumeAwaitingC3(db, mandateId);
      for (const purchaseId of await awaitingC3(db, mandateId)) {
        await proveAnonymousPurchase({ db, log }, purchaseId);
      }
    };
  }
  return async (mandateId, salt) => {
    await kv.set(c3SaltKey(mandateId), salt, { EX: C3_SALT_TTL_SECONDS });
    const run = await workflow.render.workflows.startTask(
      `${workflow.slug}/proveAnonymousMandate`,
      [mandateId],
      { idempotencyKey: `proveAnonymousMandate:${mandateId}` },
    );
    log.info({ mandateId, taskRunId: run.taskRunId }, "C3 workflow started");
  };
}
