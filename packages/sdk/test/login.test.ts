import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { login, readCredentials } from "../src/index.ts";
import { json, scriptedServer } from "./server.ts";

let s: Awaited<ReturnType<typeof scriptedServer>>;
beforeAll(async () => {
  s = await scriptedServer();
});
afterAll(() => s.close());

test("a stray callback with the wrong state does not end the sign-in", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "keelson-login-")), "credentials.json");
  s.script(
    json(201, { client_id: "cli" }),
    json(200, { access_token: "a1", refresh_token: "r1", expires_in: 3600 }),
  );
  const c = await login({
    baseUrl: s.url,
    path,
    log: () => {},
    timeoutMs: 10_000,
    open: async (url) => {
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri") as string;
      const state = u.searchParams.get("state") as string;
      // Something else on this machine hits the listener first, with a state it cannot know.
      const stray = await fetch(`${redirect}?code=evil&state=guess`);
      expect(stray.status).toBe(400);
      await fetch(`${redirect}?code=good&state=${state}`);
    },
  });
  expect(c.accessToken).toBe("a1");
  expect(new URLSearchParams(s.seen[1]?.body).get("code")).toBe("good");
  expect((await readCredentials(path))?.clientId).toBe("cli");
});
