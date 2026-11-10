import {
  addresses,
  checkpointAnchorAbi,
  iPYUSDAbi,
  keelsonBondVaultAbi,
  keelsonReserveAbi,
  type Verdict,
} from "@keelson/chain";
import { EXTERNAL } from "@keelson/relayer";
import {
  type Address,
  concat,
  encodeAbiParameters,
  type Hex,
  keccak256,
  type LocalAccount,
  maxUint256,
  type PublicClient,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KEELSON_TREASURY } from "../merchants.ts";

const CHAIN_ID = 421614;
const TRANSFER_WITH_AUTHORIZATION = keccak256(
  stringToHex(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);

/**
 * Chain refusals after which Keelson's treasury pays the payee itself: the verdict holds, but its
 * deadline passed, or the coverage was released or its warranty window closed, before the chain
 * paid; none of them can be undone, so the chain can never pay it later. The others mean the
 * verdict cannot be paid as signed (bad signature, nothing covered, already paid) or may still be
 * paid on chain (`InsufficientReserve`, until the reserve is refilled), and the treasury stays out.
 */
export const TREASURY_PAYS: ReadonlySet<string> = new Set([
  "CoverageNotActive",
  "Expired",
  "WarrantyWindowClosed",
]);

/** Keelson's treasury account, from its key; the key must be the treasury's. */
export function treasuryFromKey(key: Hex | undefined): LocalAccount | undefined {
  if (!key) return undefined;
  const account = privateKeyToAccount(key);
  if (account.address !== KEELSON_TREASURY) {
    throw new Error(`the treasury key signs for ${account.address}, not ${KEELSON_TREASURY}`);
  }
  return account;
}

/**
 * The arguments of PYUSD's `transferWithAuthorization` moving `value` from the treasury to `to`.
 * The EIP-3009 nonce is the verdict's digest and the signature is deterministic (RFC 6979), so
 * every retry relays the same calldata and PYUSD moves the money at most once per verdict.
 */
export async function treasuryTransfer(
  treasury: LocalAccount,
  domainSeparator: Hex,
  t: { to: Address; value: bigint; nonce: Hex },
) {
  if (!treasury.sign) throw new Error("the treasury account cannot sign a digest");
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [TRANSFER_WITH_AUTHORIZATION, treasury.address, t.to, t.value, 0n, maxUint256, t.nonce],
    ),
  );
  const signature = await treasury.sign({
    hash: keccak256(concat(["0x1901", domainSeparator, structHash])),
  });
  return [treasury.address, t.to, t.value, 0n, maxUint256, t.nonce, signature] as const;
}

/** PYUSD's EIP-712 domain separator on Arbitrum Sepolia. */
export function pyusdDomain(client: PublicClient): Promise<Hex> {
  return client.readContract({
    address: EXTERNAL[CHAIN_ID].PYUSD,
    abi: iPYUSDAbi,
    functionName: "DOMAIN_SEPARATOR",
  });
}

export type TreasuryCheck =
  | { pays: true; recipient: Address; remaining: bigint }
  | { pays: false; reason: string };

/**
 * What the chain would check had it reached the payment, read from it: the verdict was not settled
 * on chain, its checkpoint is anchored, its coverage exists for its agent, and how much that
 * coverage has left (its amount less what was slashed or paid as warranty from it). The recipient
 * is the payee's payout address when it set one, as the vault and the reserve pay.
 */
export async function treasuryCheck(
  client: PublicClient,
  v: Verdict,
  anchoredSize: bigint,
): Promise<TreasuryCheck> {
  const deployed = addresses[CHAIN_ID];
  const vault = {
    address: deployed.KeelsonBondVault as Address,
    abi: keelsonBondVaultAbi,
  } as const;
  const reserve = { address: deployed.KeelsonReserve as Address, abi: keelsonReserveAbi } as const;
  const [coverage, slashed, warranted, slashSettled, warrantySettled, origin, payout] =
    await Promise.all([
      client.readContract({ ...vault, functionName: "coverages", args: [v.coverageId] }),
      client.readContract({ ...vault, functionName: "slashed", args: [v.coverageId] }),
      client.readContract({ ...reserve, functionName: "warranted", args: [v.coverageId] }),
      client.readContract({ ...vault, functionName: "settled", args: [v.disputeId] }),
      client.readContract({ ...reserve, functionName: "settled", args: [v.disputeId] }),
      client.readContract({ ...vault, functionName: "logOrigin" }),
      client.readContract({ ...vault, functionName: "payoutAddress", args: [v.payee] }),
    ]);
  if (slashSettled || warrantySettled) return { pays: false, reason: "AlreadySettled" };
  const root = await client.readContract({
    address: deployed.CheckpointAnchor as Address,
    abi: checkpointAnchorAbi,
    functionName: "rootAt",
    args: [origin, anchoredSize],
  });
  if (v.checkpointRoot === zeroHash || root !== v.checkpointRoot) {
    return { pays: false, reason: "NotAnchored" };
  }
  if (coverage.status === 0 || BigInt(coverage.agentId) !== v.agentId) {
    return { pays: false, reason: "UnknownCoverage" };
  }
  return {
    pays: true,
    recipient: payout === zeroAddress ? v.payee : payout,
    remaining: BigInt(coverage.amount) - slashed - warranted,
  };
}
