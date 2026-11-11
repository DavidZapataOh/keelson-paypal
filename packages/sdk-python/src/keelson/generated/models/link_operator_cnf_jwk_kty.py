from typing import Literal

LinkOperatorCnfJwkKty = Literal["EC"]

LINK_OPERATOR_CNF_JWK_KTY_VALUES: set[LinkOperatorCnfJwkKty] = {
    "EC",
}


def check_link_operator_cnf_jwk_kty(value: str) -> LinkOperatorCnfJwkKty:
    if value in LINK_OPERATOR_CNF_JWK_KTY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {LINK_OPERATOR_CNF_JWK_KTY_VALUES!r}"
    )
