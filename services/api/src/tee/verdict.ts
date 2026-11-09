import type { Db } from "@keelson/db";
import { type Hex, isAddressEqual, recoverAddress } from "viem";
import type { VerdictJson, VerdictRequest, VerdictSigned } from "./client.ts";
import { activeSigner, type Leg, type TeeConfig } from "./signers.ts";

export interface SignedVerdict {
  message: VerdictJson;
  chainId: number;
  digest: Hex;
  signatures: { tee: number; signer: Hex; signature: Hex }[];
}

class VerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictError";
  }
}

const same = (a: VerdictJson, b: VerdictJson) =>
  (Object.keys(a) as (keyof VerdictJson)[]).every((k) => a[k].toLowerCase() === b[k].toLowerCase());

/**
 * Has both legs attribute the dispute and sign its `Verdict`. Each answer must recover to the
 * leg's admitted signer, and both must sign the same message; anything less is no verdict.
 */
export async function verdict2of2(
  deps: { db: Db; tee: Pick<TeeConfig, "client"> },
  req: VerdictRequest,
): Promise<SignedVerdict> {
  const legs: Leg[] = ["a", "b"];
  const answers = await Promise.all(legs.map((leg) => deps.tee.client[leg].verdict(req)));
  const [a, b] = answers as [VerdictSigned, VerdictSigned];
  if (a.digest !== b.digest || !same(a.verdict, b.verdict) || a.chain_id !== b.chain_id) {
    throw new VerdictError("the legs signed different verdicts");
  }
  for (const [i, answer] of answers.entries()) {
    const kind = i === 0 ? 1 : 2;
    const signer = await activeSigner(deps.db, kind);
    if (!signer || !isAddressEqual(signer.address, answer.signer)) {
      throw new VerdictError(`leg ${legs[i]} signed with a signer that is not admitted`);
    }
    const recovered = await recoverAddress({ hash: answer.digest, signature: answer.signature });
    if (!isAddressEqual(recovered, answer.signer)) {
      throw new VerdictError(`leg ${legs[i]}'s signature does not recover to its signer`);
    }
  }
  return {
    message: a.verdict,
    chainId: a.chain_id,
    digest: a.digest,
    signatures: answers.map((x) => ({ tee: x.tee, signer: x.signer, signature: x.signature })),
  };
}
