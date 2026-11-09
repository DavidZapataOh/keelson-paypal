import { type SignerAttestation, verifySigner } from "@keelson/attest";
import { deploymentsFor } from "@keelson/chain";
import { calculateJwkThumbprint, type JWK } from "jose";
import { getAddress } from "viem";
import { fromBase64url } from "../../b64.ts";
import type { AlibiBundle } from "../../schema.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { TEE_BUILDS } from "../trust.ts";
import { isBundle, sameJson, UNDISCLOSED } from "./util.ts";

const hex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

/** RFC 7638 thumbprint of the credential issuer's key the bundle carries. */
export async function issuerThumbprint(b: AlibiBundle): Promise<string> {
  return hex(fromBase64url(await calculateJwkThumbprint(b.mandate.issuer_jwk as JWK, "sha256")));
}

function attestation(kind: "tdx" | "nitro", step: number): CheckDef {
  return {
    id: kind === "tdx" ? "tee.attestation.tdx" : "tee.attestation.nitro",
    step,
    reads: ["/tee/attestations"],
    async run(input) {
      if (!isBundle(input)) return UNDISCLOSED;
      const i = input.tee.attestations.findIndex((a) => a.kind === kind);
      if (i < 0) {
        expect(kind === "nitro" && input.tee.mode === "degraded", "no TDX attestation", [
          "/tee/attestations",
        ]);
        return { status: "absent", reads: ["/tee/attestations"] };
      }
      const at = `/tee/attestations/${i}`;
      const a = input.tee.attestations[i] as AlibiBundle["tee"]["attestations"][number];
      const doc = a.document as unknown as SignerAttestation;
      expect(doc.tee === kind, "the document is of another TEE", [`${at}/document`]);
      expect(sameJson(doc.binding, a.binding), "the binding is not the document's", [
        `${at}/binding`,
        `${at}/document`,
      ]);
      const chainId = input.tee.domain.chain_id;
      const bondVault = deploymentsFor(chainId).KeelsonBondVault;
      expect(bondVault, "no bond vault on this chain", ["/tee/domain/chain_id"]);
      const now = new Date(Number(input.tee.countersign.issuedAt) * 1000);
      let last: unknown;
      for (const build of TEE_BUILDS) {
        try {
          const v = await verifySigner(doc, {
            chainId,
            bondVault,
            policySetHash: input.tee.countersign.policySetHash as `0x${string}`,
            engineBuildId: build.engineBuildId,
            measurements: [build[kind]],
            now,
            issuerJwkThumbprint: (await issuerThumbprint(input)) as `0x${string}`,
          });
          expect(
            v.signer === getAddress(a.signer) && v.measurement === a.measurement,
            "the attestation is of another signer or measurement",
            [`${at}/signer`, `${at}/measurement`, `${at}/document`],
          );
          return pass({ measurement: v.measurement, tcb: v.tcbStatus ?? "" });
        } catch (err) {
          last = err;
        }
      }
      throw last;
    },
  };
}

/** The TDX leg's platform evidence binds its signer to a pinned build and the issuer key. */
export const tdx = attestation("tdx", 3);
/** The Nitro leg's, absent when only the TDX leg countersigned. */
export const nitro = attestation("nitro", 3);
