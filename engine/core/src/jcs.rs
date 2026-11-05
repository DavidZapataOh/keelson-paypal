use serde_json::{Number, Value};

use crate::Error;

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Rejects numbers that are not safe integers and rewrites integral floats (`1.0`, `1e3`, `-0`)
/// as integers, the way a JavaScript `JSON.parse` would have read them.
fn normalize(value: &Value) -> Result<Value, Error> {
    Ok(match value {
        Value::Number(n) => {
            let safe = -MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER;
            if let Some(i) = n.as_i64() {
                if !safe.contains(&i) {
                    return Err(Error::UnsafeInteger);
                }
                Value::Number(n.clone())
            } else if n.as_u64().is_some() {
                return Err(Error::UnsafeInteger);
            } else {
                let f = n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0);
                let f = f.ok_or(Error::NonInteger)?;
                if f.abs() > MAX_SAFE_INTEGER as f64 {
                    return Err(Error::UnsafeInteger);
                }
                Value::Number(Number::from(f as i64))
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect::<Result<_, _>>()?),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| Ok((k.clone(), normalize(v)?)))
                .collect::<Result<_, Error>>()?,
        ),
        other => other.clone(),
    })
}

/// Serializes a value as RFC 8785 canonical JSON.
///
/// Numbers must be safe integers; larger values are carried as strings.
pub fn jcs(value: &Value) -> Result<String, Error> {
    serde_jcs::to_string(&normalize(value)?).map_err(|e| Error::Serialize(e.to_string()))
}
