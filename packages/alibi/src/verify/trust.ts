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
    engineBuildId: "0x9967b89c2fed0ab1b854c8ea20247eee70d7c1fb3ae9445c7134bbf692b6a3fd",
    tdx: "tdx:f33b8b201d9daa57f1ddb49ddc1e4d2176caeeea97d7ce2b23fa891b223ad947",
    nitro: "nitro:35db041c95b64fa5f5229256fc17c9e1ac55238d45af87614c5ab566f09f121d",
  },
  {
    engineBuildId: "0x0af4d1ec1e2c3743bad0f8d50b9feec1516e7fbbd7809d5649d8fd5dc53651bc",
    tdx: "tdx:a50ad21c8a724475b6c24df85d8a77078f72d08efb3e7b845e8768acbff332e1",
    nitro: "nitro:4404b1f00e6eb3971942e9f16c8cbd64df81ebf50646367f5aefa3229c992322",
  },
  {
    engineBuildId: "0x5a160684e3392ef1094a3827055c9c505f983c45575908af4f90ebfec34ad2da",
    tdx: "tdx:0e61f7054f5881f0e96c8d94468c59bc0afe8f4950ea7eeebe1f864062ba3e99",
    nitro: "nitro:ff32b4d98bd0a98bac0a4555bfd4792040904ce040cd50140891d9311274c322",
  },
  {
    engineBuildId: "0x79c49577e2186a80e2924ff41dcf1972ae4f6f90f47b7dac24a27832323026ca",
    tdx: "tdx:ecf423e166d5a07723788729808bc4f914cb91e1beb197ed6e76f511cbc88188",
    nitro: "nitro:036525992b0c50e42123f2debb8f6e5ef99a3e96a1c70ef772a26c7e2177f1fc",
  },
];

/** The origin a passkey assertion over a mandate must come from, and its RP ID. */
export const MANDATE_ORIGIN = "https://app.keelson.finance";
export const MANDATE_RP_ID = "keelson.finance";
