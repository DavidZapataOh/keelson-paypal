from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.alibi_report_checks_item_status import (
    AlibiReportChecksItemStatus,
    check_alibi_report_checks_item_status,
)
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.alibi_report_checks_item_detail import AlibiReportChecksItemDetail


T = TypeVar("T", bound="AlibiReportChecksItem")


@_attrs_define
class AlibiReportChecksItem:
    """
    Attributes:
        id (str):
        step (int):
        status (AlibiReportChecksItemStatus):
        reads (list[str]): RFC 6901 pointers the check read.
        ms (float):
        reason (str | Unset):
        detail (AlibiReportChecksItemDetail | Unset):
    """

    id: str
    step: int
    status: AlibiReportChecksItemStatus
    reads: list[str]
    ms: float
    reason: str | Unset = UNSET
    detail: AlibiReportChecksItemDetail | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        step = self.step

        status: str = self.status

        reads = self.reads

        ms = self.ms

        reason = self.reason

        detail: dict[str, Any] | Unset = UNSET
        if not isinstance(self.detail, Unset):
            detail = self.detail.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "step": step,
                "status": status,
                "reads": reads,
                "ms": ms,
            }
        )
        if reason is not UNSET:
            field_dict["reason"] = reason
        if detail is not UNSET:
            field_dict["detail"] = detail

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.alibi_report_checks_item_detail import AlibiReportChecksItemDetail

        d = dict(src_dict)
        id = d.pop("id")

        step = d.pop("step")

        status = check_alibi_report_checks_item_status(d.pop("status"))

        reads = cast(list[str], d.pop("reads"))

        ms = d.pop("ms")

        reason = d.pop("reason", UNSET)

        _detail = d.pop("detail", UNSET)
        detail: AlibiReportChecksItemDetail | Unset
        if isinstance(_detail, Unset):
            detail = UNSET
        else:
            detail = AlibiReportChecksItemDetail.from_dict(_detail)

        alibi_report_checks_item = cls(
            id=id,
            step=step,
            status=status,
            reads=reads,
            ms=ms,
            reason=reason,
            detail=detail,
        )

        alibi_report_checks_item.additional_properties = d
        return alibi_report_checks_item

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
