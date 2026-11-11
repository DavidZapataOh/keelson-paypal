import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { addresses, engineProofVerifierAbi } from "@keelson/chain";
import { type Db, type EngineProof, type EngineProved, eq, mandates, purchases } from "@keelson/db";
import type { Relayer } from "@keelson/relayer";
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
  vkey: "0x002239e16cb091e30fe341ef30ed323dc2064c7afcb39e4aa63e6fa1b9961a55" as Hex,
} as const;

/** The chain `EngineProofVerifier` records proofs on. */
const ENGINE_PROOF_CHAIN_ID = arbitrumSepolia.id;
/** The block `EngineProofVerifier` was deployed at, where its `EngineProven` history starts. */
const ENGINE_PROOF_FROM_BLOCK = 328_028_156n;

/**
 * The most PROVE, in wei, one dispute's proof may cost on the Succinct Prover Network: the prover
 * refuses a request whose Groth16 base fee plus gas limit at the bid price exceeds it.
 */
const ENGINE_PROOF_MAX_COST = 2n * 10n ** 18n;
/** The network's auction, proving and the requester's local simulation and verification. */
const PROVE_TIMEOUT_MS = 40 * 60 * 1000;
/** The free run of the program that checks a dispute's input before a proof of it is paid for. */
const EXECUTE_TIMEOUT_MS = 5 * 60 * 1000;
const RECORD_WAIT_MS = 120_000;
const RECORD_ATTEMPTS = 2;

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
  const res = await fetch(ENGINE_PROVER.url, { redirect: "follow" });
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
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Proves `input` to a Groth16 proof on the Succinct Prover Network, paid by `NETWORK_PRIVATE_KEY`. */
async function proveInput(input: CountersignInput): Promise<EngineProved> {
  if (!process.env.NETWORK_PRIVATE_KEY) throw new Error("NETWORK_PRIVATE_KEY is not set");
  const dir = await mkdtemp(join(tmpdir(), "engine-proof-"));
  try {
    const inputPath = join(dir, "input.json");
    const outPath = join(dir, "proof.json");
    await writeFile(inputPath, JSON.stringify(input));
    await run(await prover(), ["prove", inputPath, outPath], {
      timeout: PROVE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // Only what the prover needs: the workflow's other keys stay out of its environment.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NETWORK_PRIVATE_KEY: process.env.NETWORK_PRIVATE_KEY,
        SP1_PROVER: "network",
        ENGINE_PROOF_MAX_COST: ENGINE_PROOF_MAX_COST.toString(),
        RUST_LOG: "warn",
      },
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
    .select({ proof: purchases.engineProof, proved: purchases.engineProved })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (existing?.proof) return existing.proof;
  const { input, evalHash, digest } = await engineInputOf(db, purchaseId);
  const verifier = addresses[ENGINE_PROOF_CHAIN_ID].EngineProofVerifier;
  if (!verifier) throw new Error("EngineProofVerifier is not deployed");

  // A proof paid for by an earlier run that did not get recorded is recorded, not bought again.
  let proved = existing?.proved?.vkey === ENGINE_PROVER.vkey ? existing.proved : undefined;
  if (!proved) {
    // A mismatch here would repeat on every paid attempt, so it is caught before paying.
    const executed = await executeInput(input);
    if (executed.eval_hash !== evalHash || executed.countersign_digest !== digest) {
      throw new Error(`purchase ${purchaseId}: its engine input does not give its countersign`);
    }
    proved = await proveInput(input);
    if (proved.vkey !== ENGINE_PROVER.vkey) throw new Error(`engine prover vkey ${proved.vkey}`);
    if (proved.eval_hash !== evalHash || proved.countersign_digest !== digest) {
      throw new Error(`purchase ${purchaseId}: the proof is not of its countersign`);
    }
    await db.update(purchases).set({ engineProved: proved }).where(eq(purchases.id, purchaseId));
    log.info(
      { purchaseId, cycles: proved.cycles, proveMs: proved.prove_ms, network: proved.network },
      "engine evaluation proved",
    );
  }

  // The task is not retried, since a retry could pay twice, so recording gets a second attempt
  // here. The relayer key makes it find the transaction already sent rather than send another.
  let tx: Hex | undefined;
  for (let attempt = 1; !tx; attempt++) {
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
    tx =
      record.status === "confirmed" && record.hash
        ? (record.hash as Hex)
        : await recordedBy(chain, verifier, digest, evalHash);
    if (!tx && attempt === RECORD_ATTEMPTS) {
      throw new Error(
        `engine proof of ${purchaseId} is ${record.status}${record.errorCode ? ` (${record.errorCode})` : ""}`,
      );
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
