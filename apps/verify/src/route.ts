/** What the page's URL asks for: an Alibi by id, what its QR link states, and an RPC to use. */
export interface Route {
  alibiId?: string;
  expect?: { leafHash: string; anchoredSize?: bigint; chainId?: number };
  rpc?: string;
  /** `?embed`: the page is framed, so it shows only the cheats and the report. */
  embed?: boolean;
  /** `?proof=anonymous`: the anonymous proof comes first, and alone in an embed. */
  anonymous?: boolean;
  /** Why a `?rpc=` was refused. */
  rpcRefused?: string;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const FRAGMENT = /^([A-Za-z0-9_-]{43}|[0-9a-fA-F]{64})\.(0|[1-9][0-9]{0,19})\.([1-9][0-9]{0,9})$/;

/**
 * Parses `/a/<alibi_id>#<leaf hash>.<anchoredSize>.<chainId>` (canonical) or the same under `/v/`.
 * A malformed fragment is ignored; `?rpc=` is accepted only as an `https:` URL.
 */
export function parseRoute(loc: { pathname: string; hash: string; search: string }): Route {
  const out: Route = {};
  const path = /^\/(?:a|v)\/([^/]+)\/?$/.exec(loc.pathname);
  if (path && ULID.test(path[1] as string)) {
    out.alibiId = path[1] as string;
    const f = FRAGMENT.exec(loc.hash.replace(/^#/, ""));
    if (f) {
      const size = BigInt(f[2] as string);
      out.expect = {
        leafHash: f[1] as string,
        ...(size > 0n ? { anchoredSize: size } : {}),
        chainId: Number(f[3]),
      };
    }
  }
  const search = new URLSearchParams(loc.search);
  if (search.has("embed")) out.embed = true;
  if (search.get("proof") === "anonymous") out.anonymous = true;
  const rpc = search.get("rpc");
  if (rpc !== null) {
    let url: URL | undefined;
    try {
      url = new URL(rpc);
    } catch {}
    if (url?.protocol === "https:" && !url.username && !url.password) out.rpc = url.href;
    else out.rpcRefused = "Only an https: RPC URL is accepted.";
  }
  return out;
}

/** A Keelson verify link read from a QR code, or `undefined` if it is anything else. */
export function verifyLinkOf(text: string, origins: readonly string[]): Route | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!origins.includes(url.origin)) return undefined;
  const route = parseRoute(url);
  return route.alibiId ? route : undefined;
}
