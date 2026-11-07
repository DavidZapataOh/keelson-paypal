import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { requestTimestamp, TimestampError } from "../src/index.ts";

test("a reply larger than 64 KiB is refused before it is parsed", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/timestamp-reply" });
    res.end(Buffer.alloc(65 * 1024, 0x30));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const error = await requestTimestamp(
      { id: "digicert", url: `http://127.0.0.1:${port}/` },
      new Uint8Array(32),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimestampError);
    expect((error as TimestampError).code).toBe("tsa-http");
    expect((error as TimestampError).message).toMatch(/64 KiB/);
  } finally {
    server.close();
  }
});
