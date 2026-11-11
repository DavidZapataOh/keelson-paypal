from typing import Literal

DisputeStatusResponsesItemAction = Literal["accept_claim", "provide_evidence", "send_message"]

DISPUTE_STATUS_RESPONSES_ITEM_ACTION_VALUES: set[DisputeStatusResponsesItemAction] = {
    "accept_claim",
    "provide_evidence",
    "send_message",
}


def check_dispute_status_responses_item_action(value: str) -> DisputeStatusResponsesItemAction:
    if value in DISPUTE_STATUS_RESPONSES_ITEM_ACTION_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISPUTE_STATUS_RESPONSES_ITEM_ACTION_VALUES!r}"
    )
