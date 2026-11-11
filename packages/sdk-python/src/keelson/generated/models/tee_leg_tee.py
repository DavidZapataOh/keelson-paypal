from typing import Literal

TeeLegTee = Literal["nitro", "tdx"]

TEE_LEG_TEE_VALUES: set[TeeLegTee] = {
    "nitro",
    "tdx",
}


def check_tee_leg_tee(value: str) -> TeeLegTee:
    if value in TEE_LEG_TEE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {TEE_LEG_TEE_VALUES!r}")
