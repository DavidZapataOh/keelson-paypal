import { useEffect } from "react";
import { API } from "./config";

/** The base64url principal key the API names a user's channels with. */
export function userChannel(userId: string, suffix: string): string {
  const bytes = new TextEncoder().encode(`user:${userId}`);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const key = btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${key}:${suffix}`;
}

/**
 * Follows a channel of the signed-in user over SSE and calls `onEvent` with each payload. The
 * browser reconnects on its own, sending `Last-Event-ID`, so nothing is missed in between.
 */
export function useEvents(
  channel: string | undefined,
  onEvent: (payload: { type: string } & Record<string, unknown>) => void,
): void {
  useEffect(() => {
    if (!channel) return;
    const source = new EventSource(`${API}/v1/events?channel=${encodeURIComponent(channel)}`, {
      withCredentials: true,
    });
    source.addEventListener(channel, (e) => onEvent(JSON.parse((e as MessageEvent<string>).data)));
    return () => source.close();
  }, [channel, onEvent]);
}
