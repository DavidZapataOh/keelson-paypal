import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** The public host every origin is served under. */
export const LOG_HOST = "log.keelson.finance";

/** The log origin of each chain the Countersign domain may name. */
export const LOG_ORIGINS: Readonly<Record<number, string>> = {
  421614: `${LOG_HOST}/alibi/2026-1`,
  42161: `${LOG_HOST}/alibi-live/2026-1`,
};

/**
 * The Ed25519 and ML-DSA-44 verifier keys of each origin; both sign every checkpoint. The Ed25519
 * key is held by leg A, which signs only a tree that extends the last one it signed.
 */
export const LOG_VKEYS: Readonly<Record<string, readonly [string, string]>> = {
  [`${LOG_HOST}/alibi/2026-1`]: [
    "log.keelson.finance/alibi/2026-1+8553fcbd+ATEHrhTfdzkwLLgf9SZhMsIhsHzRmvpFnaBfgK0D10Id",
    "log.keelson.finance/alibi/2026-1+d6ce88c7+Bn5CCM1R4PB/tCwjAZOknZ+6swnmlKFwdAE0GJjW0ITT178TJEjJRBaoP1AB/vwd6ZKywZz9VqpPSYHdZhN8ImLml47rFj8bc8MF+f9OycGezBdaNHTDTAZ4hL3hgakjTy4JTOKTdtp7MMD2RJuR0TKNhRawr3+aEZW7bNSEPN05J9F6f6EVCRz+4CG0wBvSwEVez6S9WpGeIoZOgC9qmn3TCJZ6AIqHH8Lm9dZIVQcvEzSwQRB4+5kFHsJTKVteyyGMSv+8G9WjgoMOcwwVqiEegThXV9Uo1Y1+1qejA1DKBb6O6TRSDnD8BnCTMwkQAtdxjYSXv63rZg1Mu5EOsifpgenjJOdpK0rcvH+GqP41+om/j0OzBpOlF9BRuT2+UCSt2AW9AUcf/gPuB06bjcCAZxutAtuUr1rJ3eQtEn+Ck3k1YypOhd3r13keBXyqp4mZY58tWnlLjJqWYmyYM/FMtYX7PIr2zvgoiResM8JluzTKeog1xgSf4mBcg7s7S//ZjX75VrZ2JkN8HlQNuB2c/FAV9zdfnV8v36NiiVL+TIjbbLoAZ4s776THAfiaAbWQyajmfuoj/80MXchrVEpK+c1ns8xJrxqnngxp6o3FYlBnaPjrlTy4DAo1ngf/0cKDvkJK8p6/smY09EHgZM3lDgavVseo81ceP4MIq+QFSVN28mcyA++FJtCRF8eQj2z8UiB3BkWr8n3ePBUR0Io7eirF9GgxvVstZ/hUPdl8+1eQ05piZiO2/84X/cxMbVEDoPW0gUjb5GJ0IA0Ot0PggTOSSLBno9z0lSHDNer4ghbPFUEtYxspfmM1A1Qh5IrT5qw9oJ6iCRjTUYKBCi+rU+jAm4KevLVUD57Ol+yMd3jbMNWeAyzTKn2X3Hk7D75H57dVV+ETLZtB0tklI03tQCsbJF4NnUjLioPaZl5hMriPksA2ZhpXptklwXPQP6hmwnrQP2R3zl7j/gwqXw6/HR4t+56fd30aBNm1ls0axDZJxn6rqoYn6ogg7P35f4Yek7NCozSV4aEC6LgIW02S+/6vdkTSmDZDsjCkXNbtBHs2NEdypc94LRiV4KaE0h5zkKym8sqYbXleQK7BJFZmgLRsIF/DO1GSx3ALDcrqn8EsgBjQ3iO3JamowtyY2K2uit4/ua+8gQ36llxeCtnjvxBzczmLzDLeed5F5LZjy88tvjuHpLbPFTYSdp5vIzR3O+fkqA+fFLuFVc8zjuTSIoOpCcETi7zXqpl+uBjCI8+O66zzWwe7gGDj4arw5nqNM8/3iVi+Z8TCS1S3RpCc2HDN5848hgclgV56xvjzjg0s1cd7QJQe9y774+MoAnYup1y5PUeVK8GadfUYU6r1WY3KZYFevuSE1G7lI/A9izNcZ9p3HSccKOtw5kgd9gEoh1UZzMSoTLpQd714+AFrMAghcVXplX/usQpsp8A4biW9eYcvfCxRqViFs8xT+pE7slJtQ8SoZ5bgkh2ocq5KEUOZo0+1xBbzYB4v2evcZQZog1bo0DKGA1WZ0qZHDTwo0adrXVZwb9FvDUb6efC3y6tuHbj79JKb9N2fLm3Herxe/3wjPxkVTZ0zhTJjuNIHKVPeYQTcBP8yaL2y6IYKchIOP2r2CO4+9fiAJVB+cUpw1Bmi4uDm/dnGilxBHXM5t/XbEGpYBJPkB4fvkuQEWdqgL6y1mvRflDBukMRZ+kfO7dSqEcRCEvgV/hhVbPfViAgrQ7IE4/29NFjbDJs=",
  ],
  [`${LOG_HOST}/alibi-live/2026-1`]: [
    "log.keelson.finance/alibi-live/2026-1+39e7ebfa+AUiaY8TAW9gFbueTv6mPbHeZq5ClgTnG9a4kGEnU5uyL",
    "log.keelson.finance/alibi-live/2026-1+0208858e+Bv8dv0Xda6W/j02Il23COxA5OwkXYmlH93g706WL4OIicfB7CKiBm3nUXzEWBwHDGzrvanJpuC3Dos0mom9SLn47Pq2OK8RUyeelDjLtvvoIxc+HlyAadAEX5gp4fL7cC49QPTpOlqCaVMi16oIv5iGuIuwpB34ipOHjStdlsqMR6vzWTAu76hOWe/f558VRyiIEVIr2spYjQhqJMSnLqi3si9knC7qJSC1tZ6whmeaSfPl1Nmc8CJ2PF1sRIUJASD8zFq+gIBvOIO/qVAn2wiLVY50J5UTgqEqudwhX78pD/3FzbWREdjmLM287JmB+C68x1eyrpfFEYCZHbSbH/K4lw2y8mnVhhOyd/io7HbOmScgT6KEY44oBoKpBE66k+sctHuzpdIBTO5LZBhsFlj+jdpOlMtSdh/5OUEPebxC1AK+FXXhSjiFWtY+eq3HU7WvOpKTDTAWAC3+VPudR1hCOkGAZr9iOz7sh5uwYxBSy0QvIxxMA+ePzZi2nKdoqR6TOJnHJy4r878sFhRKkPTCNZYXh7gi6fGAOZHvU5xsbIhueIx2VlwDMSYWTTcj6v6GefJmDmvQP14btk3nFgrf6ustH2zlODrxxK1WhfIx8Sd64c/vGnD4Zp0UNIoS/lUjNwNySOwu/8+YlrLKTO2kCU6gzacUy7IdUOk7X8sL7YWnsZjUO8V86s8PY2GVqk5aNKXt6XFY5Hbrq/2yzHwsoCiNUKd48XveRPuA1E5OKJm1+m7lt3AYY2L1DpbEy1hDwrySKBbOVdKk3BpY/Dt+t38nDr/GXqIRkZVSxu7yCBRWuzVbA6qj5m2BzNtulFDzMvfnW7V5iC7Qyb/zDAMGRLxCfwNjPTZlMFOsa13ZCKQnzx70AJX/Wl6SrDcWIwFDjcomQNqDM6doNBI2j7dVMVwNtBf2gDUITv7oBrs8bK4eZDK6/IcJL75K1CmmHVGmshpYfW2L8np93zp8SIumc2XNMhkahSYO2Fvx3hJLvAvDW83UOwRqPVksUUUmNri38iJaAUiYYg4KTWUOWVHNq/y0Rm6EupgQjoSOfy0AZECkFy00F/sBtLy7CKosxMzsElb7vom7I8CLkECTPIlqpwwc2ZQEjku484G0qkTMmRk4qWgj6cS8rYTNTm3bob42JxOTpgGNGNiEFQ5969LgcCkYjbXVbg0GNBh6UdWLbVG0u7eSMFQaTm2PR7IVBcX3sDcDHLDqwlY1Kho76SZTQEyCsQbiKjgzKohfyYbOHFwLeNMX8YmqSqNQluAWVhbFkMVyEukSTQ/zo/43iTJga7dBdkWWZgz08zs4jFOVvRsF5de6dRytOilf9iEwb05bkFlXfjf63tcK5bKY9pNxumzwAkO1I0x79UpblhH910km/DrgRxrbRnFRjmYehKU2r0sxN8gB1PtthwSSUvKFvZ9NmoRPSudzmyr06A4iruhUVffmZJKF2ALVq1cDoob9iAwyfs0yOxvPTsqLBNMH7CBcGooyPAcoUdnSK/U7LJB1nE26+GA3SMW+FZZCXH73dHAAilXwVKY5qGWo+msfvO6fZiP2tJb9pQSoJZhLq1wQWZdMlYDDIJbTbJ+s4wZyH3B+lXq6fncmkz8l2MwFnbBgBymUOhUQzG3C+SdVQkQiNBsZMSoolh/zBicKbT/cAnEoBVSghgCJaSduBxLoa/osmgOdKjLu+SOsIPBPP9coOtMgRFatPZMEUaTCJu5eAHDjJHvLhxJIL8GbEj7A=",
  ],
};

