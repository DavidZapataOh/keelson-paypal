//! C3 `anonymous_mandate`: a registered user's passkey signed the mandate `mandate_hash`, whose
//! commitment `c_m` names that passkey, without revealing which user or key.

use poseidon::poseidon2::Poseidon2;

/// `"KEELSON_MANDATE"` read as a big-endian field element.
global KEELSON_MANDATE: Field = 0x4b45454c534f4e5f4d414e44415445;
/// Depth of the registered-user tree.
global USER_DEPTH: u32 = 20;
/// Longest `clientDataJSON` a proof takes.
global MAX_CLIENT_DATA: u32 = 1024;
/// `"keelson/mandate-challenge/v1"`.
global CHALLENGE_DST: [u8; 28] = "keelson/mandate-challenge/v1".as_bytes();

global FLAG_UP: u8 = 0x01;
global FLAG_UV: u8 = 0x04;
global FLAG_BE: u8 = 0x08;
global FLAG_BS: u8 = 0x10;

/// The opening of `c_m` other than the user's key.
pub struct Opening {
    max_amount: u64,
    currency: u16,
    category_mask: u64,
    merchant_root: Field,
    expiry: u64,
    operator_id: Field,
    nonce: Field,
    salt: Field,
}

/// A WebAuthn assertion (`webauthn.get`) or a Secure Payment Confirmation one (`payment.get`).
pub struct Assertion {
    /// `r ‖ s`, with `s` in the lower half of the order.
    signature: [u8; 64],
    /// `rpIdHash (32) ‖ flags (1) ‖ signCount (4)`.
    authenticator_data: [u8; 37],
    client_data_json: BoundedVec<u8, MAX_CLIENT_DATA>,
    /// Byte offset of `"challenge":"` in `client_data_json`.
    challenge_index: u32,
    /// Byte offset of `"type":"` in `client_data_json`.
    type_index: u32,
}

/// `poseidon2([x_hi, x_lo, y_hi, y_lo])` over the 128-bit big-endian limbs of the key.
fn user_key_hash(x: [u8; 32], y: [u8; 32]) -> Field {
    let mut limbs = [0; 4];
    for i in 0..4 {
        let coordinate = if i < 2 { x } else { y };
        let mut limb: Field = 0;
        for j in 0..16 {
            limb = limb * 256 + coordinate[(i % 2) * 16 + j] as Field;
        }
        limbs[i] = limb;
    }
    Poseidon2::hash(limbs, 4)
}

fn user_tree_root(leaf: Field, index: u32, path: [Field; USER_DEPTH]) -> Field {
    let mut node = leaf;
    for h in 0..USER_DEPTH {
        node = if (index >> h) & 1 == 1 {
            Poseidon2::hash([path[h], node], 2)
        } else {
            Poseidon2::hash([node, path[h]], 2)
        };
    }
    node
}

/// `M = SHA-256("keelson/mandate-challenge/v1" ‖ 0x00 ‖ H_sd ‖ C_m)`.
fn mandate_challenge(h_sd: [u8; 32], c_m: Field) -> [u8; 32] {
    let mut input = [0; 93];
    for i in 0..28 {
        input[i] = CHALLENGE_DST[i];
    }
    let c: [u8; 32] = c_m.to_be_bytes();
    for i in 0..32 {
        input[29 + i] = h_sd[i];
        input[61 + i] = c[i];
    }
    sha256::digest(input)
}

/// Whether `json[at..]` starts with `expected`.
fn has_at<let N: u32>(json: BoundedVec<u8, MAX_CLIENT_DATA>, at: u32, expected: [u8; N]) -> bool {
    let mut found = at + N <= json.len();
    for i in 0..N {
        found &= json.storage()[at + i] == expected[i];
    }
    found
}

