from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.mandate_draft_agent_bond import MandateDraftAgentBond
    from ..models.mandate_draft_agent_cnf import MandateDraftAgentCnf
    from ..models.mandate_draft_agent_operator import MandateDraftAgentOperator


T = TypeVar("T", bound="MandateDraftAgent")


@_attrs_define
class MandateDraftAgent:
    """
    Attributes:
        operator (MandateDraftAgentOperator):
        cnf (MandateDraftAgentCnf):
        bond (MandateDraftAgentBond):
    """

    operator: MandateDraftAgentOperator
    cnf: MandateDraftAgentCnf
    bond: MandateDraftAgentBond

    def to_dict(self) -> dict[str, Any]:
        operator = self.operator.to_dict()

        cnf = self.cnf.to_dict()

        bond = self.bond.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "operator": operator,
                "cnf": cnf,
                "bond": bond,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_agent_bond import MandateDraftAgentBond
        from ..models.mandate_draft_agent_cnf import MandateDraftAgentCnf
        from ..models.mandate_draft_agent_operator import MandateDraftAgentOperator

        d = dict(src_dict)
        operator = MandateDraftAgentOperator.from_dict(d.pop("operator"))

        cnf = MandateDraftAgentCnf.from_dict(d.pop("cnf"))

        bond = MandateDraftAgentBond.from_dict(d.pop("bond"))

        mandate_draft_agent = cls(
            operator=operator,
            cnf=cnf,
            bond=bond,
        )

        return mandate_draft_agent
