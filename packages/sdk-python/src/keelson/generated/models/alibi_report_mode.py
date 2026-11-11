from typing import Literal

AlibiReportMode = Literal["2of2", "degraded"]

ALIBI_REPORT_MODE_VALUES: set[AlibiReportMode] = {
    "2of2",
    "degraded",
}


def check_alibi_report_mode(value: str) -> AlibiReportMode:
    if value in ALIBI_REPORT_MODE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {ALIBI_REPORT_MODE_VALUES!r}")
