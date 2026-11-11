from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.feedback_keelson import FeedbackKeelson


T = TypeVar("T", bound="Feedback")


@_attrs_define
class Feedback:
    """An ERC-8004 off-chain feedback file.

    Attributes:
        agent_registry (str):
        agent_id (float | str):
        client_address (str): The reporter, as a CAIP-10 account.
        created_at (str):
        value (int):
        value_decimals (int):
        tag1 (str):
        tag2 (str):
        keelson (FeedbackKeelson):
    """

    agent_registry: str
    agent_id: float | str
    client_address: str
    created_at: str
    value: int
    value_decimals: int
    tag1: str
    tag2: str
    keelson: FeedbackKeelson
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        agent_registry = self.agent_registry

        agent_id: float | str
        agent_id = self.agent_id

        client_address = self.client_address

        created_at = self.created_at

        value = self.value

        value_decimals = self.value_decimals

        tag1 = self.tag1

        tag2 = self.tag2

        keelson = self.keelson.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "agentRegistry": agent_registry,
                "agentId": agent_id,
                "clientAddress": client_address,
                "createdAt": created_at,
                "value": value,
                "valueDecimals": value_decimals,
                "tag1": tag1,
                "tag2": tag2,
                "keelson": keelson,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.feedback_keelson import FeedbackKeelson

        d = dict(src_dict)
        agent_registry = d.pop("agentRegistry")

        def _parse_agent_id(data: object) -> float | str:
            return cast(float | str, data)

        agent_id = _parse_agent_id(d.pop("agentId"))

        client_address = d.pop("clientAddress")

        created_at = d.pop("createdAt")

        value = d.pop("value")

        value_decimals = d.pop("valueDecimals")

        tag1 = d.pop("tag1")

        tag2 = d.pop("tag2")

        keelson = FeedbackKeelson.from_dict(d.pop("keelson"))

        feedback = cls(
            agent_registry=agent_registry,
            agent_id=agent_id,
            client_address=client_address,
            created_at=created_at,
            value=value,
            value_decimals=value_decimals,
            tag1=tag1,
            tag2=tag2,
            keelson=keelson,
        )

        feedback.additional_properties = d
        return feedback

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
