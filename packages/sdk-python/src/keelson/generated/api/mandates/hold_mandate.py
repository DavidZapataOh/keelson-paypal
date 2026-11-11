from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.hold_order import HoldOrder
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/mandates/{id}/hold".format(
            id=quote(str(id), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> HoldOrder | Problem | None:
    if response.status_code == 200:
        response_200 = HoldOrder.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

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
) -> Response[HoldOrder | Problem]:
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
) -> Response[HoldOrder | Problem]:
    """Hold a mandate's budget

     Creates the PayPal `AUTHORIZE` order for the budget of a signed mandate, bound to the signed mandate
    hash by its `custom_id`, and moves the mandate to `HOLD_PENDING`. While the mandate waits for
    approval the same order is returned; an order PayPal no longer offers is replaced.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[HoldOrder | Problem]
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
) -> HoldOrder | Problem | None:
    """Hold a mandate's budget

     Creates the PayPal `AUTHORIZE` order for the budget of a signed mandate, bound to the signed mandate
    hash by its `custom_id`, and moves the mandate to `HOLD_PENDING`. While the mandate waits for
    approval the same order is returned; an order PayPal no longer offers is replaced.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        HoldOrder | Problem
    """

    return sync_detailed(
        id=id,
        client=client,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
) -> Response[HoldOrder | Problem]:
    """Hold a mandate's budget

     Creates the PayPal `AUTHORIZE` order for the budget of a signed mandate, bound to the signed mandate
    hash by its `custom_id`, and moves the mandate to `HOLD_PENDING`. While the mandate waits for
    approval the same order is returned; an order PayPal no longer offers is replaced.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[HoldOrder | Problem]
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
) -> HoldOrder | Problem | None:
    """Hold a mandate's budget

     Creates the PayPal `AUTHORIZE` order for the budget of a signed mandate, bound to the signed mandate
    hash by its `custom_id`, and moves the mandate to `HOLD_PENDING`. While the mandate waits for
    approval the same order is returned; an order PayPal no longer offers is replaced.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        HoldOrder | Problem
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
        )
    ).parsed
