from typing import Literal

Channel3ObservationRequestAgentViewCurrency = Literal[
    "AUD",
    "BRL",
    "CAD",
    "CHF",
    "CNY",
    "CZK",
    "DKK",
    "EUR",
    "GBP",
    "HKD",
    "HUF",
    "ILS",
    "JPY",
    "MXN",
    "MYR",
    "NOK",
    "NZD",
    "PHP",
    "PLN",
    "SEK",
    "SGD",
    "THB",
    "TWD",
    "USD",
]

CHANNEL_3_OBSERVATION_REQUEST_AGENT_VIEW_CURRENCY_VALUES: set[
    Channel3ObservationRequestAgentViewCurrency
] = {
    "AUD",
    "BRL",
    "CAD",
    "CHF",
    "CNY",
    "CZK",
    "DKK",
    "EUR",
    "GBP",
    "HKD",
    "HUF",
    "ILS",
    "JPY",
    "MXN",
    "MYR",
    "NOK",
    "NZD",
    "PHP",
    "PLN",
    "SEK",
    "SGD",
    "THB",
    "TWD",
    "USD",
}


def check_channel_3_observation_request_agent_view_currency(
    value: str,
) -> Channel3ObservationRequestAgentViewCurrency:
    if value in CHANNEL_3_OBSERVATION_REQUEST_AGENT_VIEW_CURRENCY_VALUES:
        return value
    raise TypeError(
        f"Unexpected value {value!r}. Expected one of {CHANNEL_3_OBSERVATION_REQUEST_AGENT_VIEW_CURRENCY_VALUES!r}"
    )
