from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="SentEmail")


@_attrs_define
class SentEmail:
    """
    Attributes:
        id (str):
        address (str):
        event (str):
        subject (str):
        subject_id (None | str):
        log_index (None | str):
        alibi_url (None | str):
        sent_at (None | str):
        error (None | str):
        created_at (str):
    """

    id: str
    address: str
    event: str
    subject: str
    subject_id: str | None
    log_index: str | None
    alibi_url: str | None
    sent_at: str | None
    error: str | None
    created_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        address = self.address

        event = self.event

        subject = self.subject

        subject_id: str | None
        subject_id = self.subject_id

        log_index: str | None
        log_index = self.log_index

        alibi_url: str | None
        alibi_url = self.alibi_url

        sent_at: str | None
        sent_at = self.sent_at

        error: str | None
        error = self.error

        created_at = self.created_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "address": address,
                "event": event,
                "subject": subject,
                "subjectId": subject_id,
                "logIndex": log_index,
                "alibiUrl": alibi_url,
                "sentAt": sent_at,
                "error": error,
                "createdAt": created_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        address = d.pop("address")

        event = d.pop("event")

        subject = d.pop("subject")

        def _parse_subject_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        subject_id = _parse_subject_id(d.pop("subjectId"))

        def _parse_log_index(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        log_index = _parse_log_index(d.pop("logIndex"))

        def _parse_alibi_url(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        alibi_url = _parse_alibi_url(d.pop("alibiUrl"))

        def _parse_sent_at(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        sent_at = _parse_sent_at(d.pop("sentAt"))

        def _parse_error(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        error = _parse_error(d.pop("error"))

        created_at = d.pop("createdAt")

        sent_email = cls(
            id=id,
            address=address,
            event=event,
            subject=subject,
            subject_id=subject_id,
            log_index=log_index,
            alibi_url=alibi_url,
            sent_at=sent_at,
            error=error,
            created_at=created_at,
        )

        sent_email.additional_properties = d
        return sent_email

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
