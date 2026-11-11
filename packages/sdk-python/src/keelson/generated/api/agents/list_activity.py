from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.list_activity_response_200 import ListActivityResponse200
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    agent: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["agent"] = agent

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/activity",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> ListActivityResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = ListActivityResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[ListActivityResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    agent: str | Unset = UNSET,
) -> Response[ListActivityResponse200 | Problem]:
    """Read your activity

     What your agents and Keelson did, newest first, one plain line each: requests, purchases, blocks and
    stops. Purchases link to their Alibi and log entry.

    Args:
        agent (str | Unset): Only this agent's rows, and stops of every agent.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ListActivityResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        agent=agent,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    agent: str | Unset = UNSET,
) -> ListActivityResponse200 | Problem | None:
    """Read your activity

     What your agents and Keelson did, newest first, one plain line each: requests, purchases, blocks and
    stops. Purchases link to their Alibi and log entry.

    Args:
        agent (str | Unset): Only this agent's rows, and stops of every agent.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ListActivityResponse200 | Problem
    """

    return sync_detailed(
        client=client,
        agent=agent,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    agent: str | Unset = UNSET,
) -> Response[ListActivityResponse200 | Problem]:
    """Read your activity

     What your agents and Keelson did, newest first, one plain line each: requests, purchases, blocks and
    stops. Purchases link to their Alibi and log entry.

    Args:
        agent (str | Unset): Only this agent's rows, and stops of every agent.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ListActivityResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        agent=agent,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    agent: str | Unset = UNSET,
) -> ListActivityResponse200 | Problem | None:
    """Read your activity

     What your agents and Keelson did, newest first, one plain line each: requests, purchases, blocks and
    stops. Purchases link to their Alibi and log entry.

    Args:
        agent (str | Unset): Only this agent's rows, and stops of every agent.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ListActivityResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            agent=agent,
        )
    ).parsed
