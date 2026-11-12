"""RFC 8785 JSON Canonicalization Scheme."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any


def _number(n: float) -> str:
    """ECMAScript Number::toString of a finite double (RFC 8785 §3.2.2.3)."""
    if isinstance(n, int):
        return str(n)
    if not math.isfinite(n):
        raise TypeError("non-finite number")
    if n == 0:
        return "0"
    sign = "-" if n < 0 else ""
    t = Decimal(repr(abs(n))).normalize().as_tuple()
    s = "".join(map(str, t.digits))
    k = len(s)
    point = k + int(t.exponent)
    if k <= point <= 21:
        return sign + s + "0" * (point - k)
    if 0 < point <= 21:
        return sign + s[:point] + "." + s[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * -point + s
    e = point - 1
    return f"{sign}{s[0]}{'.' + s[1:] if k > 1 else ''}e{'+' if e >= 0 else '-'}{abs(e)}"


def _encode(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int | float):
        return _number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list | tuple):
        return "[" + ",".join(_encode(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{_encode(v[k])}" for k in keys) + "}"
    raise TypeError(f"{type(v).__name__} is not JSON")


def canonicalize(value: Any) -> str:
    return _encode(value)


def canonical_bytes(value: Any) -> bytes:
    return canonicalize(value).encode("utf-8")
