import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { addresses, keelsonBondVaultAbi, keelsonValidationRegistryAbi } from "@keelson/chain";
import { and, desc, eq, isNotNull, mandates, operators, sql } from "@keelson/db";
import {
  agentRegistry,
  ERC8004,
  type Erc8004ChainId,
  identityRegistryAbi,
  operatorRegistration,
  reputationRegistryAbi,
  verifyOperatorLink,
} from "@keelson/erc8004";
import { CHAINS, isChainId } from "@keelson/relayer";
import { calculateJwkThumbprint } from "jose";
import { type Address, BaseError, ContractFunctionRevertedError, getAddress, type Hex } from "viem";
import type { Deps } from "../app.ts";
import { blockScoped, chainUnavailable } from "../chain/reader.ts";
import { requireClient } from "../middleware/auth.ts";
import { ProblemSchema, problem } from "../problem.ts";

/**
 * The demo operator of the Arbitrum Sepolia deployment registry (`.demo`), linked or not.
 * @internal
 */
export const DEMO_OPERATOR = {
  chainId: 421614,
  agentId: 351n,
  owner: "0xcdA4d2330C027Aa025f4A14b525a386CE02AD98f",
  name: "Keelson demo operator",
} as const;

const IMAGE = "https://keelson.finance/icon-512.png";
const DESCRIPTION =
  "An agent operator bonded with Keelson: purchases its agents make under a Keelson mandate are covered by its PYUSD bond, which a TEE-countersigned verdict slashes when an agent breaks the mandate.";

const AGENT_ID = /^(0|[1-9]\d{0,19})$/;
/** The vault keys bonds by a `uint64` agent id. */
const MAX_AGENT_ID = 2n ** 64n - 1n;
/** A link signature is short-lived, so a superseded one cannot be replayed to undo a key rotation. */
const MAX_DEADLINE_SECONDS = 15 * 60;
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ChainId = z
  .enum(["421614", "42161", "11155111"])
  .openapi({ description: "An EIP-155 chain id." });
const AgentId = z
  .string()
  .regex(AGENT_ID)
  .refine((v) => BigInt(v) <= MAX_AGENT_ID, "agent ids are at most 2^64 - 1")
  .openapi({ description: "The ERC-8004 agent id, a decimal integer." });

const LinkOperator = z
  .object({
    chainId: z.union([z.literal(421614), z.literal(42161), z.literal(11155111)]),
    agentId: AgentId,
    name: z.string().min(1).max(200),
    cnfJwk: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: b64url32,
        y: b64url32,
        kid: z.string().max(64).optional(),
      })
      .openapi({ description: "The agent's P-256 `cnf` key, a public JWK." }),
    deadline: z
      .number()
      .int()
      .positive()
      .openapi({ description: "Unix seconds, at most 15 minutes ahead." }),
    signature: z
      .string()
      .regex(/^0x([0-9a-fA-F]{2})+$/)
      .max(2 + 2 * 4096)
      .openapi({
        description:
          'The EIP-712 `OperatorLink(uint256 agentId,bytes32 cnfThumbprint,uint256 deadline)` signature under the domain `{ name: "Keelson", version: "1", chainId }`, by the agent\'s owner or `agentWallet` (EOA, ERC-1271 or ERC-6492). `cnfThumbprint` is the RFC 7638 SHA-256 thumbprint of `cnfJwk`.',
      }),
  })
  .openapi("LinkOperator");

const Operator = z
  .object({
    agentId: AgentId,
    chainId: z.number().int(),
    agentRegistry: z.string(),
    owner: z.string().openapi({ description: "The agent's owner in the Identity registry." }),
  })
  .openapi("Operator");

const Registration = z
  .object({
    type: z.string(),
    name: z.string(),
    description: z.string(),
    image: z.string(),
    services: z.array(
      z.object({ name: z.string(), endpoint: z.string(), version: z.string().optional() }),
    ),
    x402Support: z.boolean(),
    active: z.boolean(),
    registrations: z.array(
      z.object({ agentId: z.union([z.number(), z.string()]), agentRegistry: z.string() }),
    ),
    supportedTrust: z.array(z.string()).optional(),
  })
  .openapi("AgentRegistration", {
    description: "An ERC-8004 agent registration file (`registration-v1`).",
  });

