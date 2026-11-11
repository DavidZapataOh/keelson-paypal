from typing import Literal

GetAgentBondChainId = Literal["11155111", "42161", "421614"]

GET_AGENT_BOND_CHAIN_ID_VALUES: set[GetAgentBondChainId] = {
    "11155111",
    "42161",
    "421614",
}


def check_get_agent_bond_chain_id(value: str) -> GetAgentBondChainId:
    if value in GET_AGENT_BOND_CHAIN_ID_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {GET_AGENT_BOND_CHAIN_ID_VALUES!r}"
    )
