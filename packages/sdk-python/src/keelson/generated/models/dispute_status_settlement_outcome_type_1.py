from typing import Literal

DisputeStatusSettlementOutcomeType1 = Literal["claimable", "failed", "paid", "queued"]

DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_1_VALUES: set[DisputeStatusSettlementOutcomeType1] = {
    "claimable",
    "failed",
    "paid",
    "queued",
}


def check_dispute_status_settlement_outcome_type_1(
    value: str,
) -> DisputeStatusSettlementOutcomeType1:
    if value in DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_SETTLEMENT_OUTCOME_TYPE_1_VALUES!r}"
    )
