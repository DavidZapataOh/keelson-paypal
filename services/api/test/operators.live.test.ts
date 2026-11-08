import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, operators } from "@keelson/db";
import {
  agentRegistry,
  ERC8004,
  identityRegistryAbi,
  OPERATOR_LINK_TYPES,
  operatorLinkDomain,
  RegistrationFile,
} from "@keelson/erc8004";
import { pino } from "pino";
import { ulid } from "ulid";
import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Fork, startFork } from "../../../packages/erc8004/test/anvil.ts";
import { createApp } from "../src/app.ts";
import { DEMO_OPERATOR } from "../src/routes/operators.ts";
import { testDb, testKv } from "./setup.ts";
import { headerPrincipal } from "./tee-live.ts";

const live = process.env.KEELSON_LIVE === "1";
const linker = {
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: "operators-test",
    scopes: ["operators:write"],
  }),
};
const registry = JSON.parse(
  readFileSync(new URL("../../../contracts/deployments/421614.json", import.meta.url), "utf8"),
) as { demo: { agentId: number; operator: string } };

function cnfJwk() {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
    format: "jwk",
  });
  return { kty: "EC", crv: "P-256", x: x as string, y: y as string };
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, without whitespace. */
const thumbprint = (jwk: ReturnType<typeof cnfJwk>) =>
  `0x${createHash("sha256")
    .update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)
    .digest("hex")}` as Hex;

test("the demo operator mirrors the deployment registry", () => {
  expect(DEMO_OPERATOR.chainId).toBe(421614);
  expect(DEMO_OPERATOR.agentId).toBe(BigInt(registry.demo.agentId));
  expect(DEMO_OPERATOR.owner).toBe(registry.demo.operator);
});

