import {
  AttestationCache,
  type DstackEvent,
  type SignerAttestation,
  verifySigner,
} from "@keelson/attest";
import { deploymentsFor } from "@keelson/chain";
import { fromHex } from "@keelson/core";
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

/** A TDX v4 quote: header, TD 1.0 report body, then the length-prefixed signature data. */
const QUOTE_BODY = 48;
const RTMR0 = QUOTE_BODY + 328;
const SIGNATURE_DATA = QUOTE_BODY + 584;

/**
 * What the platform check leaves unread in a TDX document: every event log entry replays into
 * its RTMR, the copies of the app id and compose hash are the event log's, and nothing but zero
 * padding follows the quote's signature data.
 */
async function tdxDocument(doc: Record<string, unknown>, at: string): Promise<void> {
  const quote = fromHex(`0x${String(doc.quote)}`);
  const view = new DataView(quote.buffer, quote.byteOffset, quote.byteLength);
  expect(
    quote.length >= SIGNATURE_DATA + 4 && view.getUint16(0, true) === 4,
    "not a version 4 TDX quote",
    [`${at}/quote`],
  );
  const end = SIGNATURE_DATA + 4 + view.getUint32(SIGNATURE_DATA, true);
  expect(
    end <= quote.length && quote.subarray(end).every((b) => b === 0),
    "the quote carries bytes after its signature data",
    [`${at}/quote`],
  );
  const events = doc.eventLog as DstackEvent[];
  for (const imr of [0, 1, 2]) {
    let rtmr = new Uint8Array(48);
    for (const e of events) {
      if (e.imr !== imr) continue;
      const data = new Uint8Array([...rtmr, ...fromHex(`0x${e.digest}`)]);
      rtmr = new Uint8Array(await crypto.subtle.digest("SHA-384", data));
    }
    const quoted = quote.subarray(RTMR0 + 48 * imr, RTMR0 + 48 * (imr + 1));
    expect(
      rtmr.every((b, i) => b === quoted[i]),
      `the event log does not replay to the quote's RTMR${imr}`,
      [`${at}/eventLog`, `${at}/quote`],
    );
  }
  const runtime = (name: string) =>
    events.find((e) => e.imr === 3 && e.event === name)?.event_payload.toLowerCase();
  expect(
    doc.app_id === runtime("app-id") && doc.compose_hash === runtime("compose-hash"),
    "the app id or compose hash is not the event log's",
    [`${at}/app_id`, `${at}/compose_hash`, `${at}/eventLog`],
  );
}

/** One per process: the legs' documents repeat across the Alibis issued while they are current. */
const cache = new AttestationCache();

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
      const attested = String(doc.binding?.engineBuildId).toLowerCase();
      const builds = TEE_BUILDS.filter((b) => b.engineBuildId.toLowerCase() === attested);
      expect(builds.length > 0, "the attested engine build is not a published one", [
        `${at}/binding`,
      ]);
      let last: unknown;
      for (const build of builds) {
        let v: Awaited<ReturnType<typeof verifySigner>>;
        try {
          v = await verifySigner(doc, {
            chainId,
            bondVault,
            policySetHash: input.tee.countersign.policySetHash as `0x${string}`,
            engineBuildId: build.engineBuildId,
            measurements: [build[kind]],
            now,
            issuerJwkThumbprints: [(await issuerThumbprint(input)) as `0x${string}`],
            cache,
          });
          expect(
            v.signer === getAddress(a.signer) && v.measurement === a.measurement,
            "the attestation is of another signer or measurement",
            [`${at}/signer`, `${at}/measurement`, `${at}/document`],
          );
        } catch (err) {
          last = err;
          continue;
        }
        if (kind === "tdx")
          await tdxDocument(a.document as Record<string, unknown>, `${at}/document`);
        return pass({ measurement: v.measurement, tcb: v.tcbStatus ?? "" });
      }
      throw last;
    },
  };
}

/** The TDX leg's platform evidence binds its signer to a pinned build and the issuer key. */
export const tdx = attestation("tdx", 3);
/** The Nitro leg's, absent when only the TDX leg countersigned. */
export const nitro = attestation("nitro", 3);
