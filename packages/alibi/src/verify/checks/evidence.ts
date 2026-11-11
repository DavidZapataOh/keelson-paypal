import { type Cart, cartHash, type Json, jcs, sha256, toHex } from "@keelson/core";
import {
  type Disclosure,
  type ItemType,
  type Manifest,
  MEDIA_TYPES,
  ORIGINAL_MEDIA_TYPE,
  verifyDisclosure,
  verifyManifest,
} from "@keelson/evidence";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle, UNDISCLOSED } from "./util.ts";

/** The only items an Alibi opens: the PII-redacted public ones. */
const DISCLOSED = new Set(["api.product", "api.cart", "channel3.observation", "tlsn.web_fact"]);

/** The media type Keelson accepts for an item type; the leaf hides it until the item is opened. */
const mediaTypeOf = (type: string) =>
  type.endsWith(".original")
    ? ORIGINAL_MEDIA_TYPE
    : (MEDIA_TYPES as Record<string, string>)[type as ItemType];

/**
 * The public manifest builds the evidence root the countersignature binds, every disclosure opens
 * its item under that root, and the cart and the Channel3 observation are the disclosed items'
 * content; the cart is the one the countersign names.
 */
export const evidence: CheckDef = {
  id: "evidence.manifest",
  step: 0,
  reads: ["/manifest"],
  run(input) {
    if (!isBundle(input)) return UNDISCLOSED;
    const m = input.manifest.public as Manifest;
    expect(verifyManifest(m), "the manifest's leaves do not build its root", [
      "/manifest/public/items",
      "/manifest/public/root",
    ]);
    for (const [i, item] of m.items.entries()) {
      expect(
        item.media_type === mediaTypeOf(item.type),
        `item ${item.type} is not ${mediaTypeOf(item.type) ?? "a known type"}`,
        [`/manifest/public/items/${i}/media_type`, `/manifest/public/items/${i}/type`],
      );
    }
    expect(m.root === input.tee.countersign.evidenceRoot, "root", [
      "/manifest/public/root",
      "/tee/countersign/evidenceRoot",
    ]);
    const seen = new Set<string>();
    for (const [i, d] of input.manifest.disclosures.entries()) {
      const at = `/manifest/disclosures/${i}`;
      const item = m.items[d.index];
      expect(
        DISCLOSED.has(d.type) && !seen.has(d.type) && item?.type === d.type,
        "an Alibi discloses only the public product, cart, Channel3 and WebFact items, once each",
        [at],
      );
      seen.add(d.type);
      expect(
        d.size === m.items.length && verifyDisclosure(m.root, d as Disclosure),
        "the disclosure does not open its item under the root",
        [at],
      );
    }
    const cart = input.cart;
    if (cart !== undefined) {
      const i = input.manifest.disclosures.findIndex((d) => d.type === "api.cart");
      const d = input.manifest.disclosures[i];
      expect(
        d !== undefined &&
          toHex(sha256(new TextEncoder().encode(jcs(cart as Json)))) === d.content_hash,
        "the cart is not the disclosed item",
        ["/cart", `/manifest/disclosures/${i}/content_hash`],
      );
      let hash: string | undefined;
      try {
        hash = toHex(cartHash(cart as unknown as Cart));
      } catch {
        hash = undefined;
      }
      expect(hash === input.tee.countersign.cartHash, "the cart is not the countersigned one", [
        "/cart",
        "/tee/countersign/cartHash",
      ]);
    }
    const obs = input.channel3_observation;
    if (obs !== undefined) {
      const i = input.manifest.disclosures.findIndex((d) => d.type === "channel3.observation");
      const d = input.manifest.disclosures[i];
      expect(
        d !== undefined &&
          toHex(sha256(new TextEncoder().encode(jcs(obs as Json)))) === d.content_hash,
        "the Channel3 observation is not the disclosed item",
        ["/channel3_observation", `/manifest/disclosures/${i}/content_hash`],
      );
    }
    return pass({ disclosed: [...seen].join(" ") });
  },
};
