from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.connection_approved import ConnectionApproved
from ...models.connection_token_error import ConnectionTokenError
from ...models.poll_connection_body import PollConnectionBody
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: PollConnectionBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/connections/token",
    }

    _kwargs["data"] = body.to_dict()
    headers["Content-Type"] = "application/x-www-form-urlencoded"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> ConnectionApproved | ConnectionTokenError | Problem | None:
    if response.status_code == 200:
        response_200 = ConnectionApproved.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ConnectionTokenError.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[ConnectionApproved | ConnectionTokenError | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: PollConnectionBody,
) -> Response[ConnectionApproved | ConnectionTokenError | Problem]:
    """Poll for the user's answer

     RFC 8628 §3.4 polling with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Until the user
    decides: `authorization_pending`, or `slow_down` (and 5 more seconds to wait) when polled faster
    than `interval`. Then `access_denied`, `expired_token`, or the approved mandate's id, once: the
    device code is spent by the answer that carries it.

    Args:
        body (PollConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ConnectionApproved | ConnectionTokenError | Problem]
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
    body: PollConnectionBody,
) -> ConnectionApproved | ConnectionTokenError | Problem | None:
    """Poll for the user's answer

     RFC 8628 §3.4 polling with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Until the user
    decides: `authorization_pending`, or `slow_down` (and 5 more seconds to wait) when polled faster
    than `interval`. Then `access_denied`, `expired_token`, or the approved mandate's id, once: the
    device code is spent by the answer that carries it.

    Args:
        body (PollConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ConnectionApproved | ConnectionTokenError | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: PollConnectionBody,
) -> Response[ConnectionApproved | ConnectionTokenError | Problem]:
    """Poll for the user's answer

     RFC 8628 §3.4 polling with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Until the user
    decides: `authorization_pending`, or `slow_down` (and 5 more seconds to wait) when polled faster
    than `interval`. Then `access_denied`, `expired_token`, or the approved mandate's id, once: the
    device code is spent by the answer that carries it.

    Args:
        body (PollConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ConnectionApproved | ConnectionTokenError | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: PollConnectionBody,
) -> ConnectionApproved | ConnectionTokenError | Problem | None:
    """Poll for the user's answer

     RFC 8628 §3.4 polling with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Until the user
    decides: `authorization_pending`, or `slow_down` (and 5 more seconds to wait) when polled faster
    than `interval`. Then `access_denied`, `expired_token`, or the approved mandate's id, once: the
    device code is spent by the answer that carries it.

    Args:
        body (PollConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ConnectionApproved | ConnectionTokenError | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
