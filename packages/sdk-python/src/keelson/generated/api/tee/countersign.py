from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.countersign_request import CountersignRequest
from ...models.countersigned import Countersigned
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: CountersignRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/countersign",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Countersigned | Problem | None:
    if response.status_code == 200:
        response_200 = Countersigned.from_dict(response.json())

        return response_200

    if response.status_code == 202:
        response_202 = Countersigned.from_dict(response.json())

        return response_202

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 413:
        response_413 = Problem.from_dict(response.json())

        return response_413

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if response.status_code == 502:
        response_502 = Problem.from_dict(response.json())

        return response_502

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Countersigned | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CountersignRequest,
) -> Response[Countersigned | Problem]:
    """Countersign a cart

     Sends the cart to the TEE legs in order and returns the countersignatures only when both agree. A
    DENY is countersigned too. An app acting for a user (`purchases:write`) countersigns only under a
    mandate that user approved for it; under a mandate of Keelson's hosted operator it sends `mandateId`
    and Keelson closes the mandate with that operator's key over the request id and this cart, and
    nothing else. A cart is bought once per mandate: while a purchase of the same cart is in flight, or
    for ten minutes after it was captured, another request for it is answered `409 purchase-exists` with
    that purchase's id, whatever its request id, evidence or `Idempotency-Key`. Retrying after a lost
    answer is therefore safe; to buy the same cart again on purpose, name that purchase in `repeatOf`.

    Args:
        body (CountersignRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Countersigned | Problem]
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
    body: CountersignRequest,
) -> Countersigned | Problem | None:
    """Countersign a cart

     Sends the cart to the TEE legs in order and returns the countersignatures only when both agree. A
    DENY is countersigned too. An app acting for a user (`purchases:write`) countersigns only under a
    mandate that user approved for it; under a mandate of Keelson's hosted operator it sends `mandateId`
    and Keelson closes the mandate with that operator's key over the request id and this cart, and
    nothing else. A cart is bought once per mandate: while a purchase of the same cart is in flight, or
    for ten minutes after it was captured, another request for it is answered `409 purchase-exists` with
    that purchase's id, whatever its request id, evidence or `Idempotency-Key`. Retrying after a lost
    answer is therefore safe; to buy the same cart again on purpose, name that purchase in `repeatOf`.

    Args:
        body (CountersignRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Countersigned | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CountersignRequest,
) -> Response[Countersigned | Problem]:
    """Countersign a cart

     Sends the cart to the TEE legs in order and returns the countersignatures only when both agree. A
    DENY is countersigned too. An app acting for a user (`purchases:write`) countersigns only under a
    mandate that user approved for it; under a mandate of Keelson's hosted operator it sends `mandateId`
    and Keelson closes the mandate with that operator's key over the request id and this cart, and
    nothing else. A cart is bought once per mandate: while a purchase of the same cart is in flight, or
    for ten minutes after it was captured, another request for it is answered `409 purchase-exists` with
    that purchase's id, whatever its request id, evidence or `Idempotency-Key`. Retrying after a lost
    answer is therefore safe; to buy the same cart again on purpose, name that purchase in `repeatOf`.

    Args:
        body (CountersignRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Countersigned | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: CountersignRequest,
) -> Countersigned | Problem | None:
    """Countersign a cart

     Sends the cart to the TEE legs in order and returns the countersignatures only when both agree. A
    DENY is countersigned too. An app acting for a user (`purchases:write`) countersigns only under a
    mandate that user approved for it; under a mandate of Keelson's hosted operator it sends `mandateId`
    and Keelson closes the mandate with that operator's key over the request id and this cart, and
    nothing else. A cart is bought once per mandate: while a purchase of the same cart is in flight, or
    for ten minutes after it was captured, another request for it is answered `409 purchase-exists` with
    that purchase's id, whatever its request id, evidence or `Idempotency-Key`. Retrying after a lost
    answer is therefore safe; to buy the same cart again on purpose, name that purchase in `repeatOf`.

    Args:
        body (CountersignRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Countersigned | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
