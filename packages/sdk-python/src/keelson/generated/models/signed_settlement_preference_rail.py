from typing import Literal

SignedSettlementPreferenceRail = Literal["paypal", "pyusd"]

SIGNED_SETTLEMENT_PREFERENCE_RAIL_VALUES: set[SignedSettlementPreferenceRail] = {
    "paypal",
    "pyusd",
}


def check_signed_settlement_preference_rail(value: str) -> SignedSettlementPreferenceRail:
    if value in SIGNED_SETTLEMENT_PREFERENCE_RAIL_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {SIGNED_SETTLEMENT_PREFERENCE_RAIL_VALUES!r}"
    )
