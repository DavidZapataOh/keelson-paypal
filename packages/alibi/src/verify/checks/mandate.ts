import { type Json, jcs, sha256, toHex } from "@keelson/core";
import {
  decodeDisclosed,
  hSd,
  mandateChallenge,
  type VerifiedOpenMandate,
  verifyOpenMandate,
} from "@keelson/mandate";
import { decodeJwt, importJWK, type JWK } from "jose";
import { fromBase64url, toBase64url } from "../../b64.ts";
import type { AlibiBundle } from "../../schema.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { MANDATE_EMBED_ORIGIN, MANDATE_ORIGIN, MANDATE_RP_ID } from "../trust.ts";
import { issuerThumbprint } from "./attestation.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The 64-byte `r ‖ s` of a DER ECDSA P-256 signature. */
function rawSignature(der: Uint8Array): Uint8Array {
  const int = (at: number): [Uint8Array, number] => {
    if (der[at] !== 0x02) throw new TypeError("malformed DER signature");
    const n = der[at + 1] as number;
    let v = der.subarray(at + 2, at + 2 + n);
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new TypeError("malformed DER signature");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return [out, at + 2 + n];
  };
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new TypeError("malformed DER signature");
  const [r, next] = int(2);
  const [s, end] = int(next);
  if (end !== der.length) throw new TypeError("malformed DER signature");
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

/** The user's credential as the mandate's disclosures reveal it; `payload_sd` alone holds only its digest. */
const userOf = (b: AlibiBundle): { id?: string; jwk?: JWK } | undefined => {
  try {
    const m = decodeDisclosed(b.mandate.payload_sd as object, b.mandate.disclosures as string[]);
    return (m as { user?: { cred?: { id?: string; jwk?: JWK } } }).user?.cred;
  } catch {
    return undefined;
  }
};

const opened = new WeakMap<AlibiBundle, Promise<VerifiedOpenMandate>>();

/**
 * The bundle's open mandate verified with its issuer key at the countersignature's time, once per
 * bundle: the credentials check and the policy replay both read it.
 */
export function openMandate(b: AlibiBundle): Promise<VerifiedOpenMandate> {
  let open = opened.get(b);
  if (!open) {
    open = (async () => {
      const token = b.mandate.sd_jwt;
      const kb = token.split("~")[token.split("~").indexOf("") + 1] ?? "";
      const { aud, nonce } = decodeJwt(kb) as { aud?: string; nonce?: string };
      const issuer = (await importJWK(b.mandate.issuer_jwk as JWK, "ES256")) as CryptoKey;
      return verifyOpenMandate(token, issuer, {
        expectedAud: String(aud),
        expectedNonce: String(nonce),
        now: Number(b.tee.countersign.issuedAt),
        maxSkewSec: 300,
        // A public Alibi withholds the user's login id and risk data; their digests stay signed.
        personalWithheld: true,
      });
    })();
    opened.set(b, open);
  }
  return open;
}

/** The mandate hash the countersignature binds is the challenge of this payload and commitment. */
export const challenge: CheckDef = {
  id: "mandate.challenge",
  step: 1,
  reads: ["/mandate/payload_sd", "/tee/countersign/mandateHash"],
  run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const c = input.tee.countersign;
    const m = mandateChallenge(hSd(input.mandate.payload_sd), BigInt(c.mandateCommitment));
    expect(
      toHex(m) === c.mandateHash,
      "mandateHash is not the challenge of this mandate's H_sd and commitment",
      ["/mandate/payload_sd", "/tee/countersign/mandateHash", "/tee/countersign/mandateCommitment"],
    );
    return pass();
  },
};

/**
 * The agent platform whose page framed Keelson's approval when the user signed, `embed.top_origin`
 * of the signed payload; undefined for a mandate signed at the top level in the Keelson app.
 */
function embeddedOn(b: AlibiBundle): string | undefined {
  const embed = (b.mandate.payload_sd as { embed?: { top_origin?: unknown } }).embed;
  return typeof embed?.top_origin === "string" ? embed.top_origin : undefined;
}

/**
 * The user's passkey, named in the mandate, signed its challenge with user verification, in the
 * Keelson app or, for a mandate with `embed`, in Keelson's approval framed by `embed.top_origin`
 * and no other page.
 */
