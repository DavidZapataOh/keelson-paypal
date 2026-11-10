//! C2b `amber_contradiction`: a JSON object a TLS server sent, committed to in a `WebFact`,
//! contradicts an amber attribute the operator attested for the same item.
//!
//! The operator's amber commitment opens to the product URL, the item's SKU and its attested size,
//! color, unit price and free-returns flag. The committed range opens to a JSON object whose
//! top-level `sku` is the attested SKU and whose value for `field_id` differs from the attested one.

mod vectors;

use json_parser::JSON512b;
use poseidon::poseidon2::Poseidon2;

/// `"KEELSON_AMBER"` read as a big-endian field element.
global KEELSON_AMBER: Field = 0x4b45454c534f4e5f414d424552;
/// The largest committed range, in bytes: up to 64 JSON tokens and 32 values.
pub global MAX_RANGE: u32 = 512;
/// The longest string value read, in bytes: a string packs into one field. json_parser slices a
/// string of a whole number of 31-byte words out of bounds, hence 30.
global MAX_STRING: u32 = 30;
global BLINDER: u32 = 16;
global TWO_POW_128: Field = 0x100000000000000000000000000000000;
global TWO_POW_248: Field = 0x100000000000000000000000000000000000000000000000000000000000000;

pub global SIZE: u8 = 1;
pub global COLOR: u8 = 2;
pub global UNIT_PRICE: u8 = 3;
pub global RETURNS_FREE: u8 = 4;

/// What the operator attested about the item; strings are packed with [`pack`].
pub struct Amber {
    sku: Field,
    size: Field,
    color: Field,
    unit_minor: u64,
    returns_free: bool,
}

/// A string of up to 30 bytes as one field: its length times 2^248 plus its bytes read big-endian.
pub fn pack(s: BoundedVec<u8, MAX_STRING>) -> Field {
    let mut acc: Field = 0;
    for i in 0..MAX_STRING {
        if i < s.len() {
            acc = acc * 256 + s.get_unchecked(i) as Field;
        }
    }
    acc + (s.len() as Field) * TWO_POW_248
}

pub fn commit(product: Field, amber: Amber, salt: Field) -> Field {
    Poseidon2::hash(
        [
            KEELSON_AMBER,
            product,
            amber.sku,
            amber.size,
            amber.color,
            amber.unit_minor as Field,
            amber.returns_free as Field,
            salt,
        ],
        8,
    )
}

/// `SHA-256(range ‖ blinder)` as its high and low 128 bits, as TLSNotary commits to a range.
fn range_commitment(range: [u8; MAX_RANGE], len: u32, blinder: [u8; BLINDER]) -> (Field, Field) {
    let mut message = [0; MAX_RANGE + BLINDER];
    for i in 0..MAX_RANGE + BLINDER {
        if i < len {
            message[i] = range[i];
        } else if i < len + BLINDER {
            message[i] = blinder[i - len];
        }
    }
    let digest = sha256::sha256_var(message, len + BLINDER);
    let mut hi: Field = 0;
    let mut lo: Field = 0;
    for i in 0..16 {
        hi = hi * 256 + digest[i] as Field;
        lo = lo * 256 + digest[i + 16] as Field;
    }
    (hi, lo)
}

fn main(
    range_hi: pub Field,
    range_lo: pub Field,
    amber_commitment: pub Field,
    product: pub Field,
    field_id: pub u8,
    range: [u8; MAX_RANGE],
    range_len: u32,
    blinder: [u8; BLINDER],
    amber: Amber,
    salt: Field,
) {
    assert(range_len <= MAX_RANGE);
    assert(commit(product, amber, salt) == amber_commitment, "amber commitment");
    assert(range_commitment(range, range_len, blinder) == (range_hi, range_lo), "range commitment");

    // Trailing spaces stand for the bytes past the range, so only the range is parsed.
    let mut text = [32; MAX_RANGE];
    for i in 0..MAX_RANGE {
        if i < range_len {
            text[i] = range[i];
        }
    }
    let json = JSON512b::parse_json(text);

    let sku: BoundedVec<u8, MAX_STRING> = json.get_string_unchecked("sku".as_bytes());
    assert(pack(sku) == amber.sku, "another item");

    if field_id == SIZE {
        let size: BoundedVec<u8, MAX_STRING> = json.get_string_unchecked("size".as_bytes());
        assert(pack(size) != amber.size, "no contradiction");
    } else if field_id == COLOR {
        let color: BoundedVec<u8, MAX_STRING> = json.get_string_unchecked("color".as_bytes());
        assert(pack(color) != amber.color, "no contradiction");
    } else if field_id == UNIT_PRICE {
        assert(
            json.get_number_unchecked("unit_minor".as_bytes()) != amber.unit_minor,
            "no contradiction",
        );
    } else {
        assert(field_id == RETURNS_FREE, "unknown field");
        let returns_free = json.get_literal_unchecked("returns_free".as_bytes());
        assert(!returns_free.is_null());
        assert(returns_free.to_bool() != amber.returns_free, "no contradiction");
    }
}

