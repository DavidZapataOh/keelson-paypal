from typing import Literal

MandateDraftPaymentCurrency = Literal[
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

MANDATE_DRAFT_PAYMENT_CURRENCY_VALUES: set[MandateDraftPaymentCurrency] = {
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


def check_mandate_draft_payment_currency(value: str) -> MandateDraftPaymentCurrency:
    if value in MANDATE_DRAFT_PAYMENT_CURRENCY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CURRENCY_VALUES!r}"
    )
