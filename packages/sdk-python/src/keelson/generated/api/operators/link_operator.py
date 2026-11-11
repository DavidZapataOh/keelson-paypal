from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.link_operator import LinkOperator
from ...models.operator import Operator
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: LinkOperator,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/operators",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Operator | Problem | None:
    if response.status_code == 201:
        response_201 = Operator.from_dict(response.json())

        return response_201

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Operator | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: LinkOperator,
) -> Response[Operator | Problem]:
    """Link an ERC-8004 agent as an operator

     Binds the agent's `cnf` key to its ERC-8004 identity once its owner or `agentWallet` signs
    `OperatorLink`. The owner of an agent that is already linked re-links it, after a transfer for
    example.

    Args:
        body (LinkOperator):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Operator | Problem]
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
    body: LinkOperator,
) -> Operator | Problem | None:
    """Link an ERC-8004 agent as an operator

     Binds the agent's `cnf` key to its ERC-8004 identity once its owner or `agentWallet` signs
    `OperatorLink`. The owner of an agent that is already linked re-links it, after a transfer for
    example.

    Args:
        body (LinkOperator):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Operator | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: LinkOperator,
) -> Response[Operator | Problem]:
    """Link an ERC-8004 agent as an operator

     Binds the agent's `cnf` key to its ERC-8004 identity once its owner or `agentWallet` signs
    `OperatorLink`. The owner of an agent that is already linked re-links it, after a transfer for
    example.

    Args:
        body (LinkOperator):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Operator | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: LinkOperator,
) -> Operator | Problem | None:
    """Link an ERC-8004 agent as an operator

     Binds the agent's `cnf` key to its ERC-8004 identity once its owner or `agentWallet` signs
    `OperatorLink`. The owner of an agent that is already linked re-links it, after a transfer for
    example.

    Args:
        body (LinkOperator):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Operator | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
