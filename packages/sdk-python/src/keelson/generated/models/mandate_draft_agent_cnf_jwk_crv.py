from typing import Literal

MandateDraftAgentCnfJwkCrv = Literal["P-256"]

MANDATE_DRAFT_AGENT_CNF_JWK_CRV_VALUES: set[MandateDraftAgentCnfJwkCrv] = {
    "P-256",
}


def check_mandate_draft_agent_cnf_jwk_crv(value: str) -> MandateDraftAgentCnfJwkCrv:
    if value in MANDATE_DRAFT_AGENT_CNF_JWK_CRV_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_AGENT_CNF_JWK_CRV_VALUES!r}"
    )
