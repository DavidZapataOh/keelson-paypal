//! C1 `mandate_predicate`: the countersigned cart satisfies the mandate that `c_m` commits to,
//! without revealing the mandate.

use poseidon::poseidon2::Poseidon2;

/// `"KEELSON_MANDATE"` read as a big-endian field element.
global KEELSON_MANDATE: Field = 0x4b45454c534f4e5f4d414e44415445;
/// Depth of the ordered merchant tree.
global DEPTH: u32 = 8;

/// The opening of the leaf that holds the cart's merchant in the mandate's merchant tree.
pub struct Membership {
    next: Field,
    next_index: Field,
    index: u8,
    path: [Field; DEPTH],
}

fn merkle_root(leaf: Field, index: u8, path: [Field; DEPTH]) -> Field {
    let mut node = leaf;
    for h in 0..DEPTH {
        let sibling = path[h];
        node = if (index >> h as u8) & 1 == 1 {
            Poseidon2::hash([sibling, node], 2)
        } else {
            Poseidon2::hash([node, sibling], 2)
        };
    }
    node
}

fn main(
    c_m: pub Field,
    amount: pub u64,
    currency: pub u16,
    category: pub u8,
    merchant_id: pub Field,
    now: pub u64,
    cart_hash: pub Field,
    operator_id: pub Field,
    user_key_hash: Field,
    max_amount: u64,
    category_mask: u64,
    merchant_root: Field,
    expiry: u64,
    nonce: Field,
    salt: Field,
    merchant: Membership,
) {
    // The cart hash is bound as a public input only, so a proof belongs to one cart.
    let _ = cart_hash;
    let commitment = Poseidon2::hash(
        [
            KEELSON_MANDATE,
            user_key_hash,
            max_amount as Field,
            currency as Field,
            category_mask as Field,
            merchant_root,
            expiry as Field,
            operator_id,
            nonce,
            salt,
        ],
        10,
    );
    assert_eq(commitment, c_m, "commitment");
    assert(amount <= max_amount, "amount");
    assert(now <= expiry, "expiry");
    assert(category < 64, "category");
    assert_eq((category_mask >> category as u64) & 1, 1, "category");
    let leaf = Poseidon2::hash([merchant_id, merchant.next, merchant.next_index], 3);
    assert_eq(merkle_root(leaf, merchant.index, merchant.path), merchant_root, "merchant");
}

mod vectors;

#[test]
fn a_compliant_cart_satisfies_the_mandate() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test]
fn the_maximum_amount_satisfies_the_mandate() {
    prove(
        vectors::MAX_AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test]
fn the_last_second_satisfies_the_mandate() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::EXPIRY,
        vectors::SALT,
    );
}

#[test(should_fail_with = "amount")]
fn an_amount_over_the_maximum_fails() {
    prove(
        vectors::MAX_AMOUNT + 1,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test(should_fail_with = "commitment")]
fn another_currency_fails() {
    prove(
        vectors::AMOUNT,
        978,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test(should_fail_with = "expiry")]
fn an_expired_mandate_fails() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::EXPIRY + 1,
        vectors::SALT,
    );
}

#[test(should_fail_with = "category")]
fn a_category_outside_the_mask_fails() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        6,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test(should_fail_with = "category")]
fn no_category_fails() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        255,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test(should_fail_with = "merchant")]
fn a_merchant_outside_the_tree_fails() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID + 1,
        vectors::NOW,
        vectors::SALT,
    );
}

#[test(should_fail_with = "commitment")]
fn another_salt_fails() {
    prove(
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::SALT + 1,
    );
}

#[test(should_fail_with = "commitment")]
fn another_operator_fails() {
    main(
        vectors::C_M,
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::CART_HASH,
        vectors::OPERATOR_ID + 1,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::NONCE,
        vectors::SALT,
        demo_membership(),
    );
}

#[test(should_fail_with = "merchant")]
fn the_zero_leaf_does_not_open_as_a_merchant() {
    let mut merchant = demo_membership();
    merchant.index = 0;
    main(
        vectors::C_M,
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        vectors::CART_HASH,
        vectors::OPERATOR_ID,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::NONCE,
        vectors::SALT,
        merchant,
    );
}

#[test]
fn any_cart_hash_is_only_bound_as_a_public_input() {
    main(
        vectors::C_M,
        vectors::AMOUNT,
        vectors::CURRENCY,
        vectors::CATEGORY,
        vectors::MERCHANT_ID,
        vectors::NOW,
        7,
        vectors::OPERATOR_ID,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::NONCE,
        vectors::SALT,
        demo_membership(),
    );
}

fn demo_membership() -> Membership {
    Membership {
        next: vectors::NEXT,
        next_index: vectors::NEXT_INDEX,
        index: vectors::INDEX,
        path: vectors::PATH,
    }
}

fn prove(amount: u64, currency: u16, category: u8, merchant_id: Field, now: u64, salt: Field) {
    main(
        vectors::C_M,
        amount,
        currency,
        category,
        merchant_id,
        now,
        vectors::CART_HASH,
        vectors::OPERATOR_ID,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::NONCE,
        salt,
        demo_membership(),
    );
}