describe.skipIf(!live)(
  "operators on an anvil fork of Arbitrum Sepolia",
  { timeout: 120_000 },
  () => {
    let fork: Fork;
    let app: ReturnType<typeof createApp>;

    beforeAll(async () => {
      fork = await startFork(18_805);
      app = createApp({
        db: testDb,
        kv: testKv,
        log: pino({ level: "silent" }),
        authenticate: headerPrincipal,
        chains: { 421614: { client: fork.client, logs: fork.client } },
      });
    });
    afterAll(() => fork?.stop());

    async function link(
      signer: PrivateKeyAccount,
      agentId: bigint,
      opts: { chainId?: 421614 | 11155111; deadline?: number; name?: string } = {},
    ) {
      const chainId = opts.chainId ?? 421614;
      const jwk = cnfJwk();
      const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 600;
      const signature = await signer.signTypedData({
        domain: operatorLinkDomain(chainId),
        types: OPERATOR_LINK_TYPES,
        primaryType: "OperatorLink",
        message: { agentId, cnfThumbprint: thumbprint(jwk), deadline: BigInt(deadline) },
      });
      const res = await app.request("/v1/operators", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid(), ...linker },
        body: JSON.stringify({
          chainId,
          agentId: agentId.toString(),
          name: opts.name ?? "Test operator",
          cnfJwk: jwk,
          deadline,
          signature,
        }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, jwk };
    }

    const row = (agentId: bigint) =>
      testDb.query.operators.findFirst({ where: eq(operators.agentId, agentId) });

    test("the owner links its agent", async () => {
      const owner = await fork.account();
      const agentId = await fork.register(owner);
      const { status, body, jwk } = await link(owner, agentId);
      expect(status).toBe(201);
      expect(body).toEqual({
        agentId: agentId.toString(),
        chainId: 421614,
        agentRegistry: agentRegistry(421614),
        owner: owner.address,
      });
      const stored = await row(agentId);
      expect(stored?.agentRegistry).toBe(agentRegistry(421614));
      expect(stored?.ownerAddress?.toString("hex")).toBe(owner.address.slice(2).toLowerCase());
      expect(stored?.cnfJwk).toEqual(jwk);
    });

    test("a stranger cannot link the agent", async () => {
      const agentId = await fork.register(await fork.account());
      const { status, body } = await link(await fork.account(), agentId);
      expect(status).toBe(403);
      expect(body.type).toBe("https://api.keelson.finance/problems/not-owner");
      expect(await row(agentId)).toBeUndefined();
    });

    test("after a transfer the old owner is refused and the new owner re-links", async () => {
      const owner = await fork.account();
      const next = await fork.account();
      const agentId = await fork.register(owner);
      expect((await link(owner, agentId)).status).toBe(201);
      await fork.transfer(owner, agentId, next.address);
      expect((await link(owner, agentId)).status).toBe(403);
      const relinked = await link(next, agentId, { name: "Renamed" });
      expect(relinked.status).toBe(201);
      expect(relinked.body.owner).toBe(next.address);
      const stored = await row(agentId);
      expect(stored?.name).toBe("Renamed");
      expect(stored?.ownerAddress?.toString("hex")).toBe(next.address.slice(2).toLowerCase());
    });

    test("an agent id linked on another registry is refused, not merged", async () => {
      const owner = await fork.account();
      const agentId = await fork.register(owner);
      await testDb.insert(operators).values({
        agentId,
        chainId: 11155111,
        agentRegistry: agentRegistry(11155111),
        name: "Sepolia operator",
        cnfJwk: {},
      });
      const before = await row(agentId);
      const { status, body } = await link(owner, agentId);
      expect(status).toBe(409);
      expect(body.type).toBe("https://api.keelson.finance/problems/agent-id-taken");
      expect(await row(agentId)).toEqual(before);
    });

    test("a link past its deadline is refused", async () => {
      const owner = await fork.account();
      const agentId = await fork.register(owner);
      const { status, body } = await link(owner, agentId, {
        deadline: Math.floor(Date.now() / 1000) - 1,
      });
      expect(status).toBe(422);
      expect(body.type).toBe("https://api.keelson.finance/problems/expired");
    });

    test("an unminted agent id is not found", async () => {
      const { status, body } = await link(await fork.account(), 2n ** 64n);
      expect(status).toBe(404);
      expect(body.type).toBe("https://api.keelson.finance/problems/no-agent");
    });

    test("the registration file lists every agent its on-chain owner owns", async () => {
      const owner = await fork.account();
      const first = await fork.register(owner);
      const second = await fork.register(owner);
      await link(owner, first, { name: "Two-agent operator" });
      await link(owner, second);
      for (const path of [
        `/v1/operators/421614/${second}/registration.json`,
        `/v1/operators/by-address/${owner.address.toLowerCase()}/registration.json`,
      ]) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^application\/json/);
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        const file = RegistrationFile.parse(await res.json());
        expect(file.name).toBe("Two-agent operator");
        expect(file.registrations).toEqual(
          [first, second].map((id) => ({
            agentId: Number(id),
            agentRegistry: agentRegistry(421614),
          })),
        );
        for (const r of file.registrations) {
          const onChain = await fork.client.readContract({
            address: ERC8004[421614].identity,
            abi: identityRegistryAbi,
            functionName: "ownerOf",
            args: [BigInt(r.agentId)],
          });
          expect(onChain).toBe(owner.address);
        }
      }
    });

    test("an agent transferred away leaves its old owner's registration file", async () => {
      const owner = await fork.account();
      const kept = await fork.register(owner);
      const sold = await fork.register(owner);
      await link(owner, kept);
      await link(owner, sold);
      await fork.transfer(owner, sold, (await fork.account()).address);
      const res = await app.request(`/v1/operators/by-address/${owner.address}/registration.json`);
      const file = RegistrationFile.parse(await res.json());
      expect(file.registrations.map((r) => r.agentId)).toEqual([Number(kept)]);
    });

    test("the demo operator's file is served without a linked row", async () => {
      const res = await app.request(
        `/v1/operators/by-address/${DEMO_OPERATOR.owner}/registration.json`,
      );
      expect(res.status).toBe(200);
      const file = RegistrationFile.parse(await res.json());
      expect(file.registrations).toContainEqual({
        agentId: Number(DEMO_OPERATOR.agentId),
        agentRegistry: agentRegistry(421614),
      });
    });

    test("an unlinked agent and an address owning none are not found", async () => {
      const owner = await fork.account();
      const agentId = await fork.register(owner);
      expect((await app.request(`/v1/operators/421614/${agentId}/registration.json`)).status).toBe(
        404,
      );
      expect(
        (await app.request(`/v1/operators/by-address/${owner.address}/registration.json`)).status,
      ).toBe(404);
    });
  },
);
