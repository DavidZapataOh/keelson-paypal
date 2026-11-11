import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { addresses, engineProofVerifierAbi } from "@keelson/chain";
import {
  and,
  type Db,
  type EngineProof,
  type EngineProved,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  mandates,
  ne,
  or,
  purchases,
  sql,
} from "@keelson/db";
import { type Relayer, RelayerError } from "@keelson/relayer";
import type { Logger } from "pino";
import { type Address, bytesToHex, type Hex, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";

const run = promisify(execFile);

/**
 * The engine's SP1 prover, built by the `engine-proof` workflow from the program whose verifying
 * key `EngineProofVerifier` holds. A new program needs a new verifier and a new pin.
 */
const ENGINE_PROVER = {
  url: "https://github.com/DavidZapataOh/keelson-paypal/releases/download/engine-proof-0000000/keelson-engine-proof-linux-x64",
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  vkey: "0x00c562cc96a77edfb4714bf98a2685fc6dfb825bb60e29e60b6a33205455e54c" as Hex,
} as const;

/** The chain `EngineProofVerifier` records proofs on. */
const ENGINE_PROOF_CHAIN_ID = arbitrumSepolia.id;
/** The block `EngineProofVerifier` was deployed at, where its `EngineProven` history starts. */
const ENGINE_PROOF_FROM_BLOCK = 328_153_386n;

/**
 * The most PROVE, in wei, one dispute's proof may cost on the Succinct Prover Network: the prover
 * refuses a request whose Groth16 base fee plus gas limit at the bid price exceeds it.
 */
const ENGINE_PROOF_MAX_COST = 2n * 10n ** 18n;
/** The local simulation that sizes a network request, and the request itself. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** The network's auction and proving, and the local verification of its proof. */
const WAIT_TIMEOUT_MS = 35 * 60 * 1000;
/** The free run of the program that checks a dispute's input before a proof of it is paid for. */
const EXECUTE_TIMEOUT_MS = 5 * 60 * 1000;
const RECORD_WAIT_MS = 120_000;
/** What `purchases.engine_request` holds while a run checks and requests a proof. */
export const REQUEST_CLAIM = "requesting";
const RECORD_ATTEMPTS = 2;
/** The `proveEngine` workflow task's timeout: no run holds a purchase it attempted longer ago. */
export const ENGINE_RUN_MS = 60 * 60 * 1000;
/** How many runs the sweep starts for one purchase before giving its proof up. */
export const ENGINE_RESUMES = 3;
/** The prover's download. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** How long a run holds its claim: the prover's download, the free check and the request. */
const CLAIM_MS = DOWNLOAD_TIMEOUT_MS + EXECUTE_TIMEOUT_MS + REQUEST_TIMEOUT_MS;

/** The `CountersignInput` the SP1 program reads, as JSON. */
interface CountersignInput {
  payload_sd: unknown;
  disclosures: string[];
  cart: unknown;
  unit: unknown;
  evidence: Record<string, string[]>;
  now_ms: number;
  budget_left_minor: number;
  request_id: Hex;
  evidence_root: Hex;
  expires_at: number;
  chain_id: number;
  verifying_contract: string;
  oci_digest: string;
  canonicalizer: string;
}

/**
 * The input the engine program recomputes purchase `purchaseId`'s countersign from, and the
 * countersign's own `evalHash` and digest it must reproduce.
 *
 * @throws {RangeError} when the purchase was countersigned without its inputs being kept.
 * @internal
 */
export async function engineInputOf(
  db: Db,
  purchaseId: string,
): Promise<{ input: CountersignInput; evalHash: Hex; digest: Hex }> {
  const [row] = await db
    .select({
      input: purchases.engineInput,
      countersign: purchases.countersign,
      digest: purchases.countersignDigest,
      trace: purchases.evalTrace,
      payloadSd: mandates.payloadSd,
      disclosures: mandates.disclosures,
    })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  const engine = (row?.trace as { engine?: { oci_digest?: string; canonicalizer?: string } })
    ?.engine;
  if (
    !row?.input ||
    !row.countersign ||
    !row.digest ||
    !row.payloadSd ||
    !row.disclosures ||
    !engine?.oci_digest ||
    !engine.canonicalizer
  ) {
    throw new RangeError(`purchase ${purchaseId} has no stored engine input`);
  }
  const c = row.countersign;
  const { cart, unit, evidence, now_ms, budget_left_minor, chain_id, verifying_contract } =
    row.input;
  return {
    input: {
      payload_sd: row.payloadSd,
      disclosures: row.disclosures,
      cart,
      unit,
      evidence,
      now_ms,
      budget_left_minor,
      request_id: c.requestId as Hex,
      evidence_root: c.evidenceRoot as Hex,
      expires_at: Number(c.expiresAt),
      chain_id,
      verifying_contract,
      oci_digest: engine.oci_digest,
      canonicalizer: engine.canonicalizer,
    },
    evalHash: c.evalHash as Hex,
    digest: bytesToHex(row.digest),
  };
}

/** The prover binary, downloaded once per instance and checked against its pinned hash. */
async function prover(): Promise<string> {
  const path = join(tmpdir(), `keelson-engine-proof-${ENGINE_PROVER.sha256.slice(0, 16)}`);
  if (
    await access(path).then(
      () => true,
      () => false,
    )
  ) {
    return path;
  }
  const res = await fetch(ENGINE_PROVER.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`engine prover download: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== ENGINE_PROVER.sha256) throw new Error(`engine prover hash ${sha256}`);
  await writeFile(path, bytes);
  await chmod(path, 0o755);
  return path;
}

/** Runs the program over `input` without proving it, which costs nothing, for its public values. */
async function executeInput(
  input: CountersignInput,
): Promise<{ eval_hash: string; countersign_digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), "engine-execute-"));
  try {
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify(input));
    const { stdout } = await run(await prover(), ["execute", inputPath], {
      timeout: EXECUTE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUST_LOG: "warn" },
    });
    // The SP1 logger writes to stdout too: the result is the last JSON line.
    const line = stdout.split("\n").findLast((l) => l.startsWith("{"));
    if (!line) throw new Error("the engine prover printed no result");
    return JSON.parse(line);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What the prover needs from the workflow's environment: its other keys stay out of it. */
function proverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  if (!process.env.NETWORK_PRIVATE_KEY) throw new Error("NETWORK_PRIVATE_KEY is not set");
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NETWORK_PRIVATE_KEY: process.env.NETWORK_PRIVATE_KEY,
    RUST_LOG: "warn",
    ...extra,
  };
}

/**
 * Requests a Groth16 proof of `input` from the Succinct Prover Network, paid by
 * `NETWORK_PRIVATE_KEY`, and stores the request on purchase `purchaseId` as soon as the prover
 * prints it, even when the prover then fails: a request it could not cancel may still be paid for.
 */
async function requestProof(db: Db, purchaseId: string, input: CountersignInput): Promise<Hex> {
  const dir = await mkdtemp(join(tmpdir(), "engine-request-"));
  try {
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify(input));
    let stdout = "";
    let failure: unknown;
    try {
      ({ stdout } = await run(await prover(), ["request", inputPath], {
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: proverEnv({ ENGINE_PROOF_MAX_COST: ENGINE_PROOF_MAX_COST.toString() }),
      }));
    } catch (err) {
      failure = err;
      stdout = (err as { stdout?: string }).stdout ?? "";
    }
    const line = stdout.split("\n").find((l) => l.startsWith("{"));
    const requested = line ? (JSON.parse(line) as { request_id: Hex }) : undefined;
    if (requested) {
      await db
        .update(purchases)
        .set({ engineRequest: requested.request_id })
        .where(eq(purchases.id, purchaseId));
    }
    if (failure) throw failure;
    if (!requested) throw new Error("the engine prover printed no request");
    return requested.request_id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Gives up a claim on purchase `purchaseId` that no request was made under. */
async function releaseClaim(db: Db, purchaseId: string): Promise<void> {
  await db
    .update(purchases)
    .set({ engineRequest: null })
    .where(and(eq(purchases.id, purchaseId), eq(purchases.engineRequest, REQUEST_CLAIM)));
}

/** Marks purchase `purchaseId` as held by this run, so the sweep leaves it until the run is over. */
async function attempted(db: Db, purchaseId: string): Promise<void> {
  await db
    .update(purchases)
    .set({ engineAttemptedAt: new Date() })
    .where(eq(purchases.id, purchaseId));
}

/** Waits for network request `requestId` to prove `input`, and verifies the proof here. */
async function waitProof(input: CountersignInput, requestId: Hex): Promise<EngineProved> {
  const dir = await mkdtemp(join(tmpdir(), "engine-proof-"));
  try {
    const inputPath = join(dir, "input.json");
    const outPath = join(dir, "proof.json");
    await writeFile(inputPath, JSON.stringify(input));
    await run(await prover(), ["wait", inputPath, requestId, outPath], {
      timeout: WAIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: proverEnv(),
    });
    return JSON.parse(await readFile(outPath, "utf8")) as EngineProved;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The transaction that recorded `evalHash` for countersign `digest` on `verifier`, when one did:
 * `record` is permissionless, so another prover's transaction may have recorded it first.
 */
async function recordedBy(
  chain: PublicClient,
  verifier: Address,
  digest: Hex,
  evalHash: Hex,
): Promise<Hex | undefined> {
  const proven = await chain.readContract({
    address: verifier,
    abi: engineProofVerifierAbi,
    functionName: "proven",
    args: [digest],
  });
  if (proven.toLowerCase() !== evalHash.toLowerCase()) return undefined;
  const [event] = await chain.getContractEvents({
    address: verifier,
    abi: engineProofVerifierAbi,
    eventName: "EngineProven",
    args: { countersignDigest: digest },
    fromBlock: ENGINE_PROOF_FROM_BLOCK,
  });
  return event?.transactionHash;
}

/**
 * Proves in SP1 that the engine's canonicalizer and Cedar evaluation, run over purchase
 * `purchaseId`'s stored inputs, give its countersign's `evalHash`, records the proof with
 * `EngineProofVerifier.record` through the relayer and stores it on the purchase. A purchase that
 * already has one keeps it.
 *
 * @throws {RangeError} when the purchase has no stored engine input.
 */
export async function proveEngine(
  deps: { db: Db; log: Logger; relayer: Relayer; chain: PublicClient },
  purchaseId: string,
): Promise<EngineProof> {
  const { db, log, relayer, chain } = deps;
  const [existing] = await db
    .select({
      proof: purchases.engineProof,
      proved: purchases.engineProved,
      request: purchases.engineRequest,
    })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (existing?.proof) return existing.proof;
  const { input, evalHash, digest } = await engineInputOf(db, purchaseId);
  const verifier = addresses[ENGINE_PROOF_CHAIN_ID].EngineProofVerifier;
  if (!verifier) throw new Error("EngineProofVerifier is not deployed");

  // A proof paid for by an earlier run that did not get recorded is recorded, not bought again.
  let proved = existing?.proved?.vkey === ENGINE_PROVER.vkey ? existing.proved : undefined;
  if (proved) await attempted(db, purchaseId);
  if (!proved) {
    // The purchase is claimed before anything is paid, so two runs never both request a proof. A
    // run that finds a request waits for it again; one that finds a claim but no request stops,
    // since a run that died while requesting may have paid: the claim is cleared by hand once the
    // requester's explorer page shows no request for it.
    const [claimed] = await db
      .update(purchases)
      .set({ engineRequest: REQUEST_CLAIM, engineAttemptedAt: new Date() })
      .where(and(eq(purchases.id, purchaseId), isNull(purchases.engineRequest)))
      .returning({ id: purchases.id });
    let requestId: Hex;
    if (claimed) {
      // A mismatch here would repeat on every paid attempt, so it is caught before paying.
      const executed = await executeInput(input).catch(async (err: unknown) => {
        await releaseClaim(db, purchaseId);
        throw err;
      });
      if (executed.eval_hash !== evalHash || executed.countersign_digest !== digest) {
        await releaseClaim(db, purchaseId);
        throw new Error(`purchase ${purchaseId}: its engine input does not give its countersign`);
      }
      requestId = await requestProof(db, purchaseId, input);
    } else {
      const [row] = await db
        .select({ request: purchases.engineRequest })
        .from(purchases)
        .where(eq(purchases.id, purchaseId));
      if (!row?.request || row.request === REQUEST_CLAIM) {
        throw new Error(`purchase ${purchaseId}: another run is requesting its engine proof`);
      }
      requestId = row.request as Hex;
      await attempted(db, purchaseId);
    }
    log.info({ purchaseId, requestId }, "engine proof requested");
    proved = await waitProof(input, requestId);
    if (proved.vkey !== ENGINE_PROVER.vkey) throw new Error(`engine prover vkey ${proved.vkey}`);
    if (proved.eval_hash !== evalHash || proved.countersign_digest !== digest) {
      throw new Error(`purchase ${purchaseId}: the proof is not of its countersign`);
    }
    await db.update(purchases).set({ engineProved: proved }).where(eq(purchases.id, purchaseId));
    log.info(
      {
        purchaseId,
        cycles: proved.cycles,
        proveMs: proved.prove_ms,
        network: proved.network,
        peakRssKb: proved.peak_rss_kb,
      },
      "engine evaluation proved",
    );
  }

  // The task is not retried, since a retry could pay twice, so recording gets a second attempt
  // here. The relayer key makes it find the transaction already sent rather than send another.
  let tx: Hex | undefined;
  for (let attempt = 1; !tx; attempt++) {
    let outcome: string;
    try {
      let record = await relayer.submit({
        chainId: ENGINE_PROOF_CHAIN_ID,
        contract: "EngineProofVerifier",
        functionName: "record",
        args: [proved.public_values as Hex, proved.proof as Hex],
        key: `EngineProofVerifier.record:${digest}`,
      });
      const deadline = Date.now() + RECORD_WAIT_MS;
      while (record.status === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        record = (await relayer.getById(record.id)) ?? record;
      }
      if (record.status === "confirmed" && record.hash) tx = record.hash as Hex;
      outcome = `${record.status}${record.errorCode ? ` (${record.errorCode})` : ""}`;
    } catch (err) {
      // A rejected submission, such as one another prover's record makes revert, is checked
      // against the chain like any other that did not confirm.
      if (!(err instanceof RelayerError)) throw err;
      outcome = `rejected (${err.code})`;
    }
    tx ??= await recordedBy(chain, verifier, digest, evalHash);
    if (!tx && attempt === RECORD_ATTEMPTS) {
      throw new Error(`engine proof of ${purchaseId} is ${outcome}`);
    }
  }
  const receipt = await chain.getTransactionReceipt({ hash: tx });

  const proof: EngineProof = {
    ...proved,
    chain_id: ENGINE_PROOF_CHAIN_ID,
    verifier,
    tx,
    gas_used: receipt.gasUsed.toString(),
    proven_at: new Date().toISOString(),
  };
  await db.update(purchases).set({ engineProof: proof }).where(eq(purchases.id, purchaseId));
  log.info({ purchaseId, tx, gasUsed: proof.gas_used }, "engine proof recorded");
  return proof;
}

/** A purchase whose paid request or proof a new run can finish without paying again. */
const resumable = and(
  isNull(purchases.engineProof),
  or(
    isNotNull(purchases.engineProved),
    and(isNotNull(purchases.engineRequest), ne(purchases.engineRequest, REQUEST_CLAIM)),
  ),
);

/** Whether a purchase was last attempted before `at`, or never marked by a run. */
const attemptedBefore = (at: Date) =>
  or(isNull(purchases.engineAttemptedAt), lt(purchases.engineAttemptedAt, at));

/**
 * Starts `proveEngine` again for every purchase whose proof was paid for, or requested, by a run
 * that is over without recording it. The new run waits for the stored request or records the
 * stored proof, so it never pays again. A purchase's first run is followed by at most `ENGINE_RESUMES` more, then
 * given up on once: it is returned as `abandoned` and logged as an error. A claim with no request
 * that outlived its run may have paid, so it is never started again: it is returned as `stuck`
 * and logged as an error, for an operator to clear once the requester's explorer page shows
 * whether a request was made.
 */
export async function sweepEngineProofs(
  deps: { db: Db; log: Logger; start: (purchaseId: string, key: string) => Promise<void> },
  now: Date = new Date(),
): Promise<{ resumed: string[]; abandoned: string[]; stuck: string[] }> {
  const { db, log, start } = deps;
  const stalled = await db
    .select({ id: purchases.id, resumes: purchases.engineResumes })
    .from(purchases)
    .where(
      and(
        resumable,
        attemptedBefore(new Date(now.getTime() - ENGINE_RUN_MS)),
        lte(purchases.engineResumes, ENGINE_RESUMES),
      ),
    );
  const resumed: string[] = [];
  const abandoned: string[] = [];
  for (const { id, resumes } of stalled) {
    const counted = and(eq(purchases.id, id), eq(purchases.engineResumes, resumes));
    if (resumes >= ENGINE_RESUMES) {
      const [given] = await db
        .update(purchases)
        .set({ engineResumes: resumes + 1 })
        .where(counted)
        .returning({ id: purchases.id });
      if (given) {
        abandoned.push(id);
        log.error({ purchaseId: id, resumes }, "engine proof given up after its resumed runs");
      }
      continue;
    }
    try {
      // Every API instance starts the same resume under the same key, which Render runs once.
      await start(id, `proveEngine:${id}:resume:${resumes + 1}`);
    } catch (err) {
      log.warn({ err, purchaseId: id }, "engine proof not resumed");
      continue;
    }
    // Marked as attempted now, so a run that has not begun yet is not started twice; a run that
    // already marked it keeps its later time.
    const [marked] = await db
      .update(purchases)
      .set({
        engineResumes: resumes + 1,
        engineAttemptedAt: sql`greatest(${purchases.engineAttemptedAt}, ${now})`,
      })
      .where(counted)
      .returning({ id: purchases.id });
    if (marked) resumed.push(id);
  }
  const stuck = (
    await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(
        and(
          isNull(purchases.engineProof),
          isNull(purchases.engineProved),
          eq(purchases.engineRequest, REQUEST_CLAIM),
          attemptedBefore(new Date(now.getTime() - CLAIM_MS)),
        ),
      )
  ).map((r) => r.id);
  for (const purchaseId of stuck) {
    log.error(
      { purchaseId },
      "engine proof claim outlived its run: check the requester for a paid request before clearing it",
    );
  }
  return { resumed, abandoned, stuck };
}
