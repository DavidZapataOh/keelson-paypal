from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.web_fact_mode import WebFactMode, check_web_fact_mode

if TYPE_CHECKING:
    from ..models.web_fact_web_fact import WebFactWebFact


T = TypeVar("T", bound="WebFact")


@_attrs_define
class WebFact:
    """
    Attributes:
        web_fact (WebFactWebFact):
        mode (WebFactMode):
        ms (int): How long the TLSNotary session took.
        range_ (list[int]): The committed range of the response, `[start, end)`.
        committed (str): The committed bytes, hex.
        blinder (str): The 16-byte blinder, hex: `rangeCommitment` is `SHA-256(committed ‖ blinder)`.
    """

    web_fact: WebFactWebFact
    mode: WebFactMode
    ms: int
    range_: list[int]
    committed: str
    blinder: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        web_fact = self.web_fact.to_dict()

        mode: str = self.mode

        ms = self.ms

        range_ = []
        for range_item_data in self.range_:
            range_item: int
            range_item = range_item_data
            range_.append(range_item)

        committed = self.committed

        blinder = self.blinder

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "webFact": web_fact,
                "mode": mode,
                "ms": ms,
                "range": range_,
                "committed": committed,
                "blinder": blinder,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.web_fact_web_fact import WebFactWebFact

        d = dict(src_dict)
        web_fact = WebFactWebFact.from_dict(d.pop("webFact"))

        mode = check_web_fact_mode(d.pop("mode"))

        ms = d.pop("ms")

        range_ = []
        _range_ = d.pop("range")
        for range_item_data in _range_:

            def _parse_range_item(data: object) -> int:
                return cast(int, data)

            range_item = _parse_range_item(range_item_data)

            range_.append(range_item)

        committed = d.pop("committed")

        blinder = d.pop("blinder")

        web_fact = cls(
            web_fact=web_fact,
            mode=mode,
            ms=ms,
            range_=range_,
            committed=committed,
            blinder=blinder,
        )

        web_fact.additional_properties = d
        return web_fact

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
