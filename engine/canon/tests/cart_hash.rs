use keelson_canon::{Cart, cart_hash};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: Value,
    expected: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn cart_hash_vectors() {
    let vectors: Vec<Vector> = serde_json::from_str(include_str!(
        "../../../packages/core/test/vectors/cart-hash.json"
    ))
    .unwrap();
    assert_eq!(vectors.len(), 6);
    for v in vectors {
        let cart: Cart = serde_json::from_value(v.input).unwrap();
        let digest = cart_hash(&cart).unwrap();
        assert_eq!(format!("0x{}", hex(&digest)), v.expected, "{}", v.name);
    }
}