#[test]
fn test_pack() {
    assert(pack(BoundedVec::from_array("".as_bytes())) == 0);
    assert(pack(BoundedVec::from_array("10".as_bytes())) == 2 * TWO_POW_248 + 0x3130);
}

#[test]
fn test_opens_what_the_operator_tooling_commits_to() {
    let mut amber = honest();
    amber.size = vectors::SIZE_10;
    assert(pack_str("RF-TMP3-11") == vectors::SKU);
    assert(pack_str("blue") == vectors::COLOR);
    assert(commit(vectors::PRODUCT, amber, vectors::SALT) == vectors::AMBER_SIZE_10);
    let (range, len) = bytes(VARIANT);
    let blinder = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
    assert(range_commitment(range, len, blinder) == (vectors::RANGE_HI, vectors::RANGE_LO));
}

#[test]
fn test_reads_the_range_commitment_as_tlsnotary_does() {
    // SHA-256("{}" ‖ 0x00..0f), from Node's crypto.
    let mut range = [0; MAX_RANGE];
    range[0] = 0x7b;
    range[1] = 0x7d;
    let blinder = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    let (hi, lo) = range_commitment(range, 2, blinder);
    assert(hi == HI_EMPTY_OBJECT);
    assert(lo == LO_EMPTY_OBJECT);
}

#[test]
fn test_size_contradiction() {
    prove(
        VARIANT,
        SIZE,
        {
            let mut a = honest();
            a.size = pack_str("10");
            a
        },
    );
}

#[test]
fn test_color_contradiction() {
    prove(
        VARIANT,
        COLOR,
        {
            let mut a = honest();
            a.color = pack_str("red");
            a
        },
    );
}

#[test]
fn test_unit_price_contradiction() {
    prove(
        VARIANT,
        UNIT_PRICE,
        {
            let mut a = honest();
            a.unit_minor = 11900;
            a
        },
    );
}

#[test]
fn test_returns_free_contradiction() {
    prove(
        VARIANT,
        RETURNS_FREE,
        {
            let mut a = honest();
            a.returns_free = false;
            a
        },
    );
}

#[test]
fn test_reads_top_level_keys_in_any_order_and_spacing() {
    let json = "{ \"variant\": {\"size\": \"10\"}, \"size\" : \"11\",\n \"sku\": \"RF-TMP3-11\" }";
    prove(
        json,
        SIZE,
        {
            let mut a = honest();
            a.size = pack_str("12");
            a
        },
    );
}

#[test(should_fail_with = "no contradiction")]
fn test_honest_size_is_no_contradiction() {
    prove(VARIANT, SIZE, honest());
}

#[test(should_fail_with = "no contradiction")]
fn test_honest_color_is_no_contradiction() {
    prove(VARIANT, COLOR, honest());
}

#[test(should_fail_with = "no contradiction")]
fn test_honest_unit_price_is_no_contradiction() {
    prove(VARIANT, UNIT_PRICE, honest());
}

#[test(should_fail_with = "no contradiction")]
fn test_honest_returns_free_is_no_contradiction() {
    prove(VARIANT, RETURNS_FREE, honest());
}

#[test(should_fail_with = "no contradiction")]
fn test_a_nested_key_is_not_the_items() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"variant\":{\"size\":\"10\"},\"size\":\"11\"}";
    prove(json, SIZE, honest());
}

#[test(should_fail_with = "another item")]
fn test_another_items_object_proves_nothing() {
    let json = "{\"sku\":\"RF-TMP3-10\",\"size\":\"10\",\"color\":\"blue\",\"unit_minor\":12900,\"returns_free\":true}";
    prove(json, SIZE, honest());
}

#[test(should_fail)]
fn test_a_missing_key_proves_nothing() {
    prove(
        "{\"sku\":\"RF-TMP3-11\",\"color\":\"blue\"}",
        SIZE,
        honest(),
    );
}

#[test(should_fail)]
fn test_a_value_of_another_type_proves_nothing() {
    prove("{\"sku\":\"RF-TMP3-11\",\"size\":10}", SIZE, honest());
}

#[test(should_fail)]
fn test_null_returns_free_proves_nothing() {
    prove(
        "{\"sku\":\"RF-TMP3-11\",\"returns_free\":null}",
        RETURNS_FREE,
        honest(),
    );
}

#[test(should_fail_with = "unknown field")]
fn test_an_unknown_field_proves_nothing() {
    prove(
        VARIANT,
        5,
        {
            let mut a = honest();
            a.size = pack_str("10");
            a
        },
    );
}

