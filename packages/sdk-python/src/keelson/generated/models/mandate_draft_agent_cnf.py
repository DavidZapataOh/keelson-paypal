from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.mandate_draft_agent_cnf_jwk import MandateDraftAgentCnfJwk


T = TypeVar("T", bound="MandateDraftAgentCnf")


@_attrs_define
class MandateDraftAgentCnf:
    """
    Attributes:
        jwk (MandateDraftAgentCnfJwk):
    """

    jwk: MandateDraftAgentCnfJwk

    def to_dict(self) -> dict[str, Any]:
        jwk = self.jwk.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "jwk": jwk,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_agent_cnf_jwk import MandateDraftAgentCnfJwk

        d = dict(src_dict)
        jwk = MandateDraftAgentCnfJwk.from_dict(d.pop("jwk"))

        mandate_draft_agent_cnf = cls(
            jwk=jwk,
        )

        return mandate_draft_agent_cnf
