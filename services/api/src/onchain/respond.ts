import { z } from "@hono/zod-openapi";
import { type Relayer, RelayerError, type TxRecord } from "@keelson/relayer";
import type { Context } from "hono";
import { ProblemSchema, problem } from "../problem.ts";

export const TxRecordSchema = z
  .object({
    id: z.string(),
    chainId: z.number().int(),
    key: z.string().openapi({ description: "`<contract>.<function>:<natural id>`." }),
    contract: z.string(),
    functionName: z.string(),
    status: z.enum(["pending", "confirmed", "reverted", "rejected", "dropped"]),
    hash: z.string().optional(),
    nonce: z.string().optional(),
    blockNumber: z.string().optional(),
    blockHash: z.string().optional(),
    gasUsed: z.string().optional(),
    effectiveGasPrice: z.string().optional(),
    latencyMs: z.number().int().optional(),
    errorCode: z.string().optional(),
    error: z.object({ name: z.string(), args: z.array(z.unknown()) }).optional(),
    explorerUrl: z.string().optional(),
  })
  .openapi("Transaction", { description: "A transaction the Keelson relayer sent and paid for." });

export type TxRecordJson = z.infer<typeof TxRecordSchema>;

export function txJson(relayer: Relayer, r: TxRecord): TxRecordJson {
  return {
    id: r.id,
    chainId: r.chainId,
    key: r.key,
    contract: r.contract,
    functionName: r.functionName,
    status: r.status,
    ...(r.hash ? { hash: r.hash, explorerUrl: relayer.explorerUrl(r.chainId, r.hash) } : {}),
    ...(r.nonce !== undefined ? { nonce: r.nonce.toString() } : {}),
    ...(r.blockNumber !== undefined ? { blockNumber: r.blockNumber.toString() } : {}),
    ...(r.blockHash ? { blockHash: r.blockHash } : {}),
    ...(r.gasUsed !== undefined ? { gasUsed: r.gasUsed.toString() } : {}),
    ...(r.effectiveGasPrice !== undefined
      ? { effectiveGasPrice: r.effectiveGasPrice.toString() }
      : {}),
    ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

/** The responses of every route that relays a call. */
export const relayedResponses = {
  200: {
    description: "Confirmed on-chain",
    content: { "application/json": { schema: TxRecordSchema } },
  },
  202: {
    description: "Sent and not yet confirmed; poll `Location`",
    headers: z.object({ Location: z.string() }),
    content: { "application/json": { schema: TxRecordSchema } },
  },
  401: { description: "No valid credentials", content: problemContent },
  403: { description: "Not allowed", content: problemContent },
  409: { description: "The same call was submitted with other arguments", content: problemContent },
  422: {
    description: "Invalid, or the call reverts: `error` names the contract's custom error",
    content: problemContent,
  },
  503: {
    description: "The relayer cannot send now: chain unavailable, gas price cap or low balance",
    content: problemContent,
  },
} as const;

/** Relays one call and answers with its record, or the problem that stopped it. */
export async function relay(
  c: Context,
  relayer: Relayer | undefined,
  submit: (relayer: Relayer) => Promise<TxRecord>,
) {
  if (!relayer) {
    return problem(
      c,
      503,
      "chain-unavailable",
      "Chain unavailable",
      "This server relays no transactions.",
    );
  }
  let record: TxRecord;
  try {
    record = await submit(relayer);
  } catch (err) {
    if (!(err instanceof RelayerError)) throw err;
    const detail = err.detail as { error?: { name: string; args: unknown[] } } | undefined;
    return problem(c, err.status, err.code, err.message, undefined, {
      code: err.code,
      ...(detail?.error ? { error: detail.error } : {}),
    });
  }
  const body = txJson(relayer, record);
  if (record.status === "confirmed") return c.json(body, 200);
  if (record.status === "pending") {
    c.header("Location", `/v1/transactions/${record.id}`);
    return c.json(body, 202);
  }
  if (record.status === "reverted") {
    return problem(c, 422, "transaction-reverted", "Transaction reverted", undefined, {
      transaction: body,
    });
  }
  return problem(c, 503, record.errorCode ?? "chain-unavailable", "Not sent", undefined, {
    code: record.errorCode,
    transaction: body,
  });
}
