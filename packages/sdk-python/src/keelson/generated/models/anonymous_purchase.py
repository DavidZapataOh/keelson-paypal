from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.anonymous_purchase_verifier import AnonymousPurchaseVerifier


T = TypeVar("T", bound="AnonymousPurchase")


@_attrs_define
class AnonymousPurchase:
    """
    Attributes:
        user_set_root (str):
        proof (str): The UltraHonk proof bytes, standard base64.
        public_inputs (list[str]): C1's `C_m, amount, currency, category, merchant_id, now, cart_hash, operator_id`,
            then `M mod r` and `user_set_root`: the calldata of `verify(bytes,bytes32[])`.
        verifier (AnonymousPurchaseVerifier | Unset): The deployed verifier that accepts the proof in an `eth_call`. It
            checks the proof only: `public_inputs` must also be the countersign's and the root one `GET /v1/user-
            set/roots/{root}` lists.
        root_tx (str | Unset): The Arbitrum Sepolia transaction that published `user_set_root` to `RegisteredUserSet`,
            once it is confirmed.
    """

    user_set_root: str
    proof: str
    public_inputs: list[str]
    verifier: AnonymousPurchaseVerifier | Unset = UNSET
    root_tx: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        user_set_root = self.user_set_root

        proof = self.proof

        public_inputs = self.public_inputs

        verifier: dict[str, Any] | Unset = UNSET
        if not isinstance(self.verifier, Unset):
            verifier = self.verifier.to_dict()

        root_tx = self.root_tx

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "user_set_root": user_set_root,
                "proof": proof,
                "public_inputs": public_inputs,
            }
        )
        if verifier is not UNSET:
            field_dict["verifier"] = verifier
        if root_tx is not UNSET:
            field_dict["root_tx"] = root_tx

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.anonymous_purchase_verifier import AnonymousPurchaseVerifier

        d = dict(src_dict)
        user_set_root = d.pop("user_set_root")

        proof = d.pop("proof")

        public_inputs = cast(list[str], d.pop("public_inputs"))

        _verifier = d.pop("verifier", UNSET)
        verifier: AnonymousPurchaseVerifier | Unset
        if isinstance(_verifier, Unset):
            verifier = UNSET
        else:
            verifier = AnonymousPurchaseVerifier.from_dict(_verifier)

        root_tx = d.pop("root_tx", UNSET)

        anonymous_purchase = cls(
            user_set_root=user_set_root,
            proof=proof,
            public_inputs=public_inputs,
            verifier=verifier,
            root_tx=root_tx,
        )

        anonymous_purchase.additional_properties = d
        return anonymous_purchase

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
