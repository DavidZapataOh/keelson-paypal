/** The EAR profile of draft-ietf-rats-ear-05. */
export const EAR_PROFILE = "tag:ietf.org,2026:rats/ear#05";

/** AR4SI trustworthiness tiers, worst last. */
export type EarStatus = "none" | "affirming" | "warning" | "contraindicated";

export interface EarAppraisal {
  status: EarStatus;
  details?: string[];
  /** AR4SI claim values: 2 affirming, 32 warning, 96 contraindicated. */
  instanceIdentity?: number;
  executables?: number;
  hardware?: number;
}

const RANK: Record<EarStatus, number> = { none: 0, affirming: 1, warning: 2, contraindicated: 3 };

/** An unsigned EAR claims set (`application/eat-ucs+json`) with one appraisal per attester. */
export function earClaims(input: {
  iat: number;
  verifier: { developer: string; build: string };
  submods: Record<string, EarAppraisal>;
}): Record<string, unknown> {
  const labels = Object.keys(input.submods);
  if (labels.length === 0) throw new RangeError("an EAR has at least one submod");
  const submods = Object.fromEntries(
    labels.map((label) => {
      const a = input.submods[label] as EarAppraisal;
      const vector = {
        ...(a.instanceIdentity !== undefined ? { "instance-identity": a.instanceIdentity } : {}),
        ...(a.executables !== undefined ? { executables: a.executables } : {}),
        ...(a.hardware !== undefined ? { hardware: a.hardware } : {}),
      };
      return [
        label,
        {
          ear_status: a.status,
          ...(a.details?.length ? { ear_status_details: a.details } : {}),
          ...(Object.keys(vector).length ? { ear_trustworthiness_vector: vector } : {}),
        },
      ];
    }),
  );
  const worst = labels
    .map((l) => (input.submods[l] as EarAppraisal).status)
    .reduce((w, s) => (RANK[s] > RANK[w] ? s : w), "none" as EarStatus);
  return {
    eat_profile: EAR_PROFILE,
    iat: input.iat,
    ear_verifier_id: input.verifier,
    ear_status: worst,
    submods,
  };
}
