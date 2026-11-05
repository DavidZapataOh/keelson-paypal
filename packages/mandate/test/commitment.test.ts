import { poseidon2 } from "@keelson/core/poseidon2";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_TABLE,
  categoryMask,
  MERCHANT_TREE_CAPACITY,
  mandateCommitment,
  merchantLeaf,
  merchantMembership,
  merchantNonMembership,
  merchantTree,
  userKeyHash,
  verifyMerchantMembership,
  verifyMerchantNonMembership,
} from "../src/commitment.ts";
import { type Mandate, MandateError, parseMandate } from "../src/schema.ts";
import demo from "./fixtures/demo-mandate.json" with { type: "json" };

const USER_KEY_HASH_VECTOR = 0x219595c517c8f29d11b2230ac8ae01c2b9f57251612bb8f8c7812ca67885d92fn;
const salt = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const mandate = (): Mandate => parseMandate(structuredClone(demo));

function constraint<T extends Mandate["payment"]["constraints"][number]["type"]>(
  m: Mandate,
  type: T,
): Extract<Mandate["payment"]["constraints"][number], { type: T }> {
  const c = m.payment.constraints.find((x) => x.type === type);
  if (!c) throw new Error(`missing ${type}`);
  return c as Extract<Mandate["payment"]["constraints"][number], { type: T }>;
}

function merchants(m: Mandate) {
  const c = m.checkout.constraints.find((x) => x.type === "checkout.allowed_merchants");
  if (c?.type !== "checkout.allowed_merchants") throw new Error("missing allowed_merchants");
  return c.allowed;
}

const ids = Array.from({ length: 20 }, (_, i) => `mrc_${i.toString(36)}`);

describe("merchantLeaf", () => {
  it("is deterministic and distinguishes ids of every length", async () => {
    const long = "m".repeat(70);
    expect(await merchantLeaf("mrc_runfast")).toBe(await merchantLeaf("mrc_runfast"));
    const leaves = new Set(
      await Promise.all(["a", "b", long, `${long}x`, "é"].map((id) => merchantLeaf(id))),
    );
    expect(leaves.size).toBe(5);
  });

  it("rejects empty ids and NUL characters", async () => {
    await expect(merchantLeaf("")).rejects.toThrow(RangeError);
    await expect(merchantLeaf("a\0b")).rejects.toThrow(RangeError);
  });
});

