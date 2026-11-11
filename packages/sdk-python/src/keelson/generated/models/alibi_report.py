from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.alibi_report_mode import AlibiReportMode, check_alibi_report_mode
from ..models.alibi_report_verdict import AlibiReportVerdict, check_alibi_report_verdict
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.alibi_report_checks_item import AlibiReportChecksItem
    from ..models.alibi_report_fields_item import AlibiReportFieldsItem
    from ..models.alibi_report_rpc import AlibiReportRpc
    from ..models.alibi_report_unbound_item import AlibiReportUnboundItem


T = TypeVar("T", bound="AlibiReport")


@_attrs_define
class AlibiReport:
    """
    Attributes:
        reference (str):
        verdict (AlibiReportVerdict):
        checks (list[AlibiReportChecksItem]):
        mode (AlibiReportMode):
        fields (list[AlibiReportFieldsItem]):
        unbound (list[AlibiReportUnboundItem]):
        changed (list[str]):
        ms (float):
        rpc (AlibiReportRpc | Unset):
    """

    reference: str
    verdict: AlibiReportVerdict
    checks: list[AlibiReportChecksItem]
    mode: AlibiReportMode
    fields: list[AlibiReportFieldsItem]
    unbound: list[AlibiReportUnboundItem]
    changed: list[str]
    ms: float
    rpc: AlibiReportRpc | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        reference = self.reference

        verdict: str = self.verdict

        checks = []
        for checks_item_data in self.checks:
            checks_item = checks_item_data.to_dict()
            checks.append(checks_item)

        mode: str = self.mode

        fields = []
        for fields_item_data in self.fields:
            fields_item = fields_item_data.to_dict()
            fields.append(fields_item)

        unbound = []
        for unbound_item_data in self.unbound:
            unbound_item = unbound_item_data.to_dict()
            unbound.append(unbound_item)

        changed = self.changed

        ms = self.ms

        rpc: dict[str, Any] | Unset = UNSET
        if not isinstance(self.rpc, Unset):
            rpc = self.rpc.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "reference": reference,
                "verdict": verdict,
                "checks": checks,
                "mode": mode,
                "fields": fields,
                "unbound": unbound,
                "changed": changed,
                "ms": ms,
            }
        )
        if rpc is not UNSET:
            field_dict["rpc"] = rpc

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.alibi_report_checks_item import AlibiReportChecksItem
        from ..models.alibi_report_fields_item import AlibiReportFieldsItem
        from ..models.alibi_report_rpc import AlibiReportRpc
        from ..models.alibi_report_unbound_item import AlibiReportUnboundItem

        d = dict(src_dict)
        reference = d.pop("reference")

        verdict = check_alibi_report_verdict(d.pop("verdict"))

        checks = []
        _checks = d.pop("checks")
        for checks_item_data in _checks:
            checks_item = AlibiReportChecksItem.from_dict(checks_item_data)

            checks.append(checks_item)

        mode = check_alibi_report_mode(d.pop("mode"))

        fields = []
        _fields = d.pop("fields")
        for fields_item_data in _fields:
            fields_item = AlibiReportFieldsItem.from_dict(fields_item_data)

            fields.append(fields_item)

        unbound = []
        _unbound = d.pop("unbound")
        for unbound_item_data in _unbound:
            unbound_item = AlibiReportUnboundItem.from_dict(unbound_item_data)

            unbound.append(unbound_item)

        changed = cast(list[str], d.pop("changed"))

        ms = d.pop("ms")

        _rpc = d.pop("rpc", UNSET)
        rpc: AlibiReportRpc | Unset
        if isinstance(_rpc, Unset):
            rpc = UNSET
        else:
            rpc = AlibiReportRpc.from_dict(_rpc)

        alibi_report = cls(
            reference=reference,
            verdict=verdict,
            checks=checks,
            mode=mode,
            fields=fields,
            unbound=unbound,
            changed=changed,
            ms=ms,
            rpc=rpc,
        )

        alibi_report.additional_properties = d
        return alibi_report

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
