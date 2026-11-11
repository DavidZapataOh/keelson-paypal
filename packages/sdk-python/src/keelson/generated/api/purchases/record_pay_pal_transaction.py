from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.pay_pal_transaction import PayPalTransaction
from ...models.problem import Problem
from ...models.purchase import Purchase
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: PayPalTransaction,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/purchases/{id}/paypal-transaction".format(
            id=quote(str(id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | Purchase | None:
    if response.status_code == 200:
        response_200 = Purchase.from_dict(response.json())

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
) -> Response[Problem | Purchase]:
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
    body: PayPalTransaction,
) -> Response[Problem | Purchase]:
    """Record a live purchase's PayPal transaction

     For a purchase countersigned with `live`, once its Alibi is issued: the PayPal transaction id of the
    buyer's payment at the store, as PayPal reported it on its confirmation. Recorded once; the Alibi
    carries it from then on, marked as not signed. Only the client that asked for the countersign
    records it.

    Args:
        id (str):
        body (PayPalTransaction):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Purchase]
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
    body: PayPalTransaction,
) -> Problem | Purchase | None:
    """Record a live purchase's PayPal transaction

     For a purchase countersigned with `live`, once its Alibi is issued: the PayPal transaction id of the
    buyer's payment at the store, as PayPal reported it on its confirmation. Recorded once; the Alibi
    carries it from then on, marked as not signed. Only the client that asked for the countersign
    records it.

    Args:
        id (str):
        body (PayPalTransaction):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Purchase
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
    body: PayPalTransaction,
) -> Response[Problem | Purchase]:
    """Record a live purchase's PayPal transaction

     For a purchase countersigned with `live`, once its Alibi is issued: the PayPal transaction id of the
    buyer's payment at the store, as PayPal reported it on its confirmation. Recorded once; the Alibi
    carries it from then on, marked as not signed. Only the client that asked for the countersign
    records it.

    Args:
        id (str):
        body (PayPalTransaction):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Purchase]
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
    body: PayPalTransaction,
) -> Problem | Purchase | None:
    """Record a live purchase's PayPal transaction

     For a purchase countersigned with `live`, once its Alibi is issued: the PayPal transaction id of the
    buyer's payment at the store, as PayPal reported it on its confirmation. Recorded once; the Alibi
    carries it from then on, marked as not signed. Only the client that asked for the countersign
    records it.

    Args:
        id (str):
        body (PayPalTransaction):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Purchase
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
