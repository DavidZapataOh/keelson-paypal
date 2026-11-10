import { addresses, iPYUSDAbi, keelsonBondVaultAbi, keelsonReserveAbi } from "@keelson/chain";
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
 * window, its deadline or the reserve ran out before the chain paid. The others mean the verdict
 * cannot be paid as signed (bad signature, nothing covered, already paid) and the treasury stays out.
 */
export const TREASURY_PAYS: ReadonlySet<string> = new Set([
  "CoverageNotActive",
  "Expired",
  "InsufficientReserve",
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

/** What a coverage can still pay: its amount less what was slashed or paid as warranty from it. */
export async function remainingCoverage(client: PublicClient, coverageId: Hex): Promise<bigint> {
  const deployed = addresses[CHAIN_ID];
  const [coverage, slashed, warranted] = await Promise.all([
    client.readContract({
      address: deployed.KeelsonBondVault as Address,
      abi: keelsonBondVaultAbi,
      functionName: "coverages",
      args: [coverageId],
    }),
    client.readContract({
      address: deployed.KeelsonBondVault as Address,
      abi: keelsonBondVaultAbi,
      functionName: "slashed",
      args: [coverageId],
    }),
    client.readContract({
      address: deployed.KeelsonReserve as Address,
      abi: keelsonReserveAbi,
      functionName: "warranted",
      args: [coverageId],
    }),
  ]);
  return BigInt(coverage.amount) - slashed - warranted;
}
