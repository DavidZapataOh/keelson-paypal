from typing import Literal

DisputeStatusSettlementPaidByType3Type1 = Literal["chain", "treasury", "violation-pool"]

DISPUTE_STATUS_SETTLEMENT_PAID_BY_TYPE_3_TYPE_1_VALUES: set[
    DisputeStatusSettlementPaidByType3Type1
] = {
    "chain",
    "treasury",
    "violation-pool",
}


def check_dispute_status_settlement_paid_by_type_3_type_1(
    value: str,
) -> DisputeStatusSettlementPaidByType3Type1:
    if value in DISPUTE_STATUS_SETTLEMENT_PAID_BY_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_SETTLEMENT_PAID_BY_TYPE_3_TYPE_1_VALUES!r}"
    )
