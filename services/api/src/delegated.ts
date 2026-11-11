import { type Cart, cartHash, toHex } from "@keelson/core";
import { agentConnections, and, type Db, eq, isNull, mandates, sql } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import type { Principal } from "./principal.ts";

/**
 * An app a user connected over OAuth (an MCP host such as claude.ai, ChatGPT or Cursor) acts for
 * that user with a delegated token: `sub` is the user, `azp` the app. The operator, its bond and
 * the `cnf` key a mandate names stay a registered agent operator's:
 *
 * - An app linked to an operator of its own (`operators.clientId` is the app) asks for mandates
 *   naming that operator, and closes them with its own key.
 * - An app with no operator of its own acts through Keelson's hosted operator (`DEMO_AGENT_ID`).
 *   Its mandates name that operator, whose bond covers the purchases, and the API closes them
 *   with that operator's `cnf` key (`KEELSON_AGENT_KEY`) over the request id and the hash of the
 *   cart the app submitted, which is the cart the TEE legs countersign. The key signs nothing else.
 *
 * Either way, a delegated token reaches only mandates its user approved for that same app, and
 * an operator's own client never reaches a mandate the user approved for another app, the hosted
 * operator's client included.
 */
export type Delegated = Principal & { kind: "client"; user: string };

export const isDelegated = (principal: Principal | undefined): principal is Delegated =>
  principal?.kind === "client" && principal.user !== undefined;

/**
 * The mandate if its user is the delegated principal's and approved it for the principal's app,
 * and the app was not disconnected since: the `agent_connections` row with that app, that user
 * and that mandate.
 */
export async function approvedMandate(
  db: Pick<Db, "select">,
  principal: Delegated,
  mandateId: string,
): Promise<typeof mandates.$inferSelect | undefined> {
  const [row] = await db
    .select({ mandate: mandates })
    .from(agentConnections)
    .innerJoin(mandates, eq(mandates.id, agentConnections.mandateId))
    .where(
      and(
        eq(agentConnections.mandateId, mandateId),
        eq(agentConnections.clientId, principal.subject),
        eq(agentConnections.userId, principal.user),
        eq(agentConnections.state, "APPROVED"),
        isNull(agentConnections.disconnectedAt),
        eq(mandates.userId, principal.user),
      ),
    )
    .limit(1);
  return row?.mandate;
}

/**
 * Closes an open mandate of the hosted operator for one countersign: the key binding over
 * `requestId` and the hash of `cart`, signed with the hosted operator's `cnf` key.
 */
export function closeForHost(
  openMandate: string,
  requestId: string,
  cart: Cart,
  hostedKey: CryptoKey,
): Promise<string> {
  return closeMandate(
    openMandate,
    { requestId, cartHash: `sha256:${toHex(cartHash(cart)).slice(2)}` },
    hostedKey,
  );
}

/**
 * For an operator's own client: the mandate was not approved for another app. A mandate the user
 * approved for an app acting for them is that app's alone, even when it names the caller's operator.
 */
export const notAnotherApps = (clientId: string) =>
  sql`not exists (select 1 from ${agentConnections} where ${agentConnections.mandateId} = ${mandates.id} and ${agentConnections.state} = 'APPROVED' and ${agentConnections.clientId} <> ${clientId})`;
