from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.mandate_purchase_card_authorizations_item import (
        MandatePurchaseCardAuthorizationsItem,
    )
    from ..models.mandate_purchase_card_chargebacks_item import MandatePurchaseCardChargebacksItem
    from ..models.mandate_purchase_card_controls import MandatePurchaseCardControls


T = TypeVar("T", bound="MandatePurchaseCard")


@_attrs_define
class MandatePurchaseCard:
    """A card purchase: its single-use card (never its number) and every authorization the card network sent it, with both
    legs' decision. `CAPTURED` once the merchant's capture settles.

        Attributes:
            issuer (str):
            last_four (str):
            state (str):
            expires_at (str):
            controls (MandatePurchaseCardControls):
            settled_minor (None | str):
            chargebacks (list[MandatePurchaseCardChargebacksItem]): Chargebacks filed through the card issuer over this
                purchase.
            bond_claim_minor (str): The most a bond claim over this purchase may pay: the settled amount less what
                chargebacks returned; 0 while one is open.
            authorizations (list[MandatePurchaseCardAuthorizationsItem]):
    """

    issuer: str
    last_four: str
    state: str
    expires_at: str
    controls: MandatePurchaseCardControls
    settled_minor: str | None
    chargebacks: list[MandatePurchaseCardChargebacksItem]
    bond_claim_minor: str
    authorizations: list[MandatePurchaseCardAuthorizationsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        issuer = self.issuer

        last_four = self.last_four

        state = self.state

        expires_at = self.expires_at

        controls = self.controls.to_dict()

        settled_minor: str | None
        settled_minor = self.settled_minor

        chargebacks = []
        for chargebacks_item_data in self.chargebacks:
            chargebacks_item = chargebacks_item_data.to_dict()
            chargebacks.append(chargebacks_item)

        bond_claim_minor = self.bond_claim_minor

        authorizations = []
        for authorizations_item_data in self.authorizations:
            authorizations_item = authorizations_item_data.to_dict()
            authorizations.append(authorizations_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "issuer": issuer,
                "lastFour": last_four,
                "state": state,
                "expiresAt": expires_at,
                "controls": controls,
                "settledMinor": settled_minor,
                "chargebacks": chargebacks,
                "bondClaimMinor": bond_claim_minor,
                "authorizations": authorizations,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_purchase_card_authorizations_item import (
            MandatePurchaseCardAuthorizationsItem,
        )
        from ..models.mandate_purchase_card_chargebacks_item import (
            MandatePurchaseCardChargebacksItem,
        )
        from ..models.mandate_purchase_card_controls import MandatePurchaseCardControls

        d = dict(src_dict)
        issuer = d.pop("issuer")

        last_four = d.pop("lastFour")

        state = d.pop("state")

        expires_at = d.pop("expiresAt")

        controls = MandatePurchaseCardControls.from_dict(d.pop("controls"))

        def _parse_settled_minor(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        settled_minor = _parse_settled_minor(d.pop("settledMinor"))

        chargebacks = []
        _chargebacks = d.pop("chargebacks")
        for chargebacks_item_data in _chargebacks:
            chargebacks_item = MandatePurchaseCardChargebacksItem.from_dict(chargebacks_item_data)

            chargebacks.append(chargebacks_item)

        bond_claim_minor = d.pop("bondClaimMinor")

        authorizations = []
        _authorizations = d.pop("authorizations")
        for authorizations_item_data in _authorizations:
            authorizations_item = MandatePurchaseCardAuthorizationsItem.from_dict(
                authorizations_item_data
            )

            authorizations.append(authorizations_item)

        mandate_purchase_card = cls(
            issuer=issuer,
            last_four=last_four,
            state=state,
            expires_at=expires_at,
            controls=controls,
            settled_minor=settled_minor,
            chargebacks=chargebacks,
            bond_claim_minor=bond_claim_minor,
            authorizations=authorizations,
        )

        mandate_purchase_card.additional_properties = d
        return mandate_purchase_card

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
