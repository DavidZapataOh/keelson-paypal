from typing import Literal

DiscloseEvidenceItemDecrypt = Literal["1"]

DISCLOSE_EVIDENCE_ITEM_DECRYPT_VALUES: set[DiscloseEvidenceItemDecrypt] = {
    "1",
}


def check_disclose_evidence_item_decrypt(value: str) -> DiscloseEvidenceItemDecrypt:
    if value in DISCLOSE_EVIDENCE_ITEM_DECRYPT_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {DISCLOSE_EVIDENCE_ITEM_DECRYPT_VALUES!r}"
    )
