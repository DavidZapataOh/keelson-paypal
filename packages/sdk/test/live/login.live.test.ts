import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  Keelson,
  LOGIN_SCOPES,
  login,
  NotFoundError,
  readCredentials,
  storedLogin,
} from "../../src/index.ts";
import { judge, type User } from "./user.ts";

describe.skipIf(process.env.KEELSON_LIVE !== "1")(
  "npx keelson login (live)",
  { timeout: 180_000 },
  () => {
    let user: User;
    beforeAll(async () => {
      user = await judge();
    }, 120_000);
    afterAll(() => user?.close());

    test("signs in through the loopback flow and calls the API as the user", async () => {
      const path = join(await mkdtemp(join(tmpdir(), "keelson-login-")), "credentials.json");
      const c = await login({ path, open: (url) => user.approveLogin(url), log: () => {} });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(c.clientId).toBeTruthy();
      expect(c.refreshToken).toBeTruthy();
      const claims = JSON.parse(
        Buffer.from(c.accessToken.split(".")[1] ?? "", "base64url").toString(),
      );
      expect(claims.scope.split(" ").sort()).toEqual([...LOGIN_SCOPES].sort());
      const keelson = new Keelson({ auth: storedLogin({ path }) });
      // Authenticated as the user: a request of someone else's is not found, not unauthorized.
      const err = await keelson
        .request("GET", "/v1/connections/requests/01JX0000000000000000000000")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      // A second sign-in reuses the registered client.
      const again = await login({ path, open: (url) => user.approveLogin(url), log: () => {} });
      expect(again.clientId).toBe(c.clientId);
      expect((await readCredentials(path))?.accessToken).toBe(again.accessToken);
    });
  },
);
