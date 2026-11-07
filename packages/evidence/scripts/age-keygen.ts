import { generateHybridIdentity, identityToRecipient } from "age-encryption";

const identity = await generateHybridIdentity();
console.log(`KEELSON_EVIDENCE_AGE_IDENTITY=${identity}`);
console.log(`KEELSON_EVIDENCE_AGE_RECIPIENT=${await identityToRecipient(identity)}`);
