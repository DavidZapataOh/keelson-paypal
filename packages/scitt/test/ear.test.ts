import { describe, expect, test } from "vitest";
import { EAR_PROFILE, earClaims } from "../src/ear.ts";
import { hasCddl, validateCddl } from "./cddl.ts";

describe("EAR claims set (draft-ietf-rats-ear-05)", () => {
  const ear = earClaims({
    iat: 1794219430,
    verifier: { developer: "https://keelson.finance", build: "@keelson/alibi 0.0.0" },
    submods: {
      tdx: { status: "affirming", instanceIdentity: 2, executables: 2, hardware: 2 },
      nitro: {
        status: "contraindicated",
        executables: 96,
        details: ["the measurement is not allowed"],
      },
    },
  });

  test("has the draft-05 member names and profile", () => {
    expect(EAR_PROFILE).toBe("tag:ietf.org,2026:rats/ear#05");
    expect(ear).toEqual({
      eat_profile: "tag:ietf.org,2026:rats/ear#05",
      iat: 1794219430,
      ear_verifier_id: { developer: "https://keelson.finance", build: "@keelson/alibi 0.0.0" },
      ear_status: "contraindicated",
      submods: {
        tdx: {
          ear_status: "affirming",
          ear_trustworthiness_vector: { "instance-identity": 2, executables: 2, hardware: 2 },
        },
        nitro: {
          ear_status: "contraindicated",
          ear_status_details: ["the measurement is not allowed"],
          ear_trustworthiness_vector: { executables: 96 },
        },
      },
    });
  });

  test("the top-level status is the worst of the submods", () => {
    const ok = earClaims({
      iat: 1,
      verifier: { developer: "https://keelson.finance", build: "x" },
      submods: { tdx: { status: "affirming" }, nitro: { status: "warning" } },
    });
    expect(ok.ear_status).toBe("warning");
  });

  test("refuses an empty set of submods", () => {
    expect(() =>
      earClaims({ iat: 1, verifier: { developer: "d", build: "b" }, submods: {} }),
    ).toThrow();
  });

  test.skipIf(!hasCddl())("validates against the EAR CDDL", () => {
    const json = new TextEncoder().encode(JSON.stringify(ear));
    expect(validateCddl("ear-05.cddl", "EAR", json, "json")).toBe(true);
  });
});
