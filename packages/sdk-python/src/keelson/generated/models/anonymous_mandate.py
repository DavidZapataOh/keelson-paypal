from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.anonymous_mandate_verifier import AnonymousMandateVerifier


T = TypeVar("T", bound="AnonymousMandate")


@_attrs_define
class AnonymousMandate:
    """
    Attributes:
        mandate_hash (str): The passkey challenge `M` the user signed.
        mandate_commitment (str): `C_m`, the commitment the mandate names.
        user_set_root (str): The registered-user tree the signer is a leaf of when the proof was made.
        proof (str): The UltraHonk proof bytes, standard base64.
        public_inputs (list[str]): `C_m, M mod r, user_set_root, SHA-256("keelson.finance")`: the calldata of
            `verify(bytes,bytes32[])`.
        verifier (AnonymousMandateVerifier | Unset): The deployed verifier that accepts the proof in an `eth_call`. It
            checks the proof only: `public_inputs` must also be the countersign's `C_m` and `M`, Keelson's RP ID hash, and a
            root published in `RegisteredUserSet`, whose `verify` checks all of it.
    """

    mandate_hash: str
    mandate_commitment: str
    user_set_root: str
    proof: str
    public_inputs: list[str]
    verifier: AnonymousMandateVerifier | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        mandate_hash = self.mandate_hash

        mandate_commitment = self.mandate_commitment

        user_set_root = self.user_set_root

        proof = self.proof

        public_inputs = self.public_inputs

        verifier: dict[str, Any] | Unset = UNSET
        if not isinstance(self.verifier, Unset):
            verifier = self.verifier.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "mandate_hash": mandate_hash,
                "mandate_commitment": mandate_commitment,
                "user_set_root": user_set_root,
                "proof": proof,
                "public_inputs": public_inputs,
            }
        )
        if verifier is not UNSET:
            field_dict["verifier"] = verifier

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.anonymous_mandate_verifier import AnonymousMandateVerifier

        d = dict(src_dict)
        mandate_hash = d.pop("mandate_hash")

        mandate_commitment = d.pop("mandate_commitment")

        user_set_root = d.pop("user_set_root")

        proof = d.pop("proof")

        public_inputs = cast(list[str], d.pop("public_inputs"))

        _verifier = d.pop("verifier", UNSET)
        verifier: AnonymousMandateVerifier | Unset
        if isinstance(_verifier, Unset):
            verifier = UNSET
        else:
            verifier = AnonymousMandateVerifier.from_dict(_verifier)

        anonymous_mandate = cls(
            mandate_hash=mandate_hash,
            mandate_commitment=mandate_commitment,
            user_set_root=user_set_root,
            proof=proof,
            public_inputs=public_inputs,
            verifier=verifier,
        )

        anonymous_mandate.additional_properties = d
        return anonymous_mandate

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
