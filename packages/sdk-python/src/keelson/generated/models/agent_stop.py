from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.agent_stop_log_indexes import AgentStopLogIndexes
    from ..models.agent_stop_released_item import AgentStopReleasedItem
    from ..models.agent_stop_releasing_item import AgentStopReleasingItem


T = TypeVar("T", bound="AgentStop")


@_attrs_define
class AgentStop:
    """
    Attributes:
        id (str):
        revoked (int): Mandates ended.
        released (list[AgentStopReleasedItem]): What PayPal held for them, per currency, now released.
        mandate_hashes (list[str]): Hex of the stopped mandates' hashes. The stop leaf commits to their digest: no Alibi
            leaf after it may carry one.
        releasing (list[AgentStopReleasingItem]): Holds backing purchases already countersigned: released once those are
            captured.
        log_indexes (AgentStopLogIndexes): The stop leaf's index in each Alibi log origin. It is appended once no
            purchase of the stopped mandates can still be logged, so no Alibi leaf after it carries one of their hashes.
        logged (bool):
        created_at (str):
    """

    id: str
    revoked: int
    released: list[AgentStopReleasedItem]
    mandate_hashes: list[str]
    releasing: list[AgentStopReleasingItem]
    log_indexes: AgentStopLogIndexes
    logged: bool
    created_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        revoked = self.revoked

        released = []
        for released_item_data in self.released:
            released_item = released_item_data.to_dict()
            released.append(released_item)

        mandate_hashes = self.mandate_hashes

        releasing = []
        for releasing_item_data in self.releasing:
            releasing_item = releasing_item_data.to_dict()
            releasing.append(releasing_item)

        log_indexes = self.log_indexes.to_dict()

        logged = self.logged

        created_at = self.created_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "revoked": revoked,
                "released": released,
                "mandateHashes": mandate_hashes,
                "releasing": releasing,
                "logIndexes": log_indexes,
                "logged": logged,
                "createdAt": created_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.agent_stop_log_indexes import AgentStopLogIndexes
        from ..models.agent_stop_released_item import AgentStopReleasedItem
        from ..models.agent_stop_releasing_item import AgentStopReleasingItem

        d = dict(src_dict)
        id = d.pop("id")

        revoked = d.pop("revoked")

        released = []
        _released = d.pop("released")
        for released_item_data in _released:
            released_item = AgentStopReleasedItem.from_dict(released_item_data)

            released.append(released_item)

        mandate_hashes = cast(list[str], d.pop("mandateHashes"))

        releasing = []
        _releasing = d.pop("releasing")
        for releasing_item_data in _releasing:
            releasing_item = AgentStopReleasingItem.from_dict(releasing_item_data)

            releasing.append(releasing_item)

        log_indexes = AgentStopLogIndexes.from_dict(d.pop("logIndexes"))

        logged = d.pop("logged")

        created_at = d.pop("createdAt")

        agent_stop = cls(
            id=id,
            revoked=revoked,
            released=released,
            mandate_hashes=mandate_hashes,
            releasing=releasing,
            log_indexes=log_indexes,
            logged=logged,
            created_at=created_at,
        )

        agent_stop.additional_properties = d
        return agent_stop

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
