use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// One line of the proposed cart.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
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
pub struct Cart {
    pub merchant: String,
    pub currency: String,
    pub lines: Vec<CartLine>,
    pub return_days: i64,
}

/// The amount breakdown of a PayPal purchase unit, as decimal strings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Breakdown {
    pub item_total: Option<String>,
    pub tax_total: Option<String>,
    pub shipping: Option<String>,
    pub handling: Option<String>,
    pub insurance: Option<String>,
    pub discount: Option<String>,
    pub shipping_discount: Option<String>,
}

/// The `amount` of a PayPal Orders v2 `purchase_units[]` entry.
///
/// Deserializes from the Orders v2 wire shape, where every amount is `{currency_code, value}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "wire::PurchaseUnit")]
pub struct PayPalUnit {
    pub currency: String,
    pub value: String,
    pub breakdown: Breakdown,
}

mod wire {
    use super::{Breakdown, PayPalUnit};
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct Money {
        currency_code: String,
        value: String,
    }

    #[derive(Deserialize)]
    struct Parts {
        item_total: Option<Money>,
        tax_total: Option<Money>,
        shipping: Option<Money>,
        handling: Option<Money>,
        insurance: Option<Money>,
        discount: Option<Money>,
        shipping_discount: Option<Money>,
    }

    #[derive(Deserialize)]
    struct Amount {
        currency_code: String,
        value: String,
        #[serde(default)]
        breakdown: Option<Parts>,
    }

    #[derive(Deserialize)]
    pub struct PurchaseUnit {
        amount: Amount,
    }

    impl TryFrom<PurchaseUnit> for PayPalUnit {
        type Error = String;

        fn try_from(unit: PurchaseUnit) -> Result<Self, String> {
            let Amount {
                currency_code,
                value,
                breakdown,
            } = unit.amount;
            let take = |m: Option<Money>| match m {
                Some(m) if m.currency_code != currency_code => Err(format!(
                    "breakdown currency {} differs from {currency_code}",
                    m.currency_code
                )),
                Some(m) => Ok(Some(m.value)),
                None => Ok(None),
            };
            let breakdown = match breakdown {
                Some(p) => Breakdown {
                    item_total: take(p.item_total)?,
                    tax_total: take(p.tax_total)?,
                    shipping: take(p.shipping)?,
                    handling: take(p.handling)?,
                    insurance: take(p.insurance)?,
                    discount: take(p.discount)?,
                    shipping_discount: take(p.shipping_discount)?,
                },
                None => Breakdown::default(),
            };
            Ok(Self {
                currency: currency_code,
                value,
                breakdown,
            })
        }
    }
}

/// A product variant in the cart.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Variant {
    pub sku: String,
    pub size: Option<String>,
    pub color: Option<String>,
}

/// The Cedar request context derived from a cart.
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
