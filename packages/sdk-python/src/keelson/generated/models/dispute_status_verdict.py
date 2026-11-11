from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.dispute_status_verdict_facts import DisputeStatusVerdictFacts
    from ..models.dispute_status_verdict_message import DisputeStatusVerdictMessage
    from ..models.dispute_status_verdict_signatures_item import DisputeStatusVerdictSignaturesItem


T = TypeVar("T", bound="DisputeStatusVerdict")


@_attrs_define
class DisputeStatusVerdict:
    """
    Attributes:
        rule (str):  Example: R61.
        digest (str):
        chain_id (int):
        message (DisputeStatusVerdictMessage):
        signatures (list[DisputeStatusVerdictSignaturesItem]):
        facts (DisputeStatusVerdictFacts):
    """

    rule: str
    digest: str
    chain_id: int
    message: DisputeStatusVerdictMessage
    signatures: list[DisputeStatusVerdictSignaturesItem]
    facts: DisputeStatusVerdictFacts
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        rule = self.rule

        digest = self.digest

        chain_id = self.chain_id

        message = self.message.to_dict()

        signatures = []
        for signatures_item_data in self.signatures:
            signatures_item = signatures_item_data.to_dict()
            signatures.append(signatures_item)

        facts = self.facts.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "rule": rule,
                "digest": digest,
                "chain_id": chain_id,
                "message": message,
                "signatures": signatures,
                "facts": facts,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.dispute_status_verdict_facts import DisputeStatusVerdictFacts
        from ..models.dispute_status_verdict_message import DisputeStatusVerdictMessage
        from ..models.dispute_status_verdict_signatures_item import (
            DisputeStatusVerdictSignaturesItem,
        )

        d = dict(src_dict)
        rule = d.pop("rule")

        digest = d.pop("digest")

        chain_id = d.pop("chain_id")

        message = DisputeStatusVerdictMessage.from_dict(d.pop("message"))

        signatures = []
        _signatures = d.pop("signatures")
        for signatures_item_data in _signatures:
            signatures_item = DisputeStatusVerdictSignaturesItem.from_dict(signatures_item_data)

            signatures.append(signatures_item)

        facts = DisputeStatusVerdictFacts.from_dict(d.pop("facts"))

        dispute_status_verdict = cls(
            rule=rule,
            digest=digest,
            chain_id=chain_id,
            message=message,
            signatures=signatures,
            facts=facts,
        )

        dispute_status_verdict.additional_properties = d
        return dispute_status_verdict

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
