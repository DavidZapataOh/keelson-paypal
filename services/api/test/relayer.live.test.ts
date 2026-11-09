import { readFileSync } from "node:fs";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  coverageTypedData,
  keelsonBondVaultAbi,
  keelsonReputationReporterAbi,
  keelsonValidationRegistryAbi,
  lockCoverageArgs,
  passkeyPublicKey,
  userKeyHash,
} from "@keelson/chain";
import { cartHash } from "@keelson/core";
import { type Countersign, KEELSON_TYPES } from "@keelson/core/eip712";
import { eq, mandates, operators, purchases, user } from "@keelson/db";
import { closeMandate, hSd } from "@keelson/mandate";
import { createRelayer, kmsAccount, type Relayer } from "@keelson/relayer";
import { pino } from "pino";
import { ulid } from "ulid";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  type Hex,
  hexToBytes,
  http,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { recordOutcomes, recordValidations, type SweeperDeps } from "../src/onchain/validations.ts";
import { createTee } from "../src/tee/config.ts";
import { refreshLeg } from "../src/tee/signers.ts";
import { EvidenceUploader } from "./evidence.ts";
import { testDb, testKv } from "./setup.ts";
import {
  asAgent,
  asUser,
  carts,
  headerPrincipal,
  holdOnSandboxAuthorization,
  live,
  liveEnv,
  type Passkey,
  seedUser,
  signedMandate,
  VirtualPasskey,
} from "./tee-live.ts";

const registry = JSON.parse(
  readFileSync(new URL("../../../contracts/deployments/421614.json", import.meta.url), "utf8"),
) as { demo: { agentId: number; merchant: Address }; contracts: Record<string, Address> };
const AGENT_ID = BigInt(registry.demo.agentId);
const VAULT = registry.contracts.KeelsonBondVault as Address;
const REGISTRY = registry.contracts.KeelsonValidationRegistry as Address;
const REPORTER = registry.contracts.KeelsonReputationReporter as Address;
const CYCLES = Number(process.env.RELAYER_LIVE_CYCLES ?? 1);
const SWEEP_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const relayerKeys =
  live && process.env.RELAYER_AWS_ACCESS_KEY_ID && process.env.KEELSON_OPERATOR_KEY;

