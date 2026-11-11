from typing import Literal

MandateDraftPaymentConstraintsItemType1Currency = Literal[
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

MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_1_CURRENCY_VALUES: set[
    MandateDraftPaymentConstraintsItemType1Currency
] = {
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


def check_mandate_draft_payment_constraints_item_type_1_currency(
    value: str,
) -> MandateDraftPaymentConstraintsItemType1Currency:
    if value in MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_1_CURRENCY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_CONSTRAINTS_ITEM_TYPE_1_CURRENCY_VALUES!r}"
    )
