from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

if TYPE_CHECKING:
    from ..models.mandate_draft_checkout_constraints_item_type_0 import (
        MandateDraftCheckoutConstraintsItemType0,
    )
    from ..models.mandate_draft_checkout_constraints_item_type_1 import (
        MandateDraftCheckoutConstraintsItemType1,
    )
    from ..models.mandate_draft_checkout_constraints_item_type_2 import (
        MandateDraftCheckoutConstraintsItemType2,
    )
    from ..models.mandate_draft_checkout_constraints_item_type_3 import (
        MandateDraftCheckoutConstraintsItemType3,
    )
    from ..models.mandate_draft_checkout_constraints_item_type_4 import (
        MandateDraftCheckoutConstraintsItemType4,
    )


T = TypeVar("T", bound="MandateDraftCheckout")


@_attrs_define
class MandateDraftCheckout:
    """
    Attributes:
        constraints (list[MandateDraftCheckoutConstraintsItemType0 | MandateDraftCheckoutConstraintsItemType1 |
            MandateDraftCheckoutConstraintsItemType2 | MandateDraftCheckoutConstraintsItemType3 |
            MandateDraftCheckoutConstraintsItemType4]):
    """

    constraints: list[
        MandateDraftCheckoutConstraintsItemType0
        | MandateDraftCheckoutConstraintsItemType1
        | MandateDraftCheckoutConstraintsItemType2
        | MandateDraftCheckoutConstraintsItemType3
        | MandateDraftCheckoutConstraintsItemType4
    ]

    def to_dict(self) -> dict[str, Any]:
        from ..models.mandate_draft_checkout_constraints_item_type_0 import (
            MandateDraftCheckoutConstraintsItemType0,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_1 import (
            MandateDraftCheckoutConstraintsItemType1,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_2 import (
            MandateDraftCheckoutConstraintsItemType2,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_3 import (
            MandateDraftCheckoutConstraintsItemType3,
        )

        constraints = []
        for constraints_item_data in self.constraints:
            constraints_item: dict[str, Any]
            if (
                isinstance(constraints_item_data, MandateDraftCheckoutConstraintsItemType0)
                or isinstance(constraints_item_data, MandateDraftCheckoutConstraintsItemType1)
                or isinstance(constraints_item_data, MandateDraftCheckoutConstraintsItemType2)
                or isinstance(constraints_item_data, MandateDraftCheckoutConstraintsItemType3)
            ):
                constraints_item = constraints_item_data.to_dict()
            else:
                constraints_item = constraints_item_data.to_dict()

            constraints.append(constraints_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "constraints": constraints,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_checkout_constraints_item_type_0 import (
            MandateDraftCheckoutConstraintsItemType0,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_1 import (
            MandateDraftCheckoutConstraintsItemType1,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_2 import (
            MandateDraftCheckoutConstraintsItemType2,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_3 import (
            MandateDraftCheckoutConstraintsItemType3,
        )
        from ..models.mandate_draft_checkout_constraints_item_type_4 import (
            MandateDraftCheckoutConstraintsItemType4,
        )

        d = dict(src_dict)
        constraints = []
        _constraints = d.pop("constraints")
        for constraints_item_data in _constraints:

            def _parse_constraints_item(
                data: object,
            ) -> (
                MandateDraftCheckoutConstraintsItemType0
                | MandateDraftCheckoutConstraintsItemType1
                | MandateDraftCheckoutConstraintsItemType2
                | MandateDraftCheckoutConstraintsItemType3
                | MandateDraftCheckoutConstraintsItemType4
            ):
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_0 = MandateDraftCheckoutConstraintsItemType0.from_dict(
                        data
                    )

                    return constraints_item_type_0
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_1 = MandateDraftCheckoutConstraintsItemType1.from_dict(
                        data
                    )

                    return constraints_item_type_1
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_2 = MandateDraftCheckoutConstraintsItemType2.from_dict(
                        data
                    )

                    return constraints_item_type_2
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_3 = MandateDraftCheckoutConstraintsItemType3.from_dict(
                        data
                    )

                    return constraints_item_type_3
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                if not isinstance(data, dict):
                    raise TypeError()
                constraints_item_type_4 = MandateDraftCheckoutConstraintsItemType4.from_dict(data)

                return constraints_item_type_4

            constraints_item = _parse_constraints_item(constraints_item_data)

            constraints.append(constraints_item)

        mandate_draft_checkout = cls(
            constraints=constraints,
        )

        return mandate_draft_checkout
