from typing import Literal

LinkOperatorChainIdType0 = Literal[421614]

LINK_OPERATOR_CHAIN_ID_TYPE_0_VALUES: set[LinkOperatorChainIdType0] = {
    421614,
}


def check_link_operator_chain_id_type_0(value: int) -> LinkOperatorChainIdType0:
    if value in LINK_OPERATOR_CHAIN_ID_TYPE_0_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {LINK_OPERATOR_CHAIN_ID_TYPE_0_VALUES!r}"
    )
