use crate::Error;

struct Currency {
    code: &'static str,
    numeric: u16,
    exponent: u32,
    integer_only: bool,
}

const fn currency(code: &'static str, numeric: u16, exponent: u32, integer_only: bool) -> Currency {
    Currency {
        code,
        numeric,
        exponent,
        integer_only,
    }
}

/// Currencies supported by the PayPal REST API, with ISO 4217 numeric codes and exponents and
/// PayPal's decimal rules.
const CURRENCIES: [Currency; 24] = [
    currency("AUD", 36, 2, false),
    currency("BRL", 986, 2, false),
    currency("CAD", 124, 2, false),
    currency("CNY", 156, 2, false),
    currency("CZK", 203, 2, false),
    currency("DKK", 208, 2, false),
    currency("EUR", 978, 2, false),
    currency("HKD", 344, 2, false),
    currency("HUF", 348, 2, true),
    currency("ILS", 376, 2, false),
    currency("JPY", 392, 0, true),
    currency("MYR", 458, 2, false),
    currency("MXN", 484, 2, false),
    currency("TWD", 901, 2, true),
    currency("NZD", 554, 2, false),
    currency("NOK", 578, 2, false),
    currency("PHP", 608, 2, false),
    currency("PLN", 985, 2, false),
    currency("GBP", 826, 2, false),
    currency("SGD", 702, 2, false),
    currency("SEK", 752, 2, false),
    currency("CHF", 756, 2, false),
    currency("THB", 764, 2, false),
    currency("USD", 840, 2, false),
];

/// An amount in minor units; never a float.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Money {
    pub currency: String,
    pub minor: i128,
}

fn info(code: &str) -> Result<&'static Currency, Error> {
    CURRENCIES
        .iter()
        .find(|c| c.code == code)
        .ok_or_else(|| Error::UnsupportedCurrency(code.to_owned()))
}

/// The ISO 4217 numeric code of a supported currency.
pub fn currency_numeric(code: &str) -> Result<u16, Error> {
    info(code).map(|c| c.numeric)
}

/// The ISO 4217 alphabetic code of a supported currency's numeric code.
#[cfg(feature = "statement")]
pub fn currency_code(numeric: u16) -> Option<&'static str> {
    CURRENCIES
        .iter()
        .find(|c| c.numeric == numeric)
        .map(|c| c.code)
}

/// Formats an amount as the decimal string PayPal expects, e.g. `"94.00"` or `"94"` for JPY.
pub fn to_paypal_value(money: &Money) -> Result<String, Error> {
    let Currency {
        exponent,
        integer_only,
        ..
    } = info(&money.currency)?;
    let scale = 10i128.pow(*exponent);
    let abs = money.minor.unsigned_abs();
    let sign = if money.minor < 0 { "-" } else { "" };
    let whole = abs / scale as u128;
    let frac = abs % scale as u128;
    if *integer_only {
        if frac != 0 {
            return Err(Error::InvalidAmount(format!(
                "{} does not allow fractional amounts",
                money.currency
            )));
        }
        return Ok(format!("{sign}{whole}"));
    }
    Ok(if *exponent == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{frac:0width$}", width = *exponent as usize)
    })
}

/// Parses a PayPal decimal string into minor units without going through a float.
pub fn from_paypal_value(currency: &str, value: &str) -> Result<Money, Error> {
    let Currency {
        exponent,
        integer_only,
        ..
    } = info(currency)?;
    let invalid = || Error::InvalidAmount(value.to_owned());
    let (negative, unsigned) = match value.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, value),
    };
    let (whole, frac) = match unsigned.split_once('.') {
        Some((whole, frac)) if !frac.is_empty() => (whole, frac),
        Some(_) => return Err(invalid()),
        None => (unsigned, ""),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || !digits(whole)
        || !digits(frac)
        || (whole.len() > 1 && whole.starts_with('0'))
    {
        return Err(invalid());
    }
    let max_decimals = if *integer_only { 0 } else { *exponent as usize };
    if frac.len() > max_decimals {
        return Err(invalid());
    }
    let scale = 10i128.pow(*exponent);
    let frac_minor = if frac.is_empty() {
        0
    } else {
        let padded = format!("{frac:0<width$}", width = *exponent as usize);
        padded.parse::<i128>().map_err(|_| invalid())?
    };
    let minor = whole
        .parse::<i128>()
        .ok()
        .and_then(|w| w.checked_mul(scale))
        .and_then(|w| w.checked_add(frac_minor))
        .ok_or_else(invalid)?;
    if negative && minor == 0 {
        return Err(invalid());
    }
    Ok(Money {
        currency: currency.to_owned(),
        minor: if negative { -minor } else { minor },
    })
}
