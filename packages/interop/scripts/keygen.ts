/** Prints a fresh private JWK: `ed25519` for RFC 9421 request signing, `es256` for a P-256 key. */
import { exportJWK, generateKeyPair } from "jose";

const alg = process.argv[2] === "es256" ? "ES256" : "Ed25519";
const { privateKey } = await generateKeyPair(alg, { extractable: true });
console.log(JSON.stringify(await exportJWK(privateKey)));
