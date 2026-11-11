//! Recomputes a countersign inside the SP1 zkVM with the engine's own canonicalizer and policy
//! evaluation, and commits `abi.encode(evalHash, countersignDigest)`.

#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input = sp1_zkvm::io::read_vec();
    let input: keelson_policy::CountersignInput =
        serde_json::from_slice(&input).expect("the input is a countersign input");
    let c = keelson_policy::recompute(&input).expect("the countersign recomputes");
    let mut public_values = [0; 64];
    public_values[..32].copy_from_slice(c.countersign.evalHash.as_slice());
    public_values[32..].copy_from_slice(&c.digest);
    sp1_zkvm::io::commit_slice(&public_values);
}