const Bond = z
  .object({
    bond: z.object({
      free: z.string(),
      locked: z.string(),
      queued: z.string(),
      slashCount: z.number().int(),
    }),
    reputation: z.object({
      count: z.number().int(),
      value: z.string().openapi({ description: "The average feedback value, fixed-point." }),
      decimals: z.number().int(),
      slashes: z.number().int(),
    }),
    validation: z.object({ count: z.number().int(), averageResponse: z.number().int() }),
  })
  .openapi("OperatorBond", {
    description:
      "The operator's bond in PYUSD base units, the Keelson feedback it has in the ERC-8004 Reputation registry, and the TEE countersigns recorded for it in the Keelson validation registry.",
  });

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const cached = z.object({ "Cache-Control": z.string() });

const link = createRoute({
  method: "post",
  path: "/v1/operators",
  tags: ["operators"],
  summary: "Link an ERC-8004 agent as an operator",
  description:
    "Binds the agent's `cnf` key to its ERC-8004 identity once its owner or `agentWallet` signs `OperatorLink`. The owner of an agent that is already linked re-links it, after a transfer for example.",
  middleware: [requireClient(["operators:write"])],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: LinkOperator } } },
  },
  responses: {
    201: {
      description: "The operator is linked",
      content: { "application/json": { schema: Operator } },
    },
    401: { description: "No valid access token", content: problemContent },
    403: {
      description: "Not signed by the agent's owner or agent wallet",
      content: problemContent,
    },
    404: { description: "No such agent in the Identity registry", content: problemContent },
    409: { description: "The agent id is linked on another registry", content: problemContent },
    422: { description: "Invalid, or past its deadline", content: problemContent },
    503: { description: "The chain cannot be read", content: problemContent },
  },
});

const registrationContent = { "application/json": { schema: Registration } };

const byAddress = createRoute({
  method: "get",
  path: "/v1/operators/by-address/{address}/registration.json",
  tags: ["operators"],
  summary: "Registration file of an owner's agents",
  description:
    "The ERC-8004 registration file listing every linked agent whose owner in the Identity registry is `address` now.",
  request: {
    params: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
  },
  responses: {
    200: { description: "The registration file", headers: cached, content: registrationContent },
    404: { description: "The address owns no linked agent", content: problemContent },
    503: { description: "The chain cannot be read", content: problemContent },
  },
});

const byAgent = createRoute({
  method: "get",
  path: "/v1/operators/{chainId}/{agentId}/registration.json",
  tags: ["operators"],
  summary: "Registration file of an agent",
  description:
    "The ERC-8004 registration file of the agent's current owner, listing every linked agent it owns.",
  request: { params: z.object({ chainId: ChainId, agentId: AgentId }) },
  responses: {
    200: { description: "The registration file", headers: cached, content: registrationContent },
    404: { description: "Not a linked agent", content: problemContent },
    503: { description: "The chain cannot be read", content: problemContent },
  },
});

const bond = createRoute({
  method: "get",
  path: "/v1/operators/{chainId}/{agentId}/bond",
  tags: ["operators"],
  summary: "Bond, reputation and validations of an agent",
  description:
    'Read on-chain in one multicall: the vault\'s `bonds(agentId)`, the Reputation registry\'s `getSummary(agentId, [reporter, relayer], "keelson", "")` (coverage outcomes, and faults the bond did not pay) and its `"slash"` count, and the validation registry\'s `getSummary(agentId, [VerdictVerifier], "")`.',
  request: { params: z.object({ chainId: ChainId, agentId: AgentId }) },
  responses: {
    200: { description: "The bond", content: { "application/json": { schema: Bond } } },
    404: { description: "Keelson is not deployed on the chain", content: problemContent },
    503: { description: "The chain cannot be read", content: problemContent },
  },
});

const reverted = (err: unknown) =>
  err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) !== null;

