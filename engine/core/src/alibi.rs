use serde_json::{Map, Value};

use crate::{Dst, Error, Money, hash_object, to_paypal_value};

/// The fields an Alibi digest commits to.
#[derive(Debug, Clone, Copy)]
pub struct AlibiFields<'a> {
    pub mandate_hash: &'a str,
    pub cart_hash: &'a str,
    pub policy_set_hash: &'a str,
    pub countersign_digest: &'a str,
    pub merchant_id: &'a str,
    pub amount: &'a Money,
    pub paypal_order_id: Option<&'a str>,
}

/// Computes `hash_object(Dst::Alibi, …)` over the snake_case Alibi fields. The amount is hashed in
/// PayPal's decimal format and the currency is taken from it, so each purchase has one digest.
pub fn alibi_digest(fields: &AlibiFields<'_>) -> Result<[u8; 32], Error> {
    let mut object = Map::new();
    let mut put = |key: &str, value: &str| object.insert(key.into(), Value::from(value));
    put("mandate_hash", fields.mandate_hash);
    put("cart_hash", fields.cart_hash);
    put("policy_set_hash", fields.policy_set_hash);
    put("countersign_digest", fields.countersign_digest);
    put("merchant_id", fields.merchant_id);
    put("amount", &to_paypal_value(fields.amount)?);
    put("currency", &fields.amount.currency);
    if let Some(order_id) = fields.paypal_order_id {
        put("paypal_order_id", order_id);
    }
    hash_object(Dst::Alibi, &Value::Object(object))
}
