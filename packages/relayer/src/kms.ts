import { GetPublicKeyCommand, type KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  getAddress,
  type Hex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  type LocalAccount,
  type Signature,
  serializeSignature,
  serializeTransaction,
} from "viem";
import { toAccount } from "viem/accounts";

const N = secp256k1.Point.CURVE().n;
/** `SubjectPublicKeyInfo` of a secp256k1 key: 23 bytes of algorithm identifiers, then the 65-byte uncompressed point. */
const SPKI_LENGTH = 88;

/** A KMS call failed, or KMS returned something that is not a secp256k1 signature of the key. */
export class KmsError extends Error {
  override name = "KmsError";
}

/**
 * A viem account whose secp256k1 key lives in AWS KMS (`ECC_SECG_P256K1`, `SIGN_VERIFY`) and never leaves it.
 * Every signature is low-S and carries the `yParity` that recovers the key's address.
 */
export async function kmsAccount(opts: {
  keyId: string;
  client: KMSClient;
}): Promise<LocalAccount<"kms">> {
  const { keyId, client } = opts;
  let spki: Uint8Array | undefined;
  try {
    ({ PublicKey: spki } = await client.send(new GetPublicKeyCommand({ KeyId: keyId })));
  } catch (err) {
    throw new KmsError(`GetPublicKey failed for ${keyId}`, { cause: err });
  }
  if (spki?.length !== SPKI_LENGTH || spki[SPKI_LENGTH - 65] !== 0x04) {
    throw new KmsError(`${keyId} is not a secp256k1 key`);
  }
  const point = spki.subarray(SPKI_LENGTH - 65);
  const address = getAddress(`0x${keccak256(point.subarray(1)).slice(-40)}`);
  const pointHex = bytesToHex(point).slice(2);

  async function signDigest(hash: Hex): Promise<Signature> {
    const digest = hexToBytes(hash);
    let der: Uint8Array | undefined;
    try {
      ({ Signature: der } = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        }),
      ));
    } catch (err) {
      throw new KmsError(`Sign failed for ${keyId}`, { cause: err });
    }
    if (!der) throw new KmsError(`Sign returned no signature for ${keyId}`);
    let sig = secp256k1.Signature.fromBytes(der, "der");
    // EIP-2: a high-S signature is malleable and Ethereum rejects it.
    if (sig.hasHighS()) sig = new secp256k1.Signature(sig.r, N - sig.s);
    for (const yParity of [0, 1] as const) {
      const recovered = sig.addRecoveryBit(yParity).recoverPublicKey(digest).toHex(false);
      if (recovered === pointHex) {
        return {
          r: bytesToHex(sig.toBytes("compact").subarray(0, 32)),
          s: bytesToHex(sig.toBytes("compact").subarray(32)),
          yParity,
        };
      }
    }
    throw new KmsError(`the signature of ${keyId} recovers to neither parity`);
  }

  const account = toAccount({
    address,
    async sign({ hash }) {
      return serializeSignature(await signDigest(hash));
    },
    async signMessage({ message }) {
      return serializeSignature(await signDigest(hashMessage(message)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const hash = keccak256(await serializer(transaction));
      return serializer(transaction, await signDigest(hash));
    },
    async signTypedData(typedData) {
      return serializeSignature(await signDigest(hashTypedData(typedData)));
    },
  });
  return { ...account, source: "kms" };
}
