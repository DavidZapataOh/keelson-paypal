from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.agent_registration import AgentRegistration
from ...models.get_agent_registration_chain_id import (
    GetAgentRegistrationChainId,
)
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    chain_id: GetAgentRegistrationChainId,
    agent_id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/operators/{chain_id}/{agent_id}/registration.json".format(
            chain_id=quote(str(chain_id), safe=""),
            agent_id=quote(str(agent_id), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> AgentRegistration | Problem | None:
    if response.status_code == 200:
        response_200 = AgentRegistration.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[AgentRegistration | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    chain_id: GetAgentRegistrationChainId,
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[AgentRegistration | Problem]:
    """Registration file of an agent

     The ERC-8004 registration file of the agent's current owner, listing every linked agent it owns.

    Args:
        chain_id (GetAgentRegistrationChainId): An EIP-155 chain id.
        agent_id (str): The ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AgentRegistration | Problem]
    """

    kwargs = _get_kwargs(
        chain_id=chain_id,
        agent_id=agent_id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    chain_id: GetAgentRegistrationChainId,
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> AgentRegistration | Problem | None:
    """Registration file of an agent

     The ERC-8004 registration file of the agent's current owner, listing every linked agent it owns.

    Args:
        chain_id (GetAgentRegistrationChainId): An EIP-155 chain id.
        agent_id (str): The ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AgentRegistration | Problem
    """

    return sync_detailed(
        chain_id=chain_id,
        agent_id=agent_id,
        client=client,
    ).parsed


async def asyncio_detailed(
    chain_id: GetAgentRegistrationChainId,
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[AgentRegistration | Problem]:
    """Registration file of an agent

     The ERC-8004 registration file of the agent's current owner, listing every linked agent it owns.

    Args:
        chain_id (GetAgentRegistrationChainId): An EIP-155 chain id.
        agent_id (str): The ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AgentRegistration | Problem]
    """

    kwargs = _get_kwargs(
        chain_id=chain_id,
        agent_id=agent_id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    chain_id: GetAgentRegistrationChainId,
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> AgentRegistration | Problem | None:
    """Registration file of an agent

     The ERC-8004 registration file of the agent's current owner, listing every linked agent it owns.

    Args:
        chain_id (GetAgentRegistrationChainId): An EIP-155 chain id.
        agent_id (str): The ERC-8004 agent id, a decimal integer.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AgentRegistration | Problem
    """

    return (
        await asyncio_detailed(
            chain_id=chain_id,
            agent_id=agent_id,
            client=client,
        )
    ).parsed
