from typing import Literal

LinkOperatorCnfJwkCrv = Literal["P-256"]

LINK_OPERATOR_CNF_JWK_CRV_VALUES: set[LinkOperatorCnfJwkCrv] = {
    "P-256",
}


def check_link_operator_cnf_jwk_crv(value: str) -> LinkOperatorCnfJwkCrv:
    if value in LINK_OPERATOR_CNF_JWK_CRV_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {LINK_OPERATOR_CNF_JWK_CRV_VALUES!r}"
    )
