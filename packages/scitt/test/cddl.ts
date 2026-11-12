import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../../internal/scitt/cddl/validate.sh", import.meta.url).pathname;
const bin = process.env.CDDL_BIN ?? "cddl";

/** Whether the cddl CLI is available; CI sets KEELSON_REQUIRE_CDDL=1, which makes its absence a failure. */
export function hasCddl(): boolean {
  // The tool has no --version: without arguments it prints its usage and exits 64 (EX_USAGE).
  const found = spawnSync(bin, [], { stdio: "ignore" }).status === 64;
  if (!found && process.env.KEELSON_REQUIRE_CDDL === "1") {
    throw new Error(`the cddl CLI (${bin}) is required and was not found`);
  }
  return found;
}

/** Validates bytes against `rule` of a vendored CDDL file. */
export function validateCddl(file: string, rule: string, data: Uint8Array, ext = "cbor"): boolean {
  const tmp = mkdtempSync(join(tmpdir(), "cddl-"));
  try {
    const path = join(tmp, `data.${ext}`);
    writeFileSync(path, data);
    execFileSync(script, [file, rule, path], { stdio: "pipe" });
    return true;
  } catch (e) {
    console.error(`cddl: ${rule} of ${file}:\n${(e as { stderr?: Buffer }).stderr ?? e}`);
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
