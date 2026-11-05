use crate::Deny;

/// Parses a PayPal decimal string into non-negative `i64` minor units.
pub(crate) fn parse(currency: &str, value: &str) -> Result<i64, Deny> {
    let money =
        keelson_core::from_paypal_value(currency, value).map_err(|_| Deny::InvalidAmount)?;
    if money.minor < 0 {
        return Err(Deny::InvalidAmount);
    }
    i64::try_from(money.minor).map_err(|_| Deny::AmountOverflow)
}
