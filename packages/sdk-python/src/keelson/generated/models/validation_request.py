from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.validation_request_countersign import ValidationRequestCountersign


T = TypeVar("T", bound="ValidationRequest")


@_attrs_define
class ValidationRequest:
    """The data of an ERC-8004 validation request Keelson records for a countersign.

    Attributes:
        payload (str): `0x1901 ‖ domainSeparator ‖ hashStruct(Countersign)`; its keccak256 is the request hash.
        countersign (ValidationRequestCountersign): The EIP-712 `Countersign` message, as decimal strings.
        alibi (str | Unset): The purchase's Alibi, once logged.
    """

    payload: str
    countersign: ValidationRequestCountersign
    alibi: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = self.payload

        countersign = self.countersign.to_dict()

        alibi = self.alibi

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "payload": payload,
                "countersign": countersign,
            }
        )
        if alibi is not UNSET:
            field_dict["alibi"] = alibi

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.validation_request_countersign import ValidationRequestCountersign

        d = dict(src_dict)
        payload = d.pop("payload")

        countersign = ValidationRequestCountersign.from_dict(d.pop("countersign"))

        alibi = d.pop("alibi", UNSET)

        validation_request = cls(
            payload=payload,
            countersign=countersign,
            alibi=alibi,
        )

        validation_request.additional_properties = d
        return validation_request

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
