from typing import Literal

PayPalClientEnvironment = Literal["production", "sandbox"]

PAY_PAL_CLIENT_ENVIRONMENT_VALUES: set[PayPalClientEnvironment] = {
    "production",
    "sandbox",
}


def check_pay_pal_client_environment(value: str) -> PayPalClientEnvironment:
    if value in PAY_PAL_CLIENT_ENVIRONMENT_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {PAY_PAL_CLIENT_ENVIRONMENT_VALUES!r}"
    )
