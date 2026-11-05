use serde_json::Value;

use crate::Error;

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

fn assert_canonical(value: &Value) -> Result<(), Error> {
    match value {
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) if i.abs() <= MAX_SAFE_INTEGER => Ok(()),
            (None, Some(u)) if u <= MAX_SAFE_INTEGER as u64 => Ok(()),
            (Some(_), _) | (_, Some(_)) => Err(Error::UnsafeInteger),
            _ => Err(Error::NonInteger),
        },
        Value::Array(items) => items.iter().try_for_each(assert_canonical),
        Value::Object(map) => map.values().try_for_each(assert_canonical),
        _ => Ok(()),
    }
}

/// Serializes a value as RFC 8785 canonical JSON.
///
/// Numbers must be safe integers; larger values are carried as strings.
pub fn jcs(value: &Value) -> Result<String, Error> {
    assert_canonical(value)?;
    serde_jcs::to_string(value).map_err(|e| Error::Serialize(e.to_string()))
}
