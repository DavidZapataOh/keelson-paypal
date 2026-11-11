// Writes openapi/postman/keelson.postman_collection.json from the developer subset of the API.
import { readFileSync, writeFileSync } from "node:fs";
import Converter from "openapi-to-postmanv2";

const root = new URL("../../../openapi/", import.meta.url);
const spec = readFileSync(new URL("keelson.public.json", root), "utf8");

/** The public client registered for Postman (RFC 7591), redirecting to Postman's own callback. */
const POSTMAN_CLIENT_ID = "WkKIPZyGePddfBSbfErTGJbptmYLYFTU";
const SCOPES = "mandates:request evidence:write purchases:write alibis:read offline_access";

type Item = { name: string; item?: Item[]; request?: Record<string, unknown> };
type Url = { path: string[]; variable?: unknown[] };

/** Path parameters become collection variables, named for what they hold. */
function variableFor(path: string[], key: string): string {
  if (key !== "id") return key === "root" ? "evidenceRoot" : key;
  const resource = path[1];
  if (resource === "alibis" || resource === "purchases") return "purchaseId";
  if (resource === "mandates") return "mandateId";
  if (resource === "disputes") return "disputeId";
  if (resource === "connections") return "requestId";
  return key;
}

const collection = await new Promise<{
  info: Record<string, unknown>;
  item: Item[];
  [k: string]: unknown;
}>((resolve, reject) =>
  Converter.convert(
    { type: "string", data: spec },
    {
      folderStrategy: "Tags",
      requestParametersResolution: "Example",
      includeAuthInfoInExample: false,
    },
    (err: Error | null, result: { result: boolean; reason?: string; output: { data: never }[] }) =>
      err || !result.result
        ? reject(err ?? new Error(result.reason))
        : resolve(result.output[0]?.data as never),
  ),
);

const kv = (key: string, value: string) => ({ key, value, type: "string" });
collection.info = {
  ...collection.info,
  name: "Keelson API (PayPal sandbox)",
  description:
    "The operations an app or an operator's agent calls on Keelson: ask for a mandate, seal evidence, countersign a cart, and read and verify the Alibi. Sign in with Get New Access Token (OAuth 2.0 with PKCE). Payments run on the PayPal sandbox; no real money moves.",
};
collection.variable = [
  kv("baseUrl", "https://api.keelson.finance"),
  ...["purchaseId", "mandateId", "requestId", "disputeId", "agentId", "evidenceRoot", "hash"].map(
    (k) => kv(k, ""),
  ),
];
collection.auth = {
  type: "oauth2",
  oauth2: [
    kv("grant_type", "authorization_code_with_pkce"),
    kv("challengeAlgorithm", "S256"),
    kv("authUrl", "https://api.keelson.finance/api/auth/oauth2/authorize"),
    kv("accessTokenUrl", "https://api.keelson.finance/api/auth/oauth2/token"),
    kv("clientId", POSTMAN_CLIENT_ID),
    kv("client_authentication", "body"),
    kv("scope", SCOPES),
    kv("redirect_uri", "https://oauth.pstmn.io/v1/callback"),
    kv("useBrowser", "true"),
    kv("tokenName", "Keelson"),
    kv("addTokenTo", "header"),
    kv(
      "authRequestParams",
      JSON.stringify([
        { key: "resource", value: "https://api.keelson.finance", send_as: "request_url" },
      ]),
    ),
    kv(
      "tokenRequestParams",
      JSON.stringify([
        { key: "resource", value: "https://api.keelson.finance", send_as: "request_body" },
      ]),
    ),
  ],
};
// Every POST is idempotent by key (draft-ietf-httpapi-idempotency-key-header).
collection.event = [
  {
    listen: "prerequest",
    script: {
      type: "text/javascript",
      exec: [
        "if (pm.request.method === 'POST' && !pm.request.headers.has('Idempotency-Key')) {",
        "  pm.request.headers.add({ key: 'Idempotency-Key', value: pm.variables.replaceIn('{{$guid}}') });",
        "}",
      ],
    },
  },
];
const strip = (items: Item[]): Item[] =>
  items.map((i) => {
    if (i.item) return { ...i, item: strip(i.item) };
    const { auth: _, ...request } = i.request as Record<string, unknown> & { auth?: unknown };
    // Requests inherit the collection's OAuth; the converter's own headers for the key are dropped.
    const header = ((request.header as { key: string }[] | undefined) ?? []).filter(
      (h) => h.key.toLowerCase() !== "idempotency-key",
    );
    const url = request.url as Url;
    const path = url.path.map((seg) =>
      seg.replace(
        /^:(\w+)$|\{\{(\w+)\}\}/,
        (_, a?: string, b?: string) => `{{${variableFor(url.path, (a ?? b) as string)}}}`,
      ),
    );
    return { ...i, request: { ...request, header, url: { ...url, path, variable: [] } } };
  });
collection.item = strip(collection.item);
writeFileSync(
  new URL("postman/keelson.postman_collection.json", root),
  `${JSON.stringify(collection, null, 2)}\n`,
);
