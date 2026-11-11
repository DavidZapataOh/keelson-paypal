from typing import Literal

CompiledMandateCheckStatus = Literal["aborted", "failed", "ok", "refused", "skipped"]

COMPILED_MANDATE_CHECK_STATUS_VALUES: set[CompiledMandateCheckStatus] = {
    "aborted",
    "failed",
    "ok",
    "refused",
    "skipped",
}


def check_compiled_mandate_check_status(value: str) -> CompiledMandateCheckStatus:
    if value in COMPILED_MANDATE_CHECK_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {COMPILED_MANDATE_CHECK_STATUS_VALUES!r}"
    )