describe("merchantTree", () => {
  it("throws on an empty list, duplicates, and more than its capacity", async () => {
    await expect(merchantTree([])).rejects.toThrow(RangeError);
    await expect(merchantTree(["a", "a"])).rejects.toThrow(RangeError);
    const over = Array.from({ length: MERCHANT_TREE_CAPACITY + 1 }, (_, i) => `m${i}`);
    await expect(merchantTree(over)).rejects.toThrow(RangeError);
  });

  it("builds a one-merchant tree", async () => {
    const tree = await merchantTree(["mrc_runfast"]);
    expect(tree.root).toBeGreaterThan(0n);
    expect(tree.leaves).toEqual([await merchantLeaf("mrc_runfast")]);
  });

  it("is independent of input order and sorts leaves ascending", async () => {
    const a = await merchantTree(ids);
    const b = await merchantTree([...ids].reverse());
    expect(a.root).toBe(b.root);
    expect(a.leaves).toEqual([...a.leaves].sort((x, y) => (x < y ? -1 : 1)));
  });

  it("proves membership by recomputing the root", async () => {
    const tree = await merchantTree(ids);
    for (const id of [ids[0] as string, ids[7] as string, ids[19] as string]) {
      const proof = await merchantMembership(tree, id);
      expect(proof.path).toHaveLength(8);
      expect(await verifyMerchantMembership(tree.root, id, proof)).toBe(true);
      expect(await verifyMerchantMembership(tree.root, "mrc_other", proof)).toBe(false);
    }
    await expect(merchantMembership(tree, "mrc_other")).rejects.toThrow(RangeError);
  });

  it("proves non-membership with a low leaf and rejects it for a present id", async () => {
    const tree = await merchantTree(ids);
    const absent = ["mrc_runfast", "x", "mrc_zz", "another"];
    for (const id of absent) {
      const proof = await merchantNonMembership(tree, id);
      const v = await merchantLeaf(id);
      expect(proof.low.value < v).toBe(true);
      expect(proof.low.next === 0n || v < proof.low.next).toBe(true);
      expect(await verifyMerchantNonMembership(tree.root, id, proof)).toBe(true);
    }
    await expect(merchantNonMembership(tree, ids[3] as string)).rejects.toThrow(RangeError);
    for (const present of ids) {
      const v = await merchantLeaf(present);
      const low = tree.leaves.filter((x) => x < v).length;
      const proof = await merchantNonMembership(tree, absent[0] as string);
      const forged = { ...proof, index: low };
      expect(await verifyMerchantNonMembership(tree.root, present, forged)).toBe(false);
      expect(await verifyMerchantNonMembership(tree.root, present, proof)).toBe(false);
    }
  });

  it("proves non-membership below the smallest and above the largest leaf", async () => {
    const tree = await merchantTree(["mrc_runfast"]);
    const v = await merchantLeaf("mrc_runfast");
    for (const id of ids) {
      const proof = await merchantNonMembership(tree, id);
      expect(proof.index).toBe((await merchantLeaf(id)) < v ? 0 : 1);
      expect(await verifyMerchantNonMembership(tree.root, id, proof)).toBe(true);
    }
  });

  it("rejects an empty low leaf opened at an unused slot", async () => {
    const tree = await merchantTree(["shop-a", "shop-b"]);
    const empty = { value: 0n, next: 0n, nextIndex: 0 };
    for (const index of [3, 5, 200, 255]) {
      const path = tree.layers.slice(0, 8).map((layer, h) => layer[(index >> h) ^ 1] as bigint);
      for (const id of ["shop-a", "shop-b", "shop-c"]) {
        const proof = { low: empty, path, index };
        expect(await verifyMerchantNonMembership(tree.root, id, proof)).toBe(false);
      }
    }
    expect(
      await verifyMerchantNonMembership(
        tree.root,
        "shop-c",
        await merchantNonMembership(tree, "shop-c"),
      ),
    ).toBe(true);
  });

  it("uses the zero leaf below the smallest id and the max leaf above the largest", async () => {
    const tree = await merchantTree(ids);
    const values = await Promise.all(
      Array.from({ length: 400 }, (_, i) => `probe_${i}`).map(async (id) => ({
        id,
        v: await merchantLeaf(id),
      })),
    );
    const min = tree.leaves[0] as bigint;
    const max = tree.leaves.at(-1) as bigint;
    const below = values.find((p) => p.v < min);
    const above = values.find((p) => p.v > max);
    if (!below || !above) throw new Error("no probe below the min or above the max");
    const low = await merchantNonMembership(tree, below.id);
    expect(low.index).toBe(0);
    expect(low.low).toEqual({ value: 0n, next: min, nextIndex: 1 });
    expect(await verifyMerchantNonMembership(tree.root, below.id, low)).toBe(true);
    const high = await merchantNonMembership(tree, above.id);
    expect(high.index).toBe(ids.length);
    expect(high.low).toEqual({ value: max, next: 0n, nextIndex: 0 });
    expect(await verifyMerchantNonMembership(tree.root, above.id, high)).toBe(true);
  });

  it("rejects a proof against another root", async () => {
    const tree = await merchantTree(ids);
    const other = await merchantTree([...ids, "mrc_runfast"]);
    const proof = await merchantMembership(tree, ids[0] as string);
    expect(await verifyMerchantMembership(other.root, ids[0] as string, proof)).toBe(false);
  });
});

describe("categoryMask", () => {
  it("sets exactly one bit for a single category", () => {
    const mask = categoryMask(["gpt:187"]);
    expect(mask).toBe(1n << BigInt(CATEGORY_TABLE.ids.indexOf("gpt:187")));
    expect(mask.toString(2).replaceAll("0", "")).toBe("1");
  });

  it("covers the top-level taxonomy and rejects unknown ids", () => {
    expect(CATEGORY_TABLE.version).toBe("v1");
    expect(CATEGORY_TABLE.ids).toContain("gpt:166");
    expect(CATEGORY_TABLE.ids).toHaveLength(22);
    expect(categoryMask(["gpt:166", "gpt:187"]).toString(2).replaceAll("0", "")).toBe("11");
    expect(() => categoryMask(["gpt:999999"])).toThrow(RangeError);
  });
});

describe("userKeyHash", () => {
  const limbs = (b64: string) => {
    const v = BigInt(`0x${Buffer.from(b64, "base64url").toString("hex")}`);
    return [v >> 128n, v & ((1n << 128n) - 1n)];
  };

  it("hashes the P-256 coordinates as four 128-bit big-endian limbs", async () => {
    const { x, y } = demo.user.cred.jwk;
    expect(await userKeyHash({ x, y })).toBe(await poseidon2([...limbs(x), ...limbs(y)]));
  });

  it("matches the pinned vector for the demo key", async () => {
    expect(await userKeyHash(demo.user.cred.jwk)).toBe(USER_KEY_HASH_VECTOR);
  });

  it("separates different keys and swapped coordinates", async () => {
    const a = demo.user.cred.jwk;
    const b = demo.agent.cnf.jwk;
    const hashes = new Set(
      await Promise.all([
        userKeyHash(a),
        userKeyHash(b),
        userKeyHash({ x: a.y, y: a.x }),
        userKeyHash({ x: a.x, y: b.y }),
      ]),
    );
    expect(hashes.size).toBe(4);
  });

  it("rejects non-canonical or wrong-length coordinates", async () => {
    const { x, y } = demo.user.cred.jwk;
    const last = x.at(-1) === "A" ? "B" : "A";
    await expect(userKeyHash({ x: `${x.slice(0, -1)}B`, y })).rejects.toThrow(RangeError);
    await expect(userKeyHash({ x: x.slice(0, -1), y })).rejects.toThrow(RangeError);
    await expect(userKeyHash({ x: `${x}${last}`, y })).rejects.toThrow(RangeError);
    await expect(userKeyHash({ x: `${x.slice(0, -1)}=`, y })).rejects.toThrow(RangeError);
  });
});

