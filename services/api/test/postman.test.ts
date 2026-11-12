import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../../openapi/${p}`, import.meta.url), "utf8"));

interface Item {
  name: string;
  item?: Item[];
  request?: { method: string; url: { path?: string[] } | string };
}
const requests = (items: Item[]): Item[] => items.flatMap((i) => (i.item ? requests(i.item) : [i]));

test("the Postman collection has one request per developer operation, on the OAuth sign-in", () => {
  const collection = read("postman/keelson.postman_collection.json");
  const all = requests(collection.item);
  expect(all).toHaveLength(read("public-operations.json").length);
  const auth = Object.fromEntries(
    collection.auth.oauth2.map((p: { key: string; value: string }) => [p.key, p.value]),
  );
  expect(collection.auth.type).toBe("oauth2");
  expect(auth.grant_type).toBe("authorization_code_with_pkce");
  expect(auth.challengeAlgorithm).toBe("S256");
  expect(collection.variable).toContainEqual(
    expect.objectContaining({ key: "baseUrl", value: "https://api.keelson.finance" }),
  );
  expect(collection.event[0].script.exec.join("\n")).toContain("Idempotency-Key");
  const paths = all.map((r) =>
    typeof r.request?.url === "string" ? r.request.url : `/${r.request?.url.path?.join("/")}`,
  );
  expect(paths.join(" ")).not.toMatch(/judge|redteam|merchant|embed|push|admin/);
});
