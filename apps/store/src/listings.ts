import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { z } from "zod";

/**
 * Where an injection goes on a listing: visible copy, a review, an accessible name, four ways of
 * hiding text from people but not from a page reader, or only the structured data.
 */
const PLACEMENTS = [
  "description",
  "review",
  "aria-label",
  "opacity",
  "offscreen",
  "color",
  "tiny",
  "json-ld",
  "api",
] as const;

export type Placement = (typeof PLACEMENTS)[number];

export const ListingRequest = z.strictObject({
  product: z.string().max(64),
  injections: z
    .array(z.strictObject({ placement: z.enum(PLACEMENTS), text: z.string().min(1).max(2000) }))
    .min(1)
    .max(8),
  ttlSeconds: z.int().min(60).max(86_400).default(3600),
});

export type Injection = z.infer<typeof ListingRequest>["injections"][number];

export interface Listing {
  id: string;
  product: string;
  injections: Injection[];
  expiresAt: string;
}

const LISTING_ID = /^[A-Za-z0-9_-]{22}$/;
const key = (id: string) => `store:listing:${id}`;

export async function putListing(
  kv: RedisClientType,
  req: z.infer<typeof ListingRequest>,
): Promise<Listing> {
  const listing: Listing = {
    id: randomBytes(16).toString("base64url"),
    product: req.product,
    injections: req.injections,
    expiresAt: new Date(Date.now() + req.ttlSeconds * 1000).toISOString(),
  };
  await kv.set(key(listing.id), JSON.stringify(listing), { EX: req.ttlSeconds });
  return listing;
}

export async function getListing(kv: RedisClientType, id: string): Promise<Listing | null> {
  if (!LISTING_ID.test(id)) return null;
  const raw = await kv.get(key(id));
  return raw ? (JSON.parse(raw) as Listing) : null;
}

export async function deleteListing(kv: RedisClientType, id: string): Promise<boolean> {
  if (!LISTING_ID.test(id)) return false;
  return (await kv.del(key(id))) > 0;
}

/** The texts of a listing at one placement, in request order. */
export function at(injections: readonly Injection[], placement: Placement): string[] {
  return injections.filter((i) => i.placement === placement).map((i) => i.text);
}
