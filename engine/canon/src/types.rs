use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// One line of the proposed cart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CartLine {
    pub sku: String,
    pub size: Option<String>,
    pub color: Option<String>,
    pub category: String,
    pub qty: i64,
    pub unit_minor: i64,
}

/// The proposed cart. An absent `size` or `color` serializes as `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cart {
    pub merchant: String,
    pub currency: String,
    pub lines: Vec<CartLine>,
    pub return_days: i64,
    /// Whether the merchant's returns are free.
    pub returns_free: bool,
}

/// A PayPal amount: `{currency_code, value}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Amount {
    pub currency_code: String,
    pub value: String,
}

/// The amount breakdown of a PayPal purchase unit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Breakdown {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_total: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tax_total: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shipping: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handling: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insurance: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discount: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shipping_discount: Option<Amount>,
}

/// The `amount` of a PayPal Orders v2 `purchase_units[]` entry.
///
/// Serializes to and from the Orders v2 wire shape, `{"amount": {currency_code, value, breakdown}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "wire::PurchaseUnit", into = "wire::PurchaseUnit")]
pub struct PayPalUnit {
    pub currency: String,
    pub value: String,
    pub breakdown: Breakdown,
}

mod wire {
    use super::{Breakdown, PayPalUnit};
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Amount {
        currency_code: String,
        value: String,
        #[serde(default)]
        breakdown: Breakdown,
    }

    #[derive(Serialize, Deserialize)]
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

    impl From<PayPalUnit> for PurchaseUnit {
        fn from(unit: PayPalUnit) -> Self {
            Self {
                amount: Amount {
                    currency_code: unit.currency,
                    value: unit.value,
                    breakdown: unit.breakdown,
                },
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
/// `max_line_qty` is the largest total quantity of any single variant, summed across lines, and
/// `max_unit_minor` the largest unit price of any line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Context {
    pub currency: String,
    pub total_minor: i64,
    pub merchant: String,
    pub categories: BTreeSet<String>,
    pub variants: BTreeSet<Variant>,
    pub max_line_qty: i64,
    pub max_unit_minor: i64,
    pub return_days: i64,
    pub returns_free: bool,
    /// The total quantity of each variant, keyed by the elements of `variants`. Not part of the
    /// Cedar context: the evaluator uses it to recompute `max_line_qty` after projecting variants.
    #[serde(skip)]
    pub quantities: BTreeMap<Variant, i64>,
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
