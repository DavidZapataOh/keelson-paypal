import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Makes a Blink MHTML snapshot byte-stable: the top-level `Date` header is removed, quoted-printable
 * soft line breaks are unfolded, the random `cid` ids Blink assigns to frames and stylesheets are
 * numbered in order of appearance, and the multipart boundary becomes `----keelson-` followed by
 * the first 16 hex digits of SHA-256 of the document with the boundary removed. Part order is kept.
 */
export function normalizeMhtml(mhtml: string): string {
  const headerEnd = mhtml.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new TypeError("not an MHTML document");
  const boundary = /boundary="([^"]+)"/.exec(mhtml.slice(0, headerEnd))?.[1];
  if (!boundary) throw new TypeError("the MHTML document has no boundary");

  const delimiter = `--${boundary}`;
  const segments = mhtml.split(delimiter).map((segment, k) => {
    if (k === 0) return segment.replace(/^Date:[^\r\n]*\r\n/m, "");
    const bodyAt = segment.indexOf("\r\n\r\n");
    if (
      bodyAt < 0 ||
      !/^Content-Transfer-Encoding:\s*quoted-printable/im.test(segment.slice(0, bodyAt))
    )
      return segment;
    return segment.slice(0, bodyAt) + segment.slice(bodyAt).replace(/=\r\n/g, "");
  });
  let out = segments.join(delimiter);

  const ids = new Map<string, string>();
  out = out.replace(/\b([a-z]+)-([0-9A-Za-z-]{8,})@mhtml\.blink\b/g, (match, kind: string) => {
    let id = ids.get(match);
    if (!id) {
      id = `${kind}-${ids.size}@mhtml.blink`;
      ids.set(match, id);
    }
    return id;
  });

  const old = new RegExp(escapeRegExp(boundary), "g");
  const digest = bytesToHex(sha256(new TextEncoder().encode(out.replace(old, ""))));
  return out.replace(old, `----keelson-${digest.slice(0, 16)}`);
}
