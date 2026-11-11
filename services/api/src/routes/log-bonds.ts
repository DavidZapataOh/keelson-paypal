import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { addresses, logBondAbi } from "@keelson/chain";
import { LOG_ORIGINS } from "@keelson/log";
import {
  type Address,
  decodeFunctionData,
  getAddress,
  type Hex,
  hexToString,
  keccak256,
  type PublicClient,
  stringToBytes,
} from "viem";
import type { Deps } from "../app.ts";
import { blockScoped, chainUnavailable } from "../chain/reader.ts";
import { ProblemSchema } from "../problem.ts";

const CHAIN_ID = 421614;
const EXPLORER = "https://sepolia.arbiscan.io";
/** The test origin whose bond the equivocation drill slashes; nothing trusts it. */
const PYUSD = "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1";
const CONFORMANCE_ORIGIN = "log.keelson.finance/conformance/2026-1";
const ORIGINS = [LOG_ORIGINS[CHAIN_ID] as string, CONFORMANCE_ORIGIN];

const pyusdAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const Equivocation = z
  .object({
    prover: z.string(),
    amountMinor: z.string().openapi({ description: "The whole bond slashed, PYUSD base units." }),
    bountyMinor: z.string().openapi({
      description: "The prover's bounty out of it; the rest went to the bond's beneficiary.",
    }),
    provenAt: z.string(),
    size: z.string().openapi({ description: "The tree size both checkpoints state." }),
    rootA: z.string(),
    rootB: z.string(),
    noteA: z.string().nullable().openapi({
      description:
        "The first signed checkpoint, as submitted; null until its transaction is found.",
    }),
    noteB: z.string().nullable(),
    txHash: z.string().nullable(),
    explorerUrl: z.string().nullable(),
  })
  .openapi("LogEquivocation");

const Bond = z
  .object({
    chainId: z.number(),
    address: z.string(),
    origin: z.string(),
    test: z
      .boolean()
      .openapi({ description: "A test origin's bond, slashed by the equivocation drill." }),
    key: z.string().openapi({ description: "The Ed25519 log key the bond pins, hex." }),
    owner: z.string(),
    verifier: z.string().openapi({ description: "The Ed25519 verifier the bond calls." }),
    canonical: z.boolean().openapi({
      description:
        "Whether the bond calls the registry's `Ed25519Verifier` over PYUSD. A bond on another verifier or token proves nothing.",
    }),
    beneficiary: z.string().openapi({ description: "Who receives a slash, less the bounty." }),
    bountyBps: z.number(),
    completionWindowSeconds: z.number(),
    balanceMinor: z.string(),
    withdrawalDelaySeconds: z.number(),
    withdrawal: z
      .object({ amountMinor: z.string(), unlockAt: z.string(), to: z.string() })
      .nullable(),
    equivocation: Equivocation.nullable(),
    explorerUrl: z.string(),
  })
  .openapi("LogBond");