/** A key set an origin signed with until its tree reached `untilSize` leaves. */
export interface RetiredVkeys {
  vkeys: readonly string[];
  untilSize: bigint;
}

/**
 * Log key sets an origin signed with before its current `LOG_VKEYS`, oldest first. A checkpoint
 * signed then still verifies under its set, but only up to the size where the log moved on: a
 * retired key's signature on a larger tree proves nothing.
 */
export const LOG_VKEY_HISTORY: Readonly<Record<string, readonly RetiredVkeys[]>> = {
  [`${LOG_HOST}/alibi/2026-1`]: [
    {
      vkeys: [
        "log.keelson.finance/alibi/2026-1+2e11a7ea+AfBrbrDNyb9uyXNtg3PXXnVxKQBcMGqa1OlCtxlttUBX",
        "log.keelson.finance/alibi/2026-1+d6ce88c7+Bn5CCM1R4PB/tCwjAZOknZ+6swnmlKFwdAE0GJjW0ITT178TJEjJRBaoP1AB/vwd6ZKywZz9VqpPSYHdZhN8ImLml47rFj8bc8MF+f9OycGezBdaNHTDTAZ4hL3hgakjTy4JTOKTdtp7MMD2RJuR0TKNhRawr3+aEZW7bNSEPN05J9F6f6EVCRz+4CG0wBvSwEVez6S9WpGeIoZOgC9qmn3TCJZ6AIqHH8Lm9dZIVQcvEzSwQRB4+5kFHsJTKVteyyGMSv+8G9WjgoMOcwwVqiEegThXV9Uo1Y1+1qejA1DKBb6O6TRSDnD8BnCTMwkQAtdxjYSXv63rZg1Mu5EOsifpgenjJOdpK0rcvH+GqP41+om/j0OzBpOlF9BRuT2+UCSt2AW9AUcf/gPuB06bjcCAZxutAtuUr1rJ3eQtEn+Ck3k1YypOhd3r13keBXyqp4mZY58tWnlLjJqWYmyYM/FMtYX7PIr2zvgoiResM8JluzTKeog1xgSf4mBcg7s7S//ZjX75VrZ2JkN8HlQNuB2c/FAV9zdfnV8v36NiiVL+TIjbbLoAZ4s776THAfiaAbWQyajmfuoj/80MXchrVEpK+c1ns8xJrxqnngxp6o3FYlBnaPjrlTy4DAo1ngf/0cKDvkJK8p6/smY09EHgZM3lDgavVseo81ceP4MIq+QFSVN28mcyA++FJtCRF8eQj2z8UiB3BkWr8n3ePBUR0Io7eirF9GgxvVstZ/hUPdl8+1eQ05piZiO2/84X/cxMbVEDoPW0gUjb5GJ0IA0Ot0PggTOSSLBno9z0lSHDNer4ghbPFUEtYxspfmM1A1Qh5IrT5qw9oJ6iCRjTUYKBCi+rU+jAm4KevLVUD57Ol+yMd3jbMNWeAyzTKn2X3Hk7D75H57dVV+ETLZtB0tklI03tQCsbJF4NnUjLioPaZl5hMriPksA2ZhpXptklwXPQP6hmwnrQP2R3zl7j/gwqXw6/HR4t+56fd30aBNm1ls0axDZJxn6rqoYn6ogg7P35f4Yek7NCozSV4aEC6LgIW02S+/6vdkTSmDZDsjCkXNbtBHs2NEdypc94LRiV4KaE0h5zkKym8sqYbXleQK7BJFZmgLRsIF/DO1GSx3ALDcrqn8EsgBjQ3iO3JamowtyY2K2uit4/ua+8gQ36llxeCtnjvxBzczmLzDLeed5F5LZjy88tvjuHpLbPFTYSdp5vIzR3O+fkqA+fFLuFVc8zjuTSIoOpCcETi7zXqpl+uBjCI8+O66zzWwe7gGDj4arw5nqNM8/3iVi+Z8TCS1S3RpCc2HDN5848hgclgV56xvjzjg0s1cd7QJQe9y774+MoAnYup1y5PUeVK8GadfUYU6r1WY3KZYFevuSE1G7lI/A9izNcZ9p3HSccKOtw5kgd9gEoh1UZzMSoTLpQd714+AFrMAghcVXplX/usQpsp8A4biW9eYcvfCxRqViFs8xT+pE7slJtQ8SoZ5bgkh2ocq5KEUOZo0+1xBbzYB4v2evcZQZog1bo0DKGA1WZ0qZHDTwo0adrXVZwb9FvDUb6efC3y6tuHbj79JKb9N2fLm3Herxe/3wjPxkVTZ0zhTJjuNIHKVPeYQTcBP8yaL2y6IYKchIOP2r2CO4+9fiAJVB+cUpw1Bmi4uDm/dnGilxBHXM5t/XbEGpYBJPkB4fvkuQEWdqgL6y1mvRflDBukMRZ+kfO7dSqEcRCEvgV/hhVbPfViAgrQ7IE4/29NFjbDJs=",
      ],
      untilSize: 796n,
    },
  ],
  [`${LOG_HOST}/alibi-live/2026-1`]: [
    {
      vkeys: [
        "log.keelson.finance/alibi-live/2026-1+2cbeb917+AUYYGFiA5vhiLgoStIMQMZCqkg5QPBseIXyURpLLwvph",
        "log.keelson.finance/alibi-live/2026-1+0208858e+Bv8dv0Xda6W/j02Il23COxA5OwkXYmlH93g706WL4OIicfB7CKiBm3nUXzEWBwHDGzrvanJpuC3Dos0mom9SLn47Pq2OK8RUyeelDjLtvvoIxc+HlyAadAEX5gp4fL7cC49QPTpOlqCaVMi16oIv5iGuIuwpB34ipOHjStdlsqMR6vzWTAu76hOWe/f558VRyiIEVIr2spYjQhqJMSnLqi3si9knC7qJSC1tZ6whmeaSfPl1Nmc8CJ2PF1sRIUJASD8zFq+gIBvOIO/qVAn2wiLVY50J5UTgqEqudwhX78pD/3FzbWREdjmLM287JmB+C68x1eyrpfFEYCZHbSbH/K4lw2y8mnVhhOyd/io7HbOmScgT6KEY44oBoKpBE66k+sctHuzpdIBTO5LZBhsFlj+jdpOlMtSdh/5OUEPebxC1AK+FXXhSjiFWtY+eq3HU7WvOpKTDTAWAC3+VPudR1hCOkGAZr9iOz7sh5uwYxBSy0QvIxxMA+ePzZi2nKdoqR6TOJnHJy4r878sFhRKkPTCNZYXh7gi6fGAOZHvU5xsbIhueIx2VlwDMSYWTTcj6v6GefJmDmvQP14btk3nFgrf6ustH2zlODrxxK1WhfIx8Sd64c/vGnD4Zp0UNIoS/lUjNwNySOwu/8+YlrLKTO2kCU6gzacUy7IdUOk7X8sL7YWnsZjUO8V86s8PY2GVqk5aNKXt6XFY5Hbrq/2yzHwsoCiNUKd48XveRPuA1E5OKJm1+m7lt3AYY2L1DpbEy1hDwrySKBbOVdKk3BpY/Dt+t38nDr/GXqIRkZVSxu7yCBRWuzVbA6qj5m2BzNtulFDzMvfnW7V5iC7Qyb/zDAMGRLxCfwNjPTZlMFOsa13ZCKQnzx70AJX/Wl6SrDcWIwFDjcomQNqDM6doNBI2j7dVMVwNtBf2gDUITv7oBrs8bK4eZDK6/IcJL75K1CmmHVGmshpYfW2L8np93zp8SIumc2XNMhkahSYO2Fvx3hJLvAvDW83UOwRqPVksUUUmNri38iJaAUiYYg4KTWUOWVHNq/y0Rm6EupgQjoSOfy0AZECkFy00F/sBtLy7CKosxMzsElb7vom7I8CLkECTPIlqpwwc2ZQEjku484G0qkTMmRk4qWgj6cS8rYTNTm3bob42JxOTpgGNGNiEFQ5969LgcCkYjbXVbg0GNBh6UdWLbVG0u7eSMFQaTm2PR7IVBcX3sDcDHLDqwlY1Kho76SZTQEyCsQbiKjgzKohfyYbOHFwLeNMX8YmqSqNQluAWVhbFkMVyEukSTQ/zo/43iTJga7dBdkWWZgz08zs4jFOVvRsF5de6dRytOilf9iEwb05bkFlXfjf63tcK5bKY9pNxumzwAkO1I0x79UpblhH910km/DrgRxrbRnFRjmYehKU2r0sxN8gB1PtthwSSUvKFvZ9NmoRPSudzmyr06A4iruhUVffmZJKF2ALVq1cDoob9iAwyfs0yOxvPTsqLBNMH7CBcGooyPAcoUdnSK/U7LJB1nE26+GA3SMW+FZZCXH73dHAAilXwVKY5qGWo+msfvO6fZiP2tJb9pQSoJZhLq1wQWZdMlYDDIJbTbJ+s4wZyH3B+lXq6fncmkz8l2MwFnbBgBymUOhUQzG3C+SdVQkQiNBsZMSoolh/zBicKbT/cAnEoBVSghgCJaSduBxLoa/osmgOdKjLu+SOsIPBPP9coOtMgRFatPZMEUaTCJu5eAHDjJHvLhxJIL8GbEj7A=",
      ],
      untilSize: 0n,
    },
  ],
};

