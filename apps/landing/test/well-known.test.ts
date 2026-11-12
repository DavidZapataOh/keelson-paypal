import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const json = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>;

describe("the user credential's SD-JWT VC metadata", () => {
  test("the issuer metadata names the engine's issuer and the API's attested key set", async () => {
    const engine = await read("engine/tee/src/engine.rs");
    const issuer = /const ISSUER: &str = "([^"]+)";/.exec(engine)?.[1];
    expect(await json("apps/landing/public/.well-known/jwt-vc-issuer")).toEqual({
      issuer,
      jwks_uri: "https://api.keelson.finance/v1/credentials/issuer/jwks.json",
    });
  });

  test("the Type Metadata is the credential's vct, with both claims always selectively disclosed", async () => {
    const source = await read("packages/mandate/src/credentials.ts");
    const vct = /USER_CREDENTIAL_VCT = "([^"]+)"/.exec(source)?.[1];
    const meta = await json("apps/landing/public/credentials/user/v1.json");
    expect(meta.vct).toBe(vct);
    expect(new URL(vct as string).pathname).toBe("/credentials/user/v1");
    expect(meta.claims).toEqual([
      expect.objectContaining({ path: ["sub"], sd: "always" }),
      expect.objectContaining({ path: ["cred"], sd: "always" }),
    ]);
  });

  test("the landing serves both as JSON any origin can read, the type at its vct path", async () => {
    const services = parse(await read("render.yaml")).services as {
      name: string;
      routes?: { type: string; source: string; destination: string }[];
      headers?: { path: string; name: string; value: string }[];
    }[];
    const landing = services.find((s) => s.name === "keelson-landing");
    expect(landing?.routes).toContainEqual({
      type: "rewrite",
      source: "/credentials/user/v1",
      destination: "/credentials/user/v1.json",
    });
    for (const path of ["/.well-known/jwt-vc-issuer", "/credentials/*"]) {
      expect(landing?.headers).toContainEqual({
        path,
        name: "Content-Type",
        value: "application/json",
      });
      expect(landing?.headers).toContainEqual({
        path,
        name: "Access-Control-Allow-Origin",
        value: "*",
      });
    }
  });
});
