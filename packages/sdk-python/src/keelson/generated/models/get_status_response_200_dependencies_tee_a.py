from typing import Literal

GetStatusResponse200DependenciesTeeA = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_TEE_A_VALUES: set[GetStatusResponse200DependenciesTeeA] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_tee_a(
    value: str,
) -> GetStatusResponse200DependenciesTeeA:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_TEE_A_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_TEE_A_VALUES!r}"
    )
