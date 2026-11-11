from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..models.mandate_draft_payment_currency import (
    MandateDraftPaymentCurrency,
    check_mandate_draft_payment_currency,
)
from ..models.mandate_draft_payment_rail import (
    MandateDraftPaymentRail,
    check_mandate_draft_payment_rail,
)

if TYPE_CHECKING:
    from ..models.mandate_draft_payment_constraints_item_type_0 import (
        MandateDraftPaymentConstraintsItemType0,
    )
    from ..models.mandate_draft_payment_constraints_item_type_1 import (
        MandateDraftPaymentConstraintsItemType1,
    )
    from ..models.mandate_draft_payment_constraints_item_type_2 import (
        MandateDraftPaymentConstraintsItemType2,
    )
    from ..models.mandate_draft_payment_constraints_item_type_3 import (
        MandateDraftPaymentConstraintsItemType3,
    )
    from ..models.mandate_draft_payment_constraints_item_type_4 import (
        MandateDraftPaymentConstraintsItemType4,
    )


T = TypeVar("T", bound="MandateDraftPayment")


@_attrs_define
class MandateDraftPayment:
    """
    Attributes:
        rail (MandateDraftPaymentRail):
        currency (MandateDraftPaymentCurrency):
        constraints (list[MandateDraftPaymentConstraintsItemType0 | MandateDraftPaymentConstraintsItemType1 |
            MandateDraftPaymentConstraintsItemType2 | MandateDraftPaymentConstraintsItemType3 |
            MandateDraftPaymentConstraintsItemType4]):
    """

    rail: MandateDraftPaymentRail
    currency: MandateDraftPaymentCurrency
    constraints: list[
        MandateDraftPaymentConstraintsItemType0
        | MandateDraftPaymentConstraintsItemType1
        | MandateDraftPaymentConstraintsItemType2
        | MandateDraftPaymentConstraintsItemType3
        | MandateDraftPaymentConstraintsItemType4
    ]

    def to_dict(self) -> dict[str, Any]:
        from ..models.mandate_draft_payment_constraints_item_type_0 import (
            MandateDraftPaymentConstraintsItemType0,
        )
        from ..models.mandate_draft_payment_constraints_item_type_1 import (
            MandateDraftPaymentConstraintsItemType1,
        )
        from ..models.mandate_draft_payment_constraints_item_type_2 import (
            MandateDraftPaymentConstraintsItemType2,
        )
        from ..models.mandate_draft_payment_constraints_item_type_3 import (
            MandateDraftPaymentConstraintsItemType3,
        )

        rail: str = self.rail

        currency: str = self.currency

        constraints = []
        for constraints_item_data in self.constraints:
            constraints_item: dict[str, Any]
            if (
                isinstance(constraints_item_data, MandateDraftPaymentConstraintsItemType0)
                or isinstance(constraints_item_data, MandateDraftPaymentConstraintsItemType1)
                or isinstance(constraints_item_data, MandateDraftPaymentConstraintsItemType2)
                or isinstance(constraints_item_data, MandateDraftPaymentConstraintsItemType3)
            ):
                constraints_item = constraints_item_data.to_dict()
            else:
                constraints_item = constraints_item_data.to_dict()

            constraints.append(constraints_item)

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "rail": rail,
                "currency": currency,
                "constraints": constraints,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.mandate_draft_payment_constraints_item_type_0 import (
            MandateDraftPaymentConstraintsItemType0,
        )
        from ..models.mandate_draft_payment_constraints_item_type_1 import (
            MandateDraftPaymentConstraintsItemType1,
        )
        from ..models.mandate_draft_payment_constraints_item_type_2 import (
            MandateDraftPaymentConstraintsItemType2,
        )
        from ..models.mandate_draft_payment_constraints_item_type_3 import (
            MandateDraftPaymentConstraintsItemType3,
        )
        from ..models.mandate_draft_payment_constraints_item_type_4 import (
            MandateDraftPaymentConstraintsItemType4,
        )

        d = dict(src_dict)
        rail = check_mandate_draft_payment_rail(d.pop("rail"))

        currency = check_mandate_draft_payment_currency(d.pop("currency"))

        constraints = []
        _constraints = d.pop("constraints")
        for constraints_item_data in _constraints:

            def _parse_constraints_item(
                data: object,
            ) -> (
                MandateDraftPaymentConstraintsItemType0
                | MandateDraftPaymentConstraintsItemType1
                | MandateDraftPaymentConstraintsItemType2
                | MandateDraftPaymentConstraintsItemType3
                | MandateDraftPaymentConstraintsItemType4
            ):
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_0 = MandateDraftPaymentConstraintsItemType0.from_dict(
                        data
                    )

                    return constraints_item_type_0
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_1 = MandateDraftPaymentConstraintsItemType1.from_dict(
                        data
                    )

                    return constraints_item_type_1
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_2 = MandateDraftPaymentConstraintsItemType2.from_dict(
                        data
                    )

                    return constraints_item_type_2
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    constraints_item_type_3 = MandateDraftPaymentConstraintsItemType3.from_dict(
                        data
                    )

                    return constraints_item_type_3
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                if not isinstance(data, dict):
                    raise TypeError()
                constraints_item_type_4 = MandateDraftPaymentConstraintsItemType4.from_dict(data)

                return constraints_item_type_4

            constraints_item = _parse_constraints_item(constraints_item_data)

            constraints.append(constraints_item)

        mandate_draft_payment = cls(
            rail=rail,
            currency=currency,
            constraints=constraints,
        )

        return mandate_draft_payment
