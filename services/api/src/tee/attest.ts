// @simplewebauthn/server loads reflect-metadata. It has to be in place before @keelson/attest
// polyfills the same API, or tsyringe fails when the second one loads.
import "@simplewebauthn/server/helpers";

export {
  type Expectations,
  type SignerAttestation,
  verifySigner,
} from "@keelson/attest";
export { getCollateral } from "@keelson/attest/server";
