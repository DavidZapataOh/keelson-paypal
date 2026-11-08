import { readFileSync } from "node:fs";
import { verdictVerifierAbi } from "@keelson/chain";
import { type Address, type Hex, parseEventLogs } from "viem";
import { describe, expect, test } from "vitest";
import {
  ensureRegisteredOnChain,
  OnChainRegistrationError,
  registerOnChain,
} from "../src/chain/registry.ts";
import { type SignerAttestation, verifySigner } from "../src/tee/attest.ts";
import { createTee } from "../src/tee/config.ts";
import { live, liveEnv } from "./tee-live.ts";

/**
 * Against the deployed `VerdictVerifier` on Arbitrum Sepolia, whose node runs the real `ArbSys` and
 * EIP-2935 history. Needs `KEELSON_REGISTRAR_KEY` funded with Sepolia ETH.
 */
const registrarKey = process.env.KEELSON_REGISTRAR_KEY as Hex | undefined;
const run = live && registrarKey !== undefined;

function deps() {
  const tee = createTee({ ...liveEnv(), KEELSON_REGISTRAR_KEY: registrarKey });
  if (!tee.chain) throw new Error("no registrar");
  return { tee, chain: tee.chain };
}

async function fresh(leg: "a" | "b") {
  const { tee } = deps();
  if (leg === "b") {
    const block = await tee.rpc.getBlock();
    await tee.client.b.refresh({ number: block.number, hash: block.hash });
  } else {
    await tee.client.a.refresh();
  }
  const attestation = await tee.client[leg].attestation();
  const verified = await verifySigner(attestation, { ...tee.expect[leg], now: new Date() });
  return { attestation, verified };
}

async function signer(address: Address) {
  const { chain } = deps();
  return chain.public.readContract({
    address: chain.verdictVerifier,
    abi: verdictVerifierAbi,
    functionName: "signers",
    args: [address],
  });
}

async function refused(att: SignerAttestation, binding: Partial<SignerAttestation["binding"]>) {
  const { chain } = deps();
  const changed = { ...att, binding: { ...att.binding, ...binding } } as SignerAttestation;
  return registerOnChain(chain, changed, new Date()).then(
    () => "registered",
    (err: unknown) => (err instanceof OnChainRegistrationError ? err.reason : String(err)),
  );
}

describe.skipIf(!run)("on-chain signer registration", { timeout: 300_000 }, () => {
  test("registers leg B's live Nitro signer with its measurement and a 72 h validity", async () => {
    const { chain } = deps();
    const { attestation, verified } = await fresh("b");
    const started = Date.now();
    const { txs } = await ensureRegisteredOnChain(chain, attestation, verified);
    const latency = Date.now() - started;
    const [teeKind, registeredAt, expiresAt, revokedAt, measurement] = await signer(
      verified.signer,
    );
    expect(teeKind).toBe(2);
    expect(revokedAt).toBe(0);
    expect(`nitro:${measurement.slice(2)}`).toBe(verified.measurement);
    expect(expiresAt).toBeGreaterThan(Date.now() / 1000 + 71 * 3600);
    for (const hash of txs) {
      const receipt = await chain.public.getTransactionReceipt({ hash });
      console.log(`nitro tx ${hash}: ${receipt.gasUsed} gas`);
      const events = parseEventLogs({
        abi: verdictVerifierAbi,
        logs: receipt.logs,
        eventName: "SignerRegistered",
      });
      for (const e of events) {
        expect(e.args.signer).toBe(verified.signer);
        expect(e.args.registeredAt).toBe(registeredAt);
        expect(e.args.expiresAt).toBe(expiresAt);
      }
    }
    console.log(`leg b admitted on-chain in ${latency} ms (${txs.length} transactions)`);
  });

  test("refuses a Nitro document bound to another signer", async () => {
    const { attestation } = await fresh("b");
    expect(
      await refused(attestation, { signer: "0x000000000000000000000000000000000000dEaD" }),
    ).toBe("BindingMismatch()");
  });

  test("refuses another issuer, which the report data commits to", async () => {
    const { attestation } = await fresh("b");
    expect(await refused(attestation, { issuerJwkThumbprint: `0x${"11".repeat(32)}` })).toBe(
      "BindingMismatch()",
    );
  });

  // Leg A's quote verifies on-chain only while Automata's PCCS holds Intel's TDX TCB info for its
  // FMSPC; `dcap-collateral` checks that.
  describe.skipIf(process.env.KEELSON_LIVE_TDX !== "1")("tdx", () => {
    test("registers leg A's live TDX signer", async () => {
      const { chain } = deps();
      const { attestation, verified } = await fresh("a");
      const started = Date.now();
      const { txs } = await ensureRegisteredOnChain(chain, attestation, verified);
      console.log(`leg a admitted on-chain in ${Date.now() - started} ms`);
      for (const hash of txs) {
        console.log(
          `tdx tx ${hash}: ${(await chain.public.getTransactionReceipt({ hash })).gasUsed} gas`,
        );
      }
      const [teeKind, , , revokedAt, measurement] = await signer(verified.signer);
      expect(teeKind).toBe(1);
      expect(revokedAt).toBe(0);
      expect(`tdx:${measurement.slice(2)}`).toBe(verified.measurement);
    });

    test("refuses the old captured quote, bound to the zero bond vault", async () => {
      const evidence = JSON.parse(
        readFileSync(
          new URL("../../../packages/attest/test/evidence/tdx-leg-a.json", import.meta.url),
          "utf8",
        ),
      ) as { attestation: SignerAttestation & { event_log: never } };
      const att = {
        ...evidence.attestation,
        eventLog: evidence.attestation.event_log,
      } as SignerAttestation;
      expect(await refused(att, {})).toMatch(/BindingMismatch|StaleBlock|UnknownBlock/);
    });

    test("refuses a quote whose binding names another signer", async () => {
      const { attestation } = await fresh("a");
      expect(
        await refused(attestation, { signer: "0x000000000000000000000000000000000000dEaD" }),
      ).toBe("BindingMismatch()");
    });
  });
});
