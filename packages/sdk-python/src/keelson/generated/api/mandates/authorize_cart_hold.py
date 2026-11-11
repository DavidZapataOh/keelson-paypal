from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.authorize_purchase_hold import AuthorizePurchaseHold
from ...models.authorized_purchase_hold import AuthorizedPurchaseHold
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    id: str,
    request_id: str,
    *,
    body: AuthorizePurchaseHold,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/mandates/{id}/holds/{request_id}/authorize".format(
            id=quote(str(id), safe=""),
            request_id=quote(str(request_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> AuthorizedPurchaseHold | Problem | None:
    if response.status_code == 200:
        response_200 = AuthorizedPurchaseHold.from_dict(response.json())

        return response_200

    if response.status_code == 202:
        response_202 = AuthorizedPurchaseHold.from_dict(response.json())

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
) -> Response[AuthorizedPurchaseHold | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    id: str,
    request_id: str,
    *,
    client: AuthenticatedClient,
    body: AuthorizePurchaseHold,
) -> Response[AuthorizedPurchaseHold | Problem]:
    """Authorize an approved cart hold

     Authorizes the order stored for the request and checks the authorization against it (amount,
    currency, `custom_id`, payee). An authorization that does not match is voided.

    Args:
        id (str):
        request_id (str):
        body (AuthorizePurchaseHold): The order the buyer approved.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AuthorizedPurchaseHold | Problem]
    """

    kwargs = _get_kwargs(
        id=id,
        request_id=request_id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    request_id: str,
    *,
    client: AuthenticatedClient,
    body: AuthorizePurchaseHold,
) -> AuthorizedPurchaseHold | Problem | None:
    """Authorize an approved cart hold

     Authorizes the order stored for the request and checks the authorization against it (amount,
    currency, `custom_id`, payee). An authorization that does not match is voided.

    Args:
        id (str):
        request_id (str):
        body (AuthorizePurchaseHold): The order the buyer approved.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AuthorizedPurchaseHold | Problem
    """

    return sync_detailed(
        id=id,
        request_id=request_id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    id: str,
    request_id: str,
    *,
    client: AuthenticatedClient,
    body: AuthorizePurchaseHold,
) -> Response[AuthorizedPurchaseHold | Problem]:
    """Authorize an approved cart hold

     Authorizes the order stored for the request and checks the authorization against it (amount,
    currency, `custom_id`, payee). An authorization that does not match is voided.

    Args:
        id (str):
        request_id (str):
        body (AuthorizePurchaseHold): The order the buyer approved.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AuthorizedPurchaseHold | Problem]
    """

    kwargs = _get_kwargs(
        id=id,
        request_id=request_id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    request_id: str,
    *,
    client: AuthenticatedClient,
    body: AuthorizePurchaseHold,
) -> AuthorizedPurchaseHold | Problem | None:
    """Authorize an approved cart hold

     Authorizes the order stored for the request and checks the authorization against it (amount,
    currency, `custom_id`, payee). An authorization that does not match is voided.

    Args:
        id (str):
        request_id (str):
        body (AuthorizePurchaseHold): The order the buyer approved.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AuthorizedPurchaseHold | Problem
    """

    return (
        await asyncio_detailed(
            id=id,
            request_id=request_id,
            client=client,
            body=body,
        )
    ).parsed
