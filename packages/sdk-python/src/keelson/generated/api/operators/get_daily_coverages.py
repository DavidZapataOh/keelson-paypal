from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.get_daily_coverages_response_200 import GetDailyCoveragesResponse200
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    agent_id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/operators/{agent_id}/coverages/daily".format(
            agent_id=quote(str(agent_id), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> GetDailyCoveragesResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = GetDailyCoveragesResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[GetDailyCoveragesResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[GetDailyCoveragesResponse200 | Problem]:
    """The operator's coverages per day

     Per UTC day: coverages locked, the amount covered, premiums, and incidents.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[GetDailyCoveragesResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        agent_id=agent_id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> GetDailyCoveragesResponse200 | Problem | None:
    """The operator's coverages per day

     Per UTC day: coverages locked, the amount covered, premiums, and incidents.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        GetDailyCoveragesResponse200 | Problem
    """

    return sync_detailed(
        agent_id=agent_id,
        client=client,
    ).parsed


async def asyncio_detailed(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[GetDailyCoveragesResponse200 | Problem]:
    """The operator's coverages per day

     Per UTC day: coverages locked, the amount covered, premiums, and incidents.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[GetDailyCoveragesResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        agent_id=agent_id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> GetDailyCoveragesResponse200 | Problem | None:
    """The operator's coverages per day

     Per UTC day: coverages locked, the amount covered, premiums, and incidents.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        GetDailyCoveragesResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            agent_id=agent_id,
            client=client,
        )
    ).parsed
