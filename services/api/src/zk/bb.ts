import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { Barretenberg } from "@aztec/bb.js";
import type { CompiledCircuit } from "@noir-lang/noir_js";

const circuits = new Map<string, CompiledCircuit>();

/**
 * A circuit's ACIR and ABI from `services/api/zk`, read on its first proof: the API that only
 * delegates proving never loads them.
 */
function circuit(name: string): CompiledCircuit {
  let c = circuits.get(name);
  if (!c) {
    c = JSON.parse(
      readFileSync(new URL(`../../zk/${name}.json`, import.meta.url), "utf8"),
    ) as CompiledCircuit;
    circuits.set(name, c);
  }
  return c;
}

/** A circuit's recursive verification key as fields, with its hash, from `services/api/zk`. */
export function recursiveKey(name: string): { vk: string[]; hash: string } {
  return JSON.parse(
    readFileSync(new URL(`../../zk/${name}.recursive.json`, import.meta.url), "utf8"),
  ) as { vk: string[]; hash: string };
}

let api: Promise<Barretenberg> | undefined;

/** Native bb through bb.js, one per process. */
function barretenberg(): Promise<Barretenberg> {
  api ??= import("@aztec/bb.js")
    .then(({ BackendType, Barretenberg }) =>
      Barretenberg.new({ backend: BackendType.NativeUnixSocket, threads: availableParallelism() }),
    )
    .catch((err: unknown) => {
      api = undefined;
      throw err;
    });
  return api;
}

/** A proof's bytes and its public inputs as 32-byte hex. */
export interface Proved {
  proof: Uint8Array;
  publicInputs: string[];
}

/**
 * Executes circuit `name` on `inputs` and proves the witness for each of `targets`: `evm` for
 * contracts and bb.js, `noir-recursive` for a circuit that verifies it.
 */
export async function prove<T extends "evm" | "noir-recursive">(
  name: string,
  inputs: Record<string, unknown>,
  targets: readonly T[],
): Promise<Record<T, Proved>> {
  const [{ Noir }, { UltraHonkBackend }] = await Promise.all([
    import("@noir-lang/noir_js"),
    import("@aztec/bb.js"),
  ]);
  const { witness } = await new Noir(circuit(name)).execute(inputs as never);
  const backend = new UltraHonkBackend(circuit(name).bytecode, await barretenberg());
  const out = {} as Record<T, Proved>;
  for (const verifierTarget of targets) {
    out[verifierTarget] = await backend.generateProof(witness, { verifierTarget });
  }
  return out;
}
