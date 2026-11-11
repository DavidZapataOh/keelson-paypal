from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_purchase_hold import CreatePurchaseHold
from ...models.problem import Problem
from ...models.purchase_hold_order import PurchaseHoldOrder
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: CreatePurchaseHold,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/mandates/{id}/holds".format(
            id=quote(str(id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | PurchaseHoldOrder | None:
    if response.status_code == 201:
        response_201 = PurchaseHoldOrder.from_dict(response.json())

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
) -> Response[Problem | PurchaseHoldOrder]:
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
    body: CreatePurchaseHold,
) -> Response[Problem | PurchaseHoldOrder]:
    """Hold one cart of a multi-merchant mandate

     For a mandate that allows several merchants, creates the PayPal `AUTHORIZE` order for exactly one
    cart, keyed by the request id it will be countersigned under. The user approves it like a mandate
    hold.

    Args:
        id (str):
        body (CreatePurchaseHold):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | PurchaseHoldOrder]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: AuthenticatedClient,
    body: CreatePurchaseHold,
) -> Problem | PurchaseHoldOrder | None:
    """Hold one cart of a multi-merchant mandate

     For a mandate that allows several merchants, creates the PayPal `AUTHORIZE` order for exactly one
    cart, keyed by the request id it will be countersigned under. The user approves it like a mandate
    hold.

    Args:
        id (str):
        body (CreatePurchaseHold):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | PurchaseHoldOrder
    """

    return sync_detailed(
        id=id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
    body: CreatePurchaseHold,
) -> Response[Problem | PurchaseHoldOrder]:
    """Hold one cart of a multi-merchant mandate

     For a mandate that allows several merchants, creates the PayPal `AUTHORIZE` order for exactly one
    cart, keyed by the request id it will be countersigned under. The user approves it like a mandate
    hold.

    Args:
        id (str):
        body (CreatePurchaseHold):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | PurchaseHoldOrder]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: AuthenticatedClient,
    body: CreatePurchaseHold,
) -> Problem | PurchaseHoldOrder | None:
    """Hold one cart of a multi-merchant mandate

     For a mandate that allows several merchants, creates the PayPal `AUTHORIZE` order for exactly one
    cart, keyed by the request id it will be countersigned under. The user approves it like a mandate
    hold.

    Args:
        id (str):
        body (CreatePurchaseHold):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | PurchaseHoldOrder
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
