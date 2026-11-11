from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.cart_check_blockers_item import CartCheckBlockersItem
    from ..models.cart_check_checks_item import CartCheckChecksItem


T = TypeVar("T", bound="CartCheck")


@_attrs_define
class CartCheck:
    """
    Attributes:
        can_attempt (bool): Whether a countersign of this cart would pass the mandate as it stands now.
        needs_approval (bool): The cart passes, and is above the user's ask-me amount: the countersign pauses it for
            their one-time approval.
        blockers (list[CartCheckBlockersItem]):
        checks (list[CartCheckChecksItem]):
    """

    can_attempt: bool
    needs_approval: bool
    blockers: list[CartCheckBlockersItem]
    checks: list[CartCheckChecksItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        can_attempt = self.can_attempt

        needs_approval = self.needs_approval

        blockers = []
        for blockers_item_data in self.blockers:
            blockers_item = blockers_item_data.to_dict()
            blockers.append(blockers_item)

        checks = []
        for checks_item_data in self.checks:
            checks_item = checks_item_data.to_dict()
            checks.append(checks_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "canAttempt": can_attempt,
                "needsApproval": needs_approval,
                "blockers": blockers,
                "checks": checks,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.cart_check_blockers_item import CartCheckBlockersItem
        from ..models.cart_check_checks_item import CartCheckChecksItem

        d = dict(src_dict)
        can_attempt = d.pop("canAttempt")

        needs_approval = d.pop("needsApproval")

        blockers = []
        _blockers = d.pop("blockers")
        for blockers_item_data in _blockers:
            blockers_item = CartCheckBlockersItem.from_dict(blockers_item_data)

            blockers.append(blockers_item)

        checks = []
        _checks = d.pop("checks")
        for checks_item_data in _checks:
            checks_item = CartCheckChecksItem.from_dict(checks_item_data)

            checks.append(checks_item)

        cart_check = cls(
            can_attempt=can_attempt,
            needs_approval=needs_approval,
            blockers=blockers,
            checks=checks,
        )

        cart_check.additional_properties = d
        return cart_check

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