describe("mandateCommitment", () => {
  it("is deterministic and a field element", async () => {
    const a = await mandateCommitment(mandate(), salt);
    expect(a).toBe(await mandateCommitment(mandate(), salt));
    expect(a).toBeGreaterThan(0n);
  });

  it("rejects a salt that is not 16 bytes", async () => {
    await expect(mandateCommitment(mandate(), new Uint8Array(15))).rejects.toThrow(RangeError);
  });

  it("validates the mandate it commits to", async () => {
    const bad = mandate();
    bad.nonce = "AAAAAAAAAAAAAAAAAAAAAB";
    await expect(mandateCommitment(bad, salt)).rejects.toThrow(MandateError);
    const padded = mandate();
    padded.agent.operator.agent_id = "042";
    await expect(mandateCommitment(padded, salt)).rejects.toThrow(RangeError);
    const zero = mandate();
    zero.agent.operator.agent_id = "0";
    await expect(mandateCommitment(zero, salt)).resolves.toBeTypeOf("bigint");
  });

  it("changes when any one of its inputs changes", async () => {
    const base = await mandateCommitment(mandate(), salt);
    const mutations: [string, (m: Mandate) => void][] = [
      [
        "user_key_hash",
        (m) => {
          m.user.cred.jwk.x = demo.agent.cnf.jwk.x;
        },
      ],
      [
        "max_amount",
        (m) => {
          constraint(m, "payment.amount_range").max = 9999;
        },
      ],
      [
        "currency_num",
        (m) => {
          m.payment.currency = "EUR";
          constraint(m, "payment.amount_range").currency = "EUR";
          constraint(m, "payment.budget").currency = "EUR";
        },
      ],
      [
        "category_mask",
        (m) => {
          const c = m.checkout.constraints.find((x) => x.type === "keelson.category");
          if (c?.type === "keelson.category") c.allow = ["gpt:166"];
        },
      ],
      [
        "merchant_root",
        (m) => {
          (merchants(m)[0] as { id: string }).id = "mrc_other";
        },
      ],
      [
        "expiry",
        (m) => {
          m.exp -= 1;
        },
      ],
      [
        "operator_id",
        (m) => {
          m.agent.operator.agent_id = "43";
        },
      ],
      [
        "nonce",
        (m) => {
          m.nonce = "AAAAAAAAAAAAAAAAAAAAAA";
        },
      ],
    ];
    const seen = new Set([base]);
    for (const [name, mutate] of mutations) {
      const m = mandate();
      mutate(m);
      const c = await mandateCommitment(m, salt);
      expect(c, name).not.toBe(base);
      seen.add(c);
    }
    const otherSalt = salt.slice();
    otherSalt[15] = 0xff;
    seen.add(await mandateCommitment(mandate(), otherSalt));
    expect(seen.size).toBe(10);
  });

  it("matches the spec formula over its ten inputs", async () => {
    const m = mandate();
    const c = await mandateCommitment(m, salt);
    const tree = await merchantTree(merchants(m).map((x) => x.id));
    const nonce = BigInt(`0x${Buffer.from(m.nonce, "base64url").toString("hex")}`);
    const s = BigInt(`0x${Buffer.from(salt).toString("hex")}`);
    const expected = await poseidon2([
      0x4b45454c534f4e5f4d414e44415445n,
      await userKeyHash(m.user.cred.jwk),
      10000n,
      840n,
      categoryMask(["gpt:187"]),
      tree.root,
      BigInt(m.exp),
      42n,
      nonce,
      s,
    ]);
    expect(c).toBe(expected);
  });

  it("builds a full tree and a commitment within budget", async () => {
    const full = Array.from({ length: MERCHANT_TREE_CAPACITY }, (_, i) => `mrc_${i}`);
    await merchantTree(full);
    const t0 = performance.now();
    await merchantTree(full);
    const tree = performance.now() - t0;
    const t1 = performance.now();
    await mandateCommitment(mandate(), salt);
    const commit = performance.now() - t1;
    console.info(
      `merchantTree(${full.length}): ${tree.toFixed(1)} ms, C_m: ${commit.toFixed(2)} ms`,
    );
    expect(tree).toBeLessThan(100);
    expect(commit).toBeLessThan(10);
  });
});
