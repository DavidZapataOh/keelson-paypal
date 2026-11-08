import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import * as abis from "../src/abis.ts";
import {
  accessManagerAbi,
  addresses,
  chainIds,
  deploymentsFor,
  keelsonDeployerAbi,
  roles,
  timelockControllerAbi,
} from "../src/index.ts";

const governance = ["KeelsonDeployer", "AccessManager", "TimelockController", "GuardianSafe"];

describe("@keelson/chain", () => {
  it("covers exactly the three chains", () => {
    expect(Object.keys(addresses).map(Number).sort()).toEqual([...chainIds].sort());
    expect([...chainIds]).toEqual([421614, 42161, 11155111]);
  });

  it("has checksummed governance addresses, equal on every chain that has them", () => {
    for (const name of governance) {
      const seen = chainIds.map((id) => addresses[id][name]).filter((a) => a !== undefined);
      for (const address of seen) expect(getAddress(address)).toBe(address);
      expect(new Set(seen).size).toBeLessThanOrEqual(1);
    }
  });

  it("returns deployments for supported chains and rejects others", () => {
    expect(deploymentsFor(421614)).toBe(addresses[421614]);
    expect(() => deploymentsFor(1)).toThrow(RangeError);
  });

  it("exports non-empty abis, including the deployer's entry points", () => {
    const all = Object.values(abis);
    expect(all.length).toBeGreaterThan(0);
    for (const abi of all) expect(abi.length).toBeGreaterThan(0);
    expect(accessManagerAbi.length).toBeGreaterThan(0);
    expect(timelockControllerAbi.length).toBeGreaterThan(0);
    const fn = (name: string) =>
      keelsonDeployerAbi.find((item) => item.type === "function" && item.name === name);
    expect(fn("deploy")).toMatchObject({ inputs: [{ type: "bytes32" }, { type: "bytes" }] });
    expect(fn("predict")).toMatchObject({ inputs: [{ type: "bytes32" }] });
  });

  it("matches the role ids in KeelsonRoles.sol", () => {
    const source = readFileSync(
      new URL("../../../contracts/src/access/KeelsonRoles.sol", import.meta.url),
      "utf8",
    );
    const solidity = Object.fromEntries(
      [...source.matchAll(/uint64 internal constant (\w+_ROLE) = (\d+);/g)].map((m) => [
        m[1],
        BigInt(m[2] as string),
      ]),
    );
    expect(roles).toEqual(solidity);
  });
});
