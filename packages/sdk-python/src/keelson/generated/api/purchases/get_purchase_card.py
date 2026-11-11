from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.purchase_card import PurchaseCard
from ...types import Response


def _get_kwargs(
    id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/purchases/{id}/card".format(
            id=quote(str(id), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | PurchaseCard | None:
    if response.status_code == 200:
        response_200 = PurchaseCard.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | PurchaseCard]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
) -> Response[Problem | PurchaseCard]:
    """The single-use card of a card purchase

     For the agent's browser: a one-minute link to the card issuer's hosted page showing the card's
    number, expiry and code. Open it in the browser session that pays; never put its contents in a
    model's context or a log. Only the client that asked for the countersign reads it, and only while
    the card is open.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | PurchaseCard]
    """

    kwargs = _get_kwargs(
        id=id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: AuthenticatedClient,
) -> Problem | PurchaseCard | None:
    """The single-use card of a card purchase

     For the agent's browser: a one-minute link to the card issuer's hosted page showing the card's
    number, expiry and code. Open it in the browser session that pays; never put its contents in a
    model's context or a log. Only the client that asked for the countersign reads it, and only while
    the card is open.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | PurchaseCard
    """

    return sync_detailed(
        id=id,
        client=client,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
) -> Response[Problem | PurchaseCard]:
    """The single-use card of a card purchase

     For the agent's browser: a one-minute link to the card issuer's hosted page showing the card's
    number, expiry and code. Open it in the browser session that pays; never put its contents in a
    model's context or a log. Only the client that asked for the countersign reads it, and only while
    the card is open.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | PurchaseCard]
    """

    kwargs = _get_kwargs(
        id=id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: AuthenticatedClient,
) -> Problem | PurchaseCard | None:
    """The single-use card of a card purchase

     For the agent's browser: a one-minute link to the card issuer's hosted page showing the card's
    number, expiry and code. Open it in the browser session that pays; never put its contents in a
    model's context or a log. Only the client that asked for the countersign reads it, and only while
    the card is open.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | PurchaseCard
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
        )
    ).parsed
