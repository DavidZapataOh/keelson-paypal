from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

T = TypeVar("T", bound="LogEquivocation")


@_attrs_define
class LogEquivocation:
    """
    Attributes:
        prover (str):
        amount_minor (str): The whole bond slashed, PYUSD base units.
        bounty_minor (str): The prover's bounty out of it; the rest went to the bond's beneficiary.
        proven_at (str):
        size (str): The tree size both checkpoints state.
        root_a (str):
        root_b (str):
        note_a (None | str): The first signed checkpoint, as submitted; null until its transaction is found.
        note_b (None | str):
        tx_hash (None | str):
        explorer_url (None | str):
    """

    prover: str
    amount_minor: str
    bounty_minor: str
    proven_at: str
    size: str
    root_a: str
    root_b: str
    note_a: str | None
    note_b: str | None
    tx_hash: str | None
    explorer_url: str | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        prover = self.prover

        amount_minor = self.amount_minor

        bounty_minor = self.bounty_minor

        proven_at = self.proven_at

        size = self.size

        root_a = self.root_a

        root_b = self.root_b

        note_a: str | None
        note_a = self.note_a

        note_b: str | None
        note_b = self.note_b

        tx_hash: str | None
        tx_hash = self.tx_hash

        explorer_url: str | None
        explorer_url = self.explorer_url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "prover": prover,
                "amountMinor": amount_minor,
                "bountyMinor": bounty_minor,
                "provenAt": proven_at,
                "size": size,
                "rootA": root_a,
                "rootB": root_b,
                "noteA": note_a,
                "noteB": note_b,
                "txHash": tx_hash,
                "explorerUrl": explorer_url,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        prover = d.pop("prover")

        amount_minor = d.pop("amountMinor")

        bounty_minor = d.pop("bountyMinor")

        proven_at = d.pop("provenAt")

        size = d.pop("size")

        root_a = d.pop("rootA")

        root_b = d.pop("rootB")

        def _parse_note_a(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        note_a = _parse_note_a(d.pop("noteA"))

        def _parse_note_b(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        note_b = _parse_note_b(d.pop("noteB"))

        def _parse_tx_hash(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        tx_hash = _parse_tx_hash(d.pop("txHash"))

        def _parse_explorer_url(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        explorer_url = _parse_explorer_url(d.pop("explorerUrl"))

        log_equivocation = cls(
            prover=prover,
            amount_minor=amount_minor,
            bounty_minor=bounty_minor,
            proven_at=proven_at,
            size=size,
            root_a=root_a,
            root_b=root_b,
            note_a=note_a,
            note_b=note_b,
            tx_hash=tx_hash,
            explorer_url=explorer_url,
        )

        log_equivocation.additional_properties = d
        return log_equivocation

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
