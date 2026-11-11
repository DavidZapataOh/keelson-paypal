from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="ListRedTeamCampaignsResponse200CampaignsItem")


@_attrs_define
class ListRedTeamCampaignsResponse200CampaignsItem:
    """
    Attributes:
        id (str):
        started_at (str):
        finished_at (None | str):
        attacks (int):
    """

    id: str
    started_at: str
    finished_at: str | None
    attacks: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        started_at = self.started_at

        finished_at: str | None
        finished_at = self.finished_at

        attacks = self.attacks

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "startedAt": started_at,
                "finishedAt": finished_at,
                "attacks": attacks,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        started_at = d.pop("startedAt")

        def _parse_finished_at(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        finished_at = _parse_finished_at(d.pop("finishedAt"))

        attacks = d.pop("attacks")

        list_red_team_campaigns_response_200_campaigns_item = cls(
            id=id,
            started_at=started_at,
            finished_at=finished_at,
            attacks=attacks,
        )

        list_red_team_campaigns_response_200_campaigns_item.additional_properties = d
        return list_red_team_campaigns_response_200_campaigns_item

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
