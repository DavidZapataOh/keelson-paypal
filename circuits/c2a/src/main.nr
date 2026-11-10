//! C2a `mandate_violation`: a countersigned cart violates the mandate that `c_m` commits to.
//! Each `violation_code` has its own check; the commitment is opened for all of them.

use poseidon::poseidon2::Poseidon2;

/// `"KEELSON_MANDATE"` read as a big-endian field element.
global KEELSON_MANDATE: Field = 0x4b45454c534f4e5f4d414e44415445;
/// Depth of the ordered merchant tree.
global DEPTH: u32 = 8;

pub global AMOUNT_OVER_MAX: u8 = 1;
pub global CURRENCY_MISMATCH: u8 = 2;
pub global CATEGORY_NOT_ALLOWED: u8 = 3;
pub global MANDATE_EXPIRED: u8 = 4;
pub global MERCHANT_NOT_ALLOWED: u8 = 5;

/// The low leaf of a merchant absent from the mandate's indexed merchant tree: the leaf with the
/// largest value below it, whose `next` is above it, or which is the last leaf.
pub struct LowLeaf {
    value: Field,
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
    cart_ts: pub u64,
    violation_code: pub u8,
    user_key_hash: Field,
    max_amount: u64,
    mandate_currency: u16,
    category_mask: u64,
    merchant_root: Field,
    expiry: u64,
    operator_id: Field,
    nonce: Field,
    salt: Field,
    low: LowLeaf,
) {
    let commitment = Poseidon2::hash(
        [
            KEELSON_MANDATE,
            user_key_hash,
            max_amount as Field,
            mandate_currency as Field,
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
    if violation_code == AMOUNT_OVER_MAX {
        assert(amount > max_amount, "amount");
    } else if violation_code == CURRENCY_MISMATCH {
        assert(currency != mandate_currency, "currency");
    } else if violation_code == CATEGORY_NOT_ALLOWED {
        // 255 marks a cart of several categories: it names none, so it violates none.
        assert(category < 64, "category");
        assert_eq((category_mask >> category as u64) & 1, 0, "category");
    } else if violation_code == MANDATE_EXPIRED {
        assert(cart_ts > expiry, "expiry");
    } else {
        assert_eq(violation_code, MERCHANT_NOT_ALLOWED, "violation_code");
        // Unused slots hold 0, which no preimage hashes to; the empty preimage is refused as in
        // the engine's non-membership check.
        assert(
            (low.value != 0) | (low.next != 0) | (low.next_index != 0),
            "merchant",
        );
        assert(low.value.lt(merchant_id), "merchant");
        let last = (low.next == 0) & (low.next_index == 0);
        assert(last | merchant_id.lt(low.next), "merchant");
        let leaf = Poseidon2::hash([low.value, low.next, low.next_index], 3);
        assert_eq(merkle_root(leaf, low.index, low.path), merchant_root, "merchant");
    }
}

mod vectors;

#[test]
fn an_amount_over_the_maximum_violates() {
    prove_cart(vectors::MAX_AMOUNT + 1, vectors::CATEGORY, vectors::CART_TS, AMOUNT_OVER_MAX);
}

#[test(should_fail_with = "amount")]
fn the_maximum_amount_does_not_violate() {
    prove_cart(vectors::MAX_AMOUNT, vectors::CATEGORY, vectors::CART_TS, AMOUNT_OVER_MAX);
}

#[test]
fn a_cart_in_another_currency_violates() {
    main(
        vectors::C_M_EUR,
        vectors::AMOUNT,
        vectors::USD,
        vectors::CATEGORY,
        vectors::MEMBER_ID,
        vectors::CART_TS,
        CURRENCY_MISMATCH,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::EUR,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::OPERATOR_ID,
        vectors::NONCE,
        vectors::SALT,
        no_low(),
    );
}

#[test(should_fail_with = "currency")]
fn the_mandate_currency_does_not_violate() {
    prove_cart(vectors::AMOUNT, vectors::CATEGORY, vectors::CART_TS, CURRENCY_MISMATCH);
}

#[test(should_fail_with = "commitment")]
fn claiming_another_mandate_currency_fails() {
    main(
        vectors::C_M,
        vectors::AMOUNT,
        vectors::USD,
        vectors::CATEGORY,
        vectors::MEMBER_ID,
        vectors::CART_TS,
        CURRENCY_MISMATCH,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::EUR,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::OPERATOR_ID,
        vectors::NONCE,
        vectors::SALT,
        no_low(),
    );
}

#[test]
fn a_category_outside_the_mask_violates() {
    prove_cart(vectors::AMOUNT, 6, vectors::CART_TS, CATEGORY_NOT_ALLOWED);
}

#[test(should_fail_with = "category")]
fn an_allowed_category_does_not_violate() {
    prove_cart(vectors::AMOUNT, vectors::CATEGORY, vectors::CART_TS, CATEGORY_NOT_ALLOWED);
}

#[test(should_fail_with = "category")]
fn a_cart_of_several_categories_does_not_violate() {
    prove_cart(vectors::AMOUNT, 255, vectors::CART_TS, CATEGORY_NOT_ALLOWED);
}

#[test]
fn a_cart_after_expiry_violates() {
    prove_cart(vectors::AMOUNT, vectors::CATEGORY, vectors::EXPIRY + 1, MANDATE_EXPIRED);
}

#[test(should_fail_with = "expiry")]
fn the_last_second_does_not_violate() {
    prove_cart(vectors::AMOUNT, vectors::CATEGORY, vectors::EXPIRY, MANDATE_EXPIRED);
}

#[test]
fn a_merchant_below_the_smallest_violates() {
    prove_merchant(vectors::OUTSIDER_ID, outsider_low());
}

#[test]
fn a_merchant_above_the_largest_violates() {
    prove_merchant(vectors::MEMBER_ID + 1, member_leaf());
}

#[test(should_fail_with = "merchant")]
fn an_allowed_merchant_does_not_violate() {
    prove_merchant(vectors::MEMBER_ID, member_leaf());
}

#[test(should_fail_with = "merchant")]
fn the_zero_leaf_does_not_cover_an_allowed_merchant() {
    prove_merchant(vectors::MEMBER_ID, outsider_low());
}

#[test(should_fail_with = "merchant")]
fn a_low_leaf_outside_the_tree_fails() {
    let mut low = outsider_low();
    low.path[3] += 1;
    prove_merchant(vectors::OUTSIDER_ID, low);
}

#[test(should_fail_with = "merchant")]
fn the_empty_preimage_is_not_a_low_leaf() {
    prove_merchant(vectors::OUTSIDER_ID, no_low());
}

#[test(should_fail_with = "violation_code")]
fn an_unknown_code_fails() {
    prove_cart(vectors::MAX_AMOUNT + 1, vectors::CATEGORY, vectors::CART_TS, 6);
}

#[test(should_fail_with = "commitment")]
fn another_salt_fails() {
    main(
        vectors::C_M,
        vectors::MAX_AMOUNT + 1,
        vectors::USD,
        vectors::CATEGORY,
        vectors::MEMBER_ID,
        vectors::CART_TS,
        AMOUNT_OVER_MAX,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::USD,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::OPERATOR_ID,
        vectors::NONCE,
        vectors::SALT + 1,
        no_low(),
    );
}

#[test(should_fail_with = "commitment")]
fn a_looser_maximum_fails() {
    main(
        vectors::C_M,
        vectors::MAX_AMOUNT + 1,
        vectors::USD,
        vectors::CATEGORY,
        vectors::MEMBER_ID,
        vectors::CART_TS,
        AMOUNT_OVER_MAX,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT - 1,
        vectors::USD,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::OPERATOR_ID,
        vectors::NONCE,
        vectors::SALT,
        no_low(),
    );
}

fn no_low() -> LowLeaf {
    LowLeaf { value: 0, next: 0, next_index: 0, index: 0, path: [0; DEPTH] }
}

/// The member's own leaf: the last of the tree.
fn member_leaf() -> LowLeaf {
    LowLeaf {
        value: vectors::MEMBER_ID,
        next: 0,
        next_index: 0,
        index: vectors::MEMBER_INDEX,
        path: vectors::MEMBER_PATH,
    }
}

/// The zero leaf, whose `next` is the smallest merchant.
fn outsider_low() -> LowLeaf {
    LowLeaf {
        value: vectors::OUTSIDER_LOW_VALUE,
        next: vectors::OUTSIDER_LOW_NEXT,
        next_index: vectors::OUTSIDER_LOW_NEXT_INDEX,
        index: vectors::OUTSIDER_LOW_INDEX,
        path: vectors::OUTSIDER_LOW_PATH,
    }
}

fn prove_cart(amount: u64, category: u8, cart_ts: u64, code: u8) {
    main(
        vectors::C_M,
        amount,
        vectors::USD,
        category,
        vectors::MEMBER_ID,
        cart_ts,
        code,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::USD,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::OPERATOR_ID,
        vectors::NONCE,
        vectors::SALT,
        no_low(),
    );
}

fn prove_merchant(merchant_id: Field, low: LowLeaf) {
    main(
        vectors::C_M,
        vectors::AMOUNT,
        vectors::USD,
        vectors::CATEGORY,
        merchant_id,
        vectors::CART_TS,
        MERCHANT_NOT_ALLOWED,
        vectors::USER_KEY_HASH,
        vectors::MAX_AMOUNT,
        vectors::USD,
        vectors::CATEGORY_MASK,
        vectors::MERCHANT_ROOT,
        vectors::EXPIRY,
        vectors::OPERATOR_ID,
        vectors::NONCE,
        vectors::SALT,
        low,
    );
}
