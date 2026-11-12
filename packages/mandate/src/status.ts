import { compactVerify, decodeJwt } from "jose";

/** Where Keelson publishes the status list of its mandates (draft-ietf-oauth-status-list-21). */
export const STATUS_URI = "https://api.keelson.finance/status/v1/mandates/2026-1";
/** How many mandates the list holds, one bit each. */
export const STATUS_SIZE = 131_072;
/** The `typ` of a status list token (section 5.1). */
export const STATUS_LIST_TYP = "statuslist+jwt";

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(
    new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
  );
  return new Uint8Array(await out.arrayBuffer());
}

/** The `lst` of a bit array (section 4.1): base64url of its ZLIB (RFC 1950) compression. */
export async function encodeStatusList(bits: Uint8Array): Promise<string> {
  return b64url(await through(bits, new CompressionStream("deflate")));
}

/** The bit array a `lst` holds. */
export async function decodeStatusList(lst: string): Promise<Uint8Array> {
  return through(fromB64url(lst), new DecompressionStream("deflate"));
}

/** A list of {@link STATUS_SIZE} entries with the bits at `revoked` set. */
export function statusBits(revoked: Iterable<number>): Uint8Array {
  const bits = new Uint8Array(STATUS_SIZE / 8);
  for (const i of revoked) {
    if (!Number.isInteger(i) || i < 0 || i >= STATUS_SIZE) throw new RangeError("status index");
    bits[i >> 3] = (bits[i >> 3] as number) | (1 << (i & 7));
  }
  return bits;
}

/** An open mandate's `status.status_list` claim, from its key-binding JWT; `null` without one. */
export function statusOf(openMandate: string): { idx: number; uri: string } | null {
  const kb = openMandate.split("~")[openMandate.split("~").indexOf("") + 1] ?? "";
  const status = (decodeJwt(kb) as { status?: { status_list?: { idx?: unknown; uri?: unknown } } })
    .status?.status_list;
  return typeof status?.idx === "number" && typeof status.uri === "string"
    ? { idx: status.idx, uri: status.uri }
    : null;
}

/**
 * The status of an open mandate in a status list token (section 8.3): the token must be signed by
 * `issuer` with type `statuslist+jwt`, be for the mandate's list and not be expired at `now`
 * (seconds). A mandate without a status entry is `valid`.
 */
export async function checkMandateStatus(
  openMandate: string,
  token: string,
  issuer: CryptoKey,
  now: number,
): Promise<"valid" | "revoked"> {
  const status = statusOf(openMandate);
  if (!status) return "valid";
  const { payload, protectedHeader } = await compactVerify(token, issuer, {
    algorithms: ["ES256"],
  });
  if (protectedHeader.typ !== STATUS_LIST_TYP) throw new RangeError("not a status list token");
  const claims = JSON.parse(new TextDecoder().decode(payload)) as {
    sub?: unknown;
    exp?: unknown;
    status_list?: { bits?: unknown; lst?: unknown };
  };
  if (claims.sub !== status.uri) throw new RangeError("the token is for another list");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new RangeError("expired");
  if (claims.status_list?.bits !== 1 || typeof claims.status_list.lst !== "string") {
    throw new RangeError("not a one-bit status list");
  }
  const bits = await decodeStatusList(claims.status_list.lst);
  return ((bits[status.idx >> 3] ?? 0) >> (status.idx & 7)) & 1 ? "revoked" : "valid";
}
