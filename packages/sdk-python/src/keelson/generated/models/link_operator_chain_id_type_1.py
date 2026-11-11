from typing import Literal

LinkOperatorChainIdType1 = Literal[42161]

LINK_OPERATOR_CHAIN_ID_TYPE_1_VALUES: set[LinkOperatorChainIdType1] = {
    42161,
}


def check_link_operator_chain_id_type_1(value: int) -> LinkOperatorChainIdType1:
    if value in LINK_OPERATOR_CHAIN_ID_TYPE_1_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {LINK_OPERATOR_CHAIN_ID_TYPE_1_VALUES!r}"
    )
