const STD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 with padding (RFC 4648 §4); refuses non-canonical input. */
export function fromBase64(s: string): Uint8Array {
  if (!STD.test(s)) throw new TypeError("malformed base64");
  const out = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (toBase64(out) !== s) throw new TypeError("non-canonical base64");
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Unpadded base64url (RFC 4648 §5). */
export function toBase64url(b: Uint8Array): string {
  return toBase64(b).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new TypeError("malformed base64url");
  const std = s.replaceAll("-", "+").replaceAll("_", "/");
  return fromBase64(std + "=".repeat((4 - (std.length % 4)) % 4));
}
