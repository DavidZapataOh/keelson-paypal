from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.merchant_order_blocked_item import MerchantOrderBlockedItem
    from ..models.merchant_order_dispute import MerchantOrderDispute


T = TypeVar("T", bound="MerchantOrder")


@_attrs_define
class MerchantOrder:
    """
    Attributes:
        purchase_id (str): Also the id of the purchase's Alibi.
        created_at (datetime.datetime):
        state (str): `DENIED` when Keelson blocked the cart.
        amount_minor (str):
        currency (str):
        agent_id (str): The ERC-8004 agent that made the purchase.
        has_alibi (bool):
        blocked (list[MerchantOrderBlockedItem]): For a blocked cart, each mandate field whose check failed and what the
            cart had. The mandate's own bound stays with the buyer.
        dispute (MerchantOrderDispute | None):
    """

    purchase_id: str
    created_at: datetime.datetime
    state: str
    amount_minor: str
    currency: str
    agent_id: str
    has_alibi: bool
    blocked: list[MerchantOrderBlockedItem]
    dispute: MerchantOrderDispute | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.merchant_order_dispute import MerchantOrderDispute

        purchase_id = self.purchase_id

        created_at = self.created_at.isoformat()

        state = self.state

        amount_minor = self.amount_minor

        currency = self.currency

        agent_id = self.agent_id

        has_alibi = self.has_alibi

        blocked = []
        for blocked_item_data in self.blocked:
            blocked_item = blocked_item_data.to_dict()
            blocked.append(blocked_item)

        dispute: dict[str, Any] | None
        if isinstance(self.dispute, MerchantOrderDispute):
            dispute = self.dispute.to_dict()
        else:
            dispute = self.dispute

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "purchase_id": purchase_id,
                "created_at": created_at,
                "state": state,
                "amount_minor": amount_minor,
                "currency": currency,
                "agent_id": agent_id,
                "has_alibi": has_alibi,
                "blocked": blocked,
                "dispute": dispute,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.merchant_order_blocked_item import MerchantOrderBlockedItem
        from ..models.merchant_order_dispute import MerchantOrderDispute

        d = dict(src_dict)
        purchase_id = d.pop("purchase_id")

        created_at = datetime.datetime.fromisoformat(d.pop("created_at"))

        state = d.pop("state")

        amount_minor = d.pop("amount_minor")

        currency = d.pop("currency")

        agent_id = d.pop("agent_id")

        has_alibi = d.pop("has_alibi")

        blocked = []
        _blocked = d.pop("blocked")
        for blocked_item_data in _blocked:
            blocked_item = MerchantOrderBlockedItem.from_dict(blocked_item_data)

            blocked.append(blocked_item)

        def _parse_dispute(data: object) -> MerchantOrderDispute | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                dispute_type_0 = MerchantOrderDispute.from_dict(data)

                return dispute_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MerchantOrderDispute | None, data)

        dispute = _parse_dispute(d.pop("dispute"))

        merchant_order = cls(
            purchase_id=purchase_id,
            created_at=created_at,
            state=state,
            amount_minor=amount_minor,
            currency=currency,
            agent_id=agent_id,
            has_alibi=has_alibi,
            blocked=blocked,
            dispute=dispute,
        )

        merchant_order.additional_properties = d
        return merchant_order

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
