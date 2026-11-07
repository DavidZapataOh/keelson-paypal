import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { TSA_INTERMEDIATES, TSA_ROOTS } from "../src/roots/index.ts";
import type { TsaId } from "../src/tsas.ts";

/** Runs `openssl ts -verify` on a DER token over a raw digest; returns stdout or throws. */
export function opensslVerify(tsa: TsaId, token: Uint8Array, imprint: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-ts-"));
  const tokenFile = join(dir, "token.der");
  const caFile = join(dir, "root.pem");
  writeFileSync(tokenFile, token);
  writeFileSync(caFile, `${TSA_ROOTS[tsa]}\n`);
  const args = ["ts", "-verify", "-token_in", "-in", tokenFile, "-digest", bytesToHex(imprint)];
  args.push("-CAfile", caFile);
  const intermediate = TSA_INTERMEDIATES[tsa];
  if (intermediate) {
    const untrusted = join(dir, "untrusted.pem");
    writeFileSync(untrusted, `${intermediate}\n`);
    args.push("-untrusted", untrusted);
  }
  return execFileSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (import.meta.main) {
  const { imprint, tokens } = await import("../test/tokens.ts");
  let failed = false;
  for (const [tsa, token] of Object.entries(tokens) as [TsaId, Uint8Array][]) {
    try {
      console.info(`${tsa}: ${opensslVerify(tsa, token, imprint).trim()}`);
    } catch (error) {
      failed = true;
      console.error(`${tsa}: ${(error as { stderr?: string }).stderr ?? error}`);
    }
  }
  if (failed) process.exit(1);
}
