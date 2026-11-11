from typing import Literal

DisputeStatusSettlementRail = Literal["paypal", "pyusd"]

DISPUTE_STATUS_SETTLEMENT_RAIL_VALUES: set[DisputeStatusSettlementRail] = {
    "paypal",
    "pyusd",
}


def check_dispute_status_settlement_rail(value: str) -> DisputeStatusSettlementRail:
    if value in DISPUTE_STATUS_SETTLEMENT_RAIL_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_SETTLEMENT_RAIL_VALUES!r}"
    )
