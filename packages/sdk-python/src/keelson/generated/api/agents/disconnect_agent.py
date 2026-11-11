from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.agents_revoked import AgentsRevoked
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    agent_id: str,
    *,
    client_query: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["client"] = client_query

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/agents/{agent_id}/disconnect".format(
            agent_id=quote(str(agent_id), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> AgentsRevoked | Problem | None:
    if response.status_code == 200:
        response_200 = AgentsRevoked.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[AgentsRevoked | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    agent_id: str,
    *,
    client: AuthenticatedClient,
    client_query: str | Unset = UNSET,
) -> Response[AgentsRevoked | Problem]:
    """Disconnect an agent

     Revokes every live mandate of yours that names the agent and ends its connections. Keelson refuses
    its countersigns from now on; purchases already countersigned may still be captured.

    With `client`, only that app, of the apps acting through the agent: the mandates you approved for
    it, its requests, its OAuth grant and refresh tokens, and the access tokens it holds for you. Apps
    acting through Keelson's hosted operator are disconnected this way; without `client`, the hosted
    operator ends only your mandates of it that no app holds (its `Unknown app` row).

    Args:
        agent_id (str):
        client_query (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AgentsRevoked | Problem]
    """

    kwargs = _get_kwargs(
        agent_id=agent_id,
        client_query=client_query,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    agent_id: str,
    *,
    client: AuthenticatedClient,
    client_query: str | Unset = UNSET,
) -> AgentsRevoked | Problem | None:
    """Disconnect an agent

     Revokes every live mandate of yours that names the agent and ends its connections. Keelson refuses
    its countersigns from now on; purchases already countersigned may still be captured.

    With `client`, only that app, of the apps acting through the agent: the mandates you approved for
    it, its requests, its OAuth grant and refresh tokens, and the access tokens it holds for you. Apps
    acting through Keelson's hosted operator are disconnected this way; without `client`, the hosted
    operator ends only your mandates of it that no app holds (its `Unknown app` row).

    Args:
        agent_id (str):
        client_query (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AgentsRevoked | Problem
    """

    return sync_detailed(
        agent_id=agent_id,
        client=client,
        client_query=client_query,
    ).parsed


async def asyncio_detailed(
    agent_id: str,
    *,
    client: AuthenticatedClient,
    client_query: str | Unset = UNSET,
) -> Response[AgentsRevoked | Problem]:
    """Disconnect an agent

     Revokes every live mandate of yours that names the agent and ends its connections. Keelson refuses
    its countersigns from now on; purchases already countersigned may still be captured.

    With `client`, only that app, of the apps acting through the agent: the mandates you approved for
    it, its requests, its OAuth grant and refresh tokens, and the access tokens it holds for you. Apps
    acting through Keelson's hosted operator are disconnected this way; without `client`, the hosted
    operator ends only your mandates of it that no app holds (its `Unknown app` row).

    Args:
        agent_id (str):
        client_query (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AgentsRevoked | Problem]
    """

    kwargs = _get_kwargs(
        agent_id=agent_id,
        client_query=client_query,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    agent_id: str,
    *,
    client: AuthenticatedClient,
    client_query: str | Unset = UNSET,
) -> AgentsRevoked | Problem | None:
    """Disconnect an agent

     Revokes every live mandate of yours that names the agent and ends its connections. Keelson refuses
    its countersigns from now on; purchases already countersigned may still be captured.

    With `client`, only that app, of the apps acting through the agent: the mandates you approved for
    it, its requests, its OAuth grant and refresh tokens, and the access tokens it holds for you. Apps
    acting through Keelson's hosted operator are disconnected this way; without `client`, the hosted
    operator ends only your mandates of it that no app holds (its `Unknown app` row).

    Args:
        agent_id (str):
        client_query (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AgentsRevoked | Problem
    """

    return (
        await asyncio_detailed(
            agent_id=agent_id,
            client=client,
            client_query=client_query,
        )
    ).parsed
