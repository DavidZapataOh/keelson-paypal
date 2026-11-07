/**
 * A second opinion on captured evidence. The TDX attestation is sent to `dstack-verifier`, whose
 * answer must match this package's: same TCB status, report data, app id and compose hash. The
 * Nitro document, which dstack does not handle, is checked again with `node:crypto` alone.
 *
 *   node scripts/dstack-verify.ts <verifier-url> <tdx-evidence.json> <nitro-evidence.json>
 */
import { verify, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Decoder, Encoder } from "cbor-x";
import { verifyNitro } from "../src/nitro.ts";
import { verifyTdx } from "../src/tdx.ts";

const [verifierUrl, tdxPath, nitroPath] = process.argv.slice(2);
if (!verifierUrl || !tdxPath || !nitroPath) {
  throw new Error(
    "usage: dstack-verify.ts <verifier-url> <tdx-evidence.json> <nitro-evidence.json>",
  );
}
const evidence = async (path: string) => JSON.parse(await readFile(path, "utf8"));

function agree(what: string, ours: unknown, theirs: unknown) {
  if (ours !== theirs) throw new Error(`${what}: ${String(ours)} here, ${String(theirs)} there`);
  console.log(`agree ${what} ${String(ours)}`);
}

const tdx = await evidence(tdxPath);
const att = tdx.attestation;
const ours = await verifyTdx(
  { quote: Buffer.from(att.quote, "hex"), eventLog: att.event_log, collateral: tdx.collateral },
  { now: new Date(tdx.capturedAt) },
);
const response = await fetch(new URL("/verify", verifierUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ attestation: att.attestation }),
});
if (!response.ok) throw new Error(`dstack-verifier answered ${response.status}`);
const theirs = (await response.json()) as {
  is_valid: boolean;
  details: {
    report_data: string;
    tcb_status: string;
    app_info: { app_id: string; compose_hash: string };
  };
};
agree("is_valid", true, theirs.is_valid);
agree("report_data", ours.reportData.slice(2), theirs.details.report_data);
agree("tcb_status", ours.tcbStatus, theirs.details.tcb_status);
agree("app_id", ours.appId.slice(2), theirs.details.app_info.app_id);
agree("compose_hash", ours.composeHash.slice(2), theirs.details.app_info.compose_hash);

const nitro = await evidence(nitroPath);
const now = new Date(nitro.capturedAt);
const document = Buffer.from(nitro.attestation.document, "base64");
await verifyNitro(document, { now });
const decoded = new Decoder().decode(document);
const [protectedHeader, , payload, signature] = (decoded.value ?? decoded) as Buffer[];
const body = new Decoder({ mapsAsObjects: true }).decode(payload as Buffer) as {
  certificate: Buffer;
  cabundle: Buffer[];
};
const chain = [...body.cabundle, body.certificate].map((der) => new X509Certificate(der));
chain.forEach((cert, i) => {
  const parent = chain[i === 0 ? 0 : i - 1] as X509Certificate;
  if (!cert.verify(parent.publicKey) || !cert.checkIssued(parent)) {
    throw new Error(`certificate ${i} is not issued by its predecessor`);
  }
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
    throw new Error(`certificate ${i} is not valid at the capture time`);
  }
});
const signed = new Encoder().encode(["Signature1", protectedHeader, Buffer.alloc(0), payload]);
const leaf = chain.at(-1) as X509Certificate;
if (
  !verify("sha384", signed, { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, signature as Buffer)
) {
  throw new Error("the Nitro signature does not verify with node:crypto");
}
console.log(`agree nitro chain of ${chain.length} certificates and signature (node:crypto)`);
