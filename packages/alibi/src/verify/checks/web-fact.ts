import { type Cart, fromHex, type Json, jcs, sha256, toHex } from "@keelson/core";
import { hashKeelson, keelsonDomain, reportData } from "@keelson/core/eip712";
import { decodeMandate } from "@keelson/mandate";
import { getAddress, type Hex, keccak256, recoverAddress, stringToHex } from "viem";
import { bindWebFact } from "../../web-fact.ts";
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

/**
 * The WebFact is the disclosed `tlsn.web_fact` item; its committed bytes and blinder open its
 * range commitment; it names the URL's host and target; and it is the EIP-712 `WebFact` signed by
 * the attested TDX signer whose binding its `attId` names; and {@link bindWebFact} ties it to the
 * store the mandate allows, the disclosed cart and the countersign's time. A WebFact the manifest
 * holds but the Alibi leaves out is undisclosed, not absent.
 */
export const webFact: CheckDef = {
  id: "evidence.web_fact",
  step: 0,
  reads: ["/web_fact", "/cart", "/mandate/payload_sd"],
  async run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const doc = input.web_fact as unknown as WebFactDocument | undefined;
    if (doc === undefined) {
      return input.manifest.public.items.some((x) => x.type === "tlsn.web_fact")
        ? { status: "undisclosed", reads: ["/web_fact", "/manifest/public/items"] }
        : { status: "absent", reads: ["/web_fact"] };
    }
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
    let website: string | undefined;
    try {
      const m = decodeMandate(input.mandate.payload_sd, input.mandate.disclosures);
      const merchants = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
      website =
        merchants?.type === "checkout.allowed_merchants"
          ? merchants.allowed.find((x) => x.id === cart.merchant)?.website
          : undefined;
    } catch {
      website = undefined;
    }
    const bound = bindWebFact(doc, cart, website, Number(input.tee.countersign.issuedAt));
    if ("reason" in bound) expect(false, bound.reason, bound.reads);
    const { line } = bound;
    return pass({ url: doc.url, sku: line.sku });
  },
};
