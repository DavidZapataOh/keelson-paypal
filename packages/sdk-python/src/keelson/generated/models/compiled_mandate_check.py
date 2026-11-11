from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.compiled_mandate_check_status import (
    CompiledMandateCheckStatus,
    check_compiled_mandate_check_status,
)

if TYPE_CHECKING:
    from ..models.compiled_mandate_check_discrepancies_type_0_item import (
        CompiledMandateCheckDiscrepanciesType0Item,
    )


T = TypeVar("T", bound="CompiledMandateCheck")


@_attrs_define
class CompiledMandateCheck:
    """The round trip of the card against the request. Only `ok` means it was checked.

    Attributes:
        status (CompiledMandateCheckStatus):
        discrepancies (list[CompiledMandateCheckDiscrepanciesType0Item] | None):
    """

    status: CompiledMandateCheckStatus
    discrepancies: list[CompiledMandateCheckDiscrepanciesType0Item] | None
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        status: str = self.status

        discrepancies: list[dict[str, Any]] | None
        if isinstance(self.discrepancies, list):
            discrepancies = []
            for discrepancies_type_0_item_data in self.discrepancies:
                discrepancies_type_0_item = discrepancies_type_0_item_data.to_dict()
                discrepancies.append(discrepancies_type_0_item)

        else:
            discrepancies = self.discrepancies

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "discrepancies": discrepancies,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.compiled_mandate_check_discrepancies_type_0_item import (
            CompiledMandateCheckDiscrepanciesType0Item,
        )

        d = dict(src_dict)
        status = check_compiled_mandate_check_status(d.pop("status"))

        def _parse_discrepancies(
            data: object,
        ) -> list[CompiledMandateCheckDiscrepanciesType0Item] | None:
            if data is None:
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                discrepancies_type_0 = []
                _discrepancies_type_0 = data
                for discrepancies_type_0_item_data in _discrepancies_type_0:
                    discrepancies_type_0_item = (
                        CompiledMandateCheckDiscrepanciesType0Item.from_dict(
                            discrepancies_type_0_item_data
                        )
                    )

                    discrepancies_type_0.append(discrepancies_type_0_item)

                return discrepancies_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[CompiledMandateCheckDiscrepanciesType0Item] | None, data)

        discrepancies = _parse_discrepancies(d.pop("discrepancies"))

        compiled_mandate_check = cls(
            status=status,
            discrepancies=discrepancies,
        )

        compiled_mandate_check.additional_properties = d
        return compiled_mandate_check

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
