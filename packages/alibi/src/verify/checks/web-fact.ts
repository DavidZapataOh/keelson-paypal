import {
  type Cart,
  CURRENCIES,
  type CurrencyCode,
  fromHex,
  fromPayPalValue,
  type Json,
  jcs,
  sha256,
  toHex,
} from "@keelson/core";
import { hashKeelson, keelsonDomain, reportData } from "@keelson/core/eip712";
import { getAddress, type Hex, keccak256, recoverAddress, stringToHex } from "viem";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

/** The `tlsn.web_fact` evidence item: the store's product endpoint, notarized by leg A. */
interface WebFactDocument {
  url: string;
  web_fact: {
    hostHash: Hex;
    urlPathHash: Hex;
    tCapture: number;
    rangeCommitment: Hex;
    attId: Hex;
  };
  chain_id: number;
  digest: Hex;
  signature: Hex;
  signer: string;
  committed: Hex;
  blinder: Hex;
}

/** How long before the countersign the store's endpoint may have been notarized. */
const WEB_FACT_MAX_AGE_SEC = 900;
/** How far the notary's clock may run ahead of the countersign's. */
const WEB_FACT_SKEW_SEC = 60;

/** The committed object of a Shopify `.oembed` body: one variant's offer. */
interface Offer {
  offer_id?: unknown;
  sku?: unknown;
  price?: unknown;
  currency_code?: unknown;
}

/** The cart line the notarized offer is for, priced at the offer's price, or `undefined`. */
function lineOf(offer: Offer, cart: Cart): Cart["lines"][number] | undefined {
  const currency = offer.currency_code;
  if (
    typeof currency !== "string" ||
    currency !== cart.currency ||
    !Object.hasOwn(CURRENCIES, currency) ||
    typeof offer.price !== "number"
  ) {
    return undefined;
  }
  let minor: bigint;
  try {
    minor = fromPayPalValue(currency as CurrencyCode, String(offer.price)).minor;
  } catch {
    return undefined;
  }
  const ids = [offer.sku, offer.offer_id].filter(
    (x) => (typeof x === "string" && x !== "") || typeof x === "number",
  );
  return cart.lines.find(
    (l) => ids.some((id) => String(id) === l.sku) && BigInt(l.unit_minor) === minor,
  );
}

/**
 * The WebFact is the disclosed `tlsn.web_fact` item; its committed bytes and blinder open its
 * range commitment; it names the URL's host and target; and it is the EIP-712 `WebFact` signed by
 * the attested TDX signer whose binding its `attId` names. Its committed offer is a line of the
 * disclosed cart at that line's price, notarized within {@link WEB_FACT_MAX_AGE_SEC} before the
 * countersign.
 */
export const webFact: CheckDef = {
  id: "evidence.web_fact",
  step: 0,
  reads: ["/web_fact", "/cart"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const doc = input.web_fact as unknown as WebFactDocument | undefined;
    if (doc === undefined) return { status: "absent", reads: ["/web_fact"] };
    const i = input.manifest.disclosures.findIndex((d) => d.type === "tlsn.web_fact");
    expect(
      toHex(sha256(new TextEncoder().encode(jcs(doc as unknown as Json)))) ===
        input.manifest.disclosures[i]?.content_hash,
      "the WebFact is not the disclosed item",
      ["/web_fact", `/manifest/disclosures/${i}/content_hash`],
    );
    const f = doc.web_fact;
    expect(
      toHex(sha256(new Uint8Array([...fromHex(doc.committed), ...fromHex(doc.blinder)]))) ===
        f.rangeCommitment.toLowerCase(),
      "the committed bytes do not open the range commitment",
      ["/web_fact/committed", "/web_fact/blinder", "/web_fact/web_fact/rangeCommitment"],
    );
    const url = new URL(doc.url);
    expect(
      f.hostHash.toLowerCase() === keccak256(stringToHex(url.hostname)) &&
        f.urlPathHash.toLowerCase() === keccak256(stringToHex(`${url.pathname}${url.search}`)),
      "the WebFact names another URL",
      ["/web_fact/url", "/web_fact/web_fact"],
    );
    const d = input.tee.domain;
    expect(doc.chain_id === d.chain_id, "the WebFact is of another chain", [
      "/web_fact/chain_id",
      "/tee/domain/chain_id",
    ]);
    const digest = hashKeelson(
      "WebFact",
      f,
      keelsonDomain(d.chain_id as 421614, d.verifying_contract as Hex),
    );
    expect(digest === doc.digest.toLowerCase(), "digest", ["/web_fact/digest"]);
    const a = input.tee.attestations.find((x) => x.kind === "tdx");
    expect(a, "no TDX attestation", ["/tee/attestations"]);
    const signer = await recoverAddress({ hash: digest, signature: doc.signature });
    expect(
      signer === getAddress(doc.signer) && signer === getAddress(a.signer),
      "the WebFact is not signed by the attested TDX signer",
      ["/web_fact/signature", "/web_fact/signer", "/tee/attestations"],
    );
    const b = a.binding as unknown as Record<string, string | number>;
    const attId = reportData(
      {
        chainId: BigInt(b.chainId as string),
        bondVault: b.bondVault as Hex,
        teeKind: Number(b.teeKind) as 1 | 2,
        signer: b.signer as Hex,
        policySetHash: b.policySetHash as Hex,
        engineBuildId: b.engineBuildId as Hex,
        bootEpoch: BigInt(b.bootEpoch as string),
        issuerJwkThumbprint: b.issuerJwkThumbprint as Hex,
      },
      `0x${"00".repeat(32)}`,
    ).slice(0, 66);
    expect(f.attId.toLowerCase() === attId.toLowerCase(), "attId is not the signer's binding", [
      "/web_fact/web_fact/attId",
      "/tee/attestations",
    ]);
    const cart = input.cart as unknown as Cart | undefined;
    expect(cart, "the WebFact is not tied to a disclosed cart", ["/web_fact", "/cart"]);
    let offer: Offer | undefined;
    try {
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(fromHex(doc.committed)),
      );
      offer =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : undefined;
    } catch {
      offer = undefined;
    }
    expect(offer, "the committed bytes are not one offer", ["/web_fact/committed"]);
    const line = lineOf(offer, cart);
    expect(line, "the notarized offer is not a line of the cart at its price", [
      "/web_fact/committed",
      "/cart/lines",
    ]);
    const issuedAt = Number(input.tee.countersign.issuedAt);
    expect(
      f.tCapture >= issuedAt - WEB_FACT_MAX_AGE_SEC && f.tCapture <= issuedAt + WEB_FACT_SKEW_SEC,
      "the WebFact was not notarized for this purchase",
      ["/web_fact/web_fact/tCapture", "/tee/countersign/issuedAt"],
    );
    return pass({ url: doc.url, sku: line.sku });
  },
};