export const passkey: CheckDef = {
  id: "mandate.passkey",
  step: 2,
  reads: ["/mandate/user_auth", "/mandate/payload_sd/user/cred", "/mandate/payload_sd/embed"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const auth = input.mandate.user_auth as {
      authenticatorData?: string;
      clientDataJSON?: string;
      signature?: string;
    };
    const reads = ["/mandate/user_auth", "/mandate/payload_sd/user/cred/jwk"];
    const jwk = userOf(input)?.jwk;
    expect(jwk?.kty === "EC" && jwk.crv === "P-256", "the mandate names no P-256 passkey", reads);
    const clientData = fromBase64url(auth.clientDataJSON ?? "");
    const authData = fromBase64url(auth.authenticatorData ?? "");
    const data = JSON.parse(decoder.decode(clientData)) as Record<string, unknown>;
    const m = toBase64url(
      mandateChallenge(
        hSd(input.mandate.payload_sd),
        BigInt(input.tee.countersign.mandateCommitment),
      ),
    );
    const top = embeddedOn(input);
    const payment = data.payment as { topOrigin?: unknown } | undefined;
    // WebAuthn Level 3 section 7.2 steps 11 and 12: a top-level assertion has no `topOrigin`
    // and `crossOrigin` absent or false; a framed one names its top-level origin.
    const framing =
      top === undefined
        ? data.origin === MANDATE_ORIGIN &&
          (data.crossOrigin === undefined || data.crossOrigin === false) &&
          !("topOrigin" in data)
        : data.origin === MANDATE_EMBED_ORIGIN &&
          data.crossOrigin === true &&
          data.topOrigin === top;
    expect(
      (data.type === "webauthn.get" || data.type === "payment.get") &&
        data.challenge === m &&
        framing &&
        (data.type !== "payment.get" || payment?.topOrigin === (top ?? MANDATE_ORIGIN)),
      top === undefined
        ? "the assertion is not over this mandate's challenge from the Keelson app"
        : `the assertion is not over this mandate's challenge from Keelson's approval framed by ${top}`,
      ["/mandate/user_auth/clientDataJSON", "/mandate/payload_sd/embed"],
    );
    const rpIdHash = sha256(encoder.encode(MANDATE_RP_ID));
    expect(
      authData.length === 37 &&
        rpIdHash.every((b, i) => b === authData[i]) &&
        ((authData[32] as number) & 0x05) === 0x05,
      "the authenticator data is not a user-verified assertion for keelson.finance",
      ["/mandate/user_auth/authenticatorData"],
    );
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(sha256(clientData), authData.length);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      rawSignature(fromBase64url(auth.signature ?? "")) as Uint8Array<ArrayBuffer>,
      signed,
    );
    expect(ok, "the passkey signature does not verify", ["/mandate/user_auth/signature", ...reads]);
    return pass(top === undefined ? undefined : { signedOn: new URL(top).host });
  },
};

/**
 * The open mandate is the credential issuer's, whose key the TDX attestation binds, delegating
 * exactly this payload with this passkey assertion, and the payload's disclosures are its own.
 */
export const credentials: CheckDef = {
  id: "mandate.credentials",
  step: 2,
  reads: ["/mandate"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const tdx = input.tee.attestations.find((a) => a.kind === "tdx");
    const bound = (tdx?.binding as { issuerJwkThumbprint?: string } | undefined)
      ?.issuerJwkThumbprint;
    expect(
      bound !== undefined && (await issuerThumbprint(input)) === bound.toLowerCase(),
      "the issuer key's thumbprint is not the one the TDX attestation binds",
      ["/mandate/issuer_jwk", "/tee/attestations/0/binding/issuerJwkThumbprint"],
    );
    const token = input.mandate.sd_jwt;
    let open: VerifiedOpenMandate;
    try {
      open = await openMandate(input);
    } catch (err) {
      expect(false, `the open mandate does not verify: ${(err as Error).message}`, [
        "/mandate/sd_jwt",
        "/mandate/issuer_jwk",
      ]);
    }
    expect(
      jcs(open.payload as Json) === jcs(input.mandate.payload_sd as Json),
      "the open mandate delegates another payload",
      ["/mandate/payload_sd", "/mandate/sd_jwt"],
    );
    expect(
      jcs(open.userAuth as unknown as Json) === jcs(input.mandate.user_auth as Json),
      "the open mandate carries another passkey assertion",
      ["/mandate/user_auth", "/mandate/sd_jwt"],
    );
    // The mandate's disclosures are exactly those the open mandate presents after its key binding,
    // but for the delegate payload itself.
    const parts = token.split("~");
    const presented = parts.slice(parts.indexOf("") + 2, -1).filter((d) => {
      const value = JSON.parse(decoder.decode(fromBase64url(d))).at(-1) as { v?: unknown };
      return value?.v !== "keelson.mandate.1";
    });
    expect(
      jcs([...presented].sort()) === jcs([...input.mandate.disclosures].sort()),
      "the disclosures are not the open mandate's",
      ["/mandate/disclosures", "/mandate/sd_jwt"],
    );
    return pass();
  },
};
