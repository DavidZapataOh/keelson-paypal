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
  {
    engineBuildId: "0xb97f7db82daee29af8c54c8d510f5ac78ff409792f025688b3e3e21cbf900441",
    tdx: "tdx:80ddd6da35964e5d8184b185bc3c632d444506b9ab64de6d64b0a78403349322",
    nitro: "nitro:bb59e03e31dfbe7f81aaa7374a9564de80168ff1899c0c34e46bbf7bf507ee66",
  },
  {
    engineBuildId: "0xff92c3209b1683f7324f5ec5e5a12eff50ff36f0bed96b1e588b6779edd0b058",
    tdx: "tdx:0faad5181c680e0bd478b69ec903ee8da239078e1713ea50b2d0806bf5a20b88",
    nitro: "nitro:750688295e0ba8d49243490bfe01db68e91415ebe2fa77c476f7b33da8a714b2",
  },
  {
    engineBuildId: "0x9f04109b0853f22e7a337ff37a8943b2e0f5ba7856d9e970618c4efc3cc58643",
    tdx: "tdx:61fcd9f01b1daca85a13c767c28368f1f09f0df7d8d31ac9dcd60c0028f2bf94",
    nitro: "nitro:b66097541c6d78e3505448e794678d9042e5e6bf18880d5446c85572d40901b0",
  },
  {
    engineBuildId: "0x62dcd6071507130db485c5fa67bd371fc28188310cf83d82fdb9b7e22341b8cd",
    tdx: "tdx:ccdbe1020654595759c24698591df8025d3385f079d4c0e4e73770b3a73fe62f",
    nitro: "nitro:1348a25408d15f524f289e75b0bd9301e7a28575113fc29087e4c03d1da9c9b7",
  },
];

/** The origin a passkey assertion over a mandate must come from, and its RP ID. */
export const MANDATE_ORIGIN = "https://app.keelson.finance";
export const MANDATE_RP_ID = "keelson.finance";
/**
 * The origin of the approval agent platforms frame: a mandate with `embed` is signed there, in a
 * frame whose top-level origin is `embed.top_origin`.
 */
export const MANDATE_EMBED_ORIGIN = "https://api.keelson.finance";
