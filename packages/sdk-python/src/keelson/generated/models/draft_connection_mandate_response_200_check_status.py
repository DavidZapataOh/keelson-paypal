from typing import Literal

DraftConnectionMandateResponse200CheckStatus = Literal["skipped"]

DRAFT_CONNECTION_MANDATE_RESPONSE_200_CHECK_STATUS_VALUES: set[
    DraftConnectionMandateResponse200CheckStatus
] = {
    "skipped",
}


def check_draft_connection_mandate_response_200_check_status(
    value: str,
) -> DraftConnectionMandateResponse200CheckStatus:
    if value in DRAFT_CONNECTION_MANDATE_RESPONSE_200_CHECK_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DRAFT_CONNECTION_MANDATE_RESPONSE_200_CHECK_STATUS_VALUES!r}"
    )
