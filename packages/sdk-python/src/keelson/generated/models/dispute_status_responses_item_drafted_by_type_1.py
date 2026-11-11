from typing import Literal

DisputeStatusResponsesItemDraftedByType1 = Literal["model", "template"]

DISPUTE_STATUS_RESPONSES_ITEM_DRAFTED_BY_TYPE_1_VALUES: set[
    DisputeStatusResponsesItemDraftedByType1
] = {
    "model",
    "template",
}


def check_dispute_status_responses_item_drafted_by_type_1(
    value: str,
) -> DisputeStatusResponsesItemDraftedByType1:
    if value in DISPUTE_STATUS_RESPONSES_ITEM_DRAFTED_BY_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_RESPONSES_ITEM_DRAFTED_BY_TYPE_1_VALUES!r}"
    )
