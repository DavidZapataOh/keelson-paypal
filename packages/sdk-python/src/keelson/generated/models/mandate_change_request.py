from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.mandate_change_request_limits import MandateChangeRequestLimits


T = TypeVar("T", bound="MandateChangeRequest")


@_attrs_define
class MandateChangeRequest:
    """
    Attributes:
        note (str): Why the agent needs more room, in one line the user reads verbatim, e.g. 'Needs $40 more for
            shipping'.
        limits (MandateChangeRequestLimits | Unset): The limits asked for; the mandate's own where left out.
    """

    note: str
    limits: MandateChangeRequestLimits | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        note = self.note

        limits: dict[str, Any] | Unset = UNSET
        if not isinstance(self.limits, Unset):
            limits = self.limits.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "note": note,
            }
        )
        if limits is not UNSET:
            field_dict["limits"] = limits

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_change_request_limits import MandateChangeRequestLimits

        d = dict(src_dict)
        note = d.pop("note")

        _limits = d.pop("limits", UNSET)
        limits: MandateChangeRequestLimits | Unset
        if isinstance(_limits, Unset):
            limits = UNSET
        else:
            limits = MandateChangeRequestLimits.from_dict(_limits)

        mandate_change_request = cls(
            note=note,
            limits=limits,
        )

        mandate_change_request.additional_properties = d
        return mandate_change_request

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
