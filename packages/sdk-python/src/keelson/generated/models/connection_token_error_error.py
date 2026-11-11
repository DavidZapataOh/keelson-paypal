from typing import Literal

ConnectionTokenErrorError = Literal[
    "access_denied",
    "authorization_pending",
    "expired_token",
    "invalid_grant",
    "slow_down",
    "unsupported_grant_type",
]

CONNECTION_TOKEN_ERROR_ERROR_VALUES: set[ConnectionTokenErrorError] = {
    "access_denied",
    "authorization_pending",
    "expired_token",
    "invalid_grant",
    "slow_down",
    "unsupported_grant_type",
}


def check_connection_token_error_error(value: str) -> ConnectionTokenErrorError:
    if value in CONNECTION_TOKEN_ERROR_ERROR_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CONNECTION_TOKEN_ERROR_ERROR_VALUES!r}"
    )