fn main(
    c_m: pub Field,
    mandate_hash: pub Field,
    user_set_root: pub Field,
    rp_id_hash: pub Field,
    key_x: [u8; 32],
    key_y: [u8; 32],
    h_sd: [u8; 32],
    opening: Opening,
    user_index: u32,
    user_path: [Field; USER_DEPTH],
    assertion: Assertion,
) {
    // The key is the user's in `c_m` and a leaf of the registered-user tree.
    let key_hash = user_key_hash(key_x, key_y);
    let commitment = Poseidon2::hash(
        [
            KEELSON_MANDATE,
            key_hash,
            opening.max_amount as Field,
            opening.currency as Field,
            opening.category_mask as Field,
            opening.merchant_root,
            opening.expiry as Field,
            opening.operator_id,
            opening.nonce,
            opening.salt,
        ],
        10,
    );
    assert_eq(commitment, c_m, "commitment");
    assert(user_index < (1 << USER_DEPTH), "user");
    assert_eq(user_tree_root(key_hash, user_index, user_path), user_set_root, "user");

    // W3C WebAuthn L3 §7.2 steps 11-20, as OpenZeppelin `WebAuthn.verify` checks them on chain.
    let auth = assertion.authenticator_data;
    let mut rp: [u8; 32] = [0; 32];
    for i in 0..32 {
        rp[i] = auth[i];
    }
    assert_eq(Field::from_be_bytes(rp), rp_id_hash, "rp id");
    let flags = auth[32];
    assert(flags & FLAG_UP != 0, "user present");
    assert(flags & FLAG_UV != 0, "user verified");
    assert((flags & FLAG_BE != 0) | (flags & FLAG_BS == 0), "backup state");

    let json = assertion.client_data_json;
    let t = assertion.type_index;
    assert(
        has_at(json, t, "\"type\":\"webauthn.get\"".as_bytes())
            | has_at(json, t, "\"type\":\"payment.get\"".as_bytes()),
        "type",
    );
    let m = mandate_challenge(h_sd, c_m);
    assert_eq(Field::from_be_bytes(m), mandate_hash, "mandate hash");
    let challenge = noir_base64::BASE64_URL_ENCODER::encode(m);
    let mut expected: [u8; 57] = [0; 57];
    let prefix = "\"challenge\":\"".as_bytes();
    for i in 0..13 {
        expected[i] = prefix[i];
    }
    for i in 0..43 {
        expected[13 + i] = challenge[i];
    }
    expected[56] = 34;
    assert(has_at(json, assertion.challenge_index, expected), "challenge");

    let mut signed: [u8; 69] = [0; 69];
    for i in 0..37 {
        signed[i] = auth[i];
    }
    let client_data_hash = sha256::sha256_var(json.storage(), json.len());
    for i in 0..32 {
        signed[37 + i] = client_data_hash[i];
    }
    let valid = std::ecdsa_secp256r1::verify_signature(
        key_x,
        key_y,
        assertion.signature,
        sha256::digest(signed),
    );
    assert(valid, "signature");
}

mod vectors;

/// The inputs of the demo vector, which a test edits before proving.
struct Inputs {
    c_m: Field,
    mandate_hash: Field,
    user_set_root: Field,
    rp_id_hash: Field,
    key_x: [u8; 32],
    h_sd: [u8; 32],
    salt: Field,
    user_index: u32,
    user_path: [Field; USER_DEPTH],
    signature: [u8; 64],
    authenticator_data: [u8; 37],
    client_data: BoundedVec<u8, MAX_CLIENT_DATA>,
    challenge_index: u32,
    type_index: u32,
}

fn demo() -> Inputs {
    Inputs {
        c_m: vectors::C_M,
        mandate_hash: vectors::MANDATE_HASH,
        user_set_root: vectors::USER_SET_ROOT,
        rp_id_hash: vectors::RP_ID_HASH,
        key_x: vectors::KEY_X,
        h_sd: vectors::H_SD,
        salt: vectors::SALT,
        user_index: vectors::USER_INDEX,
        user_path: vectors::USER_PATH,
        signature: vectors::SIGNATURE,
        authenticator_data: vectors::AUTHENTICATOR_DATA,
        client_data: BoundedVec::from_array(vectors::CLIENT_DATA),
        challenge_index: vectors::CHALLENGE_INDEX,
        type_index: vectors::TYPE_INDEX,
    }
}

fn prove(i: Inputs) {
    main(
        i.c_m,
        i.mandate_hash,
        i.user_set_root,
        i.rp_id_hash,
        i.key_x,
        vectors::KEY_Y,
        i.h_sd,
        Opening {
            max_amount: vectors::MAX_AMOUNT,
            currency: vectors::CURRENCY,
            category_mask: vectors::CATEGORY_MASK,
            merchant_root: vectors::MERCHANT_ROOT,
            expiry: vectors::EXPIRY,
            operator_id: vectors::OPERATOR_ID,
            nonce: vectors::NONCE,
            salt: i.salt,
        },
        i.user_index,
        i.user_path,
        Assertion {
            signature: i.signature,
            authenticator_data: i.authenticator_data,
            client_data_json: i.client_data,
            challenge_index: i.challenge_index,
            type_index: i.type_index,
        },
    );
}

