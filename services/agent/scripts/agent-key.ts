// Prints a new private P-256 JWK for the agent's `cnf` key, to store as KEELSON_AGENT_KEY.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log(JSON.stringify({ kty, crv, x, y, d }));
