import { readFileSync } from "node:fs";
import { deploymentsFor } from "@keelson/chain";
import { sha256 } from "@keelson/core";
import { createPublicClient, type Hex, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, test } from "vitest";
import { fromBase64, fromBase64url, toBase64, toBase64url } from "../src/b64.ts";
import { leafHashOf } from "../src/codec.ts";
import type { AlibiBundle } from "../src/schema.ts";
import { type VerifyOptions, verifyAlibi } from "../src/verify/index.ts";
import { copy, fixtures } from "./fixtures.ts";
import { liveChain, memoized } from "./live.ts";

const live = process.env.KEELSON_LIVE === "1";
const full = fixtures.find((f) => f.mode === "2of2" && f.anchored);
const degraded = fixtures.find((f) => f.mode === "degraded");
const nitroOfAnotherBoot = (
  JSON.parse(
    readFileSync(new URL("../../attest/test/evidence/nitro-leg-b.json", import.meta.url), "utf8"),
  ) as { attestation: { document: string } }
).attestation.document;

const assertionOfAnotherMandate = (
  JSON.parse(
    readFileSync(
      new URL("../../mandate/test/vectors/webauthn-captures.json", import.meta.url),
      "utf8",
    ),
  ) as {
    signed: {
      webauthn: { assertion: Record<"authenticatorData" | "clientDataJSON" | "signature", string> };
    };
  }
).signed.webauthn.assertion;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Raises the budget cap in its disclosure and re-points the payload at the new disclosure. */
function raiseCap(x: AlibiBundle): void {
  const at = x.mandate.disclosures.findIndex((d) =>
    decoder.decode(fromBase64url(d)).includes('"max",'),
  );
  const old = x.mandate.disclosures[at] as string;
  const [salt, key, value] = JSON.parse(decoder.decode(fromBase64url(old))) as [
    string,
    string,
    number,
  ];
  const raised = toBase64url(encoder.encode(JSON.stringify([salt, key, value * 100])));
  const digest = (d: string) => toBase64url(sha256(encoder.encode(d)));
  x.mandate.disclosures[at] = raised;
  x.mandate.payload_sd = JSON.parse(
    JSON.stringify(x.mandate.payload_sd).replace(digest(old), digest(raised)),
  );
}

async function resign(x: AlibiBundle): Promise<void> {
  const attacker = privateKeyToAccount(generatePrivateKey());
  const s = x.tee.signatures[0] as { signer: string; signature: string };
  s.signature = await attacker.sign({ hash: x.tee.digest as Hex });
  s.signer = attacker.address;
}

/** A real transaction of the anchor's block that is not the anchor: the block's first. */
async function otherTx(b: AlibiBundle): Promise<Hex> {
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
  const block = await client.getBlock({ blockNumber: BigInt(b.anchor?.block_number ?? 0) });
  return block.transactions[0] as Hex;
}

type Row = [
  tampering: string,
  check: string,
  reason: string,
  edit: (x: AlibiBundle) => void | Promise<void>,
  opts?: VerifyOptions,
  base?: typeof full,
];

