from typing import Literal

GetStatusResponse200DependenciesPaypalEnvironment = Literal["production", "sandbox"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_PAYPAL_ENVIRONMENT_VALUES: set[
    GetStatusResponse200DependenciesPaypalEnvironment
] = {
    "production",
    "sandbox",
}


def check_get_status_response_200_dependencies_paypal_environment(
    value: str,
) -> GetStatusResponse200DependenciesPaypalEnvironment:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_PAYPAL_ENVIRONMENT_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_PAYPAL_ENVIRONMENT_VALUES!r}"
    )