/** Every key set of an origin, the current one last, with the largest size each may sign. */
export function logVkeySets(origin: string): readonly RetiredVkeys[] {
  const current = LOG_VKEYS[origin];
  if (!current) return [];
  const max = 2n ** 64n - 1n;
  return [...(LOG_VKEY_HISTORY[origin] ?? []), { vkeys: current, untilSize: max }];
}

const OWN_WITNESSES = [
  "witness-1.keelson.finance+f179740d+BA2CNkIvGf1TnnZNrT8I4QEE3VFdcK71m1HOqlHv6INc",
  "witness-2.keelson.finance+25bcde99+BG9zFgsma2ggzGNea4Nm1oG1/011LGpfypKDmR5Qi2ox",
  "witness-3.keelson.finance+9d46cab2+BHzNOrCnXA/4RzT9dabueqKXrTRswymwxybNZrcNkmX4",
] as const;

/** The `cosignature/v1` witnesses of each origin and the quorum every checkpoint carries. */
export const LOG_WITNESSES: Readonly<Record<string, { vkeys: readonly string[]; quorum: number }>> =
  {
    [`${LOG_HOST}/alibi/2026-1`]: { vkeys: OWN_WITNESSES, quorum: 2 },
    [`${LOG_HOST}/alibi-live/2026-1`]: { vkeys: OWN_WITNESSES, quorum: 2 },
  };

