//! `anonymous_purchase`: C1 composed with C3 by recursion. The countersigned cart satisfies the
//! mandate `C_m` commits to (C1), and a registered user's passkey, the one `C_m` names, signed
//! that mandate (C3): one proof, with neither the mandate nor the user.

mod keys;

/// UltraHonk with ZK, as `bb_proof_verification` 5.3.0 `verify_honk_proof` takes it.
global PROOF_TYPE_HONK_ZK: u32 = 6;
global VK_LENGTH: u32 = 115;
global PROOF_LENGTH: u32 = 458;
/// `SHA-256("keelson.finance")`, the RP ID every Keelson passkey is scoped to.
global RP_ID_HASH: Field = 0x1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f7;

fn main(
    // C1: `C_m, amount, currency, category, merchant_id, now, cart_hash, operator_id`.
    c1_inputs: pub [Field; 8],
    mandate_hash: pub Field,
    user_set_root: pub Field,
    c1_vk: [Field; VK_LENGTH],
    c1_proof: [Field; PROOF_LENGTH],
    c3_vk: [Field; VK_LENGTH],
    c3_proof: [Field; PROOF_LENGTH],
) {
    // bb asserts that each key hashes to the pinned hash, so each proof is of its circuit.
    std::verify_proof_with_type(c1_vk, c1_proof, c1_inputs, keys::C1_KEY_HASH, PROOF_TYPE_HONK_ZK);
    std::verify_proof_with_type(
        c3_vk,
        c3_proof,
        [c1_inputs[0], mandate_hash, user_set_root, RP_ID_HASH],
        keys::C3_KEY_HASH,
        PROOF_TYPE_HONK_ZK,
    );
}
