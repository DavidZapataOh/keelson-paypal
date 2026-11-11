from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.channel_3_comparison_availability import (
    Channel3ComparisonAvailability,
    check_channel_3_comparison_availability,
)
from ..models.channel_3_comparison_brand import (
    Channel3ComparisonBrand,
    check_channel_3_comparison_brand,
)
from ..models.channel_3_comparison_price import (
    Channel3ComparisonPrice,
    check_channel_3_comparison_price,
)
from ..models.channel_3_comparison_variant import (
    Channel3ComparisonVariant,
    check_channel_3_comparison_variant,
)

T = TypeVar("T", bound="Channel3Comparison")


@_attrs_define
class Channel3Comparison:
    """
    Attributes:
        offer_domain (None | str):
        variant (Channel3ComparisonVariant):
        price (Channel3ComparisonPrice):
        availability (Channel3ComparisonAvailability):
        brand (Channel3ComparisonBrand):
        mismatches (list[str]):
    """

    offer_domain: str | None
    variant: Channel3ComparisonVariant
    price: Channel3ComparisonPrice
    availability: Channel3ComparisonAvailability
    brand: Channel3ComparisonBrand
    mismatches: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        offer_domain: str | None
        offer_domain = self.offer_domain

        variant: str = self.variant

        price: str = self.price

        availability: str = self.availability

        brand: str = self.brand

        mismatches = self.mismatches

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "offerDomain": offer_domain,
                "variant": variant,
                "price": price,
                "availability": availability,
                "brand": brand,
                "mismatches": mismatches,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)

        def _parse_offer_domain(data: object) -> str | None:
            if data is None:
                return data
            return cast(None | str, data)

        offer_domain = _parse_offer_domain(d.pop("offerDomain"))

        variant = check_channel_3_comparison_variant(d.pop("variant"))

        price = check_channel_3_comparison_price(d.pop("price"))

        availability = check_channel_3_comparison_availability(d.pop("availability"))

        brand = check_channel_3_comparison_brand(d.pop("brand"))

        mismatches = cast(list[str], d.pop("mismatches"))

        channel_3_comparison = cls(
            offer_domain=offer_domain,
            variant=variant,
            price=price,
            availability=availability,
            brand=brand,
            mismatches=mismatches,
        )

        channel_3_comparison.additional_properties = d
        return channel_3_comparison

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
