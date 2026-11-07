import { POLICY_SET_HASH } from "@keelson/policy/hashes";
import { createPublicClient, type Hex, http, zeroAddress } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { LegClient } from "./client.ts";
import { loadMeasurements } from "./measurements.ts";
import type { LegExpectations, TeeConfig } from "./signers.ts";

/** The `verifyingContract` of the EIP-712 domain both legs were booted with. */
export const VERIFYING_CONTRACT = zeroAddress;

/** Leg A reads PayPal, so it gets longer than leg B, which only evaluates. */
const LEG_TIMEOUT_MS = { a: 1_500, b: 500 } as const;

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
 * zero bond vault, on the image whose digest is published with the deployment files.
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
    bondVault: zeroAddress,
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
