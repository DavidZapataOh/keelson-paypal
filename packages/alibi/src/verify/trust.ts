/**
 * The engine builds whose TEE signers an Alibi may be countersigned by: each image digest (the
 * `engineBuildId` the attestations bind) and the measurement id of each leg running it. A build
 * stays listed after the legs move on, so earlier Alibis keep verifying.
 */
export const TEE_BUILDS: readonly {
  engineBuildId: `0x${string}`;
  tdx: string;
  nitro: string;
}[] = [
  {
    engineBuildId: "0x79c49577e2186a80e2924ff41dcf1972ae4f6f90f47b7dac24a27832323026ca",
    tdx: "tdx:ecf423e166d5a07723788729808bc4f914cb91e1beb197ed6e76f511cbc88188",
    nitro: "nitro:036525992b0c50e42123f2debb8f6e5ef99a3e96a1c70ef772a26c7e2177f1fc",
  },
];

/** The origin a passkey assertion over a mandate must come from, and its RP ID. */
export const MANDATE_ORIGIN = "https://app.keelson.finance";
export const MANDATE_RP_ID = "keelson.finance";
