from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.merchant_dispute import MerchantDispute


T = TypeVar("T", bound="ListMerchantDisputesResponse200")


@_attrs_define
class ListMerchantDisputesResponse200:
    """
    Attributes:
        disputes (list[MerchantDispute]):
    """

    disputes: list[MerchantDispute]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        disputes = []
        for disputes_item_data in self.disputes:
            disputes_item = disputes_item_data.to_dict()
            disputes.append(disputes_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "disputes": disputes,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.merchant_dispute import MerchantDispute

        d = dict(src_dict)
        disputes = []
        _disputes = d.pop("disputes")
        for disputes_item_data in _disputes:
            disputes_item = MerchantDispute.from_dict(disputes_item_data)

            disputes.append(disputes_item)

        list_merchant_disputes_response_200 = cls(
            disputes=disputes,
        )

        list_merchant_disputes_response_200.additional_properties = d
        return list_merchant_disputes_response_200

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
