import { CHANNEL } from "./events.ts";

export interface Principal {
  kind: "user" | "client";
  subject: string;
  scopes?: string[];
  /** The Better Auth session a user principal came with. */
  session?: { id: string; createdAt: Date };
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal | undefined;
  }
}

/**
 * The opaque per-principal key: base64url of `<kind>:<subject>`. Kinds contain no `:`, so a
 * subject containing `:` cannot make two principals share a key.
 */
export function principalKey(principal: Pick<Principal, "kind" | "subject">): string {
  return Buffer.from(`${principal.kind}:${principal.subject}`).toString("base64url");
}

/**
 * The principal's event channel namespace, `<principalKey>`, or one of its sub-channels,
 * `<principalKey>:<suffix>`. Subscribers and publishers must both build channels with this.
 * @internal
 */
export function principalChannel(
  principal: Pick<Principal, "kind" | "subject">,
  suffix?: string,
): string {
  const channel =
    suffix === undefined ? principalKey(principal) : `${principalKey(principal)}:${suffix}`;
  if (suffix === "" || !CHANNEL.test(channel)) {
    throw new RangeError(`invalid channel: ${channel}`);
  }
  return channel;
}
