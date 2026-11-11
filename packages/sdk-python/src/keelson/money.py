"""Amounts as PayPal writes them."""

_EXPONENT = {"JPY": 0}
"""ISO 4217 minor-unit exponents that are not 2, among the currencies PayPal supports."""
_INTEGER_ONLY = frozenset({"HUF", "JPY", "TWD"})
"""Currencies PayPal takes in whole units only."""


def to_paypal_value(currency: str, minor: int) -> str:
    """The decimal string PayPal expects, e.g. ``"94.00"``, or ``"94"`` for JPY."""
    exponent = _EXPONENT.get(currency, 2)
    sign = "-" if minor < 0 else ""
    whole, frac = divmod(abs(minor), 10**exponent)
    if currency in _INTEGER_ONLY:
        if frac:
            raise ValueError(f"{currency} does not allow fractional amounts")
        return f"{sign}{whole}"
    return f"{sign}{whole}.{frac:0{exponent}d}"