/**
 * The Ed25519 keys (hex) each origin signs RFC 9942 receipts with: pinned when leg A first serves
 * them, never removed, so every receipt keeps verifying.
 */
export const LOG_RECEIPT_KEYS: Readonly<Record<string, readonly string[]>> = {};

/** The pinned receipt keys of every origin, by hex SHA-256 key id. */
export function receiptKeyMap(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const keys of Object.values(LOG_RECEIPT_KEYS)) {
    for (const k of keys) {
      const pub = hexToBytes(k);
      out.set(bytesToHex(sha256(pub)), pub);
    }
  }
  return out;
}

export interface AppendResult {
  index: bigint;
  /** RFC 6962 leaf hash. */
  leafHash: Uint8Array;
  /** c2sp.org/tlog-proof@v1 against `checkpoint`. */
  proof: string;
  checkpoint: string;
  /** The RFC 9942 receipt of the leaf in the same checkpoint, when the origin issues them. */
  receipt?: Uint8Array;
}

/** `invalid`: the log answered with a leaf hash or a proof that does not verify. */
export type LogErrorKind =
  | "rejected"
  | "pushback"
  | "timeout"
  | "unavailable"
  | "unreachable"
  | "invalid";

export class LogError extends Error {
  readonly kind: LogErrorKind;
  readonly code: string | undefined;

