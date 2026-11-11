from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.get_timestamps_response_200 import GetTimestampsResponse200
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    hash_: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/timestamps/{hash_}".format(
            hash_=quote(str(hash_), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> GetTimestampsResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = GetTimestampsResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[GetTimestampsResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    hash_: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[GetTimestampsResponse200 | Problem]:
    """RFC 3161 timestamps of a hash

     The RFC 3161 tokens two independent TSAs issued over a log leaf hash (or another stamped hash). Each
    token's message imprint is the hash itself, so `openssl ts -verify -digest <hash>` checks it.

    Args:
        hash_ (str): The SHA-256 hash, 64 lowercase hex digits.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[GetTimestampsResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        hash_=hash_,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    hash_: str,
    *,
    client: AuthenticatedClient | Client,
) -> GetTimestampsResponse200 | Problem | None:
    """RFC 3161 timestamps of a hash

     The RFC 3161 tokens two independent TSAs issued over a log leaf hash (or another stamped hash). Each
    token's message imprint is the hash itself, so `openssl ts -verify -digest <hash>` checks it.

    Args:
        hash_ (str): The SHA-256 hash, 64 lowercase hex digits.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        GetTimestampsResponse200 | Problem
    """

    return sync_detailed(
        hash_=hash_,
        client=client,
    ).parsed


async def asyncio_detailed(
    hash_: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[GetTimestampsResponse200 | Problem]:
    """RFC 3161 timestamps of a hash

     The RFC 3161 tokens two independent TSAs issued over a log leaf hash (or another stamped hash). Each
    token's message imprint is the hash itself, so `openssl ts -verify -digest <hash>` checks it.

    Args:
        hash_ (str): The SHA-256 hash, 64 lowercase hex digits.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[GetTimestampsResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        hash_=hash_,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    hash_: str,
    *,
    client: AuthenticatedClient | Client,
) -> GetTimestampsResponse200 | Problem | None:
    """RFC 3161 timestamps of a hash

     The RFC 3161 tokens two independent TSAs issued over a log leaf hash (or another stamped hash). Each
    token's message imprint is the hash itself, so `openssl ts -verify -digest <hash>` checks it.

    Args:
        hash_ (str): The SHA-256 hash, 64 lowercase hex digits.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        GetTimestampsResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            hash_=hash_,
            client=client,
        )
    ).parsed
