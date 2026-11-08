import { KMSClient } from "@aws-sdk/client-kms";

const keyId = process.env.RELAYER_KMS_KEY_SANDBOX;
const accessKeyId = process.env.RELAYER_AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.RELAYER_AWS_SECRET_ACCESS_KEY;
const region = process.env.AWS_REGION ?? "us-west-2";

/** The sandbox KMS key, signed with the relayer's own least-privilege credentials. */
export const kms =
  keyId && accessKeyId && secretAccessKey
    ? {
        keyId,
        region,
        credentials: { accessKeyId, secretAccessKey },
        client: new KMSClient({ region, credentials: { accessKeyId, secretAccessKey } }),
      }
    : undefined;

export const live = process.env.KEELSON_LIVE === "1";
