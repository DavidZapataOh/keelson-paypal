/** A witness policy in the Sigsum policy format (sigsum-go `doc/policy.md`). */
export interface WitnessPolicy {
  /** The log keys, as written on the `log` lines. */
  logs: string[];
  /** Witness name → key, as written on the `witness` lines. */
  witnesses: Map<string, string>;
  /** The group the `quorum` line names: `k` of `members` (witness names) must cosign. */
  quorum: { group: string; k: number; members: string[] };
}

/**
 * Parses a Sigsum policy whose quorum group lists witnesses directly. `quorum none` gives
 * `k = 0`.
 */
export function parseWitnessPolicy(text: string): WitnessPolicy {
  const logs: string[] = [];
  const witnesses = new Map<string, string>();
  const groups = new Map<string, { k: number; members: string[] }>();
  let quorum: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (line === "") continue;
    const [kind, ...args] = line.split(/\s+/) as [string, ...string[]];
    if (kind === "log" && (args.length === 1 || args.length === 2)) {
      logs.push(args[0] as string);
    } else if (kind === "witness" && (args.length === 2 || args.length === 3)) {
      const [name, key] = args as [string, string];
      if (witnesses.has(name) || groups.has(name)) throw new Error(`duplicate name: ${name}`);
      witnesses.set(name, key);
    } else if (kind === "group" && args.length >= 3) {
      const [name, threshold, ...members] = args as [string, string, ...string[]];
      if (witnesses.has(name) || groups.has(name)) throw new Error(`duplicate name: ${name}`);
      for (const m of members) {
        if (!witnesses.has(m)) throw new Error(`group ${name}: ${m} is not a witness`);
      }
      if (new Set(members).size !== members.length) throw new Error(`group ${name}: duplicate`);
      const k =
        threshold === "all"
          ? members.length
          : threshold === "any"
            ? 1
            : /^[1-9][0-9]*$/.test(threshold)
              ? Number(threshold)
              : Number.NaN;
      if (!(k >= 1 && k <= members.length)) throw new Error(`group ${name}: bad threshold`);
      groups.set(name, { k, members });
    } else if (kind === "quorum" && args.length === 1 && quorum === undefined) {
      quorum = args[0] as string;
    } else {
      throw new Error(`malformed policy line: ${line}`);
    }
  }
  if (quorum === undefined) throw new Error("the policy has no quorum line");
  if (quorum === "none") return { logs, witnesses, quorum: { group: "none", k: 0, members: [] } };
  const group = groups.get(quorum);
  if (!group) throw new Error(`quorum names an unknown group: ${quorum}`);
  return { logs, witnesses, quorum: { group: quorum, ...group } };
}
