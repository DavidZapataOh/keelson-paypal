import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO } from "./lib/markdown";

const page = readFileSync(
  join(REPO, "apps/docs/src/content/docs/security/attestation-roles.mdoc"),
  "utf8",
);
const section = (heading: string) => page.split(/^## /m).find((s) => s.startsWith(heading)) ?? "";

describe("the attestation roles page", () => {
  test("maps every RFC 9334 role to a Keelson component", () => {
    const roles = section("RFC 9334 roles");
    for (const role of [
      "Attester",
      "Verifier",
      "Relying Party",
      "Endorser",
      "Reference Value Provider",
    ]) {
      expect(roles, role).toContain(`**${role}**`);
    }
  });

  test("states the appraisal policy for SWHardeningNeeded and the runbook for a new advisory", () => {
    const tcb = section("TCB appraisal");
    for (const k of [
      "ACCEPTED_ADVISORIES",
      "advisory_not_allowed",
      "advisories-watch.ts",
      "disallowMeasurement",
      "72 h",
    ]) {
      expect(tcb, k).toContain(k);
    }
  });

  test("records the EAR and CoRIM decision with the conditions to revisit it", () => {
    const ear = section("Attestation results");
    for (const k of ["EAR", "CoRIM", "draft-cds-rats-intel-corim-profile", "Revisit"]) {
      expect(ear, k).toContain(k);
    }
  });
});
