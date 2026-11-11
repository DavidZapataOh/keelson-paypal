import { passkeyRegistrationOptions, rememberPaymentPasskey } from "@keelson/mandate/browser";
import { authClient } from "./auth";

/** A passkey of the signed-in user, as `GET /v1/passkeys` lists it. */
export interface Passkey {
  id: string;
  credentialId: string;
  name: string | null;
  createdAt: string | null;
  payment: boolean;
}

const KEY = "keelson.passkeys";

/** The credential ids this browser created or signed with, newest last. */
export function localPasskeys(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Records that `credentialId` lives on this device, so mandates written here name it. */
export function rememberPasskey(credentialId: string): void {
  const ids = localPasskeys().filter((id) => id !== credentialId);
  localStorage.setItem(KEY, JSON.stringify([...ids, credentialId]));
}

/** The newest of the user's passkeys known to live on this device. */
export function devicePasskey(passkeys: readonly Passkey[]): Passkey | undefined {
  const registered = new Map(passkeys.map((p) => [p.credentialId, p]));
  return localPasskeys()
    .reverse()
    .map((id) => registered.get(id))
    .find((p) => p !== undefined);
}

export type AddResult = { ok: true } | { ok: false; stale: boolean; message: string };

/**
 * Creates a passkey on this device for the signed-in user. A user who already has one must have
 * signed in within the last minutes; `stale` says the session is older.
 */
export async function addPasskey(name: string): Promise<AddResult> {
  const opts = await passkeyRegistrationOptions();
  const res = await authClient.passkey.addPasskey({ name, ...opts });
  if (res.error || !res.data) {
    return {
      ok: false,
      stale: res.error !== null && "code" in res.error && res.error.code === "SESSION_NOT_FRESH",
      message: res.error?.message ?? "The passkey was not created. Try again.",
    };
  }
  if (opts.authenticatorAttachment === "platform") rememberPaymentPasskey(res.data.credentialID);
  rememberPasskey(res.data.credentialID);
  return { ok: true };
}
