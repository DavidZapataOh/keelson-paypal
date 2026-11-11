from typing import Literal

AlibiReportVerdict = Literal[
    "failed", "incomplete", "verified", "verified-offline", "verified-unanchored"
]

ALIBI_REPORT_VERDICT_VALUES: set[AlibiReportVerdict] = {
    "failed",
    "incomplete",
    "verified",
    "verified-offline",
    "verified-unanchored",
}


def check_alibi_report_verdict(value: str) -> AlibiReportVerdict:
    if value in ALIBI_REPORT_VERDICT_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {ALIBI_REPORT_VERDICT_VALUES!r}")
