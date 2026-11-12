import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  AuthenticationError,
  type Credentials,
  storedLogin,
  writeCredentials,
} from "../src/index.ts";
import { json, scriptedServer } from "./server.ts";

let s: Awaited<ReturnType<typeof scriptedServer>>;
let dir: string;
beforeAll(async () => {
  s = await scriptedServer();
  dir = await mkdtemp(join(tmpdir(), "keelson-credentials-"));
});
afterAll(() => s.close());

const saved = (over: Partial<Credentials> = {}): Credentials => ({
  apiUrl: s.url,
  clientId: "cli",
  refreshToken: "r0",
  accessToken: "a0",
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

test("the file is written for its owner only, through a rename", async () => {
  const path = join(dir, "a", "credentials.json");
  await writeCredentials(saved(), path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(dir, "a"))).toEqual(["credentials.json"]);
  expect(JSON.parse(await readFile(path, "utf8")).refreshToken).toBe("r0");
});

test("an expired token is refreshed once; a second reader uses the new one", async () => {
  const path = join(dir, "b.json");
  await writeCredentials(saved({ expiresAt: Date.now() - 1 }), path);
  s.script(json(200, { access_token: "a1", refresh_token: "r1", expires_in: 3600 }));
  expect(await storedLogin({ path }).token()).toBe("a1");
  expect(await storedLogin({ path }).token()).toBe("a1");
  expect(s.seen).toHaveLength(1);
  expect(new URLSearchParams(s.seen[0]?.body)).toEqual(
    new URLSearchParams({
      resource: "https://api.keelson.finance",
      grant_type: "refresh_token",
      refresh_token: "r0",
      client_id: "cli",
    }),
  );
  const after = JSON.parse(await readFile(path, "utf8")) as Credentials;
  expect(after.refreshToken).toBe("r1");
});

test("a token another process already refreshed is used when the API refuses ours", async () => {
  const path = join(dir, "c.json");
  await writeCredentials(saved({ accessToken: "old" }), path);
  const mine = storedLogin({ path });
  expect(await mine.token()).toBe("old");
  await writeCredentials(saved({ accessToken: "new" }), path);
  s.script();
  expect(await mine.token({ force: true })).toBe("new");
  expect(s.seen).toHaveLength(0);
});

test("a revoked sign-in is an AuthenticationError naming npx keelson login, asked once", async () => {
  const path = join(dir, "d.json");
  await writeCredentials(saved({ expiresAt: 0 }), path);
  s.script(json(400, { error: "invalid_grant", error_description: "revoked" }));
  const err = (await storedLogin({ path })
    .token()
    .catch((e: unknown) => e)) as AuthenticationError;
  expect(err).toBeInstanceOf(AuthenticationError);
  expect(err.type).toBe("invalid_grant");
  expect(err.message).toContain("npx keelson login");
  expect(s.seen).toHaveLength(1);
});

test("no saved sign-in says how to sign in", async () => {
  const err = await storedLogin({ path: join(dir, "none.json") })
    .token()
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AuthenticationError);
  expect((err as Error).message).toContain("npx keelson login");
});

test("two refreshes at once send one request, so a rotated token is never reused", async () => {
  const path = join(dir, "e.json");
  await writeCredentials(saved({ expiresAt: 0 }), path);
  s.script((res) => {
    setTimeout(
      () =>
        json(200, { access_token: "a9", refresh_token: "r9", expires_in: 3600 })(
          res,
          s.seen[0] as never,
        ),
      200,
    );
  });
  const one = storedLogin({ path });
  const [a, b, c] = await Promise.all([one.token(), one.token(), storedLogin({ path }).token()]);
  expect([a, b, c]).toEqual(["a9", "a9", "a9"]);
  expect(s.seen).toHaveLength(1);
  expect(await readdir(dir)).not.toContain("e.json.lock");
});

test("a refresh goes to the client's API, not the one written in the file", async () => {
  const path = join(dir, "f.json");
  await writeCredentials(saved({ apiUrl: "https://elsewhere.invalid", expiresAt: 0 }), path);
  s.script(json(200, { access_token: "a2", expires_in: 3600 }));
  expect(await storedLogin({ path, baseUrl: s.url }).token()).toBe("a2");
  expect(s.seen).toHaveLength(1);
});
