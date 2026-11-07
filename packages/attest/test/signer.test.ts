import { createHash } from "node:crypto";
import { reportData, type SignerBinding } from "@keelson/core/eip712";
import { createPublicClient, type Hex, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import { AttestError } from "../src/errors.ts";
import { nitroMeasurement, tdxMeasurement } from "../src/measurement.ts";
import { verifyNitro } from "../src/nitro.ts";
import {
  type Expectations,
  type SignerAttestation,
  verifyLegs,
  verifySigner,
} from "../src/signer.ts";
import { verifyTdx } from "../src/tdx.ts";
import { nitroEvidence, tdxEvidence } from "./evidence.ts";

const tdxAtt: SignerAttestation = {
  tee: "tdx",
  quote: tdxEvidence.attestation.quote,
  eventLog: tdxEvidence.attestation.event_log,
  collateral: tdxEvidence.collateral,
  binding: tdxEvidence.attestation.binding,
  block: tdxEvidence.attestation.block,
};
const nitroAtt: SignerAttestation = {
  tee: "nitro",
  document: nitroEvidence.attestation.document,
  binding: nitroEvidence.attestation.binding,
  block: nitroEvidence.attestation.block,
};
const tdxNow = new Date(tdxEvidence.capturedAt);
const nitroNow = new Date(nitroEvidence.capturedAt);

async function expectations(att: SignerAttestation, now: Date): Promise<Expectations> {
  const platform =
    att.tee === "tdx"
      ? tdxMeasurement(
          await verifyTdx(
            {
              quote: Buffer.from(att.quote, "hex"),
              eventLog: att.eventLog,
              collateral: att.collateral,
            },
            { now },
          ),
        )
      : nitroMeasurement(await verifyNitro(Buffer.from(att.document, "base64"), { now }));
  return {
    chainId: Number(att.binding.chainId),
    bondVault: att.binding.bondVault,
    policySetHash: att.binding.policySetHash,
    engineBuildId: att.binding.engineBuildId,
    measurements: [platform],
    now,
  };
}

const codeOf = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AttestError);
  return (error as AttestError).code;
};

describe("measurements", () => {
  test("hash the registers the way the allowlist names them", async () => {
    const tdx = await verifyTdx(
      {
        quote: Buffer.from(tdxAtt.tee === "tdx" ? tdxAtt.quote : "", "hex"),
        eventLog: tdxEvidence.attestation.event_log,
        collateral: tdxEvidence.collateral,
      },
      { now: tdxNow },
    );
    const concat = [
      tdx.mrtd,
      tdx.rtmr[0],
      tdx.rtmr[1],
      tdx.rtmr[2],
      tdx.appId,
      tdx.composeHash,
      tdx.osImageHash,
    ]
      .map((h) => h?.slice(2))
      .join("");
    expect(tdxMeasurement(tdx)).toBe(
      `tdx:${createHash("sha256").update(Buffer.from(concat, "hex")).digest("hex")}`,
    );
    const nitro = await verifyNitro(Buffer.from(nitroEvidence.attestation.document, "base64"), {
      now: nitroNow,
    });
    const pcrs = [nitro.pcrs[0], nitro.pcrs[1], nitro.pcrs[2]].map((h) => h.slice(2)).join("");
    expect(nitroMeasurement(nitro)).toBe(
      `nitro:${createHash("sha256").update(Buffer.from(pcrs, "hex")).digest("hex")}`,
    );
  });
});

describe("the tdx measurement", () => {
  const measured = () =>
    verifyTdx(
      {
        quote: Buffer.from(tdxEvidence.attestation.quote, "hex"),
        eventLog: tdxEvidence.attestation.event_log,
        collateral: tdxEvidence.collateral,
      },
      { now: tdxNow },
    );

  test("does not depend on RTMR3, which holds the instance id", async () => {
    const tdx = await measured();
    const other = {
      ...tdx,
      rtmr: [tdx.rtmr[0], tdx.rtmr[1], tdx.rtmr[2], `0x${"11".repeat(48)}`] as const,
    };
    expect(tdxMeasurement(other)).toBe(tdxMeasurement(tdx));
  });

  test.each([
    ["mrtd", () => `0x${"22".repeat(48)}`],
    ["appId", () => `0x${"33".repeat(20)}`],
    ["composeHash", () => `0x${"44".repeat(32)}`],
    ["osImageHash", () => `0x${"55".repeat(32)}`],
  ] as const)("changes with %s", async (field, value) => {
    const tdx = await measured();
    expect(tdxMeasurement({ ...tdx, [field]: value() })).not.toBe(tdxMeasurement(tdx));
  });

  test("changes with each of RTMR0 to RTMR2", async () => {
    const tdx = await measured();
    for (const i of [0, 1, 2]) {
      const rtmr = [...tdx.rtmr] as typeof tdx.rtmr;
      rtmr[i] = `0x${"66".repeat(48)}`;
      expect(tdxMeasurement({ ...tdx, rtmr })).not.toBe(tdxMeasurement(tdx));
    }
  });

  test("is refused when the log has no OS image hash", async () => {
    const tdx = await measured();
    expect(() => tdxMeasurement({ ...tdx, osImageHash: null })).toThrow(AttestError);
  });
});

