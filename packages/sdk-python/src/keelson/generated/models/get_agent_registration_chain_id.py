from typing import Literal

GetAgentRegistrationChainId = Literal["11155111", "42161", "421614"]

GET_AGENT_REGISTRATION_CHAIN_ID_VALUES: set[GetAgentRegistrationChainId] = {
    "11155111",
    "42161",
    "421614",
}


def check_get_agent_registration_chain_id(value: str) -> GetAgentRegistrationChainId:
    if value in GET_AGENT_REGISTRATION_CHAIN_ID_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_AGENT_REGISTRATION_CHAIN_ID_VALUES!r}"
    )
