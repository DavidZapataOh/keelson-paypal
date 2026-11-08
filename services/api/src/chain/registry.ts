import { createRequire } from "node:module";
import type { SignerAttestation, VerifiedSigner } from "@keelson/attest";
import { verdictVerifierAbi } from "@keelson/chain";
import {
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  parseAbi,
  type Transport,
  type WalletClient,
} from "viem";

const require = createRequire(import.meta.url);
const { prepareHintedAttestationCalls } =
  require("./vendor/nitro-validator/hinted_attestation_calls.js") as {
    prepareHintedAttestationCalls: (
      attestation: Uint8Array,
      addresses: { certManager: Address },
    ) => {
      cold: {
        kind: "cache_ca" | "cache_leaf" | "validate_attestation";
        certHash: Hex | null;
        calldata: Hex;
        args: Record<string, Hex>;
      }[];
    };
  };

const certManagerAbi = parseAbi([
  "function loadVerified(bytes32 certHash) view returns ((bool ca, uint64 notAfter, int64 maxPathLen, bytes32 subjectHash, bytes pubKey))",
]);

/** An on-chain registration this close to its expiry is renewed. */
const RENEW_BEFORE_MS = 24 * 3_600_000;

/** Where signers are registered: the chain's `VerdictVerifier` and the `CertManager` of its Nitro validator. */
export interface ChainDeps {
  wallet: WalletClient<Transport, Chain, Account>;
  public: PublicClient;
  verdictVerifier: Address;
  certManager: Address;
}

/**
 * The registration reverted or was not mined; `reason` is the contract error or Automata's reason.
 *
 * @internal
 */
export class OnChainRegistrationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`on-chain registration failed: ${reason}`);
    this.reason = reason;
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      const args = reverted.data?.args?.map(String).join(", ");
      return name ? `${name}(${args ?? ""})` : reverted.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

async function mined(chain: ChainDeps, hash: Hex): Promise<Hex> {
  const receipt = await chain.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new OnChainRegistrationError(`transaction ${hash} reverted`);
  return hash;
}

/**
 * Registers the attested signer in the chain's `VerdictVerifier`, unless it is registered there
 * for more than another 24 hours, and waits for each receipt. A TDX signer takes one transaction;
 * a Nitro signer first caches each certificate of its document's chain the `CertManager` does not
 * hold yet, then the document.
 */
export async function ensureRegisteredOnChain(
  chain: ChainDeps,
  att: SignerAttestation,
  verified: VerifiedSigner,
  now: Date = new Date(),
): Promise<{ txs: Hex[]; expiresAt: Date }> {
  const verifier = { address: chain.verdictVerifier, abi: verdictVerifierAbi } as const;
  const [, , expiresAt, revokedAt] = await chain.public.readContract({
    ...verifier,
    functionName: "signers",
    args: [verified.signer],
  });
  if (revokedAt > 0) throw new OnChainRegistrationError("SignerIsRevoked()");
  const active = await chain.public.readContract({
    ...verifier,
    functionName: "isActive",
    args: [verified.signer, verified.teeKind],
  });
  if (active && expiresAt * 1000 - now.getTime() >= RENEW_BEFORE_MS) {
    return { txs: [], expiresAt: new Date(expiresAt * 1000) };
  }

  const b = att.binding;
  const binding = {
    teeKind: b.teeKind,
    signer: b.signer,
    policySetHash: b.policySetHash,
    engineBuildId: b.engineBuildId,
    bootEpoch: BigInt(b.bootEpoch),
    issuerJwkThumbprint: b.issuerJwkThumbprint,
  };
  const blockNumber = BigInt(att.block.number);
  const txs: Hex[] = [];
  try {
    if (att.tee === "tdx") {
      const events = att.eventLog
        .filter((e) => e.imr === 3)
        .map((e) => ({ name: e.event, payload: `0x${e.event_payload}` as Hex }));
      const { request } = await chain.public.simulateContract({
        ...verifier,
        account: chain.wallet.account,
        functionName: "registerSignerWithQuote",
        args: [`0x${att.quote}`, events, binding, blockNumber],
      });
      txs.push(await mined(chain, await chain.wallet.writeContract(request)));
    } else {
      const document = Uint8Array.from(Buffer.from(att.document, "base64"));
      const plan = prepareHintedAttestationCalls(document, { certManager: chain.certManager });
      for (const call of plan.cold) {
        if (call.kind === "validate_attestation" || !call.certHash) continue;
        const cached = await chain.public.readContract({
          address: chain.certManager,
          abi: certManagerAbi,
          functionName: "loadVerified",
          args: [call.certHash],
        });
        if (cached.pubKey !== "0x" && Number(cached.notAfter) * 1000 > now.getTime()) continue;
        const hash = await chain.wallet.sendTransaction({
          to: chain.certManager,
          data: call.calldata,
        });
        txs.push(await mined(chain, hash));
      }
      const final = plan.cold.find((call) => call.kind === "validate_attestation");
      if (!final) throw new OnChainRegistrationError("the document has no signature to validate");
      const { request } = await chain.public.simulateContract({
        ...verifier,
        account: chain.wallet.account,
        functionName: "registerSignerWithNitro",
        args: [
          final.args.attestationTbs as Hex,
          final.args.signature as Hex,
          final.args.attestationHints as Hex,
          binding,
          blockNumber,
        ],
      });
      txs.push(await mined(chain, await chain.wallet.writeContract(request)));
    }
  } catch (err) {
    if (err instanceof OnChainRegistrationError) throw err;
    throw new OnChainRegistrationError(reasonOf(err));
  }
  const [, , renewed] = await chain.public.readContract({
    ...verifier,
    functionName: "signers",
    args: [verified.signer],
  });
  return { txs, expiresAt: new Date(renewed * 1000) };
}
