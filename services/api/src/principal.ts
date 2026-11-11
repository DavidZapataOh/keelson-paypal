import { CHANNEL } from "./events.ts";

export interface Principal {
  kind: "user" | "client";
  subject: string;
  scopes?: string[];
  /**
   * For a client acting with a token a user delegated to it (an MCP host): that user, the token's
   * `sub`. `subject` stays the client, the token's `azp`.
   */
  user?: string;
  /** The Better Auth session a user principal came with. */
  session?: { id: string; createdAt: Date };
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal | undefined;
  }
}

/**
 * The opaque per-principal key: base64url of `<kind>:<subject>`, or of
 * `delegated:<length of user>:<user>:<subject>` for a client acting for a user, so that the users of
 * one app never share idempotency keys, rate limits or event channels. Kinds contain no `:`, so a
 * subject containing `:` cannot make two principals share a key.
 */
export function principalKey(principal: Pick<Principal, "kind" | "subject" | "user">): string {
  const { kind, subject, user } = principal;
  const key =
    kind === "client" && user !== undefined
      ? `delegated:${user.length}:${user}:${subject}`
      : `${kind}:${subject}`;
  return Buffer.from(key).toString("base64url");
}

/**
 * The principal's event channel namespace, `<principalKey>`, or one of its sub-channels,
 * `<principalKey>:<suffix>`. Subscribers and publishers must both build channels with this.
 * @internal
 */
export function principalChannel(
  principal: Pick<Principal, "kind" | "subject" | "user">,
  suffix?: string,
): string {
  const channel =
    suffix === undefined ? principalKey(principal) : `${principalKey(principal)}:${suffix}`;
  if (suffix === "" || !CHANNEL.test(channel)) {
    throw new RangeError(`invalid channel: ${channel}`);
  }
  return channel;
}
