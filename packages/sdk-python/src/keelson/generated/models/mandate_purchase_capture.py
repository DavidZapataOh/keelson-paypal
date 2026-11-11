from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="MandatePurchaseCapture")


@_attrs_define
class MandatePurchaseCapture:
    """The PayPal capture of the countersigned amount.

    Attributes:
        id (str):
        invoice_id (str):
        status (None | str):
    """

    id: str
    invoice_id: str
    status: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        invoice_id = self.invoice_id

        status: str | None
        status = self.status

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "invoiceId": invoice_id,
                "status": status,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        invoice_id = d.pop("invoiceId")

        def _parse_status(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        status = _parse_status(d.pop("status"))

        mandate_purchase_capture = cls(
            id=id,
            invoice_id=invoice_id,
            status=status,
        )

        mandate_purchase_capture.additional_properties = d
        return mandate_purchase_capture

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