  constructor(kind: LogErrorKind, code?: string) {
    super(code ? `log ${kind}: ${code}` : `log ${kind}`);
    this.name = "LogError";
    this.kind = kind;
    this.code = code;
  }
}

/** Appends leaves to one origin of the log over its private write listener. */
export class LogClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(url: string, token: string, origin: string, timeoutMs = 8000) {
    if (!origin.startsWith(`${LOG_HOST}/`)) throw new RangeError(`not a log origin: ${origin}`);
    this.base = `${url.replace(/\/$/, "")}/${origin.slice(LOG_HOST.length + 1)}`;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** Appends `leaf` and resolves once a checkpoint covers it. */
  add(leaf: Uint8Array, countersign: Record<string, string>): Promise<AppendResult> {
    return this.post("add", { leaf: btoa(String.fromCharCode(...leaf)), countersign });
  }

  /** Appends a stop leaf (`keelson.finance/stop/v1`) and resolves once a checkpoint covers it. */
  stop(leaf: Uint8Array): Promise<AppendResult> {
    return this.post("stop", { leaf: btoa(String.fromCharCode(...leaf)) });
  }

  /**
   * The inclusion proof and receipt of the leaf at `index` in the latest checkpoint: what a leaf
   * logged under an earlier log key is proven with now.
   */
  async prove(index: bigint): Promise<Omit<AppendResult, "leafHash">> {
    const { leafHash: _, ...out } = await this.request(`proof?index=${index}`);
    return out;
  }

  private post(path: "add" | "stop", body: unknown): Promise<AppendResult> {
    return this.request(path, body);
  }

  private async request(path: string, body?: unknown): Promise<AppendResult> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new LogError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable",
      );
    }
    const answer = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (res.status === 200) {
      const { index, leafHash, proof, checkpoint, receipt } = answer;
      if (!index || (!leafHash && body !== undefined) || !proof || !checkpoint)
        throw new LogError("unreachable", "malformed");
      return {
        index: BigInt(index),
        leafHash: leafHash ? hexToBytes(leafHash) : new Uint8Array(),
        proof,
        checkpoint,
        ...(receipt ? { receipt: Uint8Array.from(atob(receipt), (c) => c.charCodeAt(0)) } : {}),
      };
    }
    if (res.status === 429) throw new LogError("pushback");
    if (res.status === 503) throw new LogError("unavailable", answer.code);
    if (res.status >= 400 && res.status < 500) throw new LogError("rejected", answer.code);
    throw new LogError("unreachable", String(res.status));
  }
}