describe.each([
  ["tdx", tdxAtt, tdxNow],
  ["nitro", nitroAtt, nitroNow],
] as const)("verifySigner (%s)", (_name, att, now) => {
  test("returns the signer the leg attested with its measurement", async () => {
    const expect_ = await expectations(att, now);
    const result = await verifySigner(att, expect_);
    expect(result.signer.toLowerCase()).toBe(att.binding.signer.toLowerCase());
    expect(result.teeKind).toBe(att.tee === "tdx" ? 1 : 2);
    expect(result.measurement).toBe(expect_.measurements[0]);
    expect(result.bootEpoch).toBe(BigInt(att.binding.bootEpoch));
    expect(result.block).toEqual({ number: BigInt(att.block.number), hash: att.block.hash });
    expect(result.issuerJwkThumbprint).toBe(att.binding.issuerJwkThumbprint);
    if (att.tee === "tdx") expect(result.tcbStatus).toBe("UpToDate");
  });

  const changes: [string, (e: Expectations) => Expectations][] = [
    ["chainId", (e) => ({ ...e, chainId: e.chainId + 1 })],
    ["bondVault", (e) => ({ ...e, bondVault: `0x${"11".repeat(20)}` })],
    ["policySetHash", (e) => ({ ...e, policySetHash: `0x${"22".repeat(32)}` })],
    ["engineBuildId", (e) => ({ ...e, engineBuildId: `0x${"33".repeat(32)}` })],
    ["issuerJwkThumbprint", (e) => ({ ...e, issuerJwkThumbprint: `0x${"44".repeat(32)}` })],
  ];
  test.each(changes)("fails with binding_mismatch when expected %s differs", async (_f, change) => {
    const expect_ = change(await expectations(att, now));
    expect(await codeOf(verifySigner(att, expect_))).toBe("binding_mismatch");
  });

  const forged: [string, (b: typeof att.binding) => typeof att.binding][] = [
    ["signer", (b) => ({ ...b, signer: `0x${"55".repeat(20)}` })],
    ["bootEpoch", (b) => ({ ...b, bootEpoch: String(BigInt(b.bootEpoch) + 1n) })],
    ["issuerJwkThumbprint", (b) => ({ ...b, issuerJwkThumbprint: `0x${"66".repeat(32)}` })],
  ];
  test.each(forged)(
    "fails with binding_mismatch when the binding names another %s",
    async (_f, change) => {
      const expect_ = await expectations(att, now);
      expect(await codeOf(verifySigner({ ...att, binding: change(att.binding) }, expect_))).toBe(
        "binding_mismatch",
      );
    },
  );

  test("fails with binding_mismatch when the block is another", async () => {
    const expect_ = await expectations(att, now);
    const block = { ...att.block, hash: `0x${"77".repeat(32)}` as Hex };
    expect(await codeOf(verifySigner({ ...att, block }, expect_))).toBe("binding_mismatch");
  });

  test("fails with measurement_not_allowed when the measurement is not listed", async () => {
    const expect_ = { ...(await expectations(att, now)), measurements: [] };
    expect(await codeOf(verifySigner(att, expect_))).toBe("measurement_not_allowed");
  });

  test("recomputes report_data exactly as the engine does", async () => {
    const b = att.binding;
    const binding: SignerBinding = {
      chainId: BigInt(b.chainId),
      bondVault: b.bondVault,
      teeKind: b.teeKind,
      signer: b.signer,
      policySetHash: b.policySetHash,
      engineBuildId: b.engineBuildId,
      bootEpoch: BigInt(b.bootEpoch),
      issuerJwkThumbprint: b.issuerJwkThumbprint,
    };
    const result = await verifySigner(att, await expectations(att, now));
    expect(result.signer).toBe(b.signer);
    expect(reportData(binding, att.block.hash)).toMatch(/^0x[0-9a-f]{128}$/);
  });
});

describe("block freshness", () => {
  const rpc = createPublicClient({
    chain: arbitrumSepolia,
    transport: http("https://sepolia-rollup.arbitrum.io/rpc"),
  });

  test("passes a block less than an hour old", async () => {
    const result = await verifySigner(tdxAtt, { ...(await expectations(tdxAtt, tdxNow)), rpc });
    expect(result.block.number).toBe(BigInt(tdxAtt.block.number));
  });

  test("fails with stale_block two hours after the block", async () => {
    const block = await rpc.getBlock({ blockNumber: BigInt(nitroAtt.block.number) });
    const now = new Date(Number(block.timestamp) * 1000 + 2 * 3600 * 1000);
    const expect_ = { ...(await expectations(nitroAtt, nitroNow)), now, rpc };
    expect(await codeOf(verifySigner(nitroAtt, expect_))).toBe("stale_block");
  });

  test("fails with binding_mismatch when the chain has another hash at that height", async () => {
    const block = { ...tdxAtt.block, number: Number(tdxAtt.block.number) - 1 };
    const expect_ = { ...(await expectations(tdxAtt, tdxNow)), rpc };
    expect(await codeOf(verifySigner({ ...tdxAtt, block }, expect_))).toBe("binding_mismatch");
  });
});

describe("verifyLegs", () => {
  test("returns both signers when the legs attest the same issuer", async () => {
    const [a, b] = await verifyLegs(
      [tdxAtt, await expectations(tdxAtt, tdxNow)],
      [nitroAtt, await expectations(nitroAtt, nitroNow)],
    );
    expect(a.issuerJwkThumbprint).toBe(b.issuerJwkThumbprint);
    expect(a.signer).not.toBe(b.signer);
  });

  test("fails when the legs attest different issuers", async () => {
    const other = { ...nitroAtt.binding, issuerJwkThumbprint: `0x${"88".repeat(32)}` as Hex };
    // A different issuer in the binding changes report_data, so the second leg fails first.
    expect(
      await codeOf(
        verifyLegs(
          [tdxAtt, await expectations(tdxAtt, tdxNow)],
          [{ ...nitroAtt, binding: other }, await expectations(nitroAtt, nitroNow)],
        ),
      ),
    ).toBe("binding_mismatch");
  });
});
