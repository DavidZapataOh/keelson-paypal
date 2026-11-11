from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.embed_link import EmbedLink
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    keelson_embed: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(keelson_embed, Unset):
        headers["keelson-embed"] = keelson_embed

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/embed/links",
    }

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> EmbedLink | Problem | None:
    if response.status_code == 201:
        response_201 = EmbedLink.from_dict(response.json())

        return response_201

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[EmbedLink | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    keelson_embed: str | Unset = UNSET,
) -> Response[EmbedLink | Problem]:
    """Link the embedded approval to a Keelson window

     A single-use nonce for the Keelson window the frame opens for a user without a passkey here: once
    they sign in there and confirm, this session signs for them.

    Args:
        keelson_embed (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedLink | Problem]
    """

    kwargs = _get_kwargs(
        keelson_embed=keelson_embed,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    keelson_embed: str | Unset = UNSET,
) -> EmbedLink | Problem | None:
    """Link the embedded approval to a Keelson window

     A single-use nonce for the Keelson window the frame opens for a user without a passkey here: once
    they sign in there and confirm, this session signs for them.

    Args:
        keelson_embed (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedLink | Problem
    """

    return sync_detailed(
        client=client,
        keelson_embed=keelson_embed,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    keelson_embed: str | Unset = UNSET,
) -> Response[EmbedLink | Problem]:
    """Link the embedded approval to a Keelson window

     A single-use nonce for the Keelson window the frame opens for a user without a passkey here: once
    they sign in there and confirm, this session signs for them.

    Args:
        keelson_embed (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedLink | Problem]
    """

    kwargs = _get_kwargs(
        keelson_embed=keelson_embed,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    keelson_embed: str | Unset = UNSET,
) -> EmbedLink | Problem | None:
    """Link the embedded approval to a Keelson window

     A single-use nonce for the Keelson window the frame opens for a user without a passkey here: once
    they sign in there and confirm, this session signs for them.

    Args:
        keelson_embed (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedLink | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            keelson_embed=keelson_embed,
        )
    ).parsed
