import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OPERATOR_LINK_TYPES, operatorLinkDomain, verifyOperatorLink } from "../src/index.ts";
import { type Fork, startFork } from "./anvil.ts";

const live = process.env.KEELSON_LIVE === "1";
const thumbprint = `0x${"ab".repeat(32)}` as Hex;
const inAnHour = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

const sign = (account: PrivateKeyAccount, agentId: bigint, deadline: bigint) =>
  account.signTypedData({
    domain: operatorLinkDomain(421614),
    types: OPERATOR_LINK_TYPES,
    primaryType: "OperatorLink",
    message: { agentId, cnfThumbprint: thumbprint, deadline },
  });

/** The official Identity registry on an anvil fork of Arbitrum Sepolia. */
describe.skipIf(!live)("verifyOperatorLink on an anvil fork", { timeout: 120_000 }, () => {
  let fork: Fork;
  const verify = (agentId: bigint, deadline: bigint, signature: Hex) =>
    verifyOperatorLink(fork.client, 421614, agentId, thumbprint, deadline, signature);

  beforeAll(async () => {
    fork = await startFork(18_804);
  });
  afterAll(() => fork?.stop());

  test("the owner's signature links the agent", async () => {
    const owner = await fork.account();
    const agentId = await fork.register(owner);
    const deadline = inAnHour();
    expect(await verify(agentId, deadline, await sign(owner, agentId, deadline))).toEqual({
      ok: true,
      signer: owner.address,
      owner: owner.address,
    });
  });

  test("the agent wallet's signature links the agent", async () => {
    const owner = await fork.account();
    const wallet = await fork.account();
    const agentId = await fork.register(owner);
    await fork.setAgentWallet(owner, agentId, wallet);
    const deadline = inAnHour();
    expect(await verify(agentId, deadline, await sign(wallet, agentId, deadline))).toEqual({
      ok: true,
      signer: wallet.address,
      owner: owner.address,
    });
  });

  test("a stranger's signature is refused", async () => {
    const agentId = await fork.register(await fork.account());
    const deadline = inAnHour();
    const stranger = await fork.account();
    expect(await verify(agentId, deadline, await sign(stranger, agentId, deadline))).toEqual({
      ok: false,
      reason: "not-owner",
    });
  });

  test("after a transfer only the new owner links the agent", async () => {
    const owner = await fork.account();
    const wallet = await fork.account();
    const next = await fork.account();
    const agentId = await fork.register(owner);
    await fork.setAgentWallet(owner, agentId, wallet);
    await fork.transfer(owner, agentId, next.address);
    const deadline = inAnHour();
    for (const old of [owner, wallet]) {
      expect(await verify(agentId, deadline, await sign(old, agentId, deadline))).toEqual({
        ok: false,
        reason: "not-owner",
      });
    }
    expect(await verify(agentId, deadline, await sign(next, agentId, deadline))).toEqual({
      ok: true,
      signer: next.address,
      owner: next.address,
    });
  });

  test("an unminted agent id is not an agent", async () => {
    const someone = await fork.account();
    const deadline = inAnHour();
    const unminted = 2n ** 64n;
    expect(await verify(unminted, deadline, await sign(someone, unminted, deadline))).toEqual({
      ok: false,
      reason: "no-agent",
    });
  });

  test("a past deadline is refused before any read", async () => {
    const owner = await fork.account();
    const agentId = await fork.register(owner);
    const deadline = BigInt(Math.floor(Date.now() / 1000) - 1);
    expect(await verify(agentId, deadline, await sign(owner, agentId, deadline))).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});
