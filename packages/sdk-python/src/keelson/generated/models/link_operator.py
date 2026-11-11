from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.link_operator_chain_id_type_0 import (
    LinkOperatorChainIdType0,
    check_link_operator_chain_id_type_0,
)
from ..models.link_operator_chain_id_type_1 import (
    LinkOperatorChainIdType1,
    check_link_operator_chain_id_type_1,
)
from ..models.link_operator_chain_id_type_2 import (
    LinkOperatorChainIdType2,
    check_link_operator_chain_id_type_2,
)

if TYPE_CHECKING:
    from ..models.link_operator_cnf_jwk import LinkOperatorCnfJwk


T = TypeVar("T", bound="LinkOperator")


@_attrs_define
class LinkOperator:
    """
    Attributes:
        chain_id (LinkOperatorChainIdType0 | LinkOperatorChainIdType1 | LinkOperatorChainIdType2):
        agent_id (str): The ERC-8004 agent id, a decimal integer.
        name (str):
        cnf_jwk (LinkOperatorCnfJwk): The agent's P-256 `cnf` key, a public JWK.
        deadline (int): Unix seconds, at most 15 minutes ahead.
        signature (str): The EIP-712 `OperatorLink(uint256 agentId,bytes32 cnfThumbprint,uint256 deadline)` signature
            under the domain `{ name: "Keelson", version: "1", chainId }`, by the agent's owner or `agentWallet` (EOA,
            ERC-1271 or ERC-6492). `cnfThumbprint` is the RFC 7638 SHA-256 thumbprint of `cnfJwk`.
    """

    chain_id: LinkOperatorChainIdType0 | LinkOperatorChainIdType1 | LinkOperatorChainIdType2
    agent_id: str
    name: str
    cnf_jwk: LinkOperatorCnfJwk
    deadline: int
    signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chain_id: int
        if isinstance(self.chain_id, int) or isinstance(self.chain_id, int):
            chain_id = self.chain_id
        else:
            chain_id = self.chain_id

        agent_id = self.agent_id

        name = self.name

        cnf_jwk = self.cnf_jwk.to_dict()

        deadline = self.deadline

        signature = self.signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chainId": chain_id,
                "agentId": agent_id,
                "name": name,
                "cnfJwk": cnf_jwk,
                "deadline": deadline,
                "signature": signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.link_operator_cnf_jwk import LinkOperatorCnfJwk

        d = dict(src_dict)

        def _parse_chain_id(
            data: object,
        ) -> LinkOperatorChainIdType0 | LinkOperatorChainIdType1 | LinkOperatorChainIdType2:
            try:
                if not isinstance(data, int):
                    raise TypeError()
                chain_id_type_0 = check_link_operator_chain_id_type_0(data)

                return chain_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, int):
                    raise TypeError()
                chain_id_type_1 = check_link_operator_chain_id_type_1(data)

                return chain_id_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            if not isinstance(data, int):
                raise TypeError()
            chain_id_type_2 = check_link_operator_chain_id_type_2(data)

            return chain_id_type_2

        chain_id = _parse_chain_id(d.pop("chainId"))

        agent_id = d.pop("agentId")

        name = d.pop("name")

        cnf_jwk = LinkOperatorCnfJwk.from_dict(d.pop("cnfJwk"))

        deadline = d.pop("deadline")

        signature = d.pop("signature")

        link_operator = cls(
            chain_id=chain_id,
            agent_id=agent_id,
            name=name,
            cnf_jwk=cnf_jwk,
            deadline=deadline,
            signature=signature,
        )

        link_operator.additional_properties = d
        return link_operator

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
