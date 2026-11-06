use crate::Deny;

/// Parses a PayPal decimal string into non-negative `i64` minor units.
///
/// Well-formed digit strings too large for the core parser are reported as overflow.
pub(crate) fn parse(currency: &str, value: &str) -> Result<i64, Deny> {
    match keelson_core::from_paypal_value(currency, value) {
        Ok(money) if money.minor < 0 => Err(Deny::InvalidAmount),
        Ok(money) => i64::try_from(money.minor).map_err(|_| Deny::AmountOverflow),
        Err(_) if is_huge(value) => Err(Deny::AmountOverflow),
        Err(_) => Err(Deny::InvalidAmount),
    }
}

fn is_huge(value: &str) -> bool {
    let (whole, frac) = value.split_once('.').unwrap_or((value, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    whole.len() >= 20 && !whole.starts_with('0') && digits(whole) && frac.len() <= 2 && digits(frac)
}
