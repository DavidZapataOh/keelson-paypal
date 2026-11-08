import { z } from "zod";
import { agentRegistry, type Erc8004ChainId } from "./addresses.ts";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** A CAIP-10 account id, the form of `agentRegistry`: `{namespace}:{chainId}:{address}`. */
const caip10 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/;

/** The agent registration file an ERC-8004 `agentURI` resolves to. */
export const RegistrationFile = z.object({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1),
  description: z.string(),
  image: z.string(),
  services: z.array(
    z.looseObject({
      name: z.string().min(1),
      endpoint: z.string().min(1),
      version: z.string().optional(),
    }),
  ),
  x402Support: z.boolean(),
  active: z.boolean(),
  registrations: z
    .array(
      z.object({
        agentId: z.union([z.number().int().nonnegative(), z.string().regex(/^(0|[1-9]\d*)$/)]),
        agentRegistry: z.string().regex(caip10),
      }),
    )
    .min(1),
  supportedTrust: z.array(z.string()).optional(),
});

export type RegistrationFile = z.infer<typeof RegistrationFile>;

export interface OperatorRegistrationInput {
  name: string;
  description: string;
  image: string;
  registrations: { chainId: Erc8004ChainId; agentId: bigint }[];
}

const json = (id: bigint): number | string =>
  id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString();

/** The registration file of a Keelson operator: one bond endpoint per registration. */
export function operatorRegistration(input: OperatorRegistrationInput): RegistrationFile {
  return {
    type: REGISTRATION_TYPE,
    name: input.name,
    description: `${input.description} ERC-8004 is a Draft standard; Keelson pins v2.0.0.`,
    image: input.image,
    services: input.registrations.map(({ chainId, agentId }) => ({
      name: "keelson-bond",
      endpoint: `https://api.keelson.finance/v1/operators/${chainId}/${agentId}/bond`,
      version: "1",
    })),
    x402Support: false,
    active: true,
    registrations: input.registrations.map(({ chainId, agentId }) => ({
      agentId: json(agentId),
      agentRegistry: agentRegistry(chainId),
    })),
    supportedTrust: ["reputation", "crypto-economic", "tee-attestation"],
  };
}
