from typing import Literal

WebFactMode = Literal["mpc", "proxy"]

WEB_FACT_MODE_VALUES: set[WebFactMode] = {
    "mpc",
    "proxy",
}


def check_web_fact_mode(value: str) -> WebFactMode:
    if value in WEB_FACT_MODE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {WEB_FACT_MODE_VALUES!r}")
