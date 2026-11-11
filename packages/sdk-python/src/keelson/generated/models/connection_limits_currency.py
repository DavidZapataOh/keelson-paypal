from typing import Literal

ConnectionLimitsCurrency = Literal[
    "AUD",
    "BRL",
    "CAD",
    "CHF",
    "CNY",
    "CZK",
    "DKK",
    "EUR",
    "GBP",
    "HKD",
    "HUF",
    "ILS",
    "JPY",
    "MXN",
    "MYR",
    "NOK",
    "NZD",
    "PHP",
    "PLN",
    "SEK",
    "SGD",
    "THB",
    "TWD",
    "USD",
]

CONNECTION_LIMITS_CURRENCY_VALUES: set[ConnectionLimitsCurrency] = {
    "AUD",
    "BRL",
    "CAD",
    "CHF",
    "CNY",
    "CZK",
    "DKK",
    "EUR",
    "GBP",
    "HKD",
    "HUF",
    "ILS",
    "JPY",
    "MXN",
    "MYR",
    "NOK",
    "NZD",
    "PHP",
    "PLN",
    "SEK",
    "SGD",
    "THB",
    "TWD",
    "USD",
}


def check_connection_limits_currency(value: str) -> ConnectionLimitsCurrency:
    if value in CONNECTION_LIMITS_CURRENCY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CONNECTION_LIMITS_CURRENCY_VALUES!r}"
    )
