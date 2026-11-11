import { verifySignature } from "http-message-sig";
import { describe, expect, it } from "vitest";
import {
  alibiHeader,
  ecdsaVerifier,
  signAgentRequest,
  TAP_TAGS,
  verifyAgentRequest,
} from "../src/tap.ts";
import { freshSigner } from "./fixtures.ts";

const NOW = 1_794_219_430;

async function signed(withAlibi = true) {
  const agent = await freshSigner();
  const headers = new Headers();
  if (withAlibi)
    headers.set(
      "Keelson-Alibi",
      alibiHeader(
        "01M6ZWZJHWRRHQEYNJAT7NMSV8",
        "https://verify.keelson.finance/a/01M6ZWZJHWRRHQEYNJAT7NMSV8",
      ),
    );
  const request = new Request("https://runfast.example/checkout/complete", {
    method: "POST",
    headers,
  });
  const fields = await signAgentRequest(request, agent, {
    tag: TAP_TAGS.pay,
    created: NOW,
    nonce: "bm9uY2UtMQ",
    withAlibi,
  });
  const out = new Headers(headers);
  out.set("Signature-Input", fields.signatureInput);
  out.set("Signature", fields.signature);
  return { agent, fields, request: new Request(request.url, { method: "POST", headers: out }) };
}

describe("Visa TAP / Web Bot Auth", () => {
  it("signs @authority, @path and Keelson-Alibi with TAP's parameters", async () => {
    const { fields, agent } = await signed();
    expect(fields.signatureInput).toBe(
      `sig2=("@authority" "@path" "keelson-alibi");created=${NOW};expires=${NOW + 480};keyid="${agent.kid}";alg="ecdsa-p256-sha256";nonce="bm9uY2UtMQ";tag="agent-payer-auth"`,
    );
  });

  it("verifies with the agent's key", async () => {
    const { request, agent } = await signed();
    const verified = await verifyAgentRequest(request, async () => agent.jwk, {
      now: NOW + 5,
      requireAlibi: true,
    });
    expect(verified.parameters.tag).toBe("agent-payer-auth");
  });

  it("refuses a request whose Keelson-Alibi was swapped", async () => {
    const { request, agent } = await signed();
    const headers = new Headers(request.headers);
    headers.set(
      "Keelson-Alibi",
      alibiHeader(
        "01M73ZK3ETHVBBMNZRCBGBDZYJ",
        "https://verify.keelson.finance/a/01M73ZK3ETHVBBMNZRCBGBDZYJ",
      ),
    );
    const tampered = new Request(request.url, { method: "POST", headers });
    await expect(
      verifyAgentRequest(tampered, async () => agent.jwk, { now: NOW + 5, requireAlibi: true }),
    ).rejects.toThrow();
  });

  it("refuses an expired signature and one that leaves the Alibi out when it is required", async () => {
    const { request, agent } = await signed(false);
    await expect(
      verifyAgentRequest(request, async () => agent.jwk, { now: NOW + 5, requireAlibi: true }),
    ).rejects.toThrow();
    await expect(
      verifyAgentRequest(request, async () => agent.jwk, { now: NOW + 600, requireAlibi: false }),
    ).rejects.toThrow();
  });

  it("verifies RFC 9421 Appendix B.2.4 with test-key-ecc-p256", async () => {
    const verifier = await ecdsaVerifier({
      kty: "EC",
      crv: "P-256",
      x: "qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA",
      y: "Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0",
    });
    const verified = await verifySignature(
      {
        kind: "response",
        status: 200,
        fields: [
          { name: "date", value: "Tue, 20 Apr 2021 02:07:56 GMT" },
          { name: "content-type", value: "application/json" },
          {
            name: "content-digest",
            value:
              "sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:",
          },
          { name: "content-length", value: "23" },
          {
            name: "signature-input",
            value:
              'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
          },
          {
            name: "signature",
            value:
              "sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:",
          },
        ],
      },
      {
        label: "sig-b24",
        policy: {
          algorithms: ["ecdsa-p256-sha256"],
          requiredComponents: ["@status"],
          requiredParameters: ["keyid"],
          now: 1618884473,
        },
        resolveVerifier: () => verifier,
      },
    );
    expect(verified.parameters.keyid).toBe("test-key-ecc-p256");
  });
});
