from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.activity_row_tone import ActivityRowTone, check_activity_row_tone

T = TypeVar("T", bound="ActivityRow")


@_attrs_define
class ActivityRow:
    """
    Attributes:
        id (str):
        at (str):
        tone (ActivityRowTone):
        line (str):  Example: Claude Code bought $94.00 at RunFast..
        agent_id (None | str):
        purchase_id (None | str):
        mandate_id (None | str):
        href (None | str):
        alibi_url (None | str):
        log_index (None | str):
    """

    id: str
    at: str
    tone: ActivityRowTone
    line: str
    agent_id: str | None
    purchase_id: str | None
    mandate_id: str | None
    href: str | None
    alibi_url: str | None
    log_index: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        at = self.at

        tone: str = self.tone

        line = self.line

        agent_id: str | None
        agent_id = self.agent_id

        purchase_id: str | None
        purchase_id = self.purchase_id

        mandate_id: str | None
        mandate_id = self.mandate_id

        href: str | None
        href = self.href

        alibi_url: str | None
        alibi_url = self.alibi_url

        log_index: str | None
        log_index = self.log_index

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "at": at,
                "tone": tone,
                "line": line,
                "agentId": agent_id,
                "purchaseId": purchase_id,
                "mandateId": mandate_id,
                "href": href,
                "alibiUrl": alibi_url,
                "logIndex": log_index,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        at = d.pop("at")

        tone = check_activity_row_tone(d.pop("tone"))

        line = d.pop("line")

        def _parse_agent_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        agent_id = _parse_agent_id(d.pop("agentId"))

        def _parse_purchase_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        purchase_id = _parse_purchase_id(d.pop("purchaseId"))

        def _parse_mandate_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        mandate_id = _parse_mandate_id(d.pop("mandateId"))

        def _parse_href(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        href = _parse_href(d.pop("href"))

        def _parse_alibi_url(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        alibi_url = _parse_alibi_url(d.pop("alibiUrl"))

        def _parse_log_index(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        log_index = _parse_log_index(d.pop("logIndex"))

        activity_row = cls(
            id=id,
            at=at,
            tone=tone,
            line=line,
            agent_id=agent_id,
            purchase_id=purchase_id,
            mandate_id=mandate_id,
            href=href,
            alibi_url=alibi_url,
            log_index=log_index,
        )

        activity_row.additional_properties = d
        return activity_row

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
