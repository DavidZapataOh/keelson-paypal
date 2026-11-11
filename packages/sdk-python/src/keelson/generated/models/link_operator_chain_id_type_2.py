from typing import Literal

LinkOperatorChainIdType2 = Literal[11155111]

LINK_OPERATOR_CHAIN_ID_TYPE_2_VALUES: set[LinkOperatorChainIdType2] = {
    11155111,
}


def check_link_operator_chain_id_type_2(value: int) -> LinkOperatorChainIdType2:
    if value in LINK_OPERATOR_CHAIN_ID_TYPE_2_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {LINK_OPERATOR_CHAIN_ID_TYPE_2_VALUES!r}"
    )
