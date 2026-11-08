import { POLICY_SET_HASH } from "@keelson/policy/hashes";
import { type Address, createPublicClient, type Hex, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
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
    transport: http(env.ARBITRUM_SEPOLIA_RPC_URL),
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
    a: { ...common, measurements: m.tdx },
    b: { ...common, measurements: m.nitro },
  };
  return {
    client: {
      a: new LegClient("a", env.TEE_A_URL, env.KEELSON_TEE_TOKEN, timeoutMs.a),
      b: new LegClient("b", env.TEE_B_URL, env.KEELSON_TEE_TOKEN, timeoutMs.b),
    },
    expect,
    rpc,
  };
}
