from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.live_purchase_decision import LivePurchaseDecision, check_live_purchase_decision
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.live_purchase_amount import LivePurchaseAmount
    from ..models.live_purchase_card import LivePurchaseCard


T = TypeVar("T", bound="LivePurchase")


@_attrs_define
class LivePurchase:
    """
    Attributes:
        id (str): The purchase and its Alibi's id.
        store (None | str): The store's origin; `null` for a card purchase, named by the card network.
        merchant (str):
        amount (LivePurchaseAmount):
        decision (LivePurchaseDecision):
        transaction_id (None | str): The PayPal transaction the store was paid by; `null` for a DENY.
        blocked (list[str]): For a DENY, the mandate fields whose check failed, or leg A's reason when it denied on its
            read of the PayPal hold.
        log_index (str):
        created_at (str):
        card (LivePurchaseCard | Unset): A card purchase: the merchant as the card network named it, and how many of the
            card's authorizations both legs approved and declined.
    """

    id: str
    store: str | None
    merchant: str
    amount: LivePurchaseAmount
    decision: LivePurchaseDecision
    transaction_id: str | None
    blocked: list[str]
    log_index: str
    created_at: str
    card: LivePurchaseCard | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        store: str | None
        store = self.store

        merchant = self.merchant

        amount = self.amount.to_dict()

        decision: str = self.decision

        transaction_id: str | None
        transaction_id = self.transaction_id

        blocked = self.blocked

        log_index = self.log_index

        created_at = self.created_at

        card: dict[str, Any] | Unset = UNSET
        if not isinstance(self.card, Unset):
            card = self.card.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "store": store,
                "merchant": merchant,
                "amount": amount,
                "decision": decision,
                "transactionId": transaction_id,
                "blocked": blocked,
                "logIndex": log_index,
                "createdAt": created_at,
            }
        )
        if card is not UNSET:
            field_dict["card"] = card

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.live_purchase_amount import LivePurchaseAmount
        from ..models.live_purchase_card import LivePurchaseCard

        d = dict(src_dict)
        id = d.pop("id")

        def _parse_store(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        store = _parse_store(d.pop("store"))

        merchant = d.pop("merchant")

        amount = LivePurchaseAmount.from_dict(d.pop("amount"))

        decision = check_live_purchase_decision(d.pop("decision"))

        def _parse_transaction_id(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        transaction_id = _parse_transaction_id(d.pop("transactionId"))

        blocked = cast(list[str], d.pop("blocked"))

        log_index = d.pop("logIndex")

        created_at = d.pop("createdAt")

        _card = d.pop("card", UNSET)
        card: LivePurchaseCard | Unset
        if isinstance(_card, Unset):
            card = UNSET
        else:
            card = LivePurchaseCard.from_dict(_card)

        live_purchase = cls(
            id=id,
            store=store,
            merchant=merchant,
            amount=amount,
            decision=decision,
            transaction_id=transaction_id,
            blocked=blocked,
            log_index=log_index,
            created_at=created_at,
            card=card,
        )

        live_purchase.additional_properties = d
        return live_purchase

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
