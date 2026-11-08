import { deploymentsFor } from "@keelson/chain";
import { and, chainTxs, type Db, eq, inArray, purchases, sql } from "@keelson/db";
import type { Logger } from "pino";
import { ulid } from "ulid";
import {
  type Address,
  BaseError,
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  fallback,
  type Hex,
  hexToBytes,
  http,
  keccak256,
  type LocalAccount,
  type PublicClient,
  TimeoutError,
  type TransactionReceipt,
  toHex,
} from "viem";
import { sendRawTransactionSync } from "viem/actions";
import { ABIS, type ContractName, ERRORS, type FunctionName, isAllowed } from "./allowlist.ts";
import { CHAINS, type ChainId, type ChainSettings } from "./chains.ts";
import { RelayerError, type RelayerErrorCode } from "./errors.ts";
import { advanceNonce, allocateNonce, nextNonce, resyncNonce } from "./nonces.ts";

const SEND_TIMEOUT_MS = 5_000;
const MAX_RESIGNS = 3;
const BASE_FEE_TTL_MS = 250;
const BALANCE_TTL_MS = 10_000;
const DUPLICATE_WAIT_MS = 5_000;
/** How long a send refused as `nonce too high` waits for predecessors still in flight before resynchronizing. */
const PREDECESSOR_WAIT_MS = 5_000;
/** A `simulating` row older than this lost its process before signing anything. */
const STALE_SIMULATION_S = 60;
const SIGNATURE_BYTES = { "2of2": 130, degraded: 65 } as const;

export type CountersignMode = keyof typeof SIGNATURE_BYTES;

export interface SubmitRequest<
  C extends ContractName = ContractName,
  F extends FunctionName<C> = FunctionName<C>,
> {
  chainId: ChainId;
  contract: C;
  functionName: F;
  args: readonly unknown[];
  /** `<contract>.<function>:<natural id>`; the same key with other calldata is refused. */
  key: string;
  /** Required for `lockCoverage`: it must equal the purchase's `countersign_mode`. */
  countersignMode?: CountersignMode;
}

export interface TxRecord {
  id: string;
  chainId: ChainId;
  key: string;
  contract: string;
  functionName: string;
  status: "pending" | "confirmed" | "reverted" | "rejected" | "dropped";
  hash?: Hex;
  nonce?: bigint;
  blockNumber?: bigint;
  blockHash?: Hex;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  latencyMs?: number;
  errorCode?: string;
  error?: { name: string; args: unknown[] };
  submittedAt?: Date;
  confirmedAt?: Date;
}

export interface RelayerStatus {
  chainId: ChainId;
  status: "up" | "down" | "degraded";
  address: Address;
  balanceWei?: bigint;
  nextNonce?: bigint;
  pending: number;
  baseFeeWei?: bigint;
}

export interface RelayerChainConfig {
  /** Reads: estimates, counts, blocks and receipts. */
  rpcUrl: string;
  /** Tried in order when `rpcUrl` fails, a provider's rate limit for one. */
  fallbackRpcUrls?: string[];
  account: LocalAccount;
  /** Writes; the chain's public sequencer endpoint by default. */
  sequencerUrl?: string;
  /** Overrides of the chain's fee and balance limits. */
  settings?: Partial<Omit<ChainSettings, "chain">>;
}

export interface Relayer {
  submit<C extends ContractName, F extends FunctionName<C>>(
    req: SubmitRequest<C, F>,
  ): Promise<TxRecord>;
  get(chainId: ChainId, key: string): Promise<TxRecord | undefined>;
  getById(id: string): Promise<TxRecord | undefined>;
  status(chainId: ChainId): Promise<RelayerStatus>;
  chains(): ChainId[];
  /** Explorer link of a transaction hash. */
  explorerUrl(chainId: ChainId, hash: Hex): string;
  reconcile(): Promise<void>;
  startReconciler(intervalMs?: number): () => void;
}

