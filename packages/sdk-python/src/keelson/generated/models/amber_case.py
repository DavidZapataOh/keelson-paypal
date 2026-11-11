from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.amber_case_attested import AmberCaseAttested
    from ..models.amber_case_conviction import AmberCaseConviction


T = TypeVar("T", bound="AmberCase")


@_attrs_define
class AmberCase:
    """What the operator attested about the item it bought, and whether it was proven false. Null when the purchase carries
    no attestation (a cart of several lines, or bought before attestations).

        Attributes:
            commitment (str): The `amberCommitment` the operator signed into the coverage: Poseidon2 over the product page,
                the fields below and a salt.
            attested (AmberCaseAttested | None): What the operator attested. Null on the public dispute read: what was
                bought stays with the consoles.
            conviction (AmberCaseConviction | None): `AmberContradictionCourt`'s conviction on Arbitrum Sepolia: a C2b proof
                that the store's own answer, notarized by leg A, holds another value of `field`. Null while there is none.
    """

    commitment: str
    attested: AmberCaseAttested | None
    conviction: AmberCaseConviction | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.amber_case_attested import AmberCaseAttested
        from ..models.amber_case_conviction import AmberCaseConviction

        commitment = self.commitment

        attested: dict[str, Any] | None
        if isinstance(self.attested, AmberCaseAttested):
            attested = self.attested.to_dict()
        else:
            attested = self.attested

        conviction: dict[str, Any] | None
        if isinstance(self.conviction, AmberCaseConviction):
            conviction = self.conviction.to_dict()
        else:
            conviction = self.conviction

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "commitment": commitment,
                "attested": attested,
                "conviction": conviction,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.amber_case_attested import AmberCaseAttested
        from ..models.amber_case_conviction import AmberCaseConviction

        d = dict(src_dict)
        commitment = d.pop("commitment")

        def _parse_attested(data: object) -> AmberCaseAttested | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                attested_type_0 = AmberCaseAttested.from_dict(data)

                return attested_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(AmberCaseAttested | None, data)

        attested = _parse_attested(d.pop("attested"))

        def _parse_conviction(data: object) -> AmberCaseConviction | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                conviction_type_0 = AmberCaseConviction.from_dict(data)

                return conviction_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(AmberCaseConviction | None, data)

        conviction = _parse_conviction(d.pop("conviction"))

        amber_case = cls(
            commitment=commitment,
            attested=attested,
            conviction=conviction,
        )

        amber_case.additional_properties = d
        return amber_case

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
