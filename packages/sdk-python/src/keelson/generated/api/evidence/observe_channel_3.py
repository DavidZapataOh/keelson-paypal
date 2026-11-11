from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.channel_3_observation import Channel3Observation
from ...models.channel_3_observation_request import Channel3ObservationRequest
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: Channel3ObservationRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/observations/channel3",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Channel3Observation | Problem | None:
    if response.status_code == 201:
        response_201 = Channel3Observation.from_dict(response.json())

        return response_201

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Channel3Observation | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: Channel3ObservationRequest,
) -> Response[Channel3Observation | Problem]:
    """Observe a product through Channel3

     Asks Channel3 about the product page once (live fetch if its data is older than an hour, eight
    seconds at most), compares variant, price, availability and brand with what the agent saw, stores
    the observation and queues RFC 3161 tokens over its hash. Channel3 is third-party testimony: it is
    shown in the countersigned trace and never changes a decision.

    Args:
        body (Channel3ObservationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Channel3Observation | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    body: Channel3ObservationRequest,
) -> Channel3Observation | Problem | None:
    """Observe a product through Channel3

     Asks Channel3 about the product page once (live fetch if its data is older than an hour, eight
    seconds at most), compares variant, price, availability and brand with what the agent saw, stores
    the observation and queues RFC 3161 tokens over its hash. Channel3 is third-party testimony: it is
    shown in the countersigned trace and never changes a decision.

    Args:
        body (Channel3ObservationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Channel3Observation | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: Channel3ObservationRequest,
) -> Response[Channel3Observation | Problem]:
    """Observe a product through Channel3

     Asks Channel3 about the product page once (live fetch if its data is older than an hour, eight
    seconds at most), compares variant, price, availability and brand with what the agent saw, stores
    the observation and queues RFC 3161 tokens over its hash. Channel3 is third-party testimony: it is
    shown in the countersigned trace and never changes a decision.

    Args:
        body (Channel3ObservationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Channel3Observation | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: Channel3ObservationRequest,
) -> Channel3Observation | Problem | None:
    """Observe a product through Channel3

     Asks Channel3 about the product page once (live fetch if its data is older than an hour, eight
    seconds at most), compares variant, price, availability and brand with what the agent saw, stores
    the observation and queues RFC 3161 tokens over its hash. Channel3 is third-party testimony: it is
    shown in the countersigned trace and never changes a decision.

    Args:
        body (Channel3ObservationRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Channel3Observation | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