const route = createRoute({
  method: "get",
  path: "/v1/log/bonds",
  tags: ["log"],
  summary: "Log equivocation bonds",
  description:
    "The PYUSD bonds on the log keys, on Arbitrum Sepolia. Two checkpoints signed by a bond's key that state different roots for one size pay its whole balance to whoever submits them (`LogBond.proveEquivocation`). Each bond reports its balance and, once slashed, the equivocation and its transaction.",
  responses: {
    200: {
      description: "Every deployed bond",
      content: { "application/json": { schema: z.object({ bonds: z.array(Bond) }) } },
    },
    503: {
      description: "This server does not read Arbitrum Sepolia",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

type Equivocation = z.infer<typeof Equivocation>;

/** A bond's equivocation never changes once proven, so it is read once per process. */
const proven = new Map<Address, Promise<Equivocation>>();

async function equivocationOf(
  logs: PublicClient,
  address: Address,
  e: {
    prover: Address;
    amount: bigint;
    bounty: bigint;
    provenAt: number;
    size: bigint;
    l2Block: bigint;
    rootA: Hex;
    rootB: Hex;
  },
): Promise<Equivocation> {
  const found = await logs.getContractEvents({
    address,
    abi: logBondAbi,
    eventName: "EquivocationProven",
    fromBlock: e.l2Block,
    toBlock: e.l2Block,
  });
  const txHash = found[0]?.transactionHash ?? null;
  const event = found[0]?.args;
  let notes: [string, string] | null = null;
  if (txHash && event) {
    // A slash sent through another contract has other calldata: the notes then stay unknown, and
    // notes are shown only when they hash to what the event recorded.
    const tx = await logs.getTransaction({ hash: txHash });
    try {
      const { args } = decodeFunctionData({ abi: logBondAbi, data: tx.input });
      const [a, b] = args as readonly [Hex, Hex];
      if (keccak256(a) === event.noteHashA && keccak256(b) === event.noteHashB) {
        notes = [hexToString(a), hexToString(b)];
      }
    } catch {}
  }
  return {
    prover: getAddress(e.prover),
    amountMinor: e.amount.toString(),
    bountyMinor: e.bounty.toString(),
    provenAt: new Date(e.provenAt * 1000).toISOString(),
    size: e.size.toString(),
    rootA: e.rootA,
    rootB: e.rootB,
    noteA: notes?.[0] ?? null,
    noteB: notes?.[1] ?? null,
    txHash,
    explorerUrl: txHash ? `${EXPLORER}/tx/${txHash}` : null,
  };
}

export function registerLogBonds(app: OpenAPIHono, deps: Pick<Deps, "chains">): void {
  const scoped = blockScoped(16);
  app.openapi(route, async (c) => {
    const reader = deps.chains?.[CHAIN_ID];
    if (!reader) return chainUnavailable(c, CHAIN_ID);
    const deployed = Object.entries(addresses[CHAIN_ID])
      .filter(([name]) => name.startsWith("LogBond"))
      .map(([, address]) => address as Address);
    const bonds = await Promise.all(
      deployed.map(async (address) => {
        const { value } = await scoped(reader.client, address, async (blockNumber) => {
          const read = <
            F extends
              | "token"
              | "origin"
              | "key"
              | "owner"
              | "verifier"
              | "withdrawalDelay"
              | "completionWindow"
              | "beneficiary"
              | "bountyBps"
              | "withdrawal"
              | "equivocation",
          >(
            functionName: F,
          ) => reader.client.readContract({ address, abi: logBondAbi, functionName, blockNumber });
          const [
            token,
            origin,
            key,
            owner,
            verifier,
            delay,
            window,
            beneficiary,
            bountyBps,
            withdrawal,
            equivocation,
          ] = await Promise.all([
            read("token"),
            read("origin"),
            read("key"),
            read("owner"),
            read("verifier"),
            read("withdrawalDelay"),
            read("completionWindow"),
            read("beneficiary"),
            read("bountyBps"),
            read("withdrawal"),
            read("equivocation"),
          ]);
          const balance = await reader.client.readContract({
            address: token,
            abi: pyusdAbi,
            functionName: "balanceOf",
            args: [address],
            blockNumber,
          });
          return {
            token,
            origin,
            key,
            owner,
            verifier,
            delay,
            window,
            beneficiary,
            bountyBps,
            withdrawal,
            equivocation,
            balance,
          };
        });
        const e = value.equivocation;
        let equivocation: Equivocation | null = null;
        if (e.prover !== "0x0000000000000000000000000000000000000000") {
          let cached = proven.get(address);
          if (!cached) {
            cached = equivocationOf(reader.logs, address, e);
            proven.set(address, cached);
            cached.catch(() => proven.delete(address));
          }
          equivocation = await cached;
        }
        const origin =
          ORIGINS.find((o) => keccak256(stringToBytes(o)) === value.origin) ?? value.origin;
        return {
          chainId: CHAIN_ID,
          address,
          origin,
          test: origin === CONFORMANCE_ORIGIN,
          key: value.key,
          owner: getAddress(value.owner),
          verifier: getAddress(value.verifier),
          canonical:
            value.verifier === addresses[CHAIN_ID].Ed25519Verifier && value.token === PYUSD,
          beneficiary: getAddress(value.beneficiary),
          bountyBps: value.bountyBps,
          completionWindowSeconds: value.window,
          balanceMinor: value.balance.toString(),
          withdrawalDelaySeconds: value.delay,
          withdrawal:
            value.withdrawal.amount > 0n
              ? {
                  amountMinor: value.withdrawal.amount.toString(),
                  unlockAt: new Date(value.withdrawal.unlockAt * 1000).toISOString(),
                  to: getAddress(value.withdrawal.to),
                }
              : null,
          equivocation,
          explorerUrl: `${EXPLORER}/address/${address}`,
        };
      }),
    );
    c.header("Cache-Control", "public, max-age=10");
    return c.json({ bonds }, 200);
  });
}
