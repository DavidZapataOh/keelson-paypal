import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { agentConnections, and, type Db, eq, isNotNull, isNull, mandates } from "@keelson/db";

/** The RFC 9396 `authorization_details` type an app asks for spending limits with. */
export const MANDATE_DETAILS_TYPE = "keelson_mandate";

/**
 * RFC 9396 for spending: the authorization server advertises `keelson_mandate`, and an access
 * token issued to an app for a user carries, as `authorization_details`, each mandate that user
 * approved for it and has not ended, with its limits (§7: the details granted, enriched with the
 * mandate's id).
 */
export function rarExtension(db: Db): OAuthProviderExtension {
  return {
    metadata: () => ({ authorization_details_types_supported: [MANDATE_DETAILS_TYPE] }),
    claims: {
      accessToken: async ({ client, user }) => {
        if (!user) return {};
        const granted = await db
          .select({ connection: agentConnections, mandate: mandates })
          .from(agentConnections)
          .innerJoin(mandates, eq(mandates.id, agentConnections.mandateId))
          .where(
            and(
              eq(agentConnections.clientId, client.clientId),
              eq(agentConnections.userId, user.id),
              eq(agentConnections.state, "APPROVED"),
              isNull(agentConnections.disconnectedAt),
              isNotNull(agentConnections.mandateId),
              isNull(mandates.revokeRequestedAt),
            ),
          );
        if (granted.length === 0) return {};
        return {
          authorization_details: granted.map(({ connection: c, mandate: m }) => ({
            type: MANDATE_DETAILS_TYPE,
            mandate_id: m.id,
            operator_agent_id: m.operatorAgentId.toString(),
            limits: {
              currency: m.currency,
              perPurchaseMinor: c.perPurchaseMinor.toString(),
              totalMinor: m.maxMinor.toString(),
              merchants: m.merchantIds,
              until: m.expiresAt.toISOString(),
            },
          })),
        };
      },
    },
  };
}
