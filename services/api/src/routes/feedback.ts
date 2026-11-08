import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { addresses, keelsonReputationReporterAbi } from "@keelson/chain";
import {
  agentRegistry,
  ERC8004,
  type Erc8004ChainId,
  erc8004ChainIds,
  reputationRegistryAbi,
} from "@keelson/erc8004";
import { type Hex, isAddressEqual, parseEventLogs } from "viem";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";

/** The block `KeelsonReputationReporter` was deployed at; Arbitrum One's registry fork block until it is. */
const SCAN_FROM: Record<Erc8004ChainId, bigint> = {
  421614: 327_279_949n,
  42161: 522_274_000n,
  11155111: 12_091_354n,
};

const Feedback = z
  .object({
    agentRegistry: z.string(),
    agentId: z.union([z.number(), z.string()]),
    clientAddress: z.string().openapi({ description: "The reporter, as a CAIP-10 account." }),
    createdAt: z.string(),
    value: z.number().int(),
    valueDecimals: z.number().int(),
    tag1: z.string(),
    tag2: z.string(),
    keelson: z.object({ coverageId: z.string(), txHash: z.string() }),
  })
  .openapi("Feedback", { description: "An ERC-8004 off-chain feedback file." });

const route = createRoute({
  method: "get",
  path: "/v1/feedback/{coverageId}",
  tags: ["reputation"],
  summary: "Feedback file of a rated coverage",
  description:
    "The off-chain feedback file the `feedbackURI` of Keelson's ERC-8004 feedback points to, built from the reporter's `CoverageRated` log and the Reputation registry's `NewFeedback` log of the same transaction.",
  request: {
    params: z.object({
      coverageId: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/)
        .openapi({ description: "The coverage id, 32 bytes of lowercase hex." }),
    }),
  },
  responses: {
    200: {
      description: "The feedback file",
      headers: z.object({ "Cache-Control": z.string() }),
      content: { "application/json": { schema: Feedback } },
    },
    404: {
      description: "The coverage was not rated",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerFeedback(app: OpenAPIHono, deps: Pick<Deps, "chains">): void {
  app.openapi(route, async (c) => {
    const coverageId = c.req.valid("param").coverageId as Hex;
    for (const chainId of erc8004ChainIds) {
      const reporter = addresses[chainId].KeelsonReputationReporter;
      const reader = deps.chains?.[chainId];
      if (!reporter || !reader) continue;
      const [rated] = await reader.logs.getContractEvents({
        address: reporter,
        abi: keelsonReputationReporterAbi,
        eventName: "CoverageRated",
        args: { coverageId },
        fromBlock: SCAN_FROM[chainId],
        toBlock: "latest",
      });
      if (!rated) continue;
      const [receipt, block] = await Promise.all([
        reader.client.getTransactionReceipt({ hash: rated.transactionHash }),
        reader.client.getBlock({ blockNumber: rated.blockNumber }),
      ]);
      const feedback = parseEventLogs({
        abi: reputationRegistryAbi,
        eventName: "NewFeedback",
        logs: receipt.logs,
        args: { agentId: rated.args.agentId, clientAddress: reporter },
      }).find((log) => isAddressEqual(log.address, ERC8004[chainId].reputation));
      if (!feedback) continue;
      const { agentId, value, valueDecimals, tag1, tag2 } = feedback.args;
      c.header("Cache-Control", "public, max-age=300");
      return c.json(
        {
          agentRegistry: agentRegistry(chainId),
          agentId:
            agentId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(agentId) : agentId.toString(),
          clientAddress: `eip155:${chainId}:${reporter}`,
          createdAt: new Date(Number(block.timestamp) * 1000).toISOString().replace(".000Z", "Z"),
          value: Number(value),
          valueDecimals,
          tag1,
          tag2,
          keelson: { coverageId, txHash: rated.transactionHash },
        },
        200,
      );
    }
    return problem(c, 404, "not-rated", "Not rated", "No Keelson feedback names this coverage.");
  });
}
