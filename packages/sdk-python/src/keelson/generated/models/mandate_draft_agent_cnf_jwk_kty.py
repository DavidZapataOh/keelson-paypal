from typing import Literal

MandateDraftAgentCnfJwkKty = Literal["EC"]

MANDATE_DRAFT_AGENT_CNF_JWK_KTY_VALUES: set[MandateDraftAgentCnfJwkKty] = {
    "EC",
}


def check_mandate_draft_agent_cnf_jwk_kty(value: str) -> MandateDraftAgentCnfJwkKty:
    if value in MANDATE_DRAFT_AGENT_CNF_JWK_KTY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {MANDATE_DRAFT_AGENT_CNF_JWK_KTY_VALUES!r}"
    )
