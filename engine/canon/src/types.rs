use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// One line of the proposed cart.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CartLine {
    pub sku: String,
    pub size: Option<String>,
    pub color: Option<String>,
    pub category: String,
    pub qty: i64,
    pub unit_minor: i64,
}

/// The proposed cart.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cart {
    pub merchant: String,
    pub currency: String,
    pub lines: Vec<CartLine>,
    pub return_days: i64,
}

/// A PayPal amount: `{currency_code, value}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Amount {
    pub currency_code: String,
    pub value: String,
}

/// The amount breakdown of a PayPal purchase unit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Breakdown {
    pub item_total: Option<Amount>,
    pub tax_total: Option<Amount>,
    pub shipping: Option<Amount>,
    pub handling: Option<Amount>,
    pub insurance: Option<Amount>,
    pub discount: Option<Amount>,
    pub shipping_discount: Option<Amount>,
}

/// The `amount` of a PayPal Orders v2 `purchase_units[]` entry.
///
/// Deserializes from the Orders v2 wire shape, `{"amount": {currency_code, value, breakdown}}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "wire::PurchaseUnit")]
pub struct PayPalUnit {
    pub currency: String,
    pub value: String,
    pub breakdown: Breakdown,
}

mod wire {
    use super::{Breakdown, PayPalUnit};
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Amount {
        currency_code: String,
        value: String,
        #[serde(default)]
        breakdown: Breakdown,
    }

    #[derive(Deserialize)]
    pub struct PurchaseUnit {
        amount: Amount,
    }

    impl From<PurchaseUnit> for PayPalUnit {
        fn from(unit: PurchaseUnit) -> Self {
            let Amount {
                currency_code,
                value,
                breakdown,
            } = unit.amount;
            Self {
                currency: currency_code,
                value,
                breakdown,
            }
        }
    }
}

/// A product variant in the cart. Absent size and color are omitted from the JSON.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Variant {
    pub sku: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// The Cedar request context derived from a cart.
///
/// `max_line_qty` is the largest total quantity of any single variant, summed across lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Context {
    pub currency: String,
    pub total_minor: i64,
    pub merchant: String,
    pub categories: BTreeSet<String>,
    pub variants: BTreeSet<Variant>,
    pub max_line_qty: i64,
    pub return_days: i64,
}

/// Why a cart cannot be canonicalized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Deny {
    AmountBreakdownMismatch,
    CurrencyMismatch,
    AmountOverflow,
    InvalidQuantity,
    InvalidAmount,
    TooManyLines,
    EmptyCart,
}
