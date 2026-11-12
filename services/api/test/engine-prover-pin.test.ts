import { describe, expect, test } from "vitest";
import { ENGINE_PROVER, requestIdOf } from "../src/zk/engine.ts";

test("the prover is pinned to a published release", () => {
  expect(ENGINE_PROVER.url).toMatch(
    /^https:\/\/github\.com\/DavidZapataOh\/keelson-paypal\/releases\/download\/engine-proof-[0-9a-f]{7}\/keelson-engine-proof-linux-x64$/,
  );
  expect(ENGINE_PROVER.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(ENGINE_PROVER.sha256).not.toBe("0".repeat(64));
});

describe("the request the prover printed", () => {
  const id = `0x${"ab".repeat(32)}`;

  test("is read from its own line among the logger's", () => {
    const stdout = [
      '{"level":"warn","msg":"network"}',
      `{"request_id":"${id}","explorer":"https://explorer.succinct.xyz/request/${id}"}`,
      "",
    ].join("\n");
    expect(requestIdOf(stdout)).toBe(id);
  });

  test("is undefined when no line names a 32-byte request id", () => {
    expect(requestIdOf('{"level":"warn"}\n{"request_id":"0x12"}\nnot json {')).toBeUndefined();
    expect(requestIdOf("")).toBeUndefined();
  });
});