/** @internal */
export interface ChainContext {
  id: ChainId;
  settings: ChainSettings;
  account: LocalAccount;
  read: PublicClient;
  seq: PublicClient;
  baseFee?: { value: Promise<bigint>; at: number } | undefined;
  balance?: { value: Promise<bigint>; at: number } | undefined;
}

type Row = typeof chainTxs.$inferSelect;

const buf = (hex: Hex) => Buffer.from(hexToBytes(hex));
const hex = (b: Buffer | null | undefined): Hex | undefined => (b ? toHex(b) : undefined);
const ZERO_HASH = `0x${"0".repeat(64)}`;

/** The JSON form of decoded error arguments: bigints as decimal strings. */
function jsonArgs(args: readonly unknown[] | undefined): unknown[] {
  return JSON.parse(
    JSON.stringify(args ?? [], (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as unknown[];
}

function toRecord(row: Row): TxRecord {
  const status = row.status === "simulating" ? "pending" : row.status;
  const error = row.error as TxRecord["error"] | null;
  return {
    id: row.id,
    chainId: row.chainId as ChainId,
    key: row.key,
    contract: row.contract,
    functionName: row.function,
    status,
    ...(row.hash ? { hash: toHex(row.hash) } : {}),
    ...(row.nonce !== null ? { nonce: row.nonce } : {}),
    ...(row.blockNumber !== null ? { blockNumber: row.blockNumber } : {}),
    ...(row.blockHash ? { blockHash: toHex(row.blockHash) } : {}),
    ...(row.gasUsed !== null ? { gasUsed: row.gasUsed } : {}),
    ...(row.effectiveGasPrice !== null ? { effectiveGasPrice: row.effectiveGasPrice } : {}),
    ...(row.latencyMs !== null ? { latencyMs: row.latencyMs } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(error ? { error } : {}),
    ...(row.submittedAt ? { submittedAt: row.submittedAt } : {}),
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt } : {}),
  };
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The purchase id a coverage id names: a ULID right-aligned in 32 bytes. */
function bytes32ToUlid(id: Hex): string | undefined {
  if (!/^0x0{32}[0-9a-f]{32}$/i.test(id)) return undefined;
  let n = BigInt(id);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

type SendFailure = "nonce-too-low" | "nonce-too-high" | "funds" | "fee" | "ambiguous";

/** What a failed broadcast means; anything not known to be a pre-check rejection may have been accepted. */
function classify(err: unknown): SendFailure {
  const text =
    err instanceof BaseError
      ? [err.shortMessage, err.details, err.message].join(" ").toLowerCase()
      : String(err).toLowerCase();
  if (err instanceof BaseError && err.walk((e) => e instanceof TimeoutError)) return "ambiguous";
  if (text.includes("nonce too low")) return "nonce-too-low";
  if (text.includes("nonce too high")) return "nonce-too-high";
  if (text.includes("insufficient funds")) return "funds";
  if (/max fee per gas less than block base fee|fee cap less than block base fee/.test(text)) {
    return "fee";
  }
  return "ambiguous";
}

/** The custom error of a reverted simulation, or undefined when the failure was not a revert. */
function revertOf(err: unknown): { name: string; args: unknown[] } | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const withData = err.walk(
    (e) =>
      typeof (e as { data?: unknown }).data === "string" &&
      /^0x/.test((e as { data: string }).data),
  ) as { data: Hex } | null;
  if (withData && withData.data.length >= 10) {
    try {
      const decoded = decodeErrorResult({ abi: ERRORS, data: withData.data });
      return { name: decoded.errorName, args: jsonArgs(decoded.args) };
    } catch {
      return { name: "UnknownError", args: [withData.data] };
    }
  }
  const text = `${err.shortMessage} ${err.details ?? ""}`.toLowerCase();
  if (text.includes("execution reverted") || text.includes("revert")) {
    return { name: "Reverted", args: [] };
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function createRelayer(opts: {
  db: Db;
  log: Logger;
  chains: Partial<Record<ChainId, RelayerChainConfig>>;
}): Relayer {
  const { db, log } = opts;
  const contexts = new Map<ChainId, ChainContext>();
  for (const [key, cfg] of Object.entries(opts.chains) as [string, RelayerChainConfig][]) {
    const id = Number(key) as ChainId;
    const settings = { ...CHAINS[id], ...cfg.settings };
    contexts.set(id, {
      id,
      settings,
      account: cfg.account,
      read: createPublicClient({
        chain: settings.chain,
        transport: fallback([cfg.rpcUrl, ...(cfg.fallbackRpcUrls ?? [])].map((url) => http(url))),
      }),
      seq: createPublicClient({
        chain: settings.chain,
        transport: http(cfg.sequencerUrl ?? settings.sequencerUrl, {
          timeout: SEND_TIMEOUT_MS + 1_000,
          retryCount: 0,
        }),
      }),
    });
  }

  function contextOf(chainId: ChainId): ChainContext {
    const ctx = contexts.get(chainId);
    if (!ctx)
      throw new RelayerError("chain-unavailable", `the relayer does not send on chain ${chainId}`);
    return ctx;
  }

  /** One read in flight per value: concurrent submissions share it instead of each asking the RPC. */
  function cached(
    ctx: ChainContext,
    slot: "baseFee" | "balance",
    ttlMs: number,
    read: () => Promise<bigint>,
  ): Promise<bigint> {
    const hit = ctx[slot];
    if (hit && Date.now() - hit.at <= ttlMs) return hit.value;
    const value = read();
    ctx[slot] = { value, at: Date.now() };
    value.catch(() => {
      if (ctx[slot]?.value === value) ctx[slot] = undefined;
    });
    return value;
  }

  const baseFee = (ctx: ChainContext) =>
    cached(ctx, "baseFee", BASE_FEE_TTL_MS, async () => {
      const block = await ctx.read.getBlock({ blockTag: "latest" });
      return block.baseFeePerGas ?? 0n;
    });

  const balance = (ctx: ChainContext) =>
    cached(ctx, "balance", BALANCE_TTL_MS, () =>
      ctx.read.getBalance({ address: ctx.account.address }),
    );

  async function rowById(id: string): Promise<Row | undefined> {
    const [row] = await db.select().from(chainTxs).where(eq(chainTxs.id, id));
    return row;
  }

  async function rowByKey(chainId: number, key: string): Promise<Row | undefined> {
    const [row] = await db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.chainId, chainId), eq(chainTxs.key, key)));
    return row;
  }

  async function reject(
    row: Row,
    code: RelayerErrorCode,
    message: string,
    detail?: { name: string; args: unknown[] },
  ): Promise<never> {
    await db
      .update(chainTxs)
      .set({ status: "rejected", errorCode: code, error: detail ?? null })
      .where(eq(chainTxs.id, row.id));
    throw new RelayerError(code, message, { id: row.id, ...(detail ? { error: detail } : {}) });
  }

  async function finish(
    row: Row,
    receipt: TransactionReceipt,
    startedAt?: number,
  ): Promise<TxRecord> {
    const blockHash =
      receipt.blockHash && receipt.blockHash !== ZERO_HASH ? buf(receipt.blockHash) : null;
    const [done] = await db
      .update(chainTxs)
      .set({
        status: receipt.status === "success" ? "confirmed" : "reverted",
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
        blockHash,
        confirmedAt: new Date(),
        ...(startedAt !== undefined
          ? { latencyMs: Math.round(performance.now() - startedAt) }
          : {}),
      })
      .where(and(eq(chainTxs.id, row.id), eq(chainTxs.hash, buf(receipt.transactionHash))))
      .returning();
    return toRecord(done ?? ((await rowById(row.id)) as Row));
  }

  async function checkCountersign(req: SubmitRequest): Promise<void> {
    const [coverage, , , , , , , countersigs] = req.args as readonly [
      { coverageId: Hex },
      ...unknown[],
    ] as unknown as [{ coverageId: Hex }, 0, 0, 0, 0, 0, 0, Hex];
    const mode = req.countersignMode;
    const refuse = (why: string) => {
      throw new RelayerError("countersign-mode", why);
    };
    if (!mode || !(mode in SIGNATURE_BYTES)) refuse("lockCoverage needs its countersign mode.");
    const m = mode as CountersignMode;
    if ((countersigs.length - 2) / 2 !== SIGNATURE_BYTES[m]) {
      refuse(`A ${m} countersign carries ${SIGNATURE_BYTES[m]} bytes of signatures.`);
    }
    const purchaseId = bytes32ToUlid(coverage.coverageId);
    if (!purchaseId) refuse("The coverage id is not a purchase id.");
    const [purchase] = await db
      .select({ mode: purchases.countersignMode })
      .from(purchases)
      .where(eq(purchases.id, purchaseId as string));
    if (purchase?.mode !== m) refuse("The countersign mode is not the purchase's.");
  }

  /** Inserts the row, or takes back one that spent nothing; returns the record when another submission owns it. */
  async function claim(
    values: typeof chainTxs.$inferInsert,
  ): Promise<{ row: Row } | { record: TxRecord }> {
    const [inserted] = await db
      .insert(chainTxs)
      .values(values)
      .onConflictDoNothing({ target: [chainTxs.chainId, chainTxs.key] })
      .returning();
    if (inserted) return { row: inserted };
    const deadline = Date.now() + DUPLICATE_WAIT_MS;
    for (;;) {
      const existing = await rowByKey(values.chainId, values.key);
      if (!existing) throw new Error(`the row of ${values.key} vanished`);
      if (!existing.dataHash.equals(values.dataHash)) {
        throw new RelayerError("key-conflict", `${values.key} was submitted with other calldata.`, {
          id: existing.id,
        });
      }
      // Rejected and dropped calls were never executed and hold no nonce; a stale simulation never signed.
      const [taken] = await db
        .update(chainTxs)
        .set({ status: "simulating", errorCode: null, error: null, updatedAt: new Date() })
        .where(
          and(
            eq(chainTxs.id, existing.id),
            sql`(${chainTxs.status} in ('rejected', 'dropped') or (${chainTxs.status} = 'simulating'
              and ${chainTxs.updatedAt} < now() - make_interval(secs => ${STALE_SIMULATION_S})))`,
          ),
        )
        .returning();
      if (taken) return { row: taken };
      const settling = existing.status === "simulating" || existing.status === "pending";
      if (!settling || Date.now() >= deadline) return { record: toRecord(existing) };
      await sleep(100);
    }
  }

  async function send(ctx: ChainContext, row: Row, gasLimit: bigint): Promise<TxRecord> {
    const sender = ctx.account.address;
    const startedAt = performance.now();
    let attempts = 0;
    let collisions = 0;
    let current: { nonce: bigint; hash: Hex; raw: Hex } | undefined;
    let keepNonce = false;
    for (;;) {
      const nonce =
        keepNonce && current
          ? current.nonce
          : await allocateNonce(db, ctx.id, sender, () =>
              ctx.read.getTransactionCount({ address: sender, blockTag: "pending" }).then(BigInt),
            );
      keepNonce = false;
      if (!current) {
        // Visible as in flight from now on, so a successor that arrives first waits for it.
        await db
          .update(chainTxs)
          .set({ nonce })
          .where(and(eq(chainTxs.id, row.id), eq(chainTxs.status, "simulating")));
      }
      const fee = await baseFee(ctx);
      let raw: Hex;
      try {
        raw = await ctx.account.signTransaction({
          chainId: ctx.id,
          type: "eip1559",
          nonce: Number(nonce),
          to: toHex(row.to),
          data: toHex(row.data),
          gas: gasLimit,
          maxFeePerGas: 2n * fee + ctx.settings.priorityFeeWei,
          maxPriorityFeePerGas: ctx.settings.priorityFeeWei,
        });
      } catch (err) {
        log.error({ err, id: row.id }, "relayer signer failed");
        return reject(row, "chain-unavailable", "The relayer's signer did not answer.");
      }
      const hash = keccak256(raw);
      let stored: Row | undefined;
      try {
        [stored] = await db
          .update(chainTxs)
          .set({
            status: "pending",
            nonce,
            raw: buf(raw),
            hash: buf(hash),
            gasLimit,
            submittedAt: new Date(),
          })
          .where(
            current
              ? and(
                  eq(chainTxs.id, row.id),
                  eq(chainTxs.status, "pending"),
                  eq(chainTxs.hash, buf(current.hash)),
                )
              : and(eq(chainTxs.id, row.id), eq(chainTxs.status, "simulating")),
          )
          .returning();
      } catch (err) {
        // Another call already holds this nonce after a resynchronization: take the next one.
        if (isUniqueViolation(err) && ++collisions < 50) continue;
        throw err;
      }
      if (!stored) return toRecord((await rowById(row.id)) as Row);
      current = { nonce, hash, raw };

      let failure: SendFailure;
      let waitedMs = 0;
      for (;;) {
        try {
          // No `timeout` parameter: the sequencer's nodes disagree on its JSON type; the transport times out instead.
          const receipt = await sendRawTransactionSync(ctx.seq, {
            serializedTransaction: raw,
            throwOnReceiptRevert: false,
          });
          ctx.balance = undefined;
          return finish(stored, receipt, startedAt);
        } catch (err) {
          failure = classify(err);
          log.warn(
            { id: row.id, nonce, failure, err: (err as Error).message },
            "relayer send failed",
          );
        }
        // Under load a predecessor may still be signing or on its way: the same bytes go again once it lands.
        if (failure !== "nonce-too-high" || waitedMs >= PREDECESSOR_WAIT_MS) break;
        if (!(await predecessorsInFlight(ctx, nonce))) break;
        await sleep(250);
        waitedMs += 250;
      }
      if (failure === "funds") {
        return reject(stored, "relayer-low-balance", "The relayer cannot pay for gas.");
      }
      if (failure === "ambiguous") return settle(ctx, stored, raw, hash, startedAt);
      if (failure === "nonce-too-low") {
        const receipt = await ctx.read.getTransactionReceipt({ hash }).catch(() => undefined);
        if (receipt) return finish(stored, receipt, startedAt);
      }
      if (++attempts > MAX_RESIGNS) {
        return reject(stored, "chain-unavailable", "The sequencer kept refusing the transaction.");
      }
      if (failure === "fee") {
        ctx.baseFee = undefined;
        keepNonce = true;
        continue;
      }
      const count = BigInt(
        await ctx.read.getTransactionCount({ address: sender, blockTag: "pending" }),
      );
      if (failure === "nonce-too-low") await advanceNonce(db, ctx.id, sender, count);
      else await resyncNonce(db, ctx.id, sender, count);
    }
  }

  /** Whether a lower nonce of the sender was handed out moments ago and is still being signed or sent. */
  async function predecessorsInFlight(ctx: ChainContext, nonce: bigint): Promise<boolean> {
    const { rows } = await db.execute(sql`
      select 1 from chain_txs
      where chain_id = ${ctx.id} and sender = ${buf(ctx.account.address)} and nonce < ${nonce}
        and status in ('simulating', 'pending') and updated_at > now() - interval '10 seconds'
      limit 1`);
    return rows.length > 0;
  }

  /** After a lost answer: look for the receipt, broadcast the same bytes once more, and leave it to the reconciler. */
  async function settle(
    ctx: ChainContext,
    row: Row,
    raw: Hex,
    hash: Hex,
    startedAt: number,
  ): Promise<TxRecord> {
    const deadline = Date.now() + SEND_TIMEOUT_MS;
    let rebroadcast = false;
    while (Date.now() < deadline) {
      const receipt = await ctx.read.getTransactionReceipt({ hash }).catch(() => undefined);
      if (receipt) return finish(row, receipt, startedAt);
      if (!rebroadcast) {
        rebroadcast = true;
        await ctx.seq
          .request({ method: "eth_sendRawTransaction", params: [raw] })
          .catch((err: unknown) =>
            log.warn({ id: row.id, err: (err as Error).message }, "rebroadcast failed"),
          );
      }
      await sleep(250);
    }
    return toRecord((await rowById(row.id)) as Row);
  }

  const relayer: Relayer = {
    async submit(req) {
      const ctx = contextOf(req.chainId);
      if (!isAllowed(req.contract, req.functionName)) {
        throw new RelayerError(
          "not-allowed",
          `${req.contract}.${req.functionName} is not relayable.`,
        );
      }
      const to = deploymentsFor(req.chainId)[req.contract];
      if (!to)
        throw new RelayerError(
          "not-allowed",
          `${req.contract} is not deployed on chain ${req.chainId}.`,
        );
      if (req.contract === "KeelsonBondVault" && req.functionName === "lockCoverage") {
        await checkCountersign(req as SubmitRequest);
      }
      const data = encodeFunctionData({
        abi: ABIS[req.contract],
        functionName: req.functionName,
        args: req.args,
      } as Parameters<typeof encodeFunctionData>[0]);
      const claimed = await claim({
        id: ulid(),
        chainId: req.chainId,
        key: req.key,
        contract: req.contract,
        function: req.functionName,
        sender: buf(ctx.account.address),
        to: buf(to),
        data: buf(data),
        dataHash: buf(keccak256(data)),
        status: "simulating",
      });
      if ("record" in claimed) return claimed.record;
      const { row } = claimed;

      let fee: bigint;
      let funds: bigint;
      try {
        [fee, funds] = await Promise.all([baseFee(ctx), balance(ctx)]);
      } catch (err) {
        log.warn({ err: (err as Error).message, id: row.id }, "relayer chain read failed");
        return reject(row, "chain-unavailable", "The chain did not answer.");
      }
      if (fee > ctx.settings.maxBaseFeeWei) {
        return reject(row, "gas-price-cap", `The base fee ${fee} is above the relayer's cap.`);
      }
      if (funds < ctx.settings.minBalanceWei) {
        return reject(row, "relayer-low-balance", "The relayer's balance is below its minimum.");
      }
      let estimate: bigint;
      try {
        estimate = await ctx.read.estimateGas({ account: ctx.account.address, to, data });
      } catch (err) {
        const reverted = revertOf(err);
        if (reverted) {
          return reject(
            row,
            "simulation-reverted",
            `The call reverts with ${reverted.name}.`,
            reverted,
          );
        }
        log.warn({ err: (err as Error).message, id: row.id }, "relayer estimate failed");
        return reject(row, "chain-unavailable", "The chain did not answer.");
      }
      // Arbitrum's gas includes an L1 component that moves with the L1 price.
      return send(ctx, row, (estimate * 12n + 9n) / 10n);
    },

    async get(chainId, key) {
      const row = await rowByKey(chainId, key);
      return row ? toRecord(row) : undefined;
    },

    async getById(id) {
      const row = await rowById(id);
      return row ? toRecord(row) : undefined;
    },

    async status(chainId) {
      const ctx = contextOf(chainId);
      const address = ctx.account.address;
      const [{ count }] = (await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chainTxs)
        .where(
          and(eq(chainTxs.chainId, chainId), inArray(chainTxs.status, ["simulating", "pending"])),
        )) as [{ count: number }];
      try {
        const [balanceWei, baseFeeWei, stored] = await Promise.all([
          balance(ctx),
          baseFee(ctx),
          nextNonce(db, chainId, address),
        ]);
        const next =
          stored ?? BigInt(await ctx.read.getTransactionCount({ address, blockTag: "pending" }));
        const degraded =
          balanceWei < ctx.settings.minBalanceWei || baseFeeWei > ctx.settings.maxBaseFeeWei;
        return {
          chainId,
          status: degraded ? "degraded" : "up",
          address,
          balanceWei,
          nextNonce: next,
          pending: count,
          baseFeeWei,
        };
      } catch (err) {
        log.warn({ err: (err as Error).message, chainId }, "relayer status read failed");
        return { chainId, status: "down", address, pending: count };
      }
    },

    chains: () => [...contexts.keys()],

    explorerUrl: (chainId, hash) => `${CHAINS[chainId].explorer}/tx/${hash}`,

    async reconcile() {
      for (const ctx of contexts.values()) await reconcileChain(ctx);
    },

    startReconciler(intervalMs = 5_000) {
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        relayer
          .reconcile()
          .catch((err: unknown) => log.error({ err }, "relayer reconcile failed"))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };

  /** Settles pending rows, re-broadcasts lost ones, and replaces receipts that were not canonical yet. */
  async function reconcileChain(ctx: ChainContext): Promise<void> {
    const pending = await db
      .select()
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.chainId, ctx.id),
          eq(chainTxs.status, "pending"),
          sql`${chainTxs.submittedAt} < now() - interval '15 seconds'`,
        ),
      )
      .limit(100);
    let count: bigint | undefined;
    for (const row of pending) {
      const hash = hex(row.hash) as Hex;
      const receipt = await ctx.read.getTransactionReceipt({ hash }).catch(() => undefined);
      if (receipt) {
        await finish(row, receipt);
        continue;
      }
      count ??= BigInt(
        await ctx.read.getTransactionCount({ address: ctx.account.address, blockTag: "latest" }),
      );
      const ageS = (Date.now() - (row.submittedAt as Date).getTime()) / 1000;
      if ((row.nonce as bigint) < count && ageS > 60) {
        // Another transaction took the nonce: this one can never execute.
        await db
          .update(chainTxs)
          .set({ status: "dropped" })
          .where(and(eq(chainTxs.id, row.id), eq(chainTxs.status, "pending")));
        log.error({ id: row.id, key: row.key }, "relayer transaction dropped");
      } else if (ageS > 30) {
        await ctx.seq
          .request({ method: "eth_sendRawTransaction", params: [hex(row.raw) as Hex] })
          .catch((err: unknown) =>
            log.warn({ id: row.id, err: (err as Error).message }, "rebroadcast failed"),
          );
      }
    }

    // Receipts can come back before their block is final: re-read the canonical one for a while.
    const recent = await db
      .select()
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.chainId, ctx.id),
          inArray(chainTxs.status, ["confirmed", "reverted"]),
          sql`${chainTxs.confirmedAt} > now() - interval '2 minutes'`,
        ),
      )
      .limit(200);
    for (const row of recent) {
      const receipt = await ctx.read
        .getTransactionReceipt({ hash: hex(row.hash) as Hex })
        .catch(() => undefined);
      if (!receipt) {
        await db
          .update(chainTxs)
          .set({
            status: "pending",
            gasUsed: null,
            effectiveGasPrice: null,
            blockNumber: null,
            blockHash: null,
            confirmedAt: null,
          })
          .where(and(eq(chainTxs.id, row.id), eq(chainTxs.hash, row.hash as Buffer)));
        log.warn({ id: row.id, key: row.key }, "relayer receipt retracted");
      } else if (!row.blockHash?.equals(buf(receipt.blockHash))) {
        await db
          .update(chainTxs)
          .set({
            status: receipt.status === "success" ? "confirmed" : "reverted",
            blockHash: buf(receipt.blockHash),
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
          })
          .where(and(eq(chainTxs.id, row.id), eq(chainTxs.hash, row.hash as Buffer)));
      }
    }
  }

  return relayer;
}
