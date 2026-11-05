use serde_json::Value;

use crate::Error;

/// Deepest nesting of arrays and objects accepted in any credential or disclosure JSON.
pub(crate) const MAX_DEPTH: usize = 32;

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Names every JavaScript object inherits. SD-JWT processing in JavaScript looks digests up in a
/// plain object, so both sides refuse these as digests and as claim names.
pub(crate) const PROTOTYPE_NAMES: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

fn invalid(reason: &str) -> Error {
    Error::Json(reason.into())
}

fn is_prototype_name(v: &Value) -> bool {
    v.as_str().is_some_and(|s| PROTOTYPE_NAMES.contains(&s))
}

fn walk(v: &Value, depth: usize) -> Result<(), Error> {
    match v {
        Value::Number(n) => {
            let safe = match (n.as_u64(), n.as_i64()) {
                (Some(u), _) => u <= MAX_SAFE_INTEGER,
                (None, Some(i)) => i.unsigned_abs() <= MAX_SAFE_INTEGER,
                _ => false,
            };
            if !safe {
                return Err(invalid("number is not a safe integer"));
            }
            Ok(())
        }
        Value::Array(_) | Value::Object(_) if depth >= MAX_DEPTH => {
            Err(invalid("JSON nested too deep"))
        }
        Value::Array(items) => items.iter().try_for_each(|item| walk(item, depth + 1)),
        Value::Object(o) => {
            let digests = o.get("_sd").and_then(Value::as_array).into_iter().flatten();
            if digests.chain(o.get("...")).any(is_prototype_name) {
                return Err(invalid("digest is an Object.prototype name"));
            }
            o.values().try_for_each(|item| walk(item, depth + 1))
        }
        _ => Ok(()),
    }
}

/// Checks a JSON value: numbers are integers in `±(2^53 - 1)` written without a fraction or
/// exponent, arrays and objects nest at most [`MAX_DEPTH`] deep, and no `_sd` or `...` digest
/// is an `Object.prototype` name. Lone surrogates never reach a [`Value`].
pub(crate) fn check(v: &Value) -> Result<(), Error> {
    walk(v, 0)
}
