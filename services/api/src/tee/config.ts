import { addresses } from "@keelson/chain";
import { POLICY_SET_HASH } from "@keelson/policy/hashes";
import { type Address, createPublicClient, createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import type { ChainDeps } from "../chain/registry.ts";
import { arbitrumSepoliaTransport, POLLING_INTERVAL_MS } from "../chain/rpc.ts";
import { LegClient } from "./client.ts";
import { loadMeasurements } from "./measurements.ts";
import type { LegExpectations, TeeConfig } from "./signers.ts";

/**
 * The `verifyingContract` of the EIP-712 domain both legs were booted with: the `VerdictVerifier`,
 * at the same CREATE3 address on every chain.
 */
export const VERIFYING_CONTRACT: Address = "0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96";

/** The `KeelsonBondVault` both legs' attestations bind, at the same CREATE3 address on every chain. */
const BOND_VAULT: Address = "0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf";

/**
 * Leg A reads PayPal, so it gets longer than leg B, which only evaluates: more than the engine's
 * 5 s PayPal timeout, so a slow read ends as leg A's own answer.
 *
 * @internal
 */
export const LEG_TIMEOUT_MS = { a: 6_500, b: 500 } as const;

interface TeeEnv {
  TEE_A_URL: string;
  TEE_B_URL: string;
  KEELSON_TEE_TOKEN: string;
  ARBITRUM_SEPOLIA_RPC_URL?: string | undefined;
  /** The RFC 7638 thumbprint of the credential issuer key both legs must attest. */
  KEELSON_ISSUER_THUMBPRINT?: Hex | undefined;
  /** Registers each admitted signer in the VerdictVerifier first. */
  KEELSON_REGISTRAR_KEY?: Hex | undefined;
}

/** The registrar on Arbitrum Sepolia: the VerdictVerifier and its Nitro validator's CertManager. */
function registrar(key: Hex, rpcUrl: string | undefined): ChainDeps {
  const transport = arbitrumSepoliaTransport(rpcUrl);
  const certManager = addresses[arbitrumSepolia.id].CertManager;
  if (!certManager) throw new Error("no CertManager on Arbitrum Sepolia");
  return {
    wallet: createWalletClient({
      account: privateKeyToAccount(key),
      chain: arbitrumSepolia,
      transport,
      pollingInterval: POLLING_INTERVAL_MS,
    }),
    public: createPublicClient({
      chain: arbitrumSepolia,
      transport,
      pollingInterval: POLLING_INTERVAL_MS,
    }),
    verdictVerifier: VERIFYING_CONTRACT,
    certManager,
  };
}

/**
 * The legs and what their attestations must say. Both legs are booted with chain 421614 and the
 * bond vault, on the image whose digest is published with the deployment files.
 */
export function createTee(
  env: TeeEnv,
  timeoutMs: Record<"a" | "b", number> = LEG_TIMEOUT_MS,
): TeeConfig {
  const rpc = createPublicClient({
    chain: arbitrumSepolia,
    transport: arbitrumSepoliaTransport(env.ARBITRUM_SEPOLIA_RPC_URL),
    pollingInterval: POLLING_INTERVAL_MS,
  });
  const m = loadMeasurements();
  const common = {
    chainId: arbitrumSepolia.id,
    bondVault: BOND_VAULT,
    policySetHash: POLICY_SET_HASH.replace("sha256:", "0x") as Hex,
    engineBuildId: m.engineBuildId,
    rpc,
    ...(env.KEELSON_ISSUER_THUMBPRINT
      ? { issuerJwkThumbprint: env.KEELSON_ISSUER_THUMBPRINT }
      : {}),
  };
  const expect: Record<"a" | "b", LegExpectations> = {
    a: {
      ...common,
      measurements: m.tdx,
      rotation: m.rotation.map((p) => ({ engineBuildId: p.engineBuildId, measurements: p.tdx })),
    },
    b: {
      ...common,
      measurements: m.nitro,
      rotation: m.rotation.map((p) => ({ engineBuildId: p.engineBuildId, measurements: p.nitro })),
    },
  };
  return {
    client: {
      a: new LegClient("a", env.TEE_A_URL, env.KEELSON_TEE_TOKEN, timeoutMs.a),
      b: new LegClient("b", env.TEE_B_URL, env.KEELSON_TEE_TOKEN, timeoutMs.b),
    },
    expect,
    rpc,
    ...(env.KEELSON_REGISTRAR_KEY
      ? { chain: registrar(env.KEELSON_REGISTRAR_KEY, env.ARBITRUM_SEPOLIA_RPC_URL) }
      : {}),
  };
}