describe.skipIf(!live || !full || !degraded)("every tampering class fails verification", () => {
  const f = full as NonNullable<typeof full>;
  const d = degraded as NonNullable<typeof degraded>;
  const chain = memoized(liveChain());

  const rows: Row[] = [
    ["mandate cap raised in a disclosure", "mandate.challenge", "H_sd", raiseCap],
    [
      "passkey assertion replayed from another mandate",
      "mandate.passkey",
      "challenge",
      (x) => {
        const { authenticatorData, clientDataJSON, signature } = assertionOfAnotherMandate;
        x.mandate.user_auth = { authenticatorData, clientDataJSON, signature };
      },
    ],
    [
      "issuer key replaced by another",
      "mandate.credentials",
      "thumbprint",
      async (x) => {
        const { publicKey } = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        );
        const { kty, crv, x: px, y } = await crypto.subtle.exportKey("jwk", publicKey);
        x.mandate.issuer_jwk = { kty, crv, x: px, y } as never;
      },
    ],
    [
      "cart total changed in the trace context",
      "tee.countersign",
      "evalHash",
      (x) => {
        x.eval.context.total_minor = Number(x.eval.context.total_minor) + 1;
      },
    ],
    [
      "decision flipped",
      "tee.countersign",
      "decision",
      (x) => {
        x.tee.countersign.decision = x.tee.countersign.decision === "1" ? "0" : "1";
      },
    ],
    [
      "countersignature re-signed by another key",
      "tee.countersign",
      "not the attested signer",
      resign,
    ],
    [
      "countersign domain on another chain",
      "tee.countersign",
      "domain",
      (x) => {
        x.tee.domain.chain_id = 11155111;
      },
    ],
    [
      "2-of-2 Alibi with only the TDX signature",
      "tee.countersign",
      "mode",
      (x) => {
        x.tee.signatures = x.tee.signatures.slice(0, 1);
      },
    ],
    [
      "degraded Alibi signed by Nitro",
      "tee.countersign",
      "mode",
      (x) => {
        (x.tee.signatures[0] as { kind: string }).kind = "nitro";
      },
      {},
      d,
    ],
    [
      "Nitro attestation of another boot",
      "tee.attestation.nitro",
      "not valid at",
      (x) => {
        (
          (x.tee.attestations[1] as { document: unknown }).document as { document: string }
        ).document = nitroOfAnotherBoot;
      },
    ],
    [
      "TDX collateral byte flipped",
      "tee.attestation.tdx",
      "Signature is invalid",
      (x) => {
        const c = (
          (x.tee.attestations[0] as { document: unknown }).document as {
            collateral: { tcb_info_signature: number[] };
          }
        ).collateral;
        c.tcb_info_signature[0] = (c.tcb_info_signature[0] as number) ^ 1;
      },
    ],
    [
      "leaf bytes changed",
      "log.inclusion",
      "not included",
      (x) => {
        const leaf = fromBase64(x.leaf);
        leaf[60] = (leaf[60] as number) ^ 1;
        x.leaf = toBase64(leaf);
      },
    ],
    [
      "policy section with an attacker's log key",
      "log.policy",
      "pinned",
      (x) => {
        x.policy.text = x.policy.text.replace(
          /^(log \S+\+)[0-9a-f]{8}\+\S+$/m,
          "$100000000+AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
      },
    ],
    [
      "cosignatures stripped to one",
      "log.witnesses",
      "1 of 2",
      (x) => {
        const cosigs = x.tlog_proof.split("\n").filter((l) => l.startsWith("— witness-"));
        for (const l of cosigs.slice(1)) x.tlog_proof = x.tlog_proof.replace(`${l}\n`, "");
      },
    ],
    [
      "anchored root changed",
      "anchor.root",
      "anchored",
      (x) => {
        const a = x.anchor as { anchored_root: string };
        a.anchored_root = `${a.anchored_root.slice(0, -1)}${a.anchored_root.endsWith("0") ? "1" : "0"}`;
      },
    ],
    [
      "anchor contract changed",
      "anchor.root",
      "pinned",
      (x) => {
        (x.anchor as { contract: string }).contract = deploymentsFor(421614)
          .VerdictVerifier as string;
      },
    ],
    [
      "anchor transaction changed",
      "anchor.tx",
      "CheckpointAnchored",
      async (x) => {
        (x.anchor as { tx_hash: string }).tx_hash = await otherTx(x);
      },
    ],
    [
      "RFC 3161 token of another leaf",
      "timestamps",
      "imprint",
      (x) => {
        x.timestamps = d.bundle.timestamps;
      },
    ],
    [
      "evidence disclosure from another purchase",
      "evidence.manifest",
      "root",
      (x) => {
        x.manifest.disclosures[0] = d.bundle.manifest.disclosures[0] as never;
      },
    ],
    [
      "invoice id of another purchase",
      "paypal.ids",
      "another",
      (x) => {
        x.paypal.invoice_id = d.bundle.paypal.invoice_id;
      },
    ],
    [
      "QR link naming another leaf",
      "qr.leaf",
      "QR",
      () => {},
      { expect: { leafHash: toBase64url(leafHashOf(d.bundle)) } },
    ],
  ];

  test.each(rows)("%s → %s", async (_, check, reason, edit, opts = {}, base = f) => {
    const x = copy(base.bundle);
    await edit(x);
    const report = await verifyAlibi(x, { chain, ...opts });
    const c = report.checks.find((r) => r.id === check);
    expect(c?.status, JSON.stringify(c)).toBe("fail");
    expect(c?.reason).toContain(reason);
    expect(report.verdict).toBe("failed");
  });

  test("the untouched Alibis verify against the chain", async () => {
    for (const b of [f, d]) {
      const report = await verifyAlibi(b.bundle, { chain });
      expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
      expect(report.verdict).toBe("verified");
    }
  });
});
