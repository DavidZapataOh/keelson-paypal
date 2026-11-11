from typing import Literal

MandateDraftPaymentRail = Literal["card", "paypal"]

MANDATE_DRAFT_PAYMENT_RAIL_VALUES: set[MandateDraftPaymentRail] = {
    "card",
    "paypal",
}


def check_mandate_draft_payment_rail(value: str) -> MandateDraftPaymentRail:
    if value in MANDATE_DRAFT_PAYMENT_RAIL_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_PAYMENT_RAIL_VALUES!r}"
    )