const OperatorMandate = z
  .object({
    id: z.string(),
    state: z.literal("ACTIVE"),
    currency: z.string(),
    maxMinor: z.number().int(),
    remainingMinor: z.number().int(),
    expiresAt: z.string().openapi({ format: "date-time" }),
    holdMode: z.enum(["mandate", "per_purchase"]).nullable(),
    authorizationId: z.string().nullable().openapi({
      description:
        "The PayPal authorization that holds the mandate's funds, when the mandate is held as a whole.",
    }),
    openMandate: z.string().openapi({
      description:
        "The mandate as issued, which the agent closes with its `cnf` key for each countersign.",
    }),
  })
  .openapi("OperatorMandate");

const operatorMandates = createRoute({
  method: "get",
  path: "/v1/operators/{agentId}/mandates",
  tags: ["operators"],
  summary: "The active mandates naming the operator",
  description:
    "Lists the active mandates whose operator is `agentId`, with their open mandates and holds, so that the operator's agent can buy under them. Only the OAuth client that linked the operator (`POST /v1/operators`) reads them; any other caller gets 404.",
  middleware: [requireClient(["countersign:write"])],
  request: { params: z.object({ agentId: AgentId }) },
  responses: {
    200: {
      description: "The operator's active mandates, newest first",
      content: {
        "application/json": { schema: z.object({ mandates: z.array(OperatorMandate) }) },
      },
    },
    401: { description: "No valid access token", content: problemContent },
    403: { description: "The token lacks countersign:write", content: problemContent },
    404: { description: "No operator this client linked", content: problemContent },
  },
});

