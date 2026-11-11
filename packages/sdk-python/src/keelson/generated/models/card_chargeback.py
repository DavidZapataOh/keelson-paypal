from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.card_chargeback_reason import CardChargebackReason, check_card_chargeback_reason

if TYPE_CHECKING:
    from ..models.card_chargeback_network_codes import CardChargebackNetworkCodes


T = TypeVar("T", bound="CardChargeback")


@_attrs_define
class CardChargeback:
    """
    Attributes:
        id (str):
        purchase_id (str):
        reason (CardChargebackReason):
        network_codes (CardChargebackNetworkCodes):
        amount_minor (str):
        status (str):
        resolution (None | str):
        recovered_minor (None | str):
        evidence_uploaded (bool):
    """

    id: str
    purchase_id: str
    reason: CardChargebackReason
    network_codes: CardChargebackNetworkCodes
    amount_minor: str
    status: str
    resolution: str | None
    recovered_minor: str | None
    evidence_uploaded: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        purchase_id = self.purchase_id

        reason: str = self.reason

        network_codes = self.network_codes.to_dict()

        amount_minor = self.amount_minor

        status = self.status

        resolution: str | None
        resolution = self.resolution

        recovered_minor: str | None
        recovered_minor = self.recovered_minor

        evidence_uploaded = self.evidence_uploaded

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "purchaseId": purchase_id,
                "reason": reason,
                "networkCodes": network_codes,
                "amountMinor": amount_minor,
                "status": status,
                "resolution": resolution,
                "recoveredMinor": recovered_minor,
                "evidenceUploaded": evidence_uploaded,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.card_chargeback_network_codes import CardChargebackNetworkCodes

        d = dict(src_dict)
        id = d.pop("id")

        purchase_id = d.pop("purchaseId")

        reason = check_card_chargeback_reason(d.pop("reason"))

        network_codes = CardChargebackNetworkCodes.from_dict(d.pop("networkCodes"))

        amount_minor = d.pop("amountMinor")

        status = d.pop("status")

        def _parse_resolution(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        resolution = _parse_resolution(d.pop("resolution"))

        def _parse_recovered_minor(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        recovered_minor = _parse_recovered_minor(d.pop("recoveredMinor"))

        evidence_uploaded = d.pop("evidenceUploaded")

        card_chargeback = cls(
            id=id,
            purchase_id=purchase_id,
            reason=reason,
            network_codes=network_codes,
            amount_minor=amount_minor,
            status=status,
            resolution=resolution,
            recovered_minor=recovered_minor,
            evidence_uploaded=evidence_uploaded,
        )

        card_chargeback.additional_properties = d
        return card_chargeback

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
