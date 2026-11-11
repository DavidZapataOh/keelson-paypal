from typing import Literal

GetStatusResponse200DependenciesTeeB = Literal["down", "up"]

GET_STATUS_RESPONSE_200_DEPENDENCIES_TEE_B_VALUES: set[GetStatusResponse200DependenciesTeeB] = {
    "down",
    "up",
}


def check_get_status_response_200_dependencies_tee_b(
    value: str,
) -> GetStatusResponse200DependenciesTeeB:
    if value in GET_STATUS_RESPONSE_200_DEPENDENCIES_TEE_B_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_STATUS_RESPONSE_200_DEPENDENCIES_TEE_B_VALUES!r}"
    )
