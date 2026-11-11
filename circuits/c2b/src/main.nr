//! C2b `amber_contradiction`: a JSON object a TLS server sent, committed to in a `WebFact`,
//! contradicts an amber attribute the operator attested for the same item.
//!
//! The operator's amber commitment opens to the item's page, its SKU and its attested size, color,
//! unit price and free-returns flag. The committed range opens to the item's JSON object: exactly
//! the keys `sku`, `size`, `color`, `unit_minor` and `returns_free`, its `sku` the attested one and
//! its value for `field_id` another than the attested one.

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

    // Five pairs in the whole object and the five keys at its root: nothing nested, no key twice.
    assert(pairs(text) == 5, "not an item");
    let sku = json.get_value_unchecked("sku".as_bytes());
    let sku = plain_string(sku.is_string(), sku.value());
    let size = json.get_value_unchecked("size".as_bytes());
    let size = plain_string(size.is_string(), size.value());
    let color = json.get_value_unchecked("color".as_bytes());
    let color = plain_string(color.is_string(), color.value());
    let unit_minor = json.get_value_unchecked("unit_minor".as_bytes());
    let unit_minor = integer(unit_minor.is_number(), unit_minor.value());
    let returns_free = json.get_literal_unchecked("returns_free".as_bytes());
    assert(!returns_free.is_null(), "not an item");
    assert(pack(sku) == amber.sku, "another item");

    let differs = if field_id == SIZE {
        pack(size) != amber.size
    } else if field_id == COLOR {
        pack(color) != amber.color
    } else if field_id == UNIT_PRICE {
        unit_minor != amber.unit_minor
    } else {
        assert(field_id == RETURNS_FREE, "unknown field");
        returns_free.to_bool() != amber.returns_free
    };
    assert(differs, "no contradiction");
}

/// The `:` outside strings in valid JSON, one per key/value pair at any depth.
fn pairs(text: [u8; MAX_RANGE]) -> u32 {
    let mut in_string = false;
    let mut escaped = false;
    let mut n = 0;
    for i in 0..MAX_RANGE {
        let b = text[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if b == 0x5c {
                escaped = true;
            } else if b == 0x22 {
                in_string = false;
            }
        } else if b == 0x22 {
            in_string = true;
        } else if b == 0x3a {
            n += 1;
        }
    }
    n
}

/// A string value as sent, without escapes or control characters: an escaped string could spell
/// the same text differently, and a control byte could be framing spliced into the body.
fn plain_string(is_string: bool, s: BoundedVec<u8, MAX_STRING>) -> BoundedVec<u8, MAX_STRING> {
    assert(is_string, "not a string");
    for i in 0..MAX_STRING {
        if i < s.len() {
            let b = s.get_unchecked(i);
            assert((b >= 0x20) & (b != 0x5c) & (b != 0x7f), "escaped string");
        }
    }
    s
}

/// A non-negative integer of up to 19 digits, which a `u64` holds.
fn integer(is_number: bool, digits: BoundedVec<u8, MAX_STRING>) -> u64 {
    assert(is_number, "not a number");
    assert(digits.len() <= 19, "not a u64");
    let mut n: u64 = 0;
    for i in 0..19 {
        if i < digits.len() {
            let d = digits.get_unchecked(i);
            assert((d >= 0x30) & (d <= 0x39), "not an integer");
            n = n * 10 + (d - 0x30) as u64;
        }
    }
    n
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
    let json = "{ \"returns_free\" : true,\n \"unit_minor\": 12900, \"color\": \"blue\", \"size\" : \"11\",\"sku\": \"RF-TMP3-11\" }";
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

#[test(should_fail_with = "not an item")]
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

#[test(should_fail_with = "not an item")]
fn test_a_repeated_key_proves_nothing() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"size\":\"10\",\"size\":\"11\",\"color\":\"blue\",\"unit_minor\":12900,\"returns_free\":true}";
    prove(json, SIZE, honest());
}

#[test(should_fail_with = "not an item")]
fn test_an_extra_key_proves_nothing() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"size\":\"10\",\"color\":\"blue\",\"unit_minor\":12900,\"returns_free\":true,\"x\":1}";
    prove(json, SIZE, honest());
}

#[test]
fn test_a_colon_inside_a_string_is_no_pair() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"size\":\"10\",\"color\":\"blue:navy\",\"unit_minor\":12900,\"returns_free\":true}";
    prove(json, SIZE, honest());
}

#[test(should_fail_with = "escaped string")]
fn test_an_escaped_value_proves_nothing() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"size\":\"1\\u0031\",\"color\":\"blue\",\"unit_minor\":12900,\"returns_free\":true}";
    prove(json, SIZE, honest());
}

#[test(should_fail_with = "escaped string")]
fn test_a_control_byte_in_a_value_proves_nothing() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"size\":\"1\r\n1\",\"color\":\"blue\",\"unit_minor\":12900,\"returns_free\":true}";
    prove(json, SIZE, honest());
}

#[test(should_fail_with = "not a u64")]
fn test_a_price_past_u64_proves_nothing() {
    let json = "{\"sku\":\"RF-TMP3-11\",\"size\":\"11\",\"color\":\"blue\",\"unit_minor\":18446744073709564516,\"returns_free\":true}";
    prove(json, UNIT_PRICE, honest());
}
