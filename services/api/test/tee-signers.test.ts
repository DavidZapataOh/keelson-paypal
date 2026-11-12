import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq, teeSigners } from "@keelson/db";
import { describe, expect, test } from "vitest";
import { createTee } from "../src/tee/config.ts";
import { activeSigner, refreshLeg, registerLeg, revokeSigner } from "../src/tee/signers.ts";
import { testDb } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";

describe.skipIf(!live)("tee signers (live legs)", { timeout: 60_000 }, () => {
  const env = {
    TEE_A_URL: process.env.TEE_A_URL as string,
    TEE_B_URL: process.env.TEE_B_URL as string,
    KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
    ARBITRUM_SEPOLIA_RPC_URL: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    KEELSON_ISSUER_THUMBPRINTS: process.env.KEELSON_ISSUER_THUMBPRINTS?.split(",") as
      | `0x${string}`[]
      | undefined,
  };
  // The legs are reached from a laptop here, not from the API's region.
  const tee = createTee(env, { a: 10_000, b: 10_000 });

  test("a verified attestation admits each leg's signer", async () => {
    const [healthA, healthB] = await Promise.all([tee.client.a.health(), tee.client.b.health()]);
    const a = await refreshLeg(testDb, "a", tee);
    const b = await refreshLeg(testDb, "b", tee);

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

  test("a signer of another build listed for a rotation is admitted, any other is refused", async () => {
    const elsewhere = { engineBuildId: `0x${"00".repeat(32)}`, measurements: ["tdx:00"] } as const;
    const { engineBuildId, measurements } = tee.expect.a;
    const rotating = { ...tee.expect.a, ...elsewhere, rotation: [{ engineBuildId, measurements }] };
    const admitted = await registerLeg(testDb, "a", tee.client.a, rotating);
    expect(measurements).toContain(admitted.measurement);

    const unlisted = { ...tee.expect.a, ...elsewhere, rotation: [elsewhere] };
    await expect(registerLeg(testDb, "a", tee.client.a, unlisted)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
  });

  test("leg b is not admitted when no issuer pin is available", async () => {
    const { issuerJwkThumbprints: _pin, ...unpinned } = tee.expect.b;
    const [a] = await testDb.select().from(teeSigners).where(eq(teeSigners.teeKind, 1));
    if (!a) throw new Error("leg a has no signer");
    const before = (await testDb.select().from(teeSigners)).length;
    await testDb
      .update(teeSigners)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(teeSigners.address, a.address));
    try {
      await expect(registerLeg(testDb, "b", tee.client.b, unpinned)).rejects.toThrow(/issuer/);
    } finally {
      await testDb
        .update(teeSigners)
        .set({ expiresAt: a.expiresAt })
        .where(eq(teeSigners.address, a.address));
    }
    expect((await testDb.select().from(teeSigners)).length).toBe(before);
  });

  test("the configured issuer pin is checked on both legs", async () => {
    const pins = tee.expect.a.issuerJwkThumbprints;
    expect(pins?.join(",")).toBe(process.env.KEELSON_ISSUER_THUMBPRINTS);
    const other = { ...tee.expect.a, issuerJwkThumbprints: [`0x${"00".repeat(32)}`] } as const;
    await expect(registerLeg(testDb, "a", tee.client.a, other)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    const wrongB = { ...tee.expect.b, issuerJwkThumbprints: [`0x${"00".repeat(32)}`] } as const;
    await expect(registerLeg(testDb, "b", tee.client.b, wrongB)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
  });

  test("a revoked signer is not active and cannot be admitted again", async () => {
    const a = await registerLeg(testDb, "a", tee.client.a, tee.expect.a);
    await revokeSigner(testDb, a.address, "test");
    expect(await activeSigner(testDb, 1)).toBeNull();
    await expect(registerLeg(testDb, "a", tee.client.a, tee.expect.a)).rejects.toThrow(/revoked/);
  });

  test("admitting a revoked signer leaves the active one in place", async () => {
    const [revoked] = await testDb.select().from(teeSigners).where(eq(teeSigners.teeKind, 1));
    if (!revoked?.revokedAt) throw new Error("leg a's signer should be revoked here");
    const other = Buffer.alloc(20, 9);
    await testDb.insert(teeSigners).values({ ...revoked, address: other, revokedAt: null });
    await expect(registerLeg(testDb, "a", tee.client.a, tee.expect.a)).rejects.toThrow(/revoked/);
    const [still] = await testDb.select().from(teeSigners).where(eq(teeSigners.address, other));
    expect(still?.revokedAt).toBeNull();
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
