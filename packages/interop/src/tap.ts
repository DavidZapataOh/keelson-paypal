import {
  createSignature,
  type Signer as HttpSigner,
  type SignatureFields,
  type SignatureMessage,
  type VerifiedSignature,
  type Verifier,
  verifySignature,
} from "http-message-sig";
import type { EcPublicJwk, Signer } from "./jose.ts";

/**
 * Visa Trusted Agent Protocol and Web Bot Auth: the agent signs its HTTP requests with RFC 9421
 * (github.com/visa/trusted-agent-protocol, `tap-agent`; draft-meunier-webbotauth-httpsig-protocol).
 * Keelson's extension: the request carries the purchase's Alibi in `Keelson-Alibi`, which the
 * signature covers, so a merchant can tie the agent's checkout to the Keelson countersign. TAP
 * itself defines no field for a mandate.
 */

/** The header that names the purchase's Alibi: its id and its verify URL. */
export const ALIBI_HEADER = "keelson-alibi";

/** TAP's `tag` for browsing and for paying. */
export const TAP_TAGS = { browse: "agent-browser-auth", pay: "agent-payer-auth" } as const;

/** RFC 9421 section 3.3.4. */
export const ECDSA_P256 = "ecdsa-p256-sha256";

/** TAP's label and covered components; `keelson-alibi` is added when the request names an Alibi. */
const LABEL = "sig2";
const COMPONENTS = ["@authority", "@path"] as const;

/** An RFC 9421 signer over an ES256 key: ECDSA P-256 with SHA-256, `r || s` (RFC 9421 §3.3.4). */
export const ecdsaSigner = (key: CryptoKey): HttpSigner => ({
  algorithm: ECDSA_P256,
  async sign(data) {
    return new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource),
    );
  },
});

/** The verifier for {@link ecdsaSigner}'s signatures. */
export async function ecdsaVerifier(jwk: EcPublicJwk): Promise<Verifier> {
  const { kty, crv, x, y } = jwk;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty, crv, x, y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return {
    algorithm: ECDSA_P256,
    verify: (data, signature) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature as BufferSource,
        data as BufferSource,
      ),
  };
}

/** The `Keelson-Alibi` value: the Alibi id and the URL its verifier opens. */
export const alibiHeader = (alibiId: string, verifyUrl: string): string =>
  `${alibiId}; url="${verifyUrl}"`;

/**
 * Signs a request as TAP's agent does: `@authority` and `@path` (and `keelson-alibi` when the
 * request carries one), `created`, `expires` (at most 8 minutes later), `keyid`, `alg`, `nonce` and
 * `tag`. Returns the `Signature-Input` and `Signature` field values.
 */
export function signAgentRequest(
  message: SignatureMessage,
  agent: Signer,
  opts: {
    tag: (typeof TAP_TAGS)[keyof typeof TAP_TAGS];
    created: number;
    nonce: string;
    withAlibi: boolean;
  },
): Promise<SignatureFields> {
  return createSignature(message, {
    label: LABEL,
    components: opts.withAlibi ? [...COMPONENTS, ALIBI_HEADER] : [...COMPONENTS],
    parameters: {
      created: opts.created,
      expires: opts.created + 8 * 60,
      keyid: agent.kid,
      alg: ECDSA_P256,
      nonce: opts.nonce,
      tag: opts.tag,
    },
    signer: ecdsaSigner(agent.key),
  });
}

/**
 * Verifies an agent's TAP signature with the key `resolve` returns for its `keyid`, requiring
 * `Keelson-Alibi` to be covered when `requireAlibi` is set.
 */
export function verifyAgentRequest(
  message: SignatureMessage,
  resolve: (keyid: string) => Promise<EcPublicJwk>,
  opts: { now: number; requireAlibi: boolean },
): Promise<VerifiedSignature> {
  return verifySignature(message, {
    label: LABEL,
    policy: {
      algorithms: [ECDSA_P256],
      requiredComponents: opts.requireAlibi ? [...COMPONENTS, ALIBI_HEADER] : [...COMPONENTS],
      requiredParameters: ["created", "expires", "keyid", "nonce", "tag"],
      maxAge: 8 * 60,
      now: opts.now,
      validate: ({ parameters }) => Object.values(TAP_TAGS).includes(parameters.tag as never),
    },
    async resolveVerifier(candidate) {
      const keyid = candidate.parameters.keyid;
      if (typeof keyid !== "string") throw new Error("no keyid");
      return ecdsaVerifier(await resolve(keyid));
    },
  });
}
