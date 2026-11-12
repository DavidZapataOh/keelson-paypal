import { isCimdClientIdUrlCandidate } from "@better-auth/cimd";
import { z } from "@hono/zod-openapi";
import { type Db, eq, oauthClient, operators } from "@keelson/db";

/**
 * Who stands behind an OAuth client, as far as Keelson can tell:
 * - `cimd`: its `client_id` is an HTTPS URL whose metadata document the authorization server
 *   fetched itself (Client ID Metadata Document), so its host is proven.
 * - `operator`: an ERC-8004 registered agent operator linked the client.
 * - `hosted`: Keelson's own hosted operator's client.
 * - `unverified`: a client that registered itself (RFC 7591); its name is its own claim.
 */
export type ClientIdentity =
  | { kind: "cimd"; host: string; clientUri: string | null }
  | { kind: "operator"; agentId: string; operator: string; registry: string }
  | { kind: "hosted" }
  | { kind: "unverified" };

/** The identity of `clientId`; `hostedClientId` is the hosted operator's own client. */
export async function verifiedClient(
  db: Pick<Db, "select">,
  clientId: string,
  hostedClientId?: string | null,
): Promise<ClientIdentity> {
  if (hostedClientId && clientId === hostedClientId) return { kind: "hosted" };
  const [own] = await db.select().from(operators).where(eq(operators.clientId, clientId));
  if (own) {
    return {
      kind: "operator",
      agentId: own.agentId.toString(),
      operator: own.name,
      registry: own.agentRegistry,
    };
  }
  // Registration (RFC 7591) mints opaque ids, so only discovery stores a URL-shaped one.
  if (isCimdClientIdUrlCandidate(clientId)) {
    const [client] = await db
      .select({ uri: oauthClient.uri })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId));
    if (client) return { kind: "cimd", host: new URL(clientId).hostname, clientUri: client.uri };
  }
  return { kind: "unverified" };
}

export const ClientIdentitySchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("cimd"), host: z.string(), clientUri: z.string().nullable() }),
    z.object({
      kind: z.literal("operator"),
      agentId: z.string(),
      operator: z.string(),
      registry: z.string(),
    }),
    z.object({ kind: z.literal("hosted") }),
    z.object({ kind: z.literal("unverified") }),
  ])
  .openapi("ClientIdentity", {
    description:
      "Who stands behind the app. `cimd`: the host of the metadata document the authorization server fetched. `operator`: the ERC-8004 registered agent that linked it. `hosted`: Keelson's hosted operator. `unverified`: an app that registered itself; its name is its own claim.",
  });
