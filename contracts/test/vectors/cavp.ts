/**
 * Writes `sha384-cavp.json` from NIST's CAVP "SHA Test Vectors for Hashing Byte-Oriented Messages"
 * (`SHA384ShortMsg.rsp` and `SHA384LongMsg.rsp`).
 *
 *   node contracts/test/vectors/cavp.ts
 *
 * Needs `unzip` on the PATH.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL =
  "https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/shs/shabytetestvectors.zip";
const ZIP_SHA256 = "929ef80b7b3418aca026643f6f248815913b60e01741a44bba9e118067f4c9b8";
const FILES = ["SHA384ShortMsg.rsp", "SHA384LongMsg.rsp"] as const;

interface Vector {
  msg: string;
  md: string;
}

/** `Len` is in bits; a zero-length message is written as `Msg = 00`. */
function parse(rsp: string): Vector[] {
  const vectors: Vector[] = [];
  let len = -1;
  let msg = "";
  for (const line of rsp.split(/\r?\n/)) {
    const [key, value] = line.split(" = ");
    if (key === "Len") len = Number(value);
    else if (key === "Msg") msg = value ?? "";
    else if (key === "MD") {
      if (len % 8 !== 0) throw new Error(`Len ${len} is not whole bytes`);
      vectors.push({ msg: `0x${msg.slice(0, len / 4)}`, md: `0x${value}` });
    }
  }
  return vectors;
}

const response = await fetch(URL);
if (!response.ok) throw new Error(`${URL}: ${response.status}`);
const zip = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(zip).digest("hex");
if (digest !== ZIP_SHA256) throw new Error(`unexpected archive sha-256 ${digest}`);

const dir = mkdtempSync(join(tmpdir(), "cavp-"));
try {
  const path = join(dir, "shabytetestvectors.zip");
  writeFileSync(path, zip);
  const [short, long] = FILES.map((file) =>
    parse(execFileSync("unzip", ["-p", path, `shabytetestvectors/${file}`], { encoding: "utf8", maxBuffer: 1 << 24 })),
  );
  const out = join(import.meta.dirname, "sha384-cavp.json");
  writeFileSync(out, `${JSON.stringify({ source: URL, short, long }, null, 1)}\n`);
  console.log(`${out}: ${short?.length} short, ${long?.length} long`);
} finally {
  rmSync(dir, { recursive: true });
}
