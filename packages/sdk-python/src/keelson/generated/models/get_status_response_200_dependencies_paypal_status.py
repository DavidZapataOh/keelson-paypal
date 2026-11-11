from typing import Literal

GetStatusResponse200DependenciesPaypalStatus = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_PAYPAL_STATUS_VALUES: set[
    GetStatusResponse200DependenciesPaypalStatus
] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_paypal_status(
    value: str,
) -> GetStatusResponse200DependenciesPaypalStatus:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_PAYPAL_STATUS_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_PAYPAL_STATUS_VALUES!r}"
    )
