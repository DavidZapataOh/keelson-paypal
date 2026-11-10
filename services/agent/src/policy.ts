import { type BetaURLContext, ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/** The URL as the browser opens it: `https://` added when Claude wrote no scheme. */
export function withScheme(url: string): string {
  return SCHEME_PREFIX.test(url) ? url : `https://${url}`;
}

/**
 * Whether the browser may load `url`: `about:blank`, or `http(s)` on one of `hosts`. A host is
 * exact, or `_.example.com` for the subdomains of `example.com` at any depth, as KERNEL's network
 * allowlist writes it. Every other scheme (`javascript:`, `data:`, `file:`, `blob:`, …) is refused.
 */
export function isAllowed(url: string, hosts: readonly string[]): boolean {
  if (url.toLowerCase() === "about:blank") return true;
  // A browser reads "\" as "/" in a web URL.
  const parsed = URL.parse(withScheme(url).replaceAll("\\", "/"));
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return false;
  const host = parsed.hostname;
  return hosts.some((h) => (h.startsWith("_.") ? host.endsWith(h.slice(1)) : h === host));
}

/** The toolset's `urlPolicy` for `navigate` over `hosts`. */
export function urlPolicy(hosts: readonly string[]): (ctx: BetaURLContext, url: string) => void {
  return (_ctx, url) => {
    if (!isAllowed(url, hosts)) throw new ToolError("blocked: the URL is not on an allowed host");
  };
}
