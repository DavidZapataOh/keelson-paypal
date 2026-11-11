from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.connection_request import ConnectionRequest
from ...models.device_authorization import DeviceAuthorization
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: ConnectionRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/connections",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> DeviceAuthorization | Problem | None:
    if response.status_code == 201:
        response_201 = DeviceAuthorization.from_dict(response.json())

        return response_201

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[DeviceAuthorization | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: ConnectionRequest,
) -> Response[DeviceAuthorization | Problem]:
    """Ask the user for a mandate

     The agent's operator asks its user for a mandate with these limits, as an RFC 8628 device
    authorization: the user opens `verification_uri_complete`, compares `user_code` and approves on
    Keelson's page with a passkey, lowering any limit. Only a client that linked an operator may ask,
    and the mandate names that operator. The code expires in 15 minutes and is single use.

    An app acting for a user with a token they granted it (`mandates:request`) asks that user only: the
    request is theirs from the start, so it carries no number to match. The mandate names the app's own
    operator, or Keelson's hosted operator when the app has none. Through the hosted operator, every app
    is capped (`hosted-cap`): one user's open mandates and purchases of the last 180 days with apps
    whose redirect URIs are not a known host's may not pass `HOSTED_CAP_PER_USER_MINOR`, and with all
    such apps `HOSTED_CAP_KNOWN_PER_USER_MINOR`; every user's funded exposure may not pass
    `HOSTED_CAP_TOTAL_MINOR`.

    Args:
        body (ConnectionRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeviceAuthorization | Problem]
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
    body: ConnectionRequest,
) -> DeviceAuthorization | Problem | None:
    """Ask the user for a mandate

     The agent's operator asks its user for a mandate with these limits, as an RFC 8628 device
    authorization: the user opens `verification_uri_complete`, compares `user_code` and approves on
    Keelson's page with a passkey, lowering any limit. Only a client that linked an operator may ask,
    and the mandate names that operator. The code expires in 15 minutes and is single use.

    An app acting for a user with a token they granted it (`mandates:request`) asks that user only: the
    request is theirs from the start, so it carries no number to match. The mandate names the app's own
    operator, or Keelson's hosted operator when the app has none. Through the hosted operator, every app
    is capped (`hosted-cap`): one user's open mandates and purchases of the last 180 days with apps
    whose redirect URIs are not a known host's may not pass `HOSTED_CAP_PER_USER_MINOR`, and with all
    such apps `HOSTED_CAP_KNOWN_PER_USER_MINOR`; every user's funded exposure may not pass
    `HOSTED_CAP_TOTAL_MINOR`.

    Args:
        body (ConnectionRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeviceAuthorization | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: ConnectionRequest,
) -> Response[DeviceAuthorization | Problem]:
    """Ask the user for a mandate

     The agent's operator asks its user for a mandate with these limits, as an RFC 8628 device
    authorization: the user opens `verification_uri_complete`, compares `user_code` and approves on
    Keelson's page with a passkey, lowering any limit. Only a client that linked an operator may ask,
    and the mandate names that operator. The code expires in 15 minutes and is single use.

    An app acting for a user with a token they granted it (`mandates:request`) asks that user only: the
    request is theirs from the start, so it carries no number to match. The mandate names the app's own
    operator, or Keelson's hosted operator when the app has none. Through the hosted operator, every app
    is capped (`hosted-cap`): one user's open mandates and purchases of the last 180 days with apps
    whose redirect URIs are not a known host's may not pass `HOSTED_CAP_PER_USER_MINOR`, and with all
    such apps `HOSTED_CAP_KNOWN_PER_USER_MINOR`; every user's funded exposure may not pass
    `HOSTED_CAP_TOTAL_MINOR`.

    Args:
        body (ConnectionRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DeviceAuthorization | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: ConnectionRequest,
) -> DeviceAuthorization | Problem | None:
    """Ask the user for a mandate

     The agent's operator asks its user for a mandate with these limits, as an RFC 8628 device
    authorization: the user opens `verification_uri_complete`, compares `user_code` and approves on
    Keelson's page with a passkey, lowering any limit. Only a client that linked an operator may ask,
    and the mandate names that operator. The code expires in 15 minutes and is single use.

    An app acting for a user with a token they granted it (`mandates:request`) asks that user only: the
    request is theirs from the start, so it carries no number to match. The mandate names the app's own
    operator, or Keelson's hosted operator when the app has none. Through the hosted operator, every app
    is capped (`hosted-cap`): one user's open mandates and purchases of the last 180 days with apps
    whose redirect URIs are not a known host's may not pass `HOSTED_CAP_PER_USER_MINOR`, and with all
    such apps `HOSTED_CAP_KNOWN_PER_USER_MINOR`; every user's funded exposure may not pass
    `HOSTED_CAP_TOTAL_MINOR`.

    Args:
        body (ConnectionRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DeviceAuthorization | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
