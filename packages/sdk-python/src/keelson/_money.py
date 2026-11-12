from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from ._errors import KeelsonError

_ZERO_DECIMAL = {"JPY", "HUF", "TWD"}

Amount = str | dict[str, Any]


def _digits(currency: str) -> int:
    return 0 if currency in _ZERO_DECIMAL else 2


def minor_of(amount: Amount) -> dict[str, Any]:
    """``"$120"`` or ``"120 USD"`` in minor units, or a ``{"currency", "minor"}`` as given."""
    if isinstance(amount, dict):
        return amount
    m = re.fullmatch(r"\s*(\$)?\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})?\s*", amount)
    if not m or not (m.group(1) or m.group(3)):
        raise KeelsonError(f'Write the amount as "$120" or "120 USD", not "{amount}".')
    currency = m.group(3) or "USD"
    whole, _, frac = m.group(2).partition(".")
    d = _digits(currency)
    if len(frac) > d:
        raise KeelsonError(f'{currency} has {d} decimal places: "{amount}".')
    return {"currency": currency, "minor": int(whole) * 10**d + int(frac.ljust(d, "0") or "0")}


def paypal_value(currency: str, minor: int) -> str:
    d = _digits(currency)
    if d == 0:
        return str(minor)
    s = str(minor).rjust(d + 1, "0")
    return f"{s[:-d]}.{s[-d:]}"


def iso_of(until: str | datetime) -> str:
    """An ISO date, a ``datetime``, or a duration from now such as ``"30m"``, ``"1h"``, ``"7d"``."""
    if isinstance(until, datetime):
        return until.astimezone(UTC).isoformat().replace("+00:00", "Z")
    m = re.fullmatch(r"\s*(\d+)\s*([mhd])\s*", until)
    if m:
        unit = {"m": "minutes", "h": "hours", "d": "days"}[m.group(2)]
        at = datetime.now(UTC) + timedelta(**{unit: int(m.group(1))})
        return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        return datetime.fromisoformat(until.replace("Z", "+00:00")).isoformat().replace("+00:00", "Z")
    except ValueError as err:
        raise KeelsonError(f'Write the end as an ISO date or "1h", not "{until}".') from err
