from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.record_tracking_response_200 import RecordTrackingResponse200
from ...models.tracking import Tracking
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: Tracking,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/purchases/{id}/tracking".format(
            id=quote(str(id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | RecordTrackingResponse200 | None:
    if response.status_code == 200:
        response_200 = RecordTrackingResponse200.from_dict(response.json())

        return response_200

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
) -> Response[Problem | RecordTrackingResponse200]:
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
    body: Tracking,
) -> Response[Problem | RecordTrackingResponse200]:
    """Record a purchase's shipment and its delivery

     Adds the tracker to the PayPal order (Orders v2) and, once delivered, records the delivery with
    PayPal's Add Tracking API. Idempotent per tracking number.

    Args:
        id (str):
        body (Tracking):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | RecordTrackingResponse200]
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
    body: Tracking,
) -> Problem | RecordTrackingResponse200 | None:
    """Record a purchase's shipment and its delivery

     Adds the tracker to the PayPal order (Orders v2) and, once delivered, records the delivery with
    PayPal's Add Tracking API. Idempotent per tracking number.

    Args:
        id (str):
        body (Tracking):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | RecordTrackingResponse200
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
    body: Tracking,
) -> Response[Problem | RecordTrackingResponse200]:
    """Record a purchase's shipment and its delivery

     Adds the tracker to the PayPal order (Orders v2) and, once delivered, records the delivery with
    PayPal's Add Tracking API. Idempotent per tracking number.

    Args:
        id (str):
        body (Tracking):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | RecordTrackingResponse200]
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
    body: Tracking,
) -> Problem | RecordTrackingResponse200 | None:
    """Record a purchase's shipment and its delivery

     Adds the tracker to the PayPal order (Orders v2) and, once delivered, records the delivery with
    PayPal's Add Tracking API. Idempotent per tracking number.

    Args:
        id (str):
        body (Tracking):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | RecordTrackingResponse200
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
