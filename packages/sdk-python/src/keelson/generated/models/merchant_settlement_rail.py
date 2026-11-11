from typing import Literal

MerchantSettlementRail = Literal["paypal", "pyusd"]

MERCHANT_SETTLEMENT_RAIL_VALUES: set[MerchantSettlementRail] = {
    "paypal",
    "pyusd",
}


def check_merchant_settlement_rail(value: str) -> MerchantSettlementRail:
    if value in MERCHANT_SETTLEMENT_RAIL_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MERCHANT_SETTLEMENT_RAIL_VALUES!r}"
    )
