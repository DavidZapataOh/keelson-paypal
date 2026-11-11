import { describe, expect, test } from "vitest";
import { fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { v2Bundle, vector } from "../../../packages/alibi/test/v2.ts";
import { envelopeOf } from "../src/server.ts";

describe("the Alibi card's envelope", () => {
  test("a v2 Alibi is a SCITT statement, served at its .cose url, issued at its CWT iat", () => {
    const b = v2Bundle();
    const iat = Number(vector("allow-2of2").inputs.countersign.issuedAt);
    expect(envelopeOf(b)).toEqual({
      envelope: "scitt",
      statementUrl: `https://api.keelson.finance/v1/alibis/${b.alibi_id}.cose`,
      issuedAt: new Date(iat * 1000).toISOString().replace(".000Z", "Z"),
      timestamps: 0,
    });
  });

  test("a v1 Alibi keeps its own envelope, issue time and timestamps", () => {
    const f = fixtures[0];
    if (!f) throw new Error("no fixture");
    expect(envelopeOf(f.bundle)).toEqual({
      envelope: "v1",
      statementUrl: null,
      issuedAt: f.bundle.leaf_view.issued_at,
      timestamps: f.bundle.timestamps.length,
    });
  });
});