#[test(should_fail)]
fn test_a_range_that_is_not_json_proves_nothing() {
    prove("{\"sku\":\"RF-TMP3-11\",\"size\":\"10\"", SIZE, honest());
}

#[test(should_fail_with = "amber commitment")]
fn test_another_commitment_proves_nothing() {
    let amber = {
        let mut a = honest();
        a.size = pack_str("10");
        a
    };
    let (range, len) = bytes(VARIANT);
    let (hi, lo) = range_commitment(range, len, BLINDER_BYTES);
    main(
        hi,
        lo,
        commit(PRODUCT, amber, SALT + 1),
        PRODUCT,
        SIZE,
        range,
        len,
        BLINDER_BYTES,
        amber,
        SALT,
    );
}

#[test(should_fail_with = "amber commitment")]
fn test_another_product_proves_nothing() {
    let amber = {
        let mut a = honest();
        a.size = pack_str("10");
        a
    };
    let (range, len) = bytes(VARIANT);
    let (hi, lo) = range_commitment(range, len, BLINDER_BYTES);
    main(
        hi,
        lo,
        commit(PRODUCT, amber, SALT),
        PRODUCT + 1,
        SIZE,
        range,
        len,
        BLINDER_BYTES,
        amber,
        SALT,
    );
}

#[test(should_fail_with = "range commitment")]
fn test_another_blinder_proves_nothing() {
    let amber = {
        let mut a = honest();
        a.size = pack_str("10");
        a
    };
    let (range, len) = bytes(VARIANT);
    let (hi, lo) = range_commitment(range, len, BLINDER_BYTES);
    let mut blinder = BLINDER_BYTES;
    blinder[0] += 1;
    main(
        hi,
        lo,
        commit(PRODUCT, amber, SALT),
        PRODUCT,
        SIZE,
        range,
        len,
        blinder,
        amber,
        SALT,
    );
}

#[test(should_fail)]
fn test_a_range_past_its_length_proves_nothing() {
    let amber = {
        let mut a = honest();
        a.size = pack_str("10");
        a
    };
    let (range, _) = bytes(VARIANT);
    let len = MAX_RANGE + 1;
    let (hi, lo) = range_commitment(range, len, BLINDER_BYTES);
    main(
        hi,
        lo,
        commit(PRODUCT, amber, SALT),
        PRODUCT,
        SIZE,
        range,
        len,
        BLINDER_BYTES,
        amber,
        SALT,
    );
}

#[test]
fn test_bytes_past_the_range_are_ignored() {
    let amber = {
        let mut a = honest();
        a.size = pack_str("10");
        a
    };
    let (mut range, len) = bytes(VARIANT);
    let (hi, lo) = range_commitment(range, len, BLINDER_BYTES);
    range[len] = 0x2c;
    range[len + 1] = 0x22;
    main(
        hi,
        lo,
        commit(PRODUCT, amber, SALT),
        PRODUCT,
        SIZE,
        range,
        len,
        BLINDER_BYTES,
        amber,
        SALT,
    );
}

global HI_EMPTY_OBJECT: Field = 0x68cb57389cd50993798987d471c311a2;
global LO_EMPTY_OBJECT: Field = 0x89420dafcf0e5bf8061ba6429d98e29b;
global VARIANT: str<86> = "{\"sku\":\"RF-TMP3-11\",\"size\":\"11\",\"color\":\"blue\",\"unit_minor\":12900,\"returns_free\":true}";
global PRODUCT: Field = 0x1234;
global SALT: Field = 0x5a17;
global BLINDER_BYTES: [u8; BLINDER] = [7; BLINDER];

fn pack_str<let N: u32>(s: str<N>) -> Field {
    pack(BoundedVec::from_array(s.as_bytes()))
}

fn honest() -> Amber {
    Amber {
        sku: pack_str("RF-TMP3-11"),
        size: pack_str("11"),
        color: pack_str("blue"),
        unit_minor: 12900,
        returns_free: true,
    }
}

fn bytes<let N: u32>(s: str<N>) -> ([u8; MAX_RANGE], u32) {
    let mut range = [0; MAX_RANGE];
    let b = s.as_bytes();
    for i in 0..N {
        range[i] = b[i];
    }
    (range, N)
}

fn prove<let N: u32>(json: str<N>, field_id: u8, amber: Amber) {
    let (range, len) = bytes(json);
    let (hi, lo) = range_commitment(range, len, BLINDER_BYTES);
    main(
        hi,
        lo,
        commit(PRODUCT, amber, SALT),
        PRODUCT,
        field_id,
        range,
        len,
        BLINDER_BYTES,
        amber,
        SALT,
    );
}
