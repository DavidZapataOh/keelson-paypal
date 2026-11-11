from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.agent_stop import AgentStop
from ...models.problem import Problem
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/agents/stop",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> AgentStop | Problem | None:
    if response.status_code == 200:
        response_200 = AgentStop.from_dict(response.json())

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
) -> Response[AgentStop | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[AgentStop | Problem]:
    """Stop all agents

     The kill switch. Keelson refuses every countersign of a mandate of yours stored before now, revokes
    every live mandate and voids its PayPal holds, denies every open request, revokes every agent's
    OAuth grant, and logs the stop as a `keelson.finance/stop/v1` leaf in the Alibi log. Purchases
    already countersigned may still be captured.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AgentStop | Problem]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> AgentStop | Problem | None:
    """Stop all agents

     The kill switch. Keelson refuses every countersign of a mandate of yours stored before now, revokes
    every live mandate and voids its PayPal holds, denies every open request, revokes every agent's
    OAuth grant, and logs the stop as a `keelson.finance/stop/v1` leaf in the Alibi log. Purchases
    already countersigned may still be captured.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AgentStop | Problem
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[AgentStop | Problem]:
    """Stop all agents

     The kill switch. Keelson refuses every countersign of a mandate of yours stored before now, revokes
    every live mandate and voids its PayPal holds, denies every open request, revokes every agent's
    OAuth grant, and logs the stop as a `keelson.finance/stop/v1` leaf in the Alibi log. Purchases
    already countersigned may still be captured.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AgentStop | Problem]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> AgentStop | Problem | None:
    """Stop all agents

     The kill switch. Keelson refuses every countersign of a mandate of yours stored before now, revokes
    every live mandate and voids its PayPal holds, denies every open request, revokes every agent's
    OAuth grant, and logs the stop as a `keelson.finance/stop/v1` leaf in the Alibi log. Purchases
    already countersigned may still be captured.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AgentStop | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
