from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    channel: str,
    last_event_id: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(last_event_id, Unset):
        headers["last-event-id"] = last_event_id

    params: dict[str, Any] = {}

    params["channel"] = channel

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/events",
        "params": params,
    }

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | str | None:
    if response.status_code == 200:
        response_200 = response.text
        return response_200

    if response.status_code == 400:
        response_400 = Problem.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | str]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    channel: str,
    last_event_id: str | Unset = UNSET,
) -> Response[Problem | str]:
    """Stream events

     Server-sent events for one channel. Send `Last-Event-ID` to replay the events after that id before
    going live.

    Args:
        channel (str): `public:<name>`, or the caller's own namespace `<base64url(kind:subject)>`
            with an optional `:<suffix>`.
        last_event_id (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | str]
    """

    kwargs = _get_kwargs(
        channel=channel,
        last_event_id=last_event_id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    channel: str,
    last_event_id: str | Unset = UNSET,
) -> Problem | str | None:
    """Stream events

     Server-sent events for one channel. Send `Last-Event-ID` to replay the events after that id before
    going live.

    Args:
        channel (str): `public:<name>`, or the caller's own namespace `<base64url(kind:subject)>`
            with an optional `:<suffix>`.
        last_event_id (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | str
    """

    return sync_detailed(
        client=client,
        channel=channel,
        last_event_id=last_event_id,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    channel: str,
    last_event_id: str | Unset = UNSET,
) -> Response[Problem | str]:
    """Stream events

     Server-sent events for one channel. Send `Last-Event-ID` to replay the events after that id before
    going live.

    Args:
        channel (str): `public:<name>`, or the caller's own namespace `<base64url(kind:subject)>`
            with an optional `:<suffix>`.
        last_event_id (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | str]
    """

    kwargs = _get_kwargs(
        channel=channel,
        last_event_id=last_event_id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    channel: str,
    last_event_id: str | Unset = UNSET,
) -> Problem | str | None:
    """Stream events

     Server-sent events for one channel. Send `Last-Event-ID` to replay the events after that id before
    going live.

    Args:
        channel (str): `public:<name>`, or the caller's own namespace `<base64url(kind:subject)>`
            with an optional `:<suffix>`.
        last_event_id (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | str
    """

    return (
        await asyncio_detailed(
            client=client,
            channel=channel,
            last_event_id=last_event_id,
        )
    ).parsed
