import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { teeSigners } from "@keelson/db";
import { describe, expect, test } from "vitest";
import { createTee } from "../src/tee/config.ts";
import { activeSigner, registerLeg, revokeSigner } from "../src/tee/signers.ts";
import { testDb } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";

describe.skipIf(!live)("tee signers (live legs)", () => {
  const env = {
    TEE_A_URL: process.env.TEE_A_URL as string,
    TEE_B_URL: process.env.TEE_B_URL as string,
    KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
    ARBITRUM_SEPOLIA_RPC_URL: process.env.ARBITRUM_SEPOLIA_RPC_URL,
  };
  // The legs are reached from a laptop here, not from the API's region.
  const tee = createTee(env, { a: 10_000, b: 10_000 });

  test("a verified attestation admits each leg's signer", async () => {
    const [healthA, healthB] = await Promise.all([tee.client.a.health(), tee.client.b.health()]);
    const a = await registerLeg(testDb, "a", tee.client.a, tee.expect.a);
    const b = await registerLeg(testDb, "b", tee.client.b, tee.expect.b);

    expect(a.teeKind).toBe(1);
    expect(b.teeKind).toBe(2);
    expect(a.address.toLowerCase()).toBe(healthA.signer.toLowerCase());
    expect(b.address.toLowerCase()).toBe(healthB.signer.toLowerCase());
    expect(a.measurement).toMatch(/^tdx:/);
    expect(b.measurement).toMatch(/^nitro:/);
    expect(a.binding.issuerJwkThumbprint).toBe(b.binding.issuerJwkThumbprint);
    expect((await activeSigner(testDb, 1))?.address).toBe(a.address);
    expect((await activeSigner(testDb, 2))?.address).toBe(b.address);
  });

  test("an attestation checked against another bond vault is refused and stores nothing", async () => {
    const other = {
      ...tee.expect.b,
      bondVault: "0x00000000000000000000000000000000000000aa",
    } as const;
    const before = (await testDb.select().from(teeSigners)).length;
    await expect(registerLeg(testDb, "b", tee.client.b, other)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    expect((await testDb.select().from(teeSigners)).length).toBe(before);
  });

  test("a measurement outside the allowlist is refused", async () => {
    const other = { ...tee.expect.a, measurements: ["tdx:00"] };
    await expect(registerLeg(testDb, "a", tee.client.a, other)).rejects.toMatchObject({
      code: "measurement_not_allowed",
    });
  });

  test("a revoked signer is not active and cannot be admitted again", async () => {
    const a = await registerLeg(testDb, "a", tee.client.a, tee.expect.a);
    await revokeSigner(testDb, a.address, "test");
    expect(await activeSigner(testDb, 1)).toBeNull();
    await expect(registerLeg(testDb, "a", tee.client.a, tee.expect.a)).rejects.toThrow(/revoked/);
  });

  test("a signer whose attestation is no longer fresh is not active", async () => {
    const b = await registerLeg(testDb, "b", tee.client.b, tee.expect.b);
    const later = new Date(Date.now() + 3 * 3_600_000);
    expect((await activeSigner(testDb, 2))?.address).toBe(b.address);
    expect(await activeSigner(testDb, 2, later)).toBeNull();
  });

  // Restarts leg B with the engine image it already runs, which gives it a new signer. It needs
  // the AWS credentials and takes a few minutes, so it runs only when asked.
  test.skipIf(process.env.KEELSON_RESTART_B !== "1")(
    "a restarted leg supersedes its old signer",
    { timeout: 900_000 },
    async () => {
      const before = await registerLeg(testDb, "b", tee.client.b, tee.expect.b);
      const health = await tee.client.a.health();
      const script = fileURLToPath(new URL("../../../engine/tee/nitro/update.sh", import.meta.url));
      const restart = spawnSync(script, [tee.expect.b.engineBuildId.replace("0x", "sha256:")], {
        env: {
          ...process.env,
          KEELSON_TEE_TOKEN_SHA256: process.env.KEELSON_TEE_TOKEN_SHA256 as string,
          KEELSON_ISSUER_JWK: JSON.stringify(health.issuer),
        },
        encoding: "utf8",
      });
      expect(restart.status, restart.stderr).toBe(0);

      const after = await registerLeg(testDb, "b", tee.client.b, tee.expect.b);
      expect(after.address).not.toBe(before.address);
      expect((await activeSigner(testDb, 2))?.address).toBe(after.address);
      const [old] = await testDb.select().from(teeSigners);
      expect(old).toBeDefined();
      const rows = await testDb.select().from(teeSigners);
      const superseded = rows.find(
        (r) => `0x${r.address.toString("hex")}` === before.address.toLowerCase(),
      );
      expect(superseded?.revokedReason).toBe("superseded");
    },
  );
});
