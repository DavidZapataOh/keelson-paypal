from typing import Literal

DraftEmbedMandateResponse200CheckStatus = Literal["skipped"]

DRAFT_EMBED_MANDATE_RESPONSE_200_CHECK_STATUS_VALUES: set[
    DraftEmbedMandateResponse200CheckStatus
] = {
    "skipped",
}


def check_draft_embed_mandate_response_200_check_status(
    value: str,
) -> DraftEmbedMandateResponse200CheckStatus:
    if value in DRAFT_EMBED_MANDATE_RESPONSE_200_CHECK_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DRAFT_EMBED_MANDATE_RESPONSE_200_CHECK_STATUS_VALUES!r}"
    )
