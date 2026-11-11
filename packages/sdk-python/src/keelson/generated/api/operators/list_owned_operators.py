from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.operator_self import OperatorSelf
from ...models.problem import Problem
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/operators/me",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> OperatorSelf | Problem | None:
    if response.status_code == 200:
        response_200 = OperatorSelf.from_dict(response.json())

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
) -> Response[OperatorSelf | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[OperatorSelf | Problem]:
    """The operators the session's wallet owns

     The linked agents whose owner or agent wallet in the Identity registry is a wallet the session
    signed in with (EIP-4361). A wallet signs in if it owned a linked agent when the agent was linked;
    ownership is then read on chain on every operator route.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[OperatorSelf | Problem]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
) -> OperatorSelf | Problem | None:
    """The operators the session's wallet owns

     The linked agents whose owner or agent wallet in the Identity registry is a wallet the session
    signed in with (EIP-4361). A wallet signs in if it owned a linked agent when the agent was linked;
    ownership is then read on chain on every operator route.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        OperatorSelf | Problem
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[OperatorSelf | Problem]:
    """The operators the session's wallet owns

     The linked agents whose owner or agent wallet in the Identity registry is a wallet the session
    signed in with (EIP-4361). A wallet signs in if it owned a linked agent when the agent was linked;
    ownership is then read on chain on every operator route.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[OperatorSelf | Problem]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
) -> OperatorSelf | Problem | None:
    """The operators the session's wallet owns

     The linked agents whose owner or agent wallet in the Identity registry is a wallet the session
    signed in with (EIP-4361). A wallet signs in if it owned a linked agent when the agent was linked;
    ownership is then read on chain on every operator route.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        OperatorSelf | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
