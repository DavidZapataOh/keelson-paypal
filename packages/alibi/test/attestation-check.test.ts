import { AttestationCache, verifySigner } from "@keelson/attest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { verifyAlibi } from "../src/verify/index.ts";
import { copy, fixtures } from "./fixtures.ts";

vi.mock("@keelson/attest", async (original) => {
  const real = await original<typeof import("@keelson/attest")>();
  return { ...real, verifySigner: vi.fn(real.verifySigner) };
});

const fixture = fixtures.find((f) => f.mode === "2of2") ?? (fixtures[0] as (typeof fixtures)[0]);
const check = (r: Awaited<ReturnType<typeof verifyAlibi>>, id: string) =>
  r.checks.find((c) => c.id === id);

beforeEach(() => {
  vi.mocked(verifySigner).mockClear();
});

describe("the TEE attestation checks", () => {
  test("verify each leg once, against the build its binding names", async () => {
    const report = await verifyAlibi(fixture.bundle);
    expect(check(report, "tee.attestation.tdx")?.status).toBe("pass");
    expect(verifySigner).toHaveBeenCalledTimes(fixture.bundle.tee.attestations.length);
    for (const [att, expectations] of vi.mocked(verifySigner).mock.calls) {
      expect(expectations.engineBuildId.toLowerCase()).toBe(
        att.binding.engineBuildId.toLowerCase(),
      );
    }
  });

  test("share one cache across verifications", async () => {
    await verifyAlibi(fixture.bundle);
    await verifyAlibi(fixture.bundle);
    const caches = vi.mocked(verifySigner).mock.calls.map(([, e]) => e.cache);
    expect(caches[0]).toBeInstanceOf(AttestationCache);
    expect(new Set(caches).size).toBe(1);
  });

  test("fail a binding that names an unpublished build", async () => {
    const b = copy(fixture.bundle);
    const tdx = b.tee.attestations.find((a) => a.kind === "tdx") as (typeof b.tee.attestations)[0];
    const build = `0x${"ab".repeat(32)}`;
    (tdx.binding as { engineBuildId: string }).engineBuildId = build;
    (tdx.document as unknown as { binding: { engineBuildId: string } }).binding.engineBuildId =
      build;
    const result = check(await verifyAlibi(b), "tee.attestation.tdx");
    expect(result).toMatchObject({
      status: "fail",
      reason: "the attested engine build is not a published one",
    });
  });
});