#[test]
fn a_registered_user_signed_the_mandate() {
    prove(demo());
}

#[test(should_fail_with = "commitment")]
fn another_salt_fails() {
    let mut i = demo();
    i.salt += 1;
    prove(i);
}

#[test(should_fail_with = "commitment")]
fn a_key_the_commitment_does_not_name_fails() {
    let mut i = demo();
    i.key_x[31] ^= 1;
    prove(i);
}

#[test(should_fail_with = "user")]
fn a_key_outside_the_set_fails() {
    let mut i = demo();
    i.user_path[0] += 1;
    prove(i);
}

#[test(should_fail_with = "user")]
fn another_set_fails() {
    let mut i = demo();
    i.user_set_root += 1;
    prove(i);
}

#[test(should_fail_with = "user")]
fn an_index_beyond_the_tree_fails() {
    let mut i = demo();
    i.user_index += 1 << USER_DEPTH;
    prove(i);
}

#[test(should_fail_with = "rp id")]
fn another_rp_id_fails() {
    let mut i = demo();
    i.rp_id_hash += 1;
    prove(i);
}

#[test(should_fail_with = "rp id")]
fn an_assertion_for_another_rp_fails() {
    let mut i = demo();
    i.authenticator_data[0] ^= 1;
    prove(i);
}

#[test(should_fail_with = "user present")]
fn no_user_presence_fails() {
    let mut i = demo();
    i.authenticator_data[32] &= !FLAG_UP;
    prove(i);
}

#[test(should_fail_with = "user verified")]
fn no_user_verification_fails() {
    let mut i = demo();
    i.authenticator_data[32] &= !FLAG_UV;
    prove(i);
}

#[test(should_fail_with = "backup state")]
fn backed_up_but_not_eligible_fails() {
    let mut i = demo();
    i.authenticator_data[32] = (i.authenticator_data[32] & !FLAG_BE) | FLAG_BS;
    prove(i);
}

#[test(should_fail_with = "type")]
fn another_type_fails() {
    let mut i = demo();
    i.type_index += 1;
    prove(i);
}

#[test(should_fail_with = "type")]
fn a_create_assertion_fails() {
    let mut i = demo();
    // `"type":"payment.get"` → `"type":"payment.crt"`.
    i.client_data.set(i.type_index + 17, 99);
    i.client_data.set(i.type_index + 18, 114);
    prove(i);
}

#[test(should_fail_with = "mandate hash")]
fn another_mandate_hash_fails() {
    let mut i = demo();
    i.mandate_hash += 1;
    prove(i);
}

#[test(should_fail_with = "challenge")]
fn a_payload_the_user_did_not_sign_fails() {
    let mut i = demo();
    i.h_sd[0] ^= 1;
    i.mandate_hash = Field::from_be_bytes(mandate_challenge(i.h_sd, i.c_m));
    prove(i);
}

#[test(should_fail_with = "challenge")]
fn a_challenge_elsewhere_fails() {
    let mut i = demo();
    i.challenge_index += 1;
    prove(i);
}

#[test(should_fail_with = "challenge")]
fn another_challenge_fails() {
    let mut i = demo();
    let at = i.challenge_index + 13;
    i.client_data.set(at, if i.client_data.get(at) == 65 { 66 } else { 65 });
    prove(i);
}

#[test(should_fail_with = "challenge")]
fn a_challenge_past_the_end_fails() {
    let mut i = demo();
    i.challenge_index = i.client_data.len() - 10;
    prove(i);
}

#[test(should_fail_with = "signature")]
fn other_client_data_fails() {
    let mut i = demo();
    let last = i.client_data.len() - 2;
    i.client_data.set(last, i.client_data.get(last) + 1);
    prove(i);
}

#[test(should_fail_with = "signature")]
fn a_shorter_client_data_fails() {
    let mut i = demo();
    let _ = i.client_data.pop();
    prove(i);
}

#[test(should_fail_with = "signature")]
fn another_signature_fails() {
    let mut i = demo();
    i.signature[63] ^= 1;
    prove(i);
}

#[test(should_fail_with = "signature")]
fn a_signature_counter_change_fails() {
    let mut i = demo();
    i.authenticator_data[36] ^= 1;
    prove(i);
}