export function registerOperators(app: OpenAPIHono, deps: Pick<Deps, "db" | "chains">): void {
  const { db } = deps;

  const bonds = blockScoped();

  /** The agent's owner on `chainId`, or `null` if it is not minted. */
  async function ownerOf(chainId: Erc8004ChainId, agentId: bigint): Promise<Address | null> {
    const reader = deps.chains?.[chainId];
    if (!reader) throw new ChainUnavailable(chainId);
    try {
      return await reader.client.readContract({
        address: ERC8004[chainId].identity,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
      });
    } catch (err) {
      if (reverted(err)) return null;
      throw err;
    }
  }

  /** The registration file of `owner`: its linked agents it still owns, on chains this server reads. */
  async function registrationOf(owner: Address) {
    const rows = await db
      .select({ agentId: operators.agentId, chainId: operators.chainId, name: operators.name })
      .from(operators)
      .where(eq(operators.ownerAddress, Buffer.from(owner.slice(2), "hex")))
      .orderBy(operators.createdAt);
    const candidates: { chainId: Erc8004ChainId; agentId: bigint; name: string }[] = rows.map(
      (r) => ({ chainId: r.chainId as Erc8004ChainId, agentId: r.agentId, name: r.name }),
    );
    if (
      owner === DEMO_OPERATOR.owner &&
      !candidates.some(
        (r) => r.chainId === DEMO_OPERATOR.chainId && r.agentId === DEMO_OPERATOR.agentId,
      )
    ) {
      candidates.push(DEMO_OPERATOR);
    }
    const owners = await Promise.all(
      candidates.map((r) => (deps.chains?.[r.chainId] ? ownerOf(r.chainId, r.agentId) : null)),
    );
    const owned = candidates.filter((_, i) => owners[i] === owner);
    const [first] = owned;
    if (!first) return null;
    return operatorRegistration({
      name: first.name,
      description: DESCRIPTION,
      image: IMAGE,
      registrations: owned.map(({ chainId, agentId }) => ({ chainId, agentId })),
    });
  }

  app.openapi(link, async (c) => {
    const body = c.req.valid("json");
    const chainId = body.chainId;
    const reader = deps.chains?.[chainId];
    if (!reader) return chainUnavailable(c, chainId);
    const agentId = BigInt(body.agentId);
    if (body.deadline > Date.now() / 1000 + MAX_DEADLINE_SECONDS) {
      return problem(
        c,
        422,
        "deadline-too-far",
        "Deadline too far",
        "A link's deadline is at most 15 minutes ahead.",
      );
    }
    const thumbprint = Buffer.from(
      await calculateJwkThumbprint(
        { kty: body.cnfJwk.kty, crv: body.cnfJwk.crv, x: body.cnfJwk.x, y: body.cnfJwk.y },
        "sha256",
      ),
      "base64url",
    );
    const result = await verifyOperatorLink(
      reader.client,
      chainId,
      agentId,
      `0x${thumbprint.toString("hex")}`,
      BigInt(body.deadline),
      body.signature as Hex,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "expired":
          return problem(c, 422, "expired", "Expired", "The link's deadline has passed.");
        case "no-agent":
          return problem(
            c,
            404,
            "no-agent",
            "No such agent",
            `Agent ${agentId} is not minted in the Identity registry of chain ${chainId}.`,
          );
        case "not-owner":
          return problem(
            c,
            403,
            "not-owner",
            "Not the owner",
            "The link is not signed by the agent's owner or its agent wallet.",
          );
      }
    }
    const registry = agentRegistry(chainId);
    const owner = Buffer.from(result.owner.slice(2), "hex");
    // The digest is over the signed message, not the signature, which ECDSA lets anyone re-encode.
    const linkDigest = createHash("sha256")
      .update(`${chainId}:${agentId}:${thumbprint.toString("hex")}:${body.deadline}`)
      .digest();
    const [linked] = await db
      .select({ linkDigest: operators.linkDigest })
      .from(operators)
      .where(eq(operators.agentId, agentId));
    if (linked?.linkDigest && Buffer.from(linked.linkDigest).equals(linkDigest)) {
      return problem(
        c,
        409,
        "link-used",
        "Link used",
        "This link signature was already used; the owner signs a new one to link again.",
      );
    }
    const [row] = await db
      .insert(operators)
      .values({
        agentId,
        chainId,
        agentRegistry: registry,
        name: body.name,
        cnfJwk: body.cnfJwk,
        ownerAddress: owner,
        clientId: c.var.principal?.subject,
        linkDigest,
      })
      .onConflictDoUpdate({
        target: operators.agentId,
        set: {
          name: body.name,
          cnfJwk: body.cnfJwk,
          ownerAddress: owner,
          clientId: c.var.principal?.subject,
          linkDigest,
        },
        setWhere: sql`${operators.agentRegistry} = ${registry} and ${operators.linkDigest} is distinct from ${linkDigest}`,
      })
      .returning({ agentId: operators.agentId });
    if (!row) {
      return problem(
        c,
        409,
        "agent-id-taken",
        "Agent id taken",
        `Agent id ${agentId} is linked on another registry.`,
      );
    }
    return c.json(
      { agentId: body.agentId, chainId, agentRegistry: registry, owner: result.owner },
      201,
    );
  });

  app.openapi(byAddress, async (c) => {
    try {
      const file = await registrationOf(getAddress(c.req.valid("param").address));
      if (!file) {
        return problem(c, 404, "not-found", "Not found", "The address owns no linked agent.");
      }
      c.header("Cache-Control", "public, max-age=300");
      return c.json(file, 200);
    } catch (err) {
      if (err instanceof ChainUnavailable) return chainUnavailable(c, err.chainId);
      throw err;
    }
  });

  app.openapi(byAgent, async (c) => {
    const params = c.req.valid("param");
    const chainId = Number(params.chainId) as Erc8004ChainId;
    const agentId = BigInt(params.agentId);
    const notLinked = () =>
      problem(
        c,
        404,
        "not-found",
        "Not found",
        `Agent ${agentId} is not linked on chain ${chainId}.`,
      );
    const isDemo = chainId === DEMO_OPERATOR.chainId && agentId === DEMO_OPERATOR.agentId;
    if (!isDemo) {
      const [row] = await db
        .select({ agentId: operators.agentId })
        .from(operators)
        .where(
          and(eq(operators.agentId, agentId), eq(operators.agentRegistry, agentRegistry(chainId))),
        );
      if (!row) return notLinked();
    }
    try {
      const owner = await ownerOf(chainId, agentId);
      const file = owner && (await registrationOf(owner));
      if (!file) return notLinked();
      c.header("Cache-Control", "public, max-age=300");
      return c.json(file, 200);
    } catch (err) {
      if (err instanceof ChainUnavailable) return chainUnavailable(c, err.chainId);
      throw err;
    }
  });

  app.openapi(bond, async (c) => {
    const params = c.req.valid("param");
    const chainId = Number(params.chainId) as Erc8004ChainId;
    const agentId = BigInt(params.agentId);
    const reader = deps.chains?.[chainId];
    if (!reader) return chainUnavailable(c, chainId);
    const deployed = addresses[chainId];
    const vault = deployed.KeelsonBondVault;
    const reporter = deployed.KeelsonReputationReporter;
    const validation = deployed.KeelsonValidationRegistry;
    const verifier = deployed.VerdictVerifier;
    if (!vault || !reporter || !validation || !verifier) {
      return problem(
        c,
        404,
        "not-deployed",
        "Not deployed",
        `Keelson's vault and ERC-8004 contracts are not deployed on chain ${chainId}.`,
      );
    }
    const reputation = {
      address: ERC8004[chainId].reputation,
      abi: reputationRegistryAbi,
    } as const;
    const started = performance.now();
    const { value, hit } = await bonds(reader.client, `${chainId}:${agentId}`, (blockNumber) =>
      reader.client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          { address: vault, abi: keelsonBondVaultAbi, functionName: "bonds", args: [agentId] },
          {
            ...reputation,
            functionName: "getSummary",
            args: [agentId, keelsonClients(chainId, reporter), "keelson", ""],
          },
          {
            ...reputation,
            functionName: "getSummary",
            args: [agentId, [reporter], "keelson", "slash"],
          },
          {
            address: validation,
            abi: keelsonValidationRegistryAbi,
            functionName: "getSummary",
            args: [agentId, [verifier], ""],
          },
        ],
      }),
    );
    const [b, all, slashes, validations] = value;
    c.header(
      "Server-Timing",
      `chain;dur=${(performance.now() - started).toFixed(1)};desc=${hit ? "hit" : "miss"}`,
    );
    c.header("Cache-Control", "public, max-age=15");
    return c.json(
      {
        bond: {
          free: b.free.toString(),
          locked: b.locked.toString(),
          queued: b.queued.toString(),
          slashCount: Number(b.slashCount),
        },
        reputation: {
          count: Number(all[0]),
          value: all[1].toString(),
          decimals: all[2],
          slashes: Number(slashes[0]),
        },
        validation: { count: Number(validations[0]), averageResponse: validations[1] },
      },
      200,
    );
  });

  app.openapi(operatorMandates, async (c) => {
    const agentId = BigInt(c.req.valid("param").agentId);
    const [operator] = await db
      .select({ clientId: operators.clientId })
      .from(operators)
      .where(eq(operators.agentId, agentId));
    // The same answer for an unknown operator and another client's, so neither is disclosed.
    if (!operator?.clientId || operator.clientId !== c.var.principal?.subject) {
      return problem(c, 404, "not-found", "Not found", "No operator this client linked.");
    }
    const rows = await db
      .select()
      .from(mandates)
      .where(
        and(
          eq(mandates.operatorAgentId, agentId),
          eq(mandates.state, "ACTIVE"),
          isNotNull(mandates.openMandate),
        ),
      )
      .orderBy(desc(mandates.createdAt));
    return c.json(
      {
        mandates: rows.map((m) => ({
          id: m.id,
          state: "ACTIVE" as const,
          currency: m.currency,
          maxMinor: Number(m.maxMinor),
          remainingMinor: Number(m.remainingMinor),
          expiresAt: m.expiresAt.toISOString(),
          holdMode: m.holdMode,
          authorizationId: m.paypalAuthorizationId,
          openMandate: m.openMandate as string,
        })),
      },
      200,
    );
  });
}

/**
 * Keelson's ERC-8004 feedback clients on a chain: the reporter, which rates coverage outcomes, and
 * the relayer, which rates the faults Keelson's treasury paid for.
 */
function keelsonClients(chainId: number, reporter: Address): Address[] {
  return isChainId(chainId) ? [reporter, CHAINS[chainId].sender] : [reporter];
}

class ChainUnavailable extends Error {
  readonly chainId: number;

  constructor(chainId: number) {
    super(`chain ${chainId} is not read`);
    this.chainId = chainId;
  }
}