describe.skipIf(!relayerKeys)(
  "a covered purchase's ERC-8004 record, live on Arbitrum Sepolia",
  { timeout: 3_600_000 },
  () => {
    const tee = createTee(liveEnv(), { a: 10_000, b: 10_000 });
    const log = pino({ level: "silent" });
    const app = createApp({
      db: testDb,
      kv: testKv,
      log,
      appOrigin: "https://app.keelson.finance",
      authenticate: headerPrincipal,
      tee,
      requestTimeoutMs: 60_000,
    });
    const evidence = new EvidenceUploader();
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL),
    });
    const logs = createPublicClient({ chain: arbitrumSepolia, transport: http() });
    const passkeys: Passkey[] = [];
    let relayer: Relayer;
    let deps: SweeperDeps;
    let mandateId: string | undefined;

    beforeAll(async () => {
      await refreshLeg(testDb, "a", tee);
      await refreshLeg(testDb, "b", tee);
      await testDb
        .insert(operators)
        .values({
          agentId: AGENT_ID,
          chainId: 421614,
          agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
          name: "Demo operator",
          cnfJwk: {},
        })
        .onConflictDoNothing();
      const kms = new KMSClient({
        region: process.env.AWS_REGION ?? "us-west-2",
        credentials: {
          accessKeyId: process.env.RELAYER_AWS_ACCESS_KEY_ID as string,
          secretAccessKey: process.env.RELAYER_AWS_SECRET_ACCESS_KEY as string,
        },
      });
      const account = await kmsAccount({
        keyId: process.env.RELAYER_KMS_KEY_SANDBOX as string,
        client: kms,
      });
      relayer = createRelayer({
        db: testDb,
        log,
        chains: {
          421614: {
            rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL as string,
            fallbackRpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
            account,
          },
        },
      });
      deps = {
        db: testDb,
        kv: testKv,
        log,
        relayer,
        chain: { client: client as PublicClient, logs: logs as PublicClient },
        outcomesFrom: await logs.getBlockNumber(),
      };
    }, 120_000);
    afterAll(async () => {
      await Promise.all(passkeys.map((p) => p.close()));
      await evidence.close();
    });

    const post = (path: string, body: unknown, headers: object) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
        body: JSON.stringify(body),
      });

    /** A real ALLOW countersign of the demo cart, with its purchase stored as the API stores it. */
    async function countersign() {
      const passkey = await VirtualPasskey.create();
      passkeys.push(passkey);
      const signed = await signedMandate(passkey, undefined, {
        agentId: AGENT_ID,
        vault: `eip155:421614:${VAULT}`,
      });
      let openMandate: string;
      if (mandateId === undefined) {
        await seedUser(testDb, passkey, signed.sub);
        const created = await post("/v1/mandates", signed.body, asUser(signed.sub));
        const stored = (await created.json()) as { id: string; openMandate: string };
        expect(created.status, JSON.stringify(stored)).toBe(201);
        mandateId = stored.id;
        openMandate = stored.openMandate;
        await holdOnSandboxAuthorization(testDb, mandateId);
      } else {
        const issued = await tee.client.a.registerMandate({
          sub: signed.sub,
          payload_sd: signed.body.payloadSd,
          disclosures: signed.body.disclosures,
          assertion: signed.assertion,
          salt: `0x${signed.salt.toString("hex")}`,
        });
        await testDb
          .insert(user)
          .values({ id: signed.sub, name: "Tester", email: `${signed.sub}@example.test` });
        await testDb
          .update(mandates)
          .set({
            userId: signed.sub,
            openMandate: issued.open_mandate,
            mandateHash: Buffer.from(hexToBytes(issued.mandate_hash as Hex)),
          })
          .where(eq(mandates.id, mandateId));
        openMandate = issued.open_mandate;
      }
      const requestId = ulid();
      const cart = carts.demo;
      const res = await post(
        "/v1/countersign",
        {
          authorizationId: process.env.PAYPAL_AUTHORIZATION_CREATED as string,
          closedMandate: await closeMandate(
            openMandate,
            { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
            signed.key,
          ),
          cart: cart.cart,
          unit: cart.unit,
          evidenceRoot: await evidence.upload(app, mandateId as string, cart.cart, asAgent),
        },
        asAgent,
      );
      const out = (await res.json()) as {
        purchaseId: string;
        mode: "2of2" | "degraded";
        decision: string;
        countersign: Record<string, string>;
        signatures: { tdx: Hex; nitro: Hex | null };
      };
      expect(res.status, JSON.stringify(out).slice(0, 300)).toBe(200);
      expect(out.decision).toBe("allow");
      return { signed, out };
    }

    test(`${CYCLES} covered purchases are validated, released, rated and settled by the sweeper`, async () => {
      const validationLags: number[] = [];
      const outcomeLags: number[] = [];
      for (let i = 0; i < CYCLES; i++) {
        const { signed, out } = await countersign();
        const cs = Object.fromEntries(
          KEELSON_TYPES.Countersign.map(({ name, type }) => [
            name,
            type.startsWith("uint")
              ? BigInt(out.countersign[name] as string)
              : out.countersign[name],
          ]),
        ) as unknown as Countersign;
        const cred = signed.body.disclosures
          .map((d) => JSON.parse(Buffer.from(d, "base64url").toString()) as unknown[])
          .find((d) => d[1] === "cred");
        const jwk = (
          (cred as unknown[])[2] as { jwk: { kty: "EC"; crv: "P-256"; x: string; y: string } }
        ).jwk;
        const { qx, qy } = passkeyPublicKey(jwk);
        const coverage = {
          coverageId: cs.requestId,
          agentId: AGENT_ID,
          merchant: registry.demo.merchant,
          amount: cs.amount * 10_000n,
          premium: 0n,
          expiresAt: Number(cs.issuedAt) + 600,
          mandateHash: cs.mandateHash,
          amberCommitment: `0x${"00".repeat(32)}` as Hex,
          userKeyHash: userKeyHash(qx, qy),
        };
        const operator = privateKeyToAccount(process.env.KEELSON_OPERATOR_KEY as Hex);
        const operatorSig = await operator.signTypedData(
          coverageTypedData(coverage, 421614, VAULT),
        );
        const lock = await relayer.submit({
          chainId: 421614,
          contract: "KeelsonBondVault",
          functionName: "lockCoverage",
          args: lockCoverageArgs({
            coverage,
            countersign: cs,
            hSd: bytesToHex(hSd(signed.body.payloadSd)),
            assertion: signed.body.assertion,
            publicKeyJwk: jwk,
            operatorSig,
            mode: out.mode,
            signatures: out.signatures,
          }),
          key: `KeelsonBondVault.lockCoverage:${cs.requestId}`,
          countersignMode: out.mode,
        });
        expect(lock.status, lock.errorCode).toBe("confirmed");
        console.info(`lock ${lock.hash} ${lock.gasUsed} gas, ${lock.latencyMs} ms`);

        // The sweeper runs on its own schedule; the purchase is validated on one of its passes.
        while (
          !(await testDb.select().from(purchases).where(eq(purchases.id, out.purchaseId)))[0]
            ?.validationTxId
        ) {
          await sleep(SWEEP_MS);
          await recordValidations(deps);
        }
        const [row] = await testDb.select().from(purchases).where(eq(purchases.id, out.purchaseId));
        const validation = await relayer.getById(row?.validationTxId as string);
        expect(validation?.status).toBe("confirmed");
        validationLags.push(
          (validation as { confirmedAt: Date }).confirmedAt.getTime() -
            (lock.confirmedAt as Date).getTime(),
        );
        console.info(`validation ${validation?.hash}, lag ${validationLags.at(-1)} ms`);

        const { releaseAfter } = await client.readContract({
          address: VAULT,
          abi: keelsonBondVaultAbi,
          functionName: "coverages",
          args: [cs.requestId],
        });
        while ((await client.getBlock()).timestamp <= BigInt(releaseAfter)) await sleep(5_000);
        const release = await relayer.submit({
          chainId: 421614,
          contract: "KeelsonBondVault",
          functionName: "releaseCoverage",
          args: [cs.requestId],
          key: `KeelsonBondVault.releaseCoverage:${cs.requestId}`,
        });
        expect(release.status).toBe("confirmed");
        const done = async () =>
          (await client.readContract({
            address: REPORTER,
            abi: keelsonReputationReporterAbi,
            functionName: "rated",
            args: [cs.requestId],
          })) &&
          (await client.readContract({
            address: REGISTRY,
            abi: keelsonValidationRegistryAbi,
            functionName: "outcomeRecorded",
            args: [cs.requestId],
          }));
        while (!(await done())) {
          await sleep(SWEEP_MS);
          await recordOutcomes(deps);
        }
        const rated = await relayer.get(
          421614,
          `KeelsonReputationReporter.rateCoverage:${cs.requestId}`,
        );
        const settled = await relayer.get(
          421614,
          `KeelsonValidationRegistry.recordOutcome:${cs.requestId}`,
        );
        const last = Math.max(
          (rated as { confirmedAt: Date }).confirmedAt.getTime(),
          (settled as { confirmedAt: Date }).confirmedAt.getTime(),
        );
        outcomeLags.push(last - (release.confirmedAt as Date).getTime());
        console.info(
          `release ${release.hash}, rate ${rated?.hash}, outcome ${settled?.hash}, lag ${outcomeLags.at(-1)} ms`,
        );
      }
      console.info(
        `validation lags ${validationLags.join(", ")} ms; outcome lags ${outcomeLags.join(", ")} ms`,
      );
      for (const lag of [...validationLags, ...outcomeLags]) expect(lag).toBeLessThan(35_000);
    });
  },
);
