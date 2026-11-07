import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DIGICERT_TRUSTED_ROOT_G4_PEM } from "../src/roots/digicert-trusted-root-g4.ts";
import { FREETSA_ROOT_PEM } from "../src/roots/freetsa.ts";
import { SECTIGO_QUALIFIED_ROOT_R45_PEM } from "../src/roots/sectigo-qualified-r45.ts";
import { SIGSTORE_TSA_ROOT_PEM, SIGSTORE_TSA_SIGNER_PEM } from "../src/roots/sigstore-tsa.ts";
import type { TsaId } from "../src/tsas.ts";

const ROOTS: Record<TsaId, string> = {
  digicert: DIGICERT_TRUSTED_ROOT_G4_PEM,
  sigstore: SIGSTORE_TSA_ROOT_PEM,
  freetsa: FREETSA_ROOT_PEM,
  sectigo: SECTIGO_QUALIFIED_ROOT_R45_PEM,
};

/** Runs `openssl ts -verify` on a DER token over a raw digest; returns stdout or throws. */
export function opensslVerify(tsa: TsaId, token: Uint8Array, imprint: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-ts-"));
  const tokenFile = join(dir, "token.der");
  const caFile = join(dir, "root.pem");
  writeFileSync(tokenFile, token);
  writeFileSync(caFile, `${ROOTS[tsa]}\n`);
  const args = ["ts", "-verify", "-token_in", "-in", tokenFile, "-digest", bytesToHex(imprint)];
  args.push("-CAfile", caFile);
  if (tsa === "sigstore") {
    const untrusted = join(dir, "untrusted.pem");
    writeFileSync(untrusted, `${SIGSTORE_TSA_SIGNER_PEM}\n`);
    args.push("-untrusted", untrusted);
  }
  return execFileSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
