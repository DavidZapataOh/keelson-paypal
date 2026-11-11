from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_agent_cnf_jwk_crv import (
    MandateDraftAgentCnfJwkCrv,
    check_mandate_draft_agent_cnf_jwk_crv,
)
from ..models.mandate_draft_agent_cnf_jwk_kty import (
    MandateDraftAgentCnfJwkKty,
    check_mandate_draft_agent_cnf_jwk_kty,
)

T = TypeVar("T", bound="MandateDraftAgentCnfJwk")


@_attrs_define
class MandateDraftAgentCnfJwk:
    """
    Attributes:
        kty (MandateDraftAgentCnfJwkKty):
        crv (MandateDraftAgentCnfJwkCrv):
        x (str):
        y (str):
        kid (str):
    """

    kty: MandateDraftAgentCnfJwkKty
    crv: MandateDraftAgentCnfJwkCrv
    x: str
    y: str
    kid: str

    def to_dict(self) -> dict[str, Any]:
        kty: str = self.kty

        crv: str = self.crv

        x = self.x

        y = self.y

        kid = self.kid

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "kty": kty,
                "crv": crv,
                "x": x,
                "y": y,
                "kid": kid,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        kty = check_mandate_draft_agent_cnf_jwk_kty(d.pop("kty"))

        crv = check_mandate_draft_agent_cnf_jwk_crv(d.pop("crv"))

        x = d.pop("x")

        y = d.pop("y")

        kid = d.pop("kid")

        mandate_draft_agent_cnf_jwk = cls(
            kty=kty,
            crv=crv,
            x=x,
            y=y,
            kid=kid,
        )

        return mandate_draft_agent_cnf_jwk
