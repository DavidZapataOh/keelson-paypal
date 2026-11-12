import { CONFUSABLES } from "./confusables.generated";

/** The scripts a name is resolved against; any other script is its own. */
const SCRIPTS = [
  "Latin",
  "Greek",
  "Cyrillic",
  "Armenian",
  "Hebrew",
  "Arabic",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Thai",
  "Lao",
  "Tibetan",
  "Myanmar",
  "Georgian",
  "Ethiopic",
  "Khmer",
  "Hangul",
  "Hiragana",
  "Katakana",
  "Bopomofo",
  "Han",
] as const;
const SCX = SCRIPTS.map((s) => [s, new RegExp(`^\\p{Script_Extensions=${s}}$`, "u")] as const);
const ANY_SCRIPT = /^[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]$/u;

/**
 * A character's scripts (`Script_Extensions`), with Han, Hiragana, Katakana, Hangul and Bopomofo
 * also counted in the writing systems they combine into (UTS #39 §5.1: Jpan, Kore, Hanb). Common
 * and inherited characters belong to every script: `undefined`.
 */
function scriptsOf(c: string): Set<string> | undefined {
  if (ANY_SCRIPT.test(c)) return undefined;
  const set = new Set<string>(SCX.filter(([, re]) => re.test(c)).map(([s]) => s));
  if (set.size === 0) set.add(`other:${c.codePointAt(0)}`);
  if (set.has("Han")) for (const w of ["Jpan", "Kore", "Hanb"]) set.add(w);
  if (set.has("Hiragana") || set.has("Katakana")) set.add("Jpan");
  if (set.has("Hangul")) set.add("Kore");
  if (set.has("Bopomofo")) set.add("Hanb");
  return set;
}

/**
 * UTS #39 §4 skeleton: NFD, each character to its prototype, NFD again.
 * @internal
 */
export function skeleton(s: string): string {
  let out = "";
  for (const c of s.normalize("NFD")) out += CONFUSABLES[c] ?? c;
  return out.normalize("NFD");
}

type RestrictionLevel =
  | "ascii"
  | "single-script"
  | "highly-restrictive"
  | "moderately-restrictive"
  | "minimally-restrictive";

/**
 * UTS #39 §5.2 restriction level of `s`.
 * @internal
 */
export function restrictionLevel(s: string): RestrictionLevel {
  if ([...s].every((c) => (c.codePointAt(0) as number) < 0x80)) return "ascii";
  let resolved: Set<string> | undefined;
  const used = new Set<string>();
  for (const c of s) {
    const scripts = scriptsOf(c);
    if (!scripts) continue;
    for (const x of scripts)
      if (SCRIPTS.includes(x as never) || x.startsWith("other:")) used.add(x);
    resolved = resolved ? new Set([...resolved].filter((x) => scripts.has(x))) : scripts;
  }
  if (!resolved || resolved.size > 0) return "single-script";
  const within = (allowed: string[]) => [...used].every((x) => allowed.includes(x));
  if (
    within(["Latin", "Han", "Hiragana", "Katakana"]) ||
    within(["Latin", "Han", "Bopomofo"]) ||
    within(["Latin", "Han", "Hangul"])
  ) {
    return "highly-restrictive";
  }
  const others = [...used].filter((x) => x !== "Latin");
  if (others.length === 1 && others[0] !== "Cyrillic" && others[0] !== "Greek") {
    return "moderately-restrictive";
  }
  return "minimally-restrictive";
}

/**
 * Whether `name` can pass for another one written in Latin letters: it mixes scripts that are not
 * normally written together, or it is written wholly in characters that look like ASCII. Returns
 * the name it looks like, or null.
 */
export function confusableWarning(name: string): { lookalike: string } | null {
  const sk = skeleton(name);
  if (sk === name.normalize("NFD")) return null;
  const level = restrictionLevel(name);
  if (level === "ascii") return null;
  const mixed = level === "moderately-restrictive" || level === "minimally-restrictive";
  const wholeAscii = [...sk].every((c) => (c.codePointAt(0) as number) < 0x80);
  return mixed || wholeAscii ? { lookalike: sk.normalize("NFC") } : null;
}
