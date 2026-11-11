from typing import Literal

AlibiReportChecksItemStatus = Literal[
    "absent", "fail", "pass", "pending", "undisclosed", "unreachable"
]

ALIBI_REPORT_CHECKS_ITEM_STATUS_VALUES: set[AlibiReportChecksItemStatus] = {
    "absent",
    "fail",
    "pass",
    "pending",
    "undisclosed",
    "unreachable",
}


def check_alibi_report_checks_item_status(value: str) -> AlibiReportChecksItemStatus:
    if value in ALIBI_REPORT_CHECKS_ITEM_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {ALIBI_REPORT_CHECKS_ITEM_STATUS_VALUES!r}"
    )
