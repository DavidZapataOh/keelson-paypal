from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.list_approvals_response_200 import ListApprovalsResponse200
from ...models.problem import Problem
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/approvals",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> ListApprovalsResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = ListApprovalsResponse200.from_dict(response.json())

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
) -> Response[ListApprovalsResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ListApprovalsResponse200 | Problem]:
    """Carts paused for your approval

     Carts your agents tried that their mandate does not allow, each waiting for you to approve it once
    or decline it. New ones arrive as `approval.requested` events on the `agents` channel.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ListApprovalsResponse200 | Problem]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
) -> ListApprovalsResponse200 | Problem | None:
    """Carts paused for your approval

     Carts your agents tried that their mandate does not allow, each waiting for you to approve it once
    or decline it. New ones arrive as `approval.requested` events on the `agents` channel.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ListApprovalsResponse200 | Problem
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
) -> Response[ListApprovalsResponse200 | Problem]:
    """Carts paused for your approval

     Carts your agents tried that their mandate does not allow, each waiting for you to approve it once
    or decline it. New ones arrive as `approval.requested` events on the `agents` channel.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ListApprovalsResponse200 | Problem]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
) -> ListApprovalsResponse200 | Problem | None:
    """Carts paused for your approval

     Carts your agents tried that their mandate does not allow, each waiting for you to approve it once
    or decline it. New ones arrive as `approval.requested` events on the `agents` channel.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ListApprovalsResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
