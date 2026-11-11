from typing import Literal

DisputeStatusSettlementOutcomeType3Type1 = Literal["claimable", "failed", "paid", "queued"]

DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_3_TYPE_1_VALUES: set[
    DisputeStatusSettlementOutcomeType3Type1
] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_dispute_status_settlement_outcome_type_3_type_1(
    value: str,
) -> DisputeStatusSettlementOutcomeType3Type1:
    if value in DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_3_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_3_TYPE_1_VALUES!r}"
    )
