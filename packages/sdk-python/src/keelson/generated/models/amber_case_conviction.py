from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.amber_case_conviction_field import (
    AmberCaseConvictionField,
    check_amber_case_conviction_field,
)

if TYPE_CHECKING:
    from ..models.amber_case_conviction_proof import AmberCaseConvictionProof


T = TypeVar("T", bound="AmberCaseConviction")


@_attrs_define
class AmberCaseConviction:
    """
    Attributes:
        field (AmberCaseConvictionField):
        attested_value (None | str): What the operator attested of the field, which the store's answer contradicts. Null
            on the public dispute read.
        proven_at (datetime.datetime):
        web_fact_digest (str): The EIP-712 digest of the `WebFact` leg A signed over the store's answer.
        captured_at (datetime.datetime | None):
        tx_hash (str):
        explorer_url (str):
        proof (AmberCaseConvictionProof | None):
    """

    field: AmberCaseConvictionField
    attested_value: str | None
    proven_at: datetime.datetime
    web_fact_digest: str
    captured_at: datetime.datetime | None
    tx_hash: str
    explorer_url: str
    proof: AmberCaseConvictionProof | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.amber_case_conviction_proof import AmberCaseConvictionProof

        field: str = self.field

        attested_value: str | None
        attested_value = self.attested_value

        proven_at = self.proven_at.isoformat()

        web_fact_digest = self.web_fact_digest

        captured_at: str | None
        if isinstance(self.captured_at, datetime.datetime):
            captured_at = self.captured_at.isoformat()
        else:
            captured_at = self.captured_at

        tx_hash = self.tx_hash

        explorer_url = self.explorer_url

        proof: dict[str, Any] | None
        if isinstance(self.proof, AmberCaseConvictionProof):
            proof = self.proof.to_dict()
        else:
            proof = self.proof

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "field": field,
                "attested_value": attested_value,
                "proven_at": proven_at,
                "web_fact_digest": web_fact_digest,
                "captured_at": captured_at,
                "tx_hash": tx_hash,
                "explorer_url": explorer_url,
                "proof": proof,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.amber_case_conviction_proof import AmberCaseConvictionProof

        d = dict(src_dict)
        field = check_amber_case_conviction_field(d.pop("field"))

        def _parse_attested_value(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        attested_value = _parse_attested_value(d.pop("attested_value"))

        proven_at = datetime.datetime.fromisoformat(d.pop("proven_at"))

        web_fact_digest = d.pop("web_fact_digest")

        def _parse_captured_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                captured_at_type_0 = datetime.datetime.fromisoformat(data)

                return captured_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        captured_at = _parse_captured_at(d.pop("captured_at"))

        tx_hash = d.pop("tx_hash")

        explorer_url = d.pop("explorer_url")

        def _parse_proof(data: object) -> AmberCaseConvictionProof | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                proof_type_0 = AmberCaseConvictionProof.from_dict(data)

                return proof_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(AmberCaseConvictionProof | None, data)

        proof = _parse_proof(d.pop("proof"))

        amber_case_conviction = cls(
            field=field,
            attested_value=attested_value,
            proven_at=proven_at,
            web_fact_digest=web_fact_digest,
            captured_at=captured_at,
            tx_hash=tx_hash,
            explorer_url=explorer_url,
            proof=proof,
        )

        amber_case_conviction.additional_properties = d
        return amber_case_conviction

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
